// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
//
// Output rows fields (stable):
// - exchange, symbol
// - funding_rate_raw (source-native; for Lighter = last hourly rate)
// - funding_interval_s (we normalize to 28800 for all exchanges)
// - funding_rate_next_interval
// - funding_rate_8h
// - mark_price
// - source_ts
//
// Lighter special:
// - Uses /api/v1/fundings?resolution=1h&count_back=8 (or fallback param variants)
// - Sums last 8 hourly funding rates => funding_rate_8h (trailing 8h sum)
// - market_id mapping from your debug: BTC=1, ETH=0, SOL=2, BNB=25

const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  BNB: "BNBUSDT",
};

const VARIATIONAL_BASE =
  "https://omni-client-api.prod.ap-northeast-1.variational.io";

const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai";

// ✅ market_id 매핑(네 디버그 값 기반)
const LIGHTER_MARKET_ID = {
  BTC: 1,
  ETH: 0,
  SOL: 2,
  BNB: 25,
};

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  // 1 year ≈ 365 days, 3 funding windows/day => 1095 windows/year
  return r / (365 * 3);
}

function normalizeTo8h(rate, interval_s) {
  const r = toNum(rate);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
  return r * (28800 / s);
}

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), funding_interval_s, mark_price, quotes.updated_at
 */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`);
  const listings = Array.isArray(stats?.listings) ? stats.listings : [];

  const byTicker = new Map();
  for (const it of listings) {
    const t = String(it?.ticker || "").toUpperCase();
    if (TARGETS.includes(t)) byTicker.set(t, it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const it = byTicker.get(sym);
    if (!it) continue;

    const rateAnnual = toNum(it.funding_rate);
    const rate8h = annualTo8h(rateAnnual);

    rows.push({
      exchange: "variational",
      symbol: sym,
      funding_rate_raw: rateAnnual,       // annual
      funding_interval_s: 28800,          // normalized output to 8h
      funding_rate_next_interval: rate8h, // next 8h
      funding_rate_8h: rate8h,            // 8h
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------------- Binance (8h) ---------------- */
async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

    // latest realized 8h funding rate
    const fundingArr = await fetchJson(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${fSym}&limit=1`
    );
    const last =
      Array.isArray(fundingArr) && fundingArr.length
        ? fundingArr[fundingArr.length - 1]
        : null;

    const fundingRate8h = toNum(last?.fundingRate);
    const fundingTimeIso = last?.fundingTime
      ? new Date(Number(last.fundingTime)).toISOString()
      : null;

    // mark price
    const prem = await fetchJson(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`
    );
    const mark = toNum(prem?.markPrice);

    rows.push({
      exchange: "binance",
      symbol: sym,
      funding_rate_raw: fundingRate8h,
      funding_interval_s: 28800,
      funding_rate_next_interval: fundingRate8h,
      funding_rate_8h: fundingRate8h,
      mark_price: mark,
      source_ts: fundingTimeIso,
    });
  }

  return rows;
}

/** ---------------- Lighter helpers ---------------- */

function lighterGetSymbol_(it) {
  const raw = pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]);
  return String(raw || "").toUpperCase();
}

function lighterGetMarketId_(it) {
  const v = pickField(it, ["market_id", "marketId", "market_index", "marketIndex", "market"]);
  const n = toNum(v);
  return n === null ? null : n;
}

function lighterGetRateRaw_(it) {
  // funding rate key candidates (hourly/instant)
  const v = pickField(it, [
    "funding_rate",
    "fundingRate",
    "rate",
    "hourly_funding_rate",
    "hourlyFundingRate",
    "funding",
  ]);
  return toNum(v);
}

function lighterGetTs_(it) {
  const v = pickField(it, ["timestamp", "ts", "time", "updated_at", "updatedAt"]);
  if (v === null || v === undefined) return null;
  // could be millis
  const n = toNum(v);
  if (n !== null && n > 10_000_000_000) {
    try {
      return new Date(n).toISOString();
    } catch (_) {}
  }
  return String(v);
}

function unwrapArray_(data) {
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.fundings)
    ? data.fundings
    : Array.isArray(data?.items)
    ? data.items
    : [];
}

/**
 * Try multiple param variants because some docs render dynamically / param names can differ.
 * We want: last 8 items at 1h resolution for a specific market_id.
 */
async function lighterFetchFundings1h_(marketId, countBack = 8) {
  const qsCandidates = [
    // user's preferred
    `market_id=${marketId}&resolution=1h&count_back=${countBack}`,
    `market_id=${marketId}&resolution=1h&countBack=${countBack}`,
    `market_id=${marketId}&resolution=1h&count=${countBack}`,
    `market_id=${marketId}&resolution=1h&limit=${countBack}`,

    // sometimes resolution is seconds
    `market_id=${marketId}&resolution=3600&count_back=${countBack}`,
    `market_id=${marketId}&resolution=3600&countBack=${countBack}`,
    `market_id=${marketId}&resolution=3600&count=${countBack}`,
    `market_id=${marketId}&resolution=3600&limit=${countBack}`,

    // sometimes marketId casing
    `marketId=${marketId}&resolution=1h&count_back=${countBack}`,
    `marketId=${marketId}&resolution=3600&count_back=${countBack}`,
  ];

  let lastErr = null;

  for (const qs of qsCandidates) {
    const url = `${LIGHTER_BASE}/api/v1/fundings?${qs}`;
    try {
      const data = await fetchJson(url);
      const items = unwrapArray_(data);
      if (items.length) {
        return { urlTried: url, items };
      }
      // empty array is also "success but no data" -> still try next
    } catch (e) {
      lastErr = e;
      // try next candidate
    }
  }

  throw new Error(
    `[lighter] fundings fetch failed (marketId=${marketId}). lastErr=${String(
      lastErr?.message || lastErr
    )}`
  );
}

async function getLighter({ debug = false } = {}) {
  const rows = [];
  const debugObj = {};

  for (const sym of TARGETS) {
    const marketId = LIGHTER_MARKET_ID[sym];
    if (marketId === undefined || marketId === null) continue;

    // 1) pull last 8 hourly fundings
    const { urlTried, items } = await lighterFetchFundings1h_(marketId, 8);

    // 2) normalize ordering if timestamps exist; else keep as given
    const enriched = items.map((it, i) => {
      const rawSymbol = lighterGetSymbol_(it) || sym;
      return {
        i,
        rawSymbol,
        marketId: lighterGetMarketId_(it),
        rate: lighterGetRateRaw_(it),
        ts: lighterGetTs_(it),
        mark: toNum(pickField(it, ["mark_price", "markPrice", "mark"])),
      };
    });

    // If timestamps look sortable, sort ascending by ts (best effort)
    const withSortableTs = enriched.every((x) => x.ts);
    const ordered = withSortableTs
      ? [...enriched].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
      : enriched;

    // Take last 8 (or fewer if API returned fewer)
    const lastN = ordered.slice(Math.max(0, ordered.length - 8));

    // Sum of last 8 hourly rates => trailing 8h equivalent
    const rates = lastN.map((x) => toNum(x.rate)).filter((x) => x !== null);
    const sum8h =
      rates.length > 0 ? rates.reduce((acc, v) => acc + v, 0) : null;

    const lastHourly = rates.length ? rates[rates.length - 1] : null;

    // Mark price may not exist in fundings -> we fill later with Binance marks
    const markCandidate = lastN.length ? lastN[lastN.length - 1].mark : null;
    const tsCandidate = lastN.length ? lastN[lastN.length - 1].ts : null;

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: lastHourly, // last hourly rate (debug-friendly)
      funding_interval_s: 28800, // normalize output to 8h
      funding_rate_next_interval: sum8h,
      funding_rate_8h: sum8h,
      mark_price: markCandidate,
      source_ts: tsCandidate,
      raw_symbol: sym,
      lighter_market_id: marketId,
      lighter_source: "fundings:sum8x1h",
      lighter_fundings_url: urlTried,
      lighter_points_used: lastN.length,
    });

    if (debug) {
      debugObj[sym] = {
        marketId,
        urlTried,
        returned: enriched.length,
        used: lastN.length,
        usedRates: lastN.map((x) => x.rate),
        usedTs: lastN.map((x) => x.ts),
        sum8h,
      };
    }
  }

  return { rows, debugObj };
}

function fillMissingMarks(rows) {
  // Prefer binance marks as fallback, then variational
  const markBySymbol = new Map();

  for (const r of rows) {
    if (r.exchange === "binance" && r.mark_price != null) {
      markBySymbol.set(r.symbol, r.mark_price);
    }
  }
  for (const r of rows) {
    if (!markBySymbol.has(r.symbol) && r.exchange === "variational" && r.mark_price != null) {
      markBySymbol.set(r.symbol, r.mark_price);
    }
  }
  for (const r of rows) {
    if (r.mark_price == null && markBySymbol.has(r.symbol)) {
      r.mark_price = markBySymbol.get(r.symbol);
    }
  }
}

export default async function handler(req, res) {
  try {
    const asOf = new Date().toISOString();
    const debug = String(req?.query?.debug || "") === "1";

    const [v, b, l] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter({ debug }),
    ]);

    const rows = [...v, ...b, ...l.rows];
    fillMissingMarks(rows);

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const payload = { asOf, rows };
    if (debug) payload.lighter_debug = l.debugObj;

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

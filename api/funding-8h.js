// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
// - Variational: funding_rate is ANNUAL -> convert to 8h (divide by 365*3)
// - Binance: fundingRate endpoint returns 8h realized rate
// - Lighter: use /fundings?resolution=1h&count_back=8 and SUM last 8 hourly rates => 8h equivalent
//            fallback to /funding-rates (last candidate) if /fundings fails

const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  BNB: "BNBUSDT",
};

const VARIATIONAL_BASE = "https://omni-client-api.prod.ap-northeast-1.variational.io";
const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai";

// Lighter market_id mapping (based on your debug)
const LIGHTER_MARKET_ID_BY_SYMBOL = {
  ETH: 0,
  BTC: 1,
  SOL: 2,
  BNB: 25,
};

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  // 1 year ≈ 365 days, 3 funding windows/day => 1095 windows/year
  return r / (365 * 3);
}

async function fetchJson(url, timeoutMs = 8000) {
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

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), mark_price, quotes.updated_at
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
      funding_rate_raw: rateAnnual,          // annual
      funding_interval_s: 28800,             // normalized
      funding_rate_next_interval: rate8h,    // next 8h
      funding_rate_8h: rate8h,               // 8h normalized
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
  const raw =
    pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]) ?? "";
  return String(raw).toUpperCase();
}

function lighterGetMarketId_(it) {
  const v = pickField(it, ["market_id", "marketId", "market_index", "marketIndex", "marketId", "id"]);
  const n = toNum(v);
  if (n === null) return null;
  return Math.trunc(n);
}

function lighterGetRateRaw_(it) {
  // fundings endpoint might use different key names
  const v =
    pickField(it, [
      "funding_rate",
      "fundingRate",
      "rate",
      "hourly_funding_rate",
      "hourlyFundingRate",
    ]);
  return toNum(v);
}

function lighterPickItems_(data) {
  return (
    (Array.isArray(data) && data) ||
    (Array.isArray(data?.data) && data.data) ||
    (Array.isArray(data?.items) && data.items) ||
    (Array.isArray(data?.fundings) && data.fundings) ||
    (Array.isArray(data?.funding_rates) && data.funding_rates) ||
    (Array.isArray(data?.fundingRates) && data.fundingRates) ||
    []
  );
}

/**
 * Try multiple query-parameter variants for robustness:
 * - market_id vs marketId
 * - count_back vs countBack
 * - resolution=1h (string)
 */
async function lighterFetchFundings_(marketId, countBack = 8) {
  const base = `${LIGHTER_BASE}/api/v1/fundings`;
  const urls = [
    `${base}?market_id=${marketId}&resolution=1h&count_back=${countBack}`,
    `${base}?marketId=${marketId}&resolution=1h&count_back=${countBack}`,
    `${base}?market_id=${marketId}&resolution=1h&countBack=${countBack}`,
    `${base}?marketId=${marketId}&resolution=1h&countBack=${countBack}`,
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const items = lighterPickItems_(data);
      if (items.length) return { url, items };
      // empty is also suspicious but not necessarily error
      return { url, items };
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown");
  throw new Error(`[lighter] fundings fetch failed (marketId=${marketId}). lastErr=${msg}`);
}

async function lighterFetchFundingRatesFallback_() {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);
  const items = lighterPickItems_(data);
  return items;
}

/** ---------------- Lighter main ----------------
 * Goal:
 * - For each symbol, call fundings(1h, count_back=8), SUM last 8 hourly rates => funding_rate_8h
 * - If fails, fallback to funding-rates: pick last candidate for that symbol
 */
async function getLighter() {
  const rows = [];

  // Step A: best effort to compute 8h from 8x1h fundings
  for (const sym of TARGETS) {
    const marketId = LIGHTER_MARKET_ID_BY_SYMBOL[sym];
    if (marketId === undefined) continue;

    try {
      const { items, url } = await lighterFetchFundings_(marketId, 8);

      // take last 8 (in case API returns more)
      const last8 = items.slice(-8);

      const rates = last8
        .map((x) => lighterGetRateRaw_(x))
        .filter((x) => x !== null);

      if (rates.length === 0) throw new Error("no funding rates in response");

      const sum8h = rates.reduce((a, b) => a + b, 0);

      rows.push({
        exchange: "lighter",
        symbol: sym,
        funding_rate_raw: sum8h,              // we store 8h-sum as raw (so raw == 8h)
        funding_interval_s: 28800,
        funding_rate_next_interval: sum8h,
        funding_rate_8h: sum8h,
        mark_price: null,                      // will be filled by fillMissingMarks()
        source_ts: null,
        raw_symbol: sym,
        lighter_market_id: marketId,
        lighter_source: `fundings:1h:sum_last_8 (via ${url})`,
        lighter_points_used: rates.length,
      });
    } catch (e) {
      // we'll fallback later (after we fetch funding-rates once)
      console.log(String(e?.message || e));
    }
  }

  // Step B: fallback for missing symbols (use funding-rates last-candidate)
  const missing = TARGETS.filter((s) => !rows.find((r) => r.exchange === "lighter" && r.symbol === s));
  if (missing.length) {
    let fallbackItems = [];
    try {
      fallbackItems = await lighterFetchFundingRatesFallback_();
    } catch (e) {
      console.log("[lighter] funding-rates fallback failed:", String(e?.message || e));
      fallbackItems = [];
    }

    const candsBySym = new Map();
    for (const it of fallbackItems) {
      const rawSym = lighterGetSymbol_(it);
      const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(s));
      if (!sym) continue;
      if (!candsBySym.has(sym)) candsBySym.set(sym, []);
      candsBySym.get(sym).push(it);
    }

    for (const sym of missing) {
      const cands = candsBySym.get(sym) || [];
      if (!cands.length) continue;
      const picked = cands[cands.length - 1]; // last candidate rule

      const rate = lighterGetRateRaw_(picked);
      const marketId = lighterGetMarketId_(picked) ?? LIGHTER_MARKET_ID_BY_SYMBOL[sym] ?? null;

      rows.push({
        exchange: "lighter",
        symbol: sym,
        funding_rate_raw: rate,
        funding_interval_s: 28800,
        funding_rate_next_interval: rate,
        funding_rate_8h: rate,
        mark_price: null,
        source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
        raw_symbol: lighterGetSymbol_(picked) || null,
        lighter_market_id: marketId,
        lighter_source: "funding-rates:last-candidate",
        lighter_candidate_count: cands.length,
      });
    }
  }

  return rows;
}

/** ---------------- Post-processing ---------------- */

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

    const [v, b, l] = await Promise.all([getVariational(), getBinance(), getLighter()]);
    const rows = [...v, ...b, ...l];
    fillMissingMarks(rows);

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

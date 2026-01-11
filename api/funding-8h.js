// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter.
// - Variational funding_rate is ANNUAL -> convert to 8h
// - Binance fundingRate is 8h realized
// - Lighter: prefer /fundings (hourly) -> sum last 8 hours as 8h-equivalent
//           fallback to /funding-rates "last candidate" if /fundings fails
// - Adds retry + partial errors so one exchange failure doesn't break the whole response
// - Optional debug: add ?debug=1 to include lighter_debug in response

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

/** ---------------- helpers ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// Variational funding_rate is annual fraction (e.g. 0.1095 = 10.95% APR annual)
// Convert to 8h window: 365 days * 3 windows/day = 1095 windows/year
function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  return r / (365 * 3);
}

async function fetchJson(url, timeoutMs = 10000, retries = 2) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
      return await resp.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(250 * (attempt + 1));
      }
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr;
}

function extractArrayCandidates(data) {
  const arr =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    Array.isArray(data?.data?.funding_rates) ? data.data.funding_rates :
    Array.isArray(data?.data?.fundingRates) ? data.data.fundingRates :
    null;

  if (arr) return arr;

  // Sometimes APIs return a map/object → use Object.values
  if (data && typeof data === "object") {
    const vals = Object.values(data);
    if (vals.every((v) => v && typeof v === "object")) return vals;

    if (data.data && typeof data.data === "object") {
      const vals2 = Object.values(data.data);
      if (vals2.every((v) => v && typeof v === "object")) return vals2;
    }
  }
  return [];
}

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), funding_interval_s, mark_price, quotes.updated_at
 */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`, 12000, 2);
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
      funding_rate_raw: rateAnnual, // annual
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------------- Binance (8h realized) ---------------- */
async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

    const fundingArr = await fetchJson(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${fSym}&limit=1`,
      12000,
      2
    );
    const last =
      Array.isArray(fundingArr) && fundingArr.length
        ? fundingArr[fundingArr.length - 1]
        : null;

    const fundingRate8h = toNum(last?.fundingRate);
    const fundingTimeIso = last?.fundingTime
      ? new Date(Number(last.fundingTime)).toISOString()
      : null;

    const prem = await fetchJson(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`,
      12000,
      2
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

/** ---------------- Lighter ---------------- */

function lighterExtractSymbol_(it) {
  const raw = pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]);
  return String(raw || "").toUpperCase();
}

function lighterExtractRate_(it) {
  const v = pickField(it, [
    "rate",
    "funding_rate",
    "fundingRate",
    "hourly_funding_rate",
    "hourlyFundingRate",
  ]);
  return toNum(v);
}

function lighterExtractMarketId_(it) {
  const v = pickField(it, ["marketId", "market_id", "marketIndex", "market_index", "id"]);
  const n = toNum(v);
  return n === null ? null : n;
}

async function lighterFetchLast8HourlyFundingsByMarketId_(marketId) {
  const limit = 8;

  // Try multiple param spellings for robustness
  const urls = [
    `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketId}&resolution=1h&limit=${limit}`,

    // without resolution
    `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketId}&limit=${limit}`,
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const data = await fetchJson(url, 12000, 1);
      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        [];

      const rates = items
        .map((x) => toNum(pickField(x, ["funding_rate", "fundingRate", "rate"])))
        .filter((x) => x !== null);

      if (rates.length) {
        // keep last N in case the API returns more
        const lastN = rates.slice(-limit);
        return { rates: lastN, source: url };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    `Lighter fundings fetch failed for marketId=${marketId}. lastErr=${String(
      lastErr?.message ?? lastErr
    )}`
  );
}

async function getLighter(debugOn = false) {
  // Cache-bust to avoid edge caching weirdness
  const data = await fetchJson(
    `${LIGHTER_BASE}/api/v1/funding-rates?t=${Date.now()}`,
    12000,
    2
  );

  const items = extractArrayCandidates(data);

  // Group candidates by exact symbol (avoid ETHFI / RESOLV contamination)
  const candsBySym = new Map();
  for (const it of items) {
    const symRaw = lighterExtractSymbol_(it);
    if (!TARGETS.includes(symRaw)) continue;

    if (!candsBySym.has(symRaw)) candsBySym.set(symRaw, []);
    candsBySym.get(symRaw).push(it);
  }

  const rows = [];
  const lighter_debug = {};

  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    const pickedIdx = cands.length - 1;
    const picked = cands[pickedIdx];

    const marketId =
      lighterExtractMarketId_(picked) ??
      lighterExtractMarketId_(cands[0]) ??
      null;

    const lastCandidateRate = lighterExtractRate_(picked);

    // Debug snapshot
    if (debugOn) {
      lighter_debug[sym] = {
        candidateCount: cands.length,
        pickedIndex: pickedIdx,
        candidates: cands.map((x, i) => {
          const rawSymbol = lighterExtractSymbol_(x);
          const rate = lighterExtractRate_(x);
          const mi = lighterExtractMarketId_(x);
          const mk = toNum(pickField(x, ["mark_price", "markPrice", "mark"]));
          const ts = pickField(x, ["timestamp", "ts", "updated_at", "updatedAt"]);
          return { i, rawSymbol, marketId: mi, rate, mark: mk ?? null, ts: ts ?? null };
        }),
      };
    }

    // Try /fundings to compute 8h-equivalent via sum(last 8 hourly)
    if (marketId !== null) {
      try {
        const { rates, source } = await lighterFetchLast8HourlyFundingsByMarketId_(marketId);
        const sum8h = rates.reduce((a, b) => a + b, 0);

        rows.push({
          exchange: "lighter",
          symbol: sym,
          funding_rate_raw: lastCandidateRate, // last-candidate (matches UI more often)
          funding_interval_s: 28800, // normalize output to 8h
          funding_rate_next_interval: lastCandidateRate,
          funding_rate_8h: sum8h, // ✅ 8h equivalent from hourly history
          mark_price: null,
          source_ts: null,
          raw_symbol: sym,
          lighter_market_id: marketId,
          lighter_source: source,
          lighter_candidate_count: cands.length,
        });

        continue;
      } catch (e) {
        console.log(
          `[lighter] fundings failed -> fallback to funding-rates:last-candidate (${sym}, marketId=${marketId}):`,
          String(e?.message || e)
        );
      }
    }

    // Fallback: last candidate from funding-rates
    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: lastCandidateRate,
      funding_interval_s: 28800,
      funding_rate_next_interval: lastCandidateRate,
      funding_rate_8h: lastCandidateRate,
      mark_price: null,
      source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: lighterExtractSymbol_(picked) || sym,
      lighter_market_id: marketId,
      lighter_source: "funding-rates:last-candidate",
      lighter_candidate_count: cands.length,
    });
  }

  return debugOn ? { rows, lighter_debug } : { rows };
}

/** ---------------- marks fallback ---------------- */
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

/** ---------------- handler ---------------- */
export default async function handler(req, res) {
  const asOf = new Date().toISOString();
  const debugOn = String(req.query?.debug || "") === "1";

  const errors = [];

  const settled = await Promise.allSettled([
    getVariational(),
    getBinance(),
    getLighter(debugOn),
  ]);

  const [vRes, bRes, lRes] = settled;

  const v =
    vRes.status === "fulfilled"
      ? vRes.value
      : (errors.push({ exchange: "variational", error: String(vRes.reason) }), []);

  const b =
    bRes.status === "fulfilled"
      ? bRes.value
      : (errors.push({ exchange: "binance", error: String(bRes.reason) }), []);

  let lRows = [];
  let lighter_debug = undefined;

  if (lRes.status === "fulfilled") {
    lRows = Array.isArray(lRes.value?.rows) ? lRes.value.rows : [];
    if (debugOn && lRes.value?.lighter_debug) lighter_debug = lRes.value.lighter_debug;
  } else {
    errors.push({ exchange: "lighter", error: String(lRes.reason) });
  }

  const rows = [...v, ...b, ...lRows];
  fillMissingMarks(rows);

  // Apps Script 대비 캐시 + CORS
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const payload = { asOf, rows };
  if (errors.length) payload.errors = errors;
  if (debugOn && lighter_debug) payload.lighter_debug = lighter_debug;

  res.status(200).json(payload);
}

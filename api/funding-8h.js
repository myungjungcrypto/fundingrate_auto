// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
// Lighter: market_id mapping + fundings?market_id=...&count_back=8 => sum hourly to 8h (fallback to funding-rates last-candidate)

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

/**
 * ✅ Lighter market_id mapping (your debug 기반)
 * - BTC: 1
 * - ETH: 0
 * - SOL: 2
 * - BNB: 25
 */
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

/**
 * Variational funding_rate is ANNUAL (e.g. 0.1095 = 10.95% APR-like)
 * Convert to 8h window: 365 days * 3 windows/day = 1095 windows/year
 */
function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
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

/**
 * Helper: try multiple URLs (for param name differences)
 */
async function fetchJsonTry_(urls, timeoutMs = 8000) {
  let lastErr = null;
  for (const url of urls) {
    try {
      return await fetchJson(url, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("fetchJsonTry_ failed");
}

/** ---------------- Variational ---------------- */
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
      funding_interval_s: 28800,          // output normalized to 8h
      funding_rate_next_interval: rate8h, // next 8h equivalent
      funding_rate_8h: rate8h,
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }

  return rows;
}

/** ---------------- Binance (already 8h) ---------------- */
async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

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

/** ---------------- Lighter ----------------
 * Strategy:
 * 1) Try /api/v1/fundings?market_id=...&count_back=8 (snake_case)
 *    - If it returns hourly slices: sum last 8 rates => 8h funding
 *    - If it returns 8h slices: take last one
 * 2) Fallback: /api/v1/funding-rates and pick LAST candidate for exact symbol match
 */
function lighterGetRateRaw_(item) {
  return toNum(
    pickField(item, [
      "funding_rate",
      "fundingRate",
      "rate",
      "hourly_funding_rate",
      "hourlyFundingRate",
      "funding_rate_8h",
      "fundingRate8h",
    ])
  );
}

function lighterGetTimestampMs_(item) {
  const v = pickField(item, ["timestamp", "ts", "time", "created_at", "createdAt", "updated_at", "updatedAt"]);
  const n = toNum(v);
  if (n === null) return null;

  // Heuristic: if it's in seconds, convert to ms
  if (n < 10_000_000_000) return n * 1000;
  return n;
}

function lighterStrictSymbol_(item) {
  const raw = String(
    pickField(item, ["symbol", "ticker", "market", "marketSymbol", "name", "base_asset", "baseAsset", "underlying"]) || ""
  ).toUpperCase().trim();

  // ✅ strict match only
  if (TARGETS.includes(raw)) return raw;
  return null;
}

function lighterGetMarketId_(item) {
  const n = toNum(
    pickField(item, [
      "market_id",
      "marketId",
      "market_index",
      "marketIndex",
      "market",
      "marketID",
      "marketid",
    ])
  );
  return n === null ? null : n;
}

function compute8hFromFundings_(fundings) {
  if (!Array.isArray(fundings) || !fundings.length) return null;

  // Extract (ts, rate)
  const pts = fundings
    .map((x) => ({
      ts: lighterGetTimestampMs_(x),
      r: lighterGetRateRaw_(x),
    }))
    .filter((p) => p.r !== null);

  if (!pts.length) return null;

  // If we have timestamps, estimate interval
  let inferredIntervalS = null;
  const tsList = pts.map((p) => p.ts).filter((t) => t !== null).sort((a, b) => a - b);
  if (tsList.length >= 2) {
    const diffs = [];
    for (let i = 1; i < tsList.length; i++) diffs.push((tsList[i] - tsList[i - 1]) / 1000);
    diffs.sort((a, b) => a - b);
    const mid = diffs[Math.floor(diffs.length / 2)];
    if (Number.isFinite(mid) && mid > 0) inferredIntervalS = mid;
  }

  // Heuristic: if ~1h slices => sum to 8h
  if (inferredIntervalS && inferredIntervalS > 2500 && inferredIntervalS < 5000) {
    const sum = pts.reduce((acc, p) => acc + p.r, 0);
    return { rate8h: sum, method: "sum_hourly", inferredIntervalS };
  }

  // Else: assume each entry is already 8h (or not hourly) => take last
  return {
    rate8h: pts[pts.length - 1].r,
    method: "last_value",
    inferredIntervalS,
  };
}

async function getLighter() {
  const rows = [];

  // 1) fundings-based (preferred)
  for (const sym of TARGETS) {
    const marketId = LIGHTER_MARKET_ID[sym];
    if (marketId === undefined || marketId === null) continue;

    let fundings = null;
    try {
      // docs seems to use snake_case: market_id, count_back
      // keep a fallback attempt for camelCase marketId if needed
      const data = await fetchJsonTry_(
        [
          `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketId}&count_back=8`,
          `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketId}&count_back=8`,
        ],
        9000
      );

      fundings =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.items) ? data.items :
        [];

    } catch (e) {
      // leave null and fallback to funding-rates
      fundings = null;
    }

    if (fundings && fundings.length) {
      const computed = compute8hFromFundings_(fundings);
      if (computed && computed.rate8h !== null) {
        rows.push({
          exchange: "lighter",
          symbol: sym,
          funding_rate_raw: computed.rate8h,
          funding_interval_s: 28800,
          funding_rate_next_interval: computed.rate8h,
          funding_rate_8h: computed.rate8h,
          mark_price: null, // will be filled by fillMissingMarks()
          source_ts: null,
          raw_symbol: sym,
          lighter_market_id: marketId,
          lighter_source: `fundings:${computed.method}`,
          lighter_candidate_count: fundings.length,
          lighter_inferred_interval_s: computed.inferredIntervalS ?? null,
        });
        continue;
      }
    }

    // 2) fallback: funding-rates last-candidate (strict symbol match)
    try {
      const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);
      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.funding_rates) ? data.funding_rates :
        Array.isArray(data?.fundingRates) ? data.fundingRates :
        [];

      const cands = [];
      for (const it of items) {
        const s = lighterStrictSymbol_(it);
        if (s !== sym) continue;
        cands.push(it);
      }
      if (!cands.length) continue;

      const picked = cands[cands.length - 1];
      const rateRaw = lighterGetRateRaw_(picked);

      rows.push({
        exchange: "lighter",
        symbol: sym,
        funding_rate_raw: rateRaw,
        funding_interval_s: 28800,
        funding_rate_next_interval: rateRaw,
        funding_rate_8h: rateRaw,
        mark_price: null, // will be filled
        source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
        raw_symbol: sym,
        lighter_market_id: marketId,
        lighter_source: "funding-rates:last-candidate",
        lighter_candidate_count: cands.length,
      });
    } catch (e) {
      // swallow; no lighter row for that symbol
    }
  }

  return rows;
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

    const [v, b, l] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(),
    ]);

    const rows = [...v, ...b, ...l];
    fillMissingMarks(rows);

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

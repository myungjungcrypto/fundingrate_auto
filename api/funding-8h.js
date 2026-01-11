// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
// - Variational: funding_rate is ANNUAL -> convert to 8h
// - Binance: fundingRate endpoint already 8h
// - Lighter:
//   1) Try to compute 8h funding as SUM of last 8 hourly fundings from /fundings (probe several param combos)
//   2) Only accept if we got EXACTLY 8 points (Option A)
//   3) Otherwise fallback to /funding-rates and pick the LAST candidate per symbol

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

// If you want Lighter debug in response, set ?debug=1
function wantDebug(req) {
  const q = req?.query || {};
  return q.debug === "1" || q.debug === 1 || q.debug === true || q.debug === "true";
}

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Variational annual -> 8h (365d * 3 windows/day)
function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  return r / (365 * 3);
}

function normalizeTo8h(rate, interval_s) {
  const r = toNum(rate);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
  return r * (28800 / s);
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
      funding_rate_raw: rateAnnual, // annual
      funding_interval_s: 28800, // normalized output to 8h
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
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
  const raw = String(
    pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name", "baseSymbol"]) || ""
  ).toUpperCase();

  // Common formats: "BTC", "BTC-PERP", "BTC_USD", etc.
  // We'll keep the raw and match TARGETS by includes.
  return raw;
}

function lighterGetMarketId_(it) {
  // Try multiple likely keys
  const v = pickField(it, [
    "market_id",
    "marketId",
    "market_index",
    "marketIndex",
    "market",
    "id",
    "marketID",
  ]);
  const n = toNum(v);
  return n === null ? null : n;
}

function lighterGetRateRaw_(it) {
  // rate field candidates (from your observations)
  const rateKeyCandidates = [
    "rate",
    "funding_rate",
    "fundingRate",
    "hourly_funding_rate",
    "hourlyFundingRate",
    "funding",
    "fundingRateNext",
  ];

  for (const k of rateKeyCandidates) {
    if (it && it[k] !== undefined && it[k] !== null) {
      const r = toNum(it[k]);
      if (r !== null) return r;
    }
  }
  return null;
}

function lighterGetIntervalS_(it) {
  // if endpoint is /funding-rates, assume already 8h equivalent (interval 28800)
  // if /fundings hourly sum was used, we still output interval_s=28800 because we return 8h equivalent
  const explicit = toNum(pickField(it, ["funding_interval_s", "interval_s", "intervalSec"]));
  if (explicit) return explicit;
  return 28800;
}

/**
 * Build a map from symbol->marketId using orderBookDetails?type=perp
 * (This is optional. If it fails, we still work via /funding-rates fallback.)
 */
async function lighterBuildPerpMarketIdMap_(debug) {
  const perpIdBySym = new Map();

  try {
    const ob = await fetchJson(`${LIGHTER_BASE}/api/v1/orderBookDetails?type=perp`);

    const obItems =
      Array.isArray(ob) ? ob :
      Array.isArray(ob?.data) ? ob.data :
      Array.isArray(ob?.order_books) ? ob.order_books :
      Array.isArray(ob?.orderBooks) ? ob.orderBooks :
      [];

    for (const it of obItems) {
      const rawSym = lighterGetSymbol_(it);
      const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(s));
      if (!sym) continue;

      const id = lighterGetMarketId_(it);
      if (id === null) continue;

      if (!perpIdBySym.has(sym)) perpIdBySym.set(sym, id);
    }
  } catch (e) {
    if (debug) debug.orderBookDetails_error = String(e?.message || e);
  }

  return perpIdBySym;
}

/**
 * Probe /fundings endpoint with multiple param name variants.
 * Goal: obtain LAST 8 hourly funding points and SUM them => 8h funding (Option A requires exactly 8 points).
 *
 * Returns:
 *  { ok: true, rate8h, usedUrl, points, pointCount }
 *  { ok: false, tried, lastErr }
 */
async function lighterTryFundingsSum8h_(marketId, debugOut) {
  const base = `${LIGHTER_BASE}/api/v1/fundings`;

  // Candidate param combinations (we observed 400 errors; probe safely)
  const candidates = [];

  // market id key variants
  const midKeys = ["marketId", "market_id", "market", "market_index", "marketIndex"];

  // count key variants
  const countKeys = ["count_back", "countBack", "count", "limit"];

  // resolution key variants (1h)
  // Try both numeric seconds and string
  const resKeys = ["resolution", "resolution_s", "res", "timeframe", "interval"];
  const resVals = ["3600", "1h", "H1"];

  // Build a reasonable set (not exploding)
  for (const mk of midKeys) {
    for (const ck of countKeys) {
      // try without resolution first
      candidates.push(`${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8`);

      // try with a few resolution formats
      for (const rk of resKeys) {
        for (const rv of resVals) {
          candidates.push(
            `${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8&${rk}=${encodeURIComponent(rv)}`
          );
        }
      }
    }
  }

  // De-dupe URLs
  const uniq = Array.from(new Set(candidates));

  const tried = [];
  let lastErr = null;

  for (const url of uniq) {
    tried.push(url);
    try {
      const data = await fetchJson(url, 8000);

      // Extract items array
      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        Array.isArray(data?.result) ? data.result :
        [];

      // Extract rate points
      const rates = [];
      for (const it of items) {
        const r = lighterGetRateRaw_(it);
        if (r !== null) rates.push(r);
      }

      // Use last 8 points (in case it returned more)
      const last8 = rates.slice(-8);

      // OPTION A: accept only if EXACTLY 8 points
      if (last8.length === 8) {
        const sum8h = last8.reduce((a, b) => a + b, 0);

        if (debugOut) {
          debugOut.fundings_used_url = url;
          debugOut.fundings_points = last8;
          debugOut.fundings_point_count = last8.length;
        }

        return {
          ok: true,
          rate8h: sum8h,
          usedUrl: url,
          points: last8,
          pointCount: last8.length,
        };
      } else {
        // Not enough points -> do NOT accept (Option A)
        if (debugOut) {
          debugOut.fundings_insufficient = {
            url,
            got: last8.length,
            last8,
          };
        }
        // keep probing other URL variants
      }
    } catch (e) {
      lastErr = String(e?.message || e);
      // keep trying
    }
  }

  return {
    ok: false,
    tried: tried.slice(0, 30), // cap for response size
    triedCount: tried.length,
    lastErr,
  };
}

/**
 * Fallback: call /funding-rates and pick LAST candidate per symbol (your confirmed rule)
 * returns map sym -> { picked, candidatesMeta }
 */
async function lighterFetchFundingRatesCandidates_(debugOut) {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  const candsBySym = new Map();
  for (const it of items) {
    const rawSym = lighterGetSymbol_(it);
    const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(s));
    if (!sym) continue;

    if (!candsBySym.has(sym)) candsBySym.set(sym, []);
    candsBySym.get(sym).push(it);
  }

  if (debugOut) {
    debugOut.funding_rates_counts = {};
    for (const sym of TARGETS) {
      debugOut.funding_rates_counts[sym] = (candsBySym.get(sym) || []).length;
    }
  }

  return candsBySym;
}

/** ---------------- Lighter main ----------------
 * Strategy:
 * 1) Build perp marketId map (best effort)
 * 2) For each sym:
 *    - If we have marketId, try /fundings probe to get EXACT 8 hourly points => sum => 8h funding
 *    - If that fails OR we don't have marketId: fallback to /funding-rates LAST candidate
 */
async function getLighter(debugEnabled) {
  const lighterDebug = debugEnabled ? {} : null;

  const perpIdBySym = await lighterBuildPerpMarketIdMap_(
    debugEnabled ? (lighterDebug.orderBookDetails = {}) : null
  );

  // Pre-fetch funding-rates candidates once (fallback)
  let fundingRatesCandsBySym = null;
  try {
    fundingRatesCandsBySym = await lighterFetchFundingRatesCandidates_(
      debugEnabled ? (lighterDebug.funding_rates = {}) : null
    );
  } catch (e) {
    if (debugEnabled) lighterDebug.funding_rates_error = String(e?.message || e);
    fundingRatesCandsBySym = new Map();
  }

  const rows = [];

  for (const sym of TARGETS) {
    const marketId = perpIdBySym.get(sym);

    let finalRate8h = null;
    let finalRaw = null;
    let finalMark = null;
    let finalTs = null;
    let finalRawSym = null;

    let lighter_source = null;
    let lighter_candidate_count = null;
    let lighter_probe_used_url = null;
    let lighter_probe_tried = null;
    let lighter_probe_error = null;

    // Debug container per symbol
    const symDbg = debugEnabled ? (lighterDebug[sym] = {}) : null;

    // 1) Try hourly sum from /fundings (Option A requires exactly 8 points)
    if (marketId !== undefined && marketId !== null) {
      const dbgFundings = debugEnabled ? (symDbg.fundings = {}) : null;

      const res = await lighterTryFundingsSum8h_(marketId, dbgFundings);

      if (res.ok) {
        finalRate8h = toNum(res.rate8h);
        finalRaw = finalRate8h; // raw = 8h equivalent in our normalized output
        lighter_source = "fundings:sum_hourly";
        lighter_probe_used_url = res.usedUrl;
      } else {
        lighter_source = "fundings:failed_or_insufficient";
        lighter_probe_tried = res.triedCount ?? (res.tried ? res.tried.length : null);
        lighter_probe_error = res.lastErr
          ? `[lighter] fundings probe failed (marketId=${marketId}). lastErr=${res.lastErr}`
          : `[lighter] fundings probe failed (marketId=${marketId}).`;

        if (debugEnabled) {
          symDbg.fundings_probe = {
            ok: false,
            marketId,
            triedCount: res.triedCount,
            lastErr: res.lastErr,
            triedSample: res.tried,
          };
        }
      }
    } else {
      if (debugEnabled) symDbg.marketId_missing = true;
    }

    // 2) Fallback to funding-rates LAST candidate per symbol
    if (finalRate8h === null) {
      const cands = fundingRatesCandsBySym.get(sym) || [];
      lighter_candidate_count = cands.length;

      if (!cands.length) {
        // No data at all for this symbol
        if (debugEnabled) symDbg.fallback_no_candidates = true;
        continue;
      }

      const picked = cands[cands.length - 1]; // last-candidate rule (your confirmed best)
      finalRawSym = lighterGetSymbol_(picked) || null;
      finalMark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));
      finalTs = pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null;

      const rateRaw = lighterGetRateRaw_(picked);
      const interval = lighterGetIntervalS_(picked); // likely 28800 in our model
      finalRaw = rateRaw;
      finalRate8h = normalizeTo8h(rateRaw, interval); // if interval=28800, it's identity

      // If fundings already failed, keep that in source string but we still used fallback
      if (!lighter_source || lighter_source === "fundings:failed_or_insufficient") {
        lighter_source = "funding-rates:last-candidate";
      }

      if (debugEnabled) {
        symDbg.fallback = {
          pickedIndex: cands.length - 1,
          candidateCount: cands.length,
          marketIdPicked: lighterGetMarketId_(picked),
          rawSymbolPicked: finalRawSym,
          ratePicked: finalRaw,
        };
      }
    }

    // interval_s: we output as 28800 always for normalized 8h values
    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: finalRaw,
      funding_interval_s: 28800,
      funding_rate_next_interval: finalRate8h,
      funding_rate_8h: finalRate8h,
      mark_price: finalMark, // may be null, will be filled by fillMissingMarks()
      source_ts: finalTs,
      raw_symbol: finalRawSym,
      lighter_market_id: marketId ?? null,
      lighter_source,
      lighter_candidate_count,
      lighter_probe_used_url: lighter_probe_used_url ?? null,
      lighter_probe_tried: lighter_probe_tried ?? null,
      lighter_probe_error: lighter_probe_error ?? null,
    });
  }

  return { rows, lighterDebug };
}

/** ---------------- mark fallback fill ---------------- */
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
  try {
    const asOf = new Date().toISOString();
    const debugEnabled = wantDebug(req);

    const [v, b, l] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(debugEnabled),
    ]);

    const rows = [...v, ...b, ...l.rows];
    fillMissingMarks(rows);

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const payload = { asOf, rows };
    if (debugEnabled) payload.lighter_debug = l.lighterDebug;

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
//
// Variational: funding_rate is ANNUAL -> convert to 8h
// Binance: fundingRate endpoint already 8h
// Lighter:
//   Option A)
//     1) Try /fundings probing to SUM last 8 hourly points => funding_rate_8h
//        - ONLY accept if we got EXACTLY 8 points
//     2) Otherwise fallback to /funding-rates and pick LAST candidate (per symbol)
//   Also: strict symbol matching to avoid RESOLV->SOL, ETHFI->ETH mistakes.

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

function wantDebug(req) {
  const q = req?.query || {};
  return q.debug === "1" || q.debug === 1 || q.debug === true || q.debug === "true";
}

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

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

/**
 * ✅ STRICT symbol match:
 * - Extract first token by splitting non-alnum: "BTC-PERP" -> "BTC", "ETH_USD" -> "ETH"
 * - Allow safe suffix forms like BTCUSD/BTCUSDT/BTCUSDTPERP
 * - DO NOT use substring includes (prevents RESOLV->SOL, ETHFI->ETH)
 */
function matchTargetSymbolStrict(rawAny) {
  const raw = String(rawAny || "").toUpperCase().trim();
  if (!raw) return null;

  // First token by separators like -, _, /, space, :
  const token = raw.split(/[^A-Z0-9]+/)[0]; // e.g. "BTC-PERP" -> "BTC", "RESOLV" -> "RESOLV"
  if (!token) return null;

  if (TARGETS.includes(token)) return token;

  // Allow known suffixes stuck to the token (no separators)
  // e.g. BTCUSD, BTCUSDT, BTCUSDTPERP, ETHUSD, etc.
  for (const t of TARGETS) {
    if (!token.startsWith(t)) continue;
    const suffix = token.slice(t.length);
    if (
      suffix === "USD" ||
      suffix === "USDT" ||
      suffix === "PERP" ||
      suffix === "USDTPERP" ||
      suffix === "USDPERP"
    ) {
      return t;
    }
  }

  return null;
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

/** ---------------- Binance (8h) ---------------- */
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

/** ---------------- Lighter helpers ---------------- */
function lighterGetRawSymbol_(it) {
  const raw = pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name", "baseSymbol"]);
  return String(raw || "").toUpperCase().trim();
}

function lighterGetMarketId_(it) {
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

/**
 * Build a map from symbol->marketId using orderBookDetails?type=perp (best effort)
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
      const rawSym = lighterGetRawSymbol_(it);
      const sym = matchTargetSymbolStrict(rawSym);
      if (!sym) continue;

      const id = lighterGetMarketId_(it);
      if (id === null) continue;

      if (!perpIdBySym.has(sym)) perpIdBySym.set(sym, id);
    }
  } catch (e) {
    if (debug) debug.orderBookDetails_error = String(e?.message || e);
  }

  if (debug) {
    debug.perpMarketIdMap = Object.fromEntries(Array.from(perpIdBySym.entries()));
  }

  return perpIdBySym;
}

/**
 * Probe /fundings endpoint with multiple param name variants.
 * Option A: accept ONLY if EXACTLY 8 points are returned (then SUM as 8h funding).
 */
async function lighterTryFundingsSum8h_(marketId, debugOut) {
  const base = `${LIGHTER_BASE}/api/v1/fundings`;

  const midKeys = ["marketId", "market_id", "market", "market_index", "marketIndex"];
  const countKeys = ["count_back", "countBack", "count", "limit"];
  const resKeys = ["resolution", "resolution_s", "res", "timeframe", "interval"];
  const resVals = ["3600", "1h", "H1"];

  const candidates = [];
  for (const mk of midKeys) {
    for (const ck of countKeys) {
      candidates.push(`${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8`);
      for (const rk of resKeys) {
        for (const rv of resVals) {
          candidates.push(
            `${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8&${rk}=${encodeURIComponent(rv)}`
          );
        }
      }
    }
  }

  const uniq = Array.from(new Set(candidates));
  const tried = [];
  let lastErr = null;

  for (const url of uniq) {
    tried.push(url);
    try {
      const data = await fetchJson(url, 8000);

      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        Array.isArray(data?.result) ? data.result :
        [];

      const rates = [];
      for (const it of items) {
        const r = lighterGetRateRaw_(it);
        if (r !== null) rates.push(r);
      }

      const last8 = rates.slice(-8);

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
          triedCount: tried.length,
        };
      } else {
        if (debugOut) {
          debugOut.fundings_insufficient = {
            url,
            got: last8.length,
            last8,
          };
        }
      }
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  return {
    ok: false,
    triedCount: tried.length,
    triedSample: tried.slice(0, 30),
    lastErr,
  };
}

/**
 * Fetch /funding-rates and group candidates by STRICT symbol match.
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
    const rawSym = lighterGetRawSymbol_(it);
    const sym = matchTargetSymbolStrict(rawSym);
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

/** ---------------- Lighter main ---------------- */
async function getLighter(debugEnabled) {
  const lighterDebug = debugEnabled ? {} : null;

  const perpIdBySym = await lighterBuildPerpMarketIdMap_(
    debugEnabled ? (lighterDebug.orderBookDetails = {}) : null
  );

  let fundingRatesCandsBySym;
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
    const symDbg = debugEnabled ? (lighterDebug[sym] = {}) : null;

    const cands = fundingRatesCandsBySym.get(sym) || [];
    const lastCand = cands.length ? cands[cands.length - 1] : null;

    // ✅ marketId resolution:
    // 1) from orderBookDetails map
    // 2) else from funding-rates candidates (last candidate's marketId)
    let marketId = perpIdBySym.get(sym);
    if ((marketId === undefined || marketId === null) && lastCand) {
      const mid = lighterGetMarketId_(lastCand);
      if (mid !== null) marketId = mid;
    }

    if (debugEnabled) {
      symDbg.marketId = marketId ?? null;
      symDbg.candidateCount = cands.length;
      symDbg.candidatesPreview = cands.slice(0, 10).map((it, i) => ({
        i,
        rawSymbol: lighterGetRawSymbol_(it),
        marketId: lighterGetMarketId_(it),
        rate: lighterGetRateRaw_(it),
      }));
    }

    let finalRate8h = null;
    let finalRaw = null;
    let finalMark = null;
    let finalTs = null;
    let finalRawSym = null;

    let lighter_source = null;
    let lighter_candidate_count = cands.length;
    let lighter_probe_used_url = null;
    let lighter_probe_tried = null;
    let lighter_probe_error = null;

    // 1) Option A: try fundings sum(8x 1h) ONLY if we have marketId
    if (marketId !== undefined && marketId !== null) {
      const dbgFundings = debugEnabled ? (symDbg.fundings = {}) : null;
      const res = await lighterTryFundingsSum8h_(marketId, dbgFundings);

      if (res.ok) {
        finalRate8h = toNum(res.rate8h);
        finalRaw = finalRate8h; // 8h equivalent
        lighter_source = "fundings:sum_hourly";
        lighter_probe_used_url = res.usedUrl;
        lighter_probe_tried = res.triedCount;

        // mark/ts not always included from /fundings, keep null and fillMissingMarks()
      } else {
        lighter_source = "fundings:failed_or_insufficient";
        lighter_probe_tried = res.triedCount;
        lighter_probe_error = res.lastErr || null;
      }
    } else {
      if (debugEnabled) symDbg.fundings = { skipped: true, reason: "marketId missing" };
    }

    // 2) fallback: funding-rates last candidate (STRICT matched already)
    if (finalRate8h === null) {
      if (!lastCand) continue;

      finalRawSym = lighterGetRawSymbol_(lastCand) || null;
      finalMark = toNum(pickField(lastCand, ["mark_price", "markPrice", "mark"]));
      finalTs = pickField(lastCand, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null;

      const rateRaw = lighterGetRateRaw_(lastCand);
      // funding-rates is treated as already 8h equivalent in practice
      finalRaw = rateRaw;
      finalRate8h = rateRaw;

      lighter_source = "funding-rates:last-candidate";
      // keep probe diagnostics if it failed earlier (helpful for debugging)
    }

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: finalRaw,
      funding_interval_s: 28800,
      funding_rate_next_interval: finalRate8h,
      funding_rate_8h: finalRate8h,
      mark_price: finalMark,
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
    const debugEnabled = wantDebug(req);

    const [v, b, l] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(debugEnabled),
    ]);

    const rows = [...v, ...b, ...l.rows];
    fillMissingMarks(rows);

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const payload = { asOf, rows };
    if (debugEnabled) payload.lighter_debug = l.lighterDebug;

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

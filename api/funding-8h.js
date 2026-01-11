// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
//
// Variational: funding_rate is ANNUAL -> convert to 8h
// Binance: fundingRate endpoint already 8h
// Lighter: (Option A)
//   - Try /fundings probing to SUM last 8 hourly points (ONLY if exactly 8 points)
//   - Else fallback to /funding-rates and pick LAST candidate (STRICT symbol match)
//   - If Lighter API hits 429 => retry/backoff, then fallback to LAST GOOD CACHE

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

// ---- module-scope cache (best-effort; survives warm invocations) ----
const LIGHTER_LAST_GOOD = {
  ts: 0,
  rows: null,
};

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch JSON with retry/backoff.
 * - Retries on 429/5xx and network timeouts
 * - Honors Retry-After header if present
 */
async function fetchJsonRetry(url, opts = {}) {
  const {
    timeoutMs = 8000,
    retries = 3,
    backoffMs = 400,
    jitterMs = 120,
    tag = "fetch",
  } = opts;

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "fundingrate-auto/1.0 (+vercel)",
          "Accept": "application/json",
        },
      });

      // success
      if (resp.ok) return await resp.json();

      // retryable?
      const status = resp.status;
      const retryable = status === 429 || (status >= 500 && status <= 599);

      if (!retryable) {
        throw new Error(`HTTP ${status} ${url}`);
      }

      // retry-after
      let waitMs = backoffMs * Math.pow(2, attempt);
      const ra = resp.headers?.get?.("retry-after");
      if (ra) {
        const raNum = Number(ra);
        if (Number.isFinite(raNum) && raNum > 0) {
          waitMs = Math.max(waitMs, raNum * 1000);
        }
      }
      waitMs += Math.floor(Math.random() * jitterMs);

      lastErr = new Error(`HTTP ${status} ${url}`);
      if (attempt < retries) {
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    } catch (e) {
      lastErr = e;
      const isAbort = String(e?.name || "").toLowerCase().includes("abort");
      const msg = String(e?.message || e);
      const retryable = isAbort || msg.includes("HTTP 429") || msg.includes("HTTP 5");

      if (attempt < retries && retryable) {
        const waitMs = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * jitterMs);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`[${tag}] ${msg}`);
    } finally {
      clearTimeout(t);
    }
  }

  // should never reach
  throw lastErr || new Error(`[${tag}] unknown error`);
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/**
 * STRICT symbol match:
 * - Split token by non-alnum: "BTC-PERP" -> "BTC"
 * - Allow safe suffix forms like BTCUSD/BTCUSDT/BTCUSDTPERP
 * - Never substring-includes (prevents RESOLV->SOL, ETHFI->ETH)
 */
function matchTargetSymbolStrict(rawAny) {
  const raw = String(rawAny || "").toUpperCase().trim();
  if (!raw) return null;

  const token = raw.split(/[^A-Z0-9]+/)[0];
  if (!token) return null;

  if (TARGETS.includes(token)) return token;

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
  const stats = await fetchJsonRetry(`${VARIATIONAL_BASE}/metadata/stats`, {
    tag: "variational",
    retries: 1,
  });
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
      funding_rate_raw: rateAnnual,
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

    const fundingArr = await fetchJsonRetry(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${fSym}&limit=1`,
      { tag: `binance_funding_${sym}`, retries: 1 }
    );
    const last =
      Array.isArray(fundingArr) && fundingArr.length
        ? fundingArr[fundingArr.length - 1]
        : null;

    const fundingRate8h = toNum(last?.fundingRate);
    const fundingTimeIso = last?.fundingTime
      ? new Date(Number(last.fundingTime)).toISOString()
      : null;

    const prem = await fetchJsonRetry(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`,
      { tag: `binance_mark_${sym}`, retries: 1 }
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
  const keys = [
    "rate",
    "funding_rate",
    "fundingRate",
    "hourly_funding_rate",
    "hourlyFundingRate",
    "funding",
  ];
  for (const k of keys) {
    if (it && it[k] !== undefined && it[k] !== null) {
      const r = toNum(it[k]);
      if (r !== null) return r;
    }
  }
  return null;
}

/**
 * Best-effort marketId map from orderBookDetails.
 * If rate-limited, we just keep it empty and recover marketId from funding-rates later.
 */
async function lighterBuildPerpMarketIdMap_(debug) {
  const map = new Map();
  try {
    const ob = await fetchJsonRetry(`${LIGHTER_BASE}/api/v1/orderBookDetails?type=perp`, {
      tag: "lighter_orderBookDetails",
      retries: 2,
      backoffMs: 500,
    });

    const items =
      Array.isArray(ob) ? ob :
      Array.isArray(ob?.data) ? ob.data :
      Array.isArray(ob?.order_books) ? ob.order_books :
      Array.isArray(ob?.orderBooks) ? ob.orderBooks :
      [];

    for (const it of items) {
      const sym = matchTargetSymbolStrict(lighterGetRawSymbol_(it));
      if (!sym) continue;

      const id = lighterGetMarketId_(it);
      if (id === null) continue;

      if (!map.has(sym)) map.set(sym, id);
    }
  } catch (e) {
    if (debug) debug.orderBookDetails_error = String(e?.message || e);
  }

  if (debug) debug.perpMarketIdMap = Object.fromEntries(Array.from(map.entries()));
  return map;
}

/**
 * Probe /fundings with multiple param variants.
 * Option A: Accept ONLY if we got EXACTLY 8 points, then SUM them as 8h funding.
 */
async function lighterTryFundingsSum8h_(marketId, debugOut) {
  const base = `${LIGHTER_BASE}/api/v1/fundings`;

  const midKeys = ["marketId", "market_id", "market", "market_index", "marketIndex"];
  const countKeys = ["count_back", "countBack", "count", "limit"];
  const resKeys = ["resolution", "resolution_s", "res", "timeframe", "interval"];
  const resVals = ["3600", "1h", "H1"];

  const urls = [];
  for (const mk of midKeys) {
    for (const ck of countKeys) {
      urls.push(`${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8`);
      for (const rk of resKeys) {
        for (const rv of resVals) {
          urls.push(`${base}?${mk}=${encodeURIComponent(marketId)}&${ck}=8&${rk}=${encodeURIComponent(rv)}`);
        }
      }
    }
  }

  const uniq = Array.from(new Set(urls));
  let lastErr = null;

  for (const url of uniq) {
    try {
      const data = await fetchJsonRetry(url, {
        tag: "lighter_fundings_probe",
        retries: 2,
        backoffMs: 500,
      });

      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        [];

      const rates = [];
      for (const it of items) {
        const r = lighterGetRateRaw_(it);
        if (r !== null) rates.push(r);
      }

      const last8 = rates.slice(-8);
      if (last8.length === 8) {
        if (debugOut) {
          debugOut.used_url = url;
          debugOut.points = last8;
        }
        return { ok: true, usedUrl: url, sum8h: last8.reduce((a, b) => a + b, 0), pointCount: 8 };
      }

      if (debugOut) {
        debugOut.last_insufficient = { url, got: last8.length, last8 };
      }
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  return { ok: false, lastErr };
}

async function lighterFetchFundingRatesCandidates_(debugOut) {
  const data = await fetchJsonRetry(`${LIGHTER_BASE}/api/v1/funding-rates`, {
    tag: "lighter_funding_rates",
    retries: 2,
    backoffMs: 600,
  });

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  const candsBySym = new Map();
  for (const it of items) {
    const sym = matchTargetSymbolStrict(lighterGetRawSymbol_(it));
    if (!sym) continue;
    if (!candsBySym.has(sym)) candsBySym.set(sym, []);
    candsBySym.get(sym).push(it);
  }

  if (debugOut) {
    debugOut.counts = {};
    for (const sym of TARGETS) {
      debugOut.counts[sym] = (candsBySym.get(sym) || []).length;
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

  let candsBySym = new Map();
  try {
    candsBySym = await lighterFetchFundingRatesCandidates_(
      debugEnabled ? (lighterDebug.funding_rates = {}) : null
    );
  } catch (e) {
    if (debugEnabled) lighterDebug.funding_rates_error = String(e?.message || e);
    // If 429 (or any error), try cache
    if (LIGHTER_LAST_GOOD.rows && Date.now() - LIGHTER_LAST_GOOD.ts < 30 * 60 * 1000) {
      const cached = LIGHTER_LAST_GOOD.rows.map((r) => ({
        ...r,
        lighter_source: "cache:stale_due_to_429",
      }));
      return { rows: cached, lighterDebug };
    }
    return { rows: [], lighterDebug };
  }

  const rows = [];

  for (const sym of TARGETS) {
    const symDbg = debugEnabled ? (lighterDebug[sym] = {}) : null;

    const cands = candsBySym.get(sym) || [];
    const lastCand = cands.length ? cands[cands.length - 1] : null;

    // marketId resolution:
    // 1) from orderBookDetails map
    // 2) else from lastCand's marketId
    let marketId = perpIdBySym.get(sym);
    if ((marketId === undefined || marketId === null) && lastCand) {
      const mid = lighterGetMarketId_(lastCand);
      if (mid !== null) marketId = mid;
    }

    if (debugEnabled) {
      symDbg.marketId = marketId ?? null;
      symDbg.candidateCount = cands.length;
      symDbg.lastCandidate = lastCand
        ? { rawSymbol: lighterGetRawSymbol_(lastCand), marketId: lighterGetMarketId_(lastCand), rate: lighterGetRateRaw_(lastCand) }
        : null;
    }

    let final8h = null;
    let source = null;
    let probeUsed = null;
    let probeErr = null;

    // Option A: fundings sum(8 points) if marketId exists
    if (marketId !== undefined && marketId !== null) {
      const dbgFundings = debugEnabled ? (symDbg.fundings = {}) : null;
      const r = await lighterTryFundingsSum8h_(marketId, dbgFundings);
      if (r.ok) {
        final8h = toNum(r.sum8h);
        source = "fundings:sum_hourly";
        probeUsed = r.usedUrl;
      } else {
        probeErr = r.lastErr || null;
      }
    }

    // fallback: funding-rates last candidate
    if (final8h === null) {
      if (!lastCand) continue;
      final8h = lighterGetRateRaw_(lastCand);
      source = "funding-rates:last-candidate";
    }

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: final8h,
      funding_interval_s: 28800,
      funding_rate_next_interval: final8h,
      funding_rate_8h: final8h,
      mark_price: null, // fillMissingMarks will patch from binance/variational
      source_ts: null,
      raw_symbol: lastCand ? lighterGetRawSymbol_(lastCand) : null,
      lighter_market_id: marketId ?? null,
      lighter_source: source,
      lighter_candidate_count: cands.length,
      lighter_probe_used_url: probeUsed,
      lighter_probe_error: probeErr,
    });
  }

  // update cache on success
  if (rows.length) {
    LIGHTER_LAST_GOOD.ts = Date.now();
    LIGHTER_LAST_GOOD.rows = rows.map((r) => ({ ...r }));
  }

  return { rows, lighterDebug };
}

/** ---------------- mark fallback fill ---------------- */
function fillMissingMarks(rows) {
  const markBySymbol = new Map();

  for (const r of rows) {
    if (r.exchange === "binance" && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  }
  for (const r of rows) {
    if (!markBySymbol.has(r.symbol) && r.exchange === "variational" && r.mark_price != null) {
      markBySymbol.set(r.symbol, r.mark_price);
    }
  }
  for (const r of rows) {
    if (r.mark_price == null && markBySymbol.has(r.symbol)) r.mark_price = markBySymbol.get(r.symbol);
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

    // 캐시를 약간 늘리면(예: 30초) 수동 연타 시 429를 더 줄일 수 있음
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const payload = { asOf, rows };
    if (debugEnabled) payload.lighter_debug = l.lighterDebug;

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

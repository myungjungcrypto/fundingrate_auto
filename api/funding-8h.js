// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
// Lighter: auto-probe fundings endpoint (multiple param variants) -> sum hourly (count_back=8) if possible, fallback to funding-rates last-candidate.

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
 * Variational funding_rate is ANNUAL (e.g. 0.1095 = 10.95% annual)
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
 * Try many URLs safely, keep report for debugging.
 * Returns { data, usedUrl, triedCount, errorSummary }
 */
async function fetchJsonProbe_(urls, timeoutMs = 8000, maxTries = 14) {
  const errs = [];
  let tried = 0;

  for (const url of urls) {
    tried++;
    if (tried > maxTries) break;

    try {
      const data = await fetchJson(url, timeoutMs);
      return {
        data,
        usedUrl: url,
        triedCount: tried,
        errorSummary: errs.length ? errs.slice(0, 4).join(" | ") : null,
      };
    } catch (e) {
      const msg = String(e?.message ?? e);
      // keep compact
      errs.push(msg.replace(/\s+/g, " ").slice(0, 180));
    }
  }

  return {
    data: null,
    usedUrl: null,
    triedCount: tried,
    errorSummary: errs.length ? errs.slice(0, 6).join(" | ") : "unknown error",
  };
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
      funding_interval_s: 28800,          // normalized output to 8h
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

/** ---------------- Lighter ---------------- */

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
  const v = pickField(item, [
    "timestamp",
    "ts",
    "time",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "block_time",
    "blockTime",
  ]);
  const n = toNum(v);
  if (n === null) return null;

  // Heuristic: if seconds-like, convert to ms
  if (n < 10_000_000_000) return n * 1000;
  return n;
}

function lighterStrictSymbol_(item) {
  const raw = String(
    pickField(item, ["symbol", "ticker", "market", "marketSymbol", "name", "base_asset", "baseAsset", "underlying"]) || ""
  )
    .toUpperCase()
    .trim();

  return TARGETS.includes(raw) ? raw : null;
}

function inferIntervalSFromTimestamps_(tsListMs) {
  const ts = tsListMs.filter((x) => x != null).slice().sort((a, b) => a - b);
  if (ts.length < 2) return null;

  const diffs = [];
  for (let i = 1; i < ts.length; i++) diffs.push((ts[i] - ts[i - 1]) / 1000);
  diffs.sort((a, b) => a - b);
  const mid = diffs[Math.floor(diffs.length / 2)];
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

function compute8hFromFundings_(fundings) {
  if (!Array.isArray(fundings) || !fundings.length) return null;

  const pts = fundings
    .map((x) => ({
      ts: lighterGetTimestampMs_(x),
      r: lighterGetRateRaw_(x),
    }))
    .filter((p) => p.r !== null);

  if (!pts.length) return null;

  const inferredIntervalS = inferIntervalSFromTimestamps_(pts.map((p) => p.ts));

  // ✅ If looks like hourly (~1h), sum all returned (ideally 8)
  if (inferredIntervalS && inferredIntervalS > 2500 && inferredIntervalS < 5000) {
    const sum = pts.reduce((acc, p) => acc + p.r, 0);
    return { rate8h: sum, method: "sum_hourly", inferredIntervalS };
  }

  // If looks like 8h (~28800s), last value
  if (inferredIntervalS && inferredIntervalS > 20000 && inferredIntervalS < 40000) {
    return { rate8h: pts[pts.length - 1].r, method: "last_8h", inferredIntervalS };
  }

  // Unknown: prefer last (safer)
  return { rate8h: pts[pts.length - 1].r, method: "last_value", inferredIntervalS };
}

/**
 * Build many fundings URL variants to "auto-discover" correct params.
 * We keep it bounded (maxTries in fetchJsonProbe_) to avoid timeouts.
 */
function buildLighterFundingsProbeUrls_(marketId) {
  const base = `${LIGHTER_BASE}/api/v1/fundings`;

  const marketKeys = ["market_id", "marketId", "market", "marketID", "marketid"];
  const countKeys = [
    ["count_back", 8],
    ["countBack", 8],
    ["count", 8],
    ["limit", 8],
  ];

  // resolution/timeframe variants (some APIs use these, some reject them => that's fine)
  const resKeys = [
    null,
    ["resolution", 3600],
    ["resolution", "3600"],
    ["resolution", "1h"],
    ["timeframe", "1h"],
    ["interval", "1h"],
  ];

  const urls = [];
  for (const mk of marketKeys) {
    for (const [ck, cv] of countKeys) {
      for (const rk of resKeys) {
        const params = new URLSearchParams();
        params.set(mk, String(marketId));
        params.set(ck, String(cv));
        if (rk) params.set(rk[0], String(rk[1]));
        urls.push(`${base}?${params.toString()}`);
      }
    }
  }

  // De-dup
  return Array.from(new Set(urls));
}

/**
 * Parse fundings response into array robustly.
 */
function normalizeFundingsItems_(data) {
  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.fundings) ? data.fundings :
    Array.isArray(data?.items) ? data.items :
    Array.isArray(data?.result) ? data.result :
    [];
  return items;
}

/**
 * Fallback funding-rates: pick LAST candidate for strict symbol match.
 */
async function lighterFallbackFundingRates_(sym) {
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
  if (!cands.length) return null;

  const picked = cands[cands.length - 1];
  const rateRaw = lighterGetRateRaw_(picked);

  return {
    rate8h: rateRaw,
    candidateCount: cands.length,
    pickedTs: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
  };
}

async function getLighter() {
  const rows = [];

  for (const sym of TARGETS) {
    const marketId = LIGHTER_MARKET_ID[sym];
    if (marketId === undefined || marketId === null) continue;

    // 1) PROBE fundings with many param variants
    let usedUrl = null;
    let triedCount = 0;
    let errorSummary = null;
    let fundings = null;

    const probeUrls = buildLighterFundingsProbeUrls_(marketId);
    const probe = await fetchJsonProbe_(probeUrls, 9000, 14);

    usedUrl = probe.usedUrl;
    triedCount = probe.triedCount;
    errorSummary = probe.errorSummary;

    if (probe.data) {
      const items = normalizeFundingsItems_(probe.data);
      if (items && items.length) {
        fundings = items;
      }
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
          mark_price: null, // filled later
          source_ts: null,
          raw_symbol: sym,
          lighter_market_id: marketId,
          lighter_source: `fundings:${computed.method}`,
          lighter_candidate_count: fundings.length,
          lighter_inferred_interval_s: computed.inferredIntervalS ?? null,
          lighter_probe_used_url: usedUrl,
          lighter_probe_tried: triedCount,
          lighter_probe_error: errorSummary,
        });
        continue;
      }
    }

    // 2) fallback funding-rates:last-candidate
    try {
      const fb = await lighterFallbackFundingRates_(sym);
      if (!fb) continue;

      rows.push({
        exchange: "lighter",
        symbol: sym,
        funding_rate_raw: fb.rate8h,
        funding_interval_s: 28800,
        funding_rate_next_interval: fb.rate8h,
        funding_rate_8h: fb.rate8h,
        mark_price: null, // filled later
        source_ts: fb.pickedTs,
        raw_symbol: sym,
        lighter_market_id: marketId,
        lighter_source: "funding-rates:last-candidate",
        lighter_candidate_count: fb.candidateCount,
        lighter_probe_used_url: usedUrl,
        lighter_probe_tried: triedCount,
        lighter_probe_error: errorSummary,
      });
    } catch (e) {
      // swallow
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

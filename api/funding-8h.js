// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter, Hyperliquid (+ optional plugins)
// and normalizes everything to 8h.
// Response shape (Apps Script friendly):
//   { asOf: ISOString, rows: [...] }
// Optional: add ?debug=1 to include { errors: [...] } in response.

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

// Hyperliquid info endpoint
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

// --- helpers ---
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

function normalizeTo8h(rate, intervalS) {
  const r = toNum(rate);
  const s = toNum(intervalS);
  if (r === null) return null;
  if (!s || s <= 0) return r; // fallback: assume already 8h-like
  return r * (28800 / s);
}

async function fetchJson(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url} :: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithRetry(url, timeoutMs, options, tries = 3, baseDelayMs = 250) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url, timeoutMs, options);
    } catch (e) {
      lastErr = e;
      // simple backoff
      const wait = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** ---------------- Variational ---------------- */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`, 12000);
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
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------------- Binance ---------------- */
async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

    const prem = await fetchJson(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`,
      9000
    );

    const mark = toNum(prem?.markPrice);
    const nextFundingRate8h = toNum(prem?.lastFundingRate);
    const nextFundingTimeIso = prem?.nextFundingTime
      ? new Date(Number(prem.nextFundingTime)).toISOString()
      : null;

    rows.push({
      exchange: "binance",
      symbol: sym,
      funding_rate_raw: nextFundingRate8h,
      funding_interval_s: 28800,
      funding_rate_next_interval: nextFundingRate8h,
      funding_rate_8h: nextFundingRate8h,
      mark_price: mark,
      source_ts: nextFundingTimeIso,
      binance_source: "premiumIndex:lastFundingRate",
    });
  }

  return rows;
}

/** ---------------- Lighter ---------------- */
async function getLighter() {
  let data;
  try {
    data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`, 12000);
  } catch (e) {
    console.log("[lighter] funding-rates failed:", String(e?.message || e));
    return [];
  }

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  const candsBySym = new Map();
  for (const it of items) {
    const raw = String(
      pickField(it, ["raw_symbol", "rawSymbol", "symbol", "market", "ticker"]) || ""
    ).toUpperCase();

    if (!TARGETS.includes(raw)) continue;

    if (!candsBySym.has(raw)) candsBySym.set(raw, []);
    candsBySym.get(raw).push(it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    const picked = cands[cands.length - 1];

    const rateRaw = toNum(
      pickField(picked, ["funding_rate", "fundingRate", "rate", "funding_rate_raw"])
    );

    const interval = toNum(
      pickField(picked, ["funding_interval_s", "fundingIntervalS", "interval_s", "intervalS"])
    ) ?? 28800;

    const mark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));
    const marketId = toNum(pickField(picked, ["market_id", "marketId", "market_index", "marketIndex"]));

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: 28800, // output always 8h
      funding_rate_next_interval: normalizeTo8h(rateRaw, interval),
      funding_rate_8h: normalizeTo8h(rateRaw, interval),
      mark_price: mark,
      source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: sym,
      lighter_market_id: marketId,
      lighter_source: "funding-rates:last-candidate",
      lighter_candidate_count: cands.length,
    });
  }

  return rows;
}

/** ---------------- Hyperliquid ----------------
 * POST /info { type: "metaAndAssetCtxs" }
 * IMPORTANT: assetCtxs is index-aligned with universe (often ctx objects have no coin/name)
 * funding is typically per 1h -> normalize to 8h
 */
async function getHyperliquid() {
  let j;
  try {
    j = await fetchJsonWithRetry(
      HYPERLIQUID_INFO,
      15000,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          // Helps with occasional WAF/bot filtering in serverless environments
          "user-agent": "Mozilla/5.0 (Vercel Serverless; funding-collector)",
        },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      },
      3,
      300
    );
  } catch (e) {
    console.log("[hyperliquid] metaAndAssetCtxs failed:", String(e?.message || e));
    return [];
  }

  // Extract universe + assetCtxs robustly
  let universe = null;
  let assetCtxs = null;

  // A) [ {universe:[...]}, [ ...ctxs ] ]
  if (Array.isArray(j) && j.length >= 2) {
    if (Array.isArray(j?.[0]?.universe)) universe = j[0].universe;
    if (Array.isArray(j?.[1])) assetCtxs = j[1];
  }

  // B) { universe:[...], assetCtxs:[...] }
  if (!universe && Array.isArray(j?.universe)) universe = j.universe;
  if (!assetCtxs && Array.isArray(j?.assetCtxs)) assetCtxs = j.assetCtxs;

  // C) { result:{universe:[...], assetCtxs:[...]} } / { data:{...} }
  if (!universe && Array.isArray(j?.result?.universe)) universe = j.result.universe;
  if (!assetCtxs && Array.isArray(j?.result?.assetCtxs)) assetCtxs = j.result.assetCtxs;
  if (!universe && Array.isArray(j?.data?.universe)) universe = j.data.universe;
  if (!assetCtxs && Array.isArray(j?.data?.assetCtxs)) assetCtxs = j.data.assetCtxs;

  if (!Array.isArray(universe) || !Array.isArray(assetCtxs) || universe.length === 0 || assetCtxs.length === 0) {
    console.log("[hyperliquid] unexpected shape:", JSON.stringify(j).slice(0, 400));
    return [];
  }

  // Build name -> ctx using universe index alignment
  const byName = new Map();
  const n = Math.min(universe.length, assetCtxs.length);
  for (let i = 0; i < n; i++) {
    const name = String(universe[i]?.name || universe[i]?.coin || "").toUpperCase();
    if (!name) continue;
    byName.set(name, assetCtxs[i]);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const ctx = byName.get(sym);
    if (!ctx) continue;

    const rate1h =
      toNum(ctx?.funding) ??
      toNum(ctx?.fundingRate) ??
      toNum(ctx?.funding_rate) ??
      0;

    const mark =
      toNum(ctx?.markPx) ??
      toNum(ctx?.mark_price) ??
      toNum(ctx?.mark) ??
      null;

    const rate8h = normalizeTo8h(rate1h, 3600);

    rows.push({
      exchange: "hyperliquid",
      symbol: sym,
      funding_rate_raw: rate1h,       // 1h raw
      funding_interval_s: 28800,      // output always 8h
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: null,
      hyperliquid_source: "info:metaAndAssetCtxs (index-aligned universe)",
    });
  }

  return rows;
}

/** ---------------- Plugin exchanges (01xyz / nado 등) ----------------
 * ENV:
 *   - O1_FUNDING_URL
 *   - NADO_FUNDING_URL
 *
 * Accepted JSON shapes:
 *   A) { rows: [{symbol, funding_rate_1h, mark_price, interval_s?}, ...] }
 *   B) [{symbol, funding_rate_1h, mark_price, interval_s?}, ...]
 */
async function getPluginExchange(exchangeName, envKey) {
  const url = process.env?.[envKey];
  if (!url) return [];

  let j;
  try {
    j = await fetchJson(url, 12000);
  } catch (e) {
    console.log(`[${exchangeName}] plugin fetch failed:`, String(e?.message || e));
    return [];
  }

  const items = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : [];
  if (!Array.isArray(items) || items.length === 0) return [];

  const bySym = new Map();
  for (const it of items) {
    const sym = String(it?.symbol || "").toUpperCase();
    if (!TARGETS.includes(sym)) continue;
    bySym.set(sym, it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const it = bySym.get(sym);
    if (!it) continue;

    const interval = toNum(pickField(it, ["interval_s", "intervalS"])) ?? 3600;

    const rateRaw =
      toNum(pickField(it, ["funding_rate_1h", "fundingRate1h", "funding_rate", "fundingRate"])) ?? 0;

    const mark =
      toNum(pickField(it, ["mark_price", "markPrice", "mark"])) ?? null;

    const rate8h = normalizeTo8h(rateRaw, interval);

    rows.push({
      exchange: exchangeName,
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: null,
      plugin_source: envKey,
    });
  }

  return rows;
}

function fillMissingMarks(rows) {
  // Prefer binance marks as fallback, then variational, then hyperliquid, then anything
  const markBySymbol = new Map();

  for (const r of rows) {
    if (r.exchange === "binance" && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  }
  for (const r of rows) {
    if (!markBySymbol.has(r.symbol) && r.exchange === "variational" && r.mark_price != null)
      markBySymbol.set(r.symbol, r.mark_price);
  }
  for (const r of rows) {
    if (!markBySymbol.has(r.symbol) && r.exchange === "hyperliquid" && r.mark_price != null)
      markBySymbol.set(r.symbol, r.mark_price);
  }
  for (const r of rows) {
    if (!markBySymbol.has(r.symbol) && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  }

  for (const r of rows) {
    if (r.mark_price == null && markBySymbol.has(r.symbol)) {
      r.mark_price = markBySymbol.get(r.symbol);
    }
  }
}

export default async function handler(req, res) {
  // CORS / preflight (Apps Script & browser safe)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const debug = String(req?.query?.debug || "") === "1";
  const errors = [];

  try {
    const asOf = new Date().toISOString();

    // IMPORTANT: allSettled so one exchange failing doesn't kill the whole response
    const tasks = [
      ["variational", () => getVariational()],
      ["binance", () => getBinance()],
      ["lighter", () => getLighter()],
      ["hyperliquid", () => getHyperliquid()],
      ["01xyz", () => getPluginExchange("01xyz", "O1_FUNDING_URL")],
      ["nado", () => getPluginExchange("nado", "NADO_FUNDING_URL")],
    ];

    const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));

    let rows = [];
    for (let i = 0; i < settled.length; i++) {
      const name = tasks[i][0];
      const s = settled[i];
      if (s.status === "fulfilled") {
        if (Array.isArray(s.value)) rows = rows.concat(s.value);
      } else {
        errors.push({ exchange: name, error: String(s.reason?.message || s.reason) });
      }
    }

    fillMissingMarks(rows);

    // Sort
    const exOrder = {
      variational: 0,
      binance: 1,
      lighter: 2,
      hyperliquid: 3,
      "01xyz": 4,
      nado: 5,
    };

    rows.sort((a, b) => {
      const ea = exOrder[String(a.exchange || "").toLowerCase()] ?? 99;
      const eb = exOrder[String(b.exchange || "").toLowerCase()] ?? 99;
      if (ea !== eb) return ea - eb;
      return TARGETS.indexOf(String(a.symbol || "").toUpperCase()) -
        TARGETS.indexOf(String(b.symbol || "").toUpperCase());
    });

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");

    if (debug) {
      res.status(200).json({ asOf, rows, errors });
    } else {
      res.status(200).json({ asOf, rows });
    }
  } catch (e) {
    res.status(500).json({
      error: String(e?.message ?? e),
      asOf: new Date().toISOString(),
      rows: [],
      ...(debug ? { errors } : {}),
    });
  }
}

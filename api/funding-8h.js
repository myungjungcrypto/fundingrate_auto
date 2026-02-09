// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter, Hyperliquid, 01.xyz, Nado
// and normalizes everything to 8h for Apps Script (funding.gs) compatibility.

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

// Hyperliquid
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

// 01.xyz (docs: /info, /market/{id}/stats)
const O1_BASE = "https://zo-mainnet.n1.xyz";

// Nado (docs: gateway + archive(indexer))
const NADO_GATEWAY_REST = "https://gateway.sonic.nado.xyz/api/v1";
const NADO_INDEXER = "https://indexer.archive.sonic.nado.xyz/api/v1/query";

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

function x18ToFloat(x18) {
  // x18 can be string/number
  const n = typeof x18 === "string" ? Number(x18) : Number(x18);
  if (!Number.isFinite(n)) return null;
  return n / 1e18;
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

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), funding_interval_s, mark_price, quotes.updated_at
 */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`, 10000);
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
      funding_interval_s: 28800,          // output always 8h
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------------- Binance (NEXT / forward-looking 8h) ----------------
 * premiumIndex: { markPrice, lastFundingRate, nextFundingTime, ... }
 */
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

/** ---------------- Lighter ----------------
 * - funding-rates 1 call
 * - strict symbol match on raw_symbol
 * - pick LAST candidate for each symbol
 */
async function getLighter() {
  let data;
  try {
    data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`, 10000);
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
      funding_rate_next_interval: rateRaw,
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
 * Usually: response = [meta, assetCtxs]
 * ctx: { coin, funding, markPx, ... }
 * funding is commonly per 1h -> normalize to 8h
 */
async function getHyperliquid() {
  let j;
  try {
    j = await fetchJson(
      HYPERLIQUID_INFO,
      12000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      }
    );
  } catch (e) {
    console.log("[hyperliquid] metaAndAssetCtxs failed:", String(e?.message || e));
    return [];
  }

  // robust extract assetCtxs
  let assetCtxs = null;
  if (Array.isArray(j) && Array.isArray(j[1])) assetCtxs = j[1];
  if (!assetCtxs && Array.isArray(j?.assetCtxs)) assetCtxs = j.assetCtxs;
  if (!assetCtxs && Array.isArray(j?.result?.assetCtxs)) assetCtxs = j.result.assetCtxs;
  if (!assetCtxs && Array.isArray(j?.data?.assetCtxs)) assetCtxs = j.data.assetCtxs;

  if (!Array.isArray(assetCtxs) || assetCtxs.length === 0) return [];

  const byCoin = new Map();
  for (const ctx of assetCtxs) {
    const coin = String(ctx?.coin || ctx?.symbol || "").toUpperCase();
    if (coin) byCoin.set(coin, ctx);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const ctx = byCoin.get(sym);
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
      hyperliquid_source: "info:metaAndAssetCtxs (funding~1h)",
    });
  }

  return rows;
}

/** ---------------- 01.xyz ----------------
 * 1) GET /info -> markets list (id + symbol)
 * 2) GET /market/{id}/stats -> perpStats.funding_rate (per hour)
 */
async function get01xyz() {
  let info;
  try {
    info = await fetchJson(`${O1_BASE}/info`, 12000);
  } catch (e) {
    console.log("[01xyz] /info failed:", String(e?.message || e));
    return [];
  }

  const markets = Array.isArray(info?.markets) ? info.markets : [];
  if (!markets.length) return [];

  // Map base symbol -> marketId (prefer perpetual/perp)
  const marketIdBySym = new Map();
  for (const m of markets) {
    const sym = String(m?.symbol || "").toUpperCase(); // e.g. "BTCUSD"
    const id = toNum(m?.id);
    if (id === null || !sym) continue;

    // base heuristic: startsWith BTC/ETH/SOL/BNB
    const base = TARGETS.find((t) => sym.startsWith(t));
    if (!base) continue;

    const type = String(m?.type || "").toLowerCase(); // "perpetual" likely
    const isPerp = type.includes("perp") || type.includes("perpetual");

    // choose perp first; if already set with perp, keep it
    if (!marketIdBySym.has(base)) {
      marketIdBySym.set(base, { id, isPerp });
    } else {
      const prev = marketIdBySym.get(base);
      if (!prev.isPerp && isPerp) marketIdBySym.set(base, { id, isPerp });
    }
  }

  const rows = [];
  for (const sym of TARGETS) {
    const m = marketIdBySym.get(sym);
    if (!m?.id) continue;

    let stats;
    try {
      stats = await fetchJson(`${O1_BASE}/market/${m.id}/stats`, 12000);
    } catch (e) {
      console.log(`[01xyz] /market/${m.id}/stats failed (${sym}):`, String(e?.message || e));
      continue;
    }

    const perp = stats?.perpStats || stats?.perp_stats || null;
    if (!perp) continue;

    // docs: perpStats.funding_rate is per-hour
    const rate1h = toNum(perp?.funding_rate ?? perp?.fundingRate) ?? 0;

    // mark price might exist depending on stats shape
    const mark =
      toNum(stats?.mark_price) ??
      toNum(stats?.markPrice) ??
      toNum(stats?.mark) ??
      toNum(perp?.mark_price) ??
      toNum(perp?.markPrice) ??
      null;

    const rate8h = normalizeTo8h(rate1h, 3600);

    rows.push({
      exchange: "01xyz",
      symbol: sym,
      funding_rate_raw: rate1h,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: null,
      o1_market_id: m.id,
      o1_source: "/info + /market/{id}/stats (funding~1h)",
    });
  }

  return rows;
}

/** ---------------- Nado ----------------
 * 1) GET [GATEWAY_REST_ENDPOINT]/symbols -> product_id map for BTC-PERP, ETH-PERP, ...
 * 2) POST [ARCHIVE_ENDPOINT] with { funding_rate: { product_id } } -> funding_rate_24h_x18
 * 3) POST [ARCHIVE_ENDPOINT] with { perp_prices: { product_ids:[...] } } -> perp_price_x18 for marks
 *
 * Normalize:
 *  - funding_rate_24h_x18 -> float (divide by 1e18), then 8h = 24h / 3
 */
async function getNado() {
  let symbols;
  try {
    symbols = await fetchJson(`${NADO_GATEWAY_REST}/symbols`, 12000);
  } catch (e) {
    console.log("[nado] /symbols failed:", String(e?.message || e));
    return [];
  }

  const symList = Array.isArray(symbols) ? symbols : [];
  if (!symList.length) return [];

  // Map TARGET -> product_id for "<SYM>-PERP"
  const productIdByTarget = new Map();
  for (const it of symList) {
    const s = String(it?.symbol || "").toUpperCase();
    const pid = toNum(it?.product_id);
    if (pid === null || !s) continue;

    // prefer live perp
    for (const t of TARGETS) {
      if (s === `${t}-PERP`) {
        productIdByTarget.set(t, pid);
      }
    }
  }

  // Collect perp prices in one indexer call (best-effort)
  const productIds = TARGETS.map((t) => productIdByTarget.get(t)).filter((x) => typeof x === "number");
  let priceByPid = new Map();
  if (productIds.length) {
    try {
      const px = await fetchJson(
        NADO_INDEXER,
        12000,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ perp_prices: { product_ids: productIds } }),
        }
      );

      // shape can vary; try common places
      const prices =
        px?.perp_prices ??
        px?.result?.perp_prices ??
        px?.data?.perp_prices ??
        px?.perpPrices ??
        null;

      if (prices && typeof prices === "object") {
        for (const [k, v] of Object.entries(prices)) {
          const pid = Number(k);
          const p = x18ToFloat(v?.perp_price_x18 ?? v?.perpPriceX18 ?? v?.price_x18 ?? v?.priceX18);
          if (Number.isFinite(pid) && p !== null) priceByPid.set(pid, p);
        }
      }
    } catch (e) {
      console.log("[nado] perp_prices failed:", String(e?.message || e));
    }
  }

  const rows = [];
  for (const t of TARGETS) {
    const pid = productIdByTarget.get(t);
    if (typeof pid !== "number") continue;

    let fr;
    try {
      fr = await fetchJson(
        NADO_INDEXER,
        12000,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ funding_rate: { product_id: pid } }),
        }
      );
    } catch (e) {
      console.log(`[nado] funding_rate failed (${t}, pid=${pid}):`, String(e?.message || e));
      continue;
    }

    // extract funding_rate_24h_x18
    const out =
      fr?.funding_rate ??
      fr?.result?.funding_rate ??
      fr?.data?.funding_rate ??
      fr?.fundingRate ??
      null;

    const rate24h = x18ToFloat(out?.funding_rate_24h_x18 ?? out?.fundingRate24hX18);
    if (rate24h === null) continue;

    const rate8h = rate24h / 3; // 24h -> 8h

    const mark = priceByPid.get(pid) ?? null;

    rows.push({
      exchange: "nado",
      symbol: t,
      funding_rate_raw: rate24h,   // 24h raw (float)
      funding_interval_s: 28800,   // output always 8h
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: null,
      nado_product_id: pid,
      nado_source: "indexer:funding_rate(24h_x18) + perp_prices(x18)",
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

  try {
    const asOf = new Date().toISOString();

    const [v, b, l, h, o1, nado] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(),
      getHyperliquid(),
      get01xyz(),
      getNado(),
    ]);

    const rows = [...v, ...b, ...l, ...h, ...o1, ...nado];
    fillMissingMarks(rows);

    // 정렬(기존처럼)
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
      return (
        TARGETS.indexOf(String(a.symbol || "").toUpperCase()) -
        TARGETS.indexOf(String(b.symbol || "").toUpperCase())
      );
    });

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({
      error: String(e?.message ?? e),
      asOf: new Date().toISOString(),
      rows: [],
    });
  }
}

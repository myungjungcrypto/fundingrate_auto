// funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter, Hyperliquid, 01.xyz, Nado
// and normalizes everything to 8h.
// Output schema is kept compatible with your funding.gs Apps Script pipeline.

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

// 01.xyz (docs: https://docs.01.xyz/)
const O1_BASE = "https://zo-mainnet.n1.xyz";

// Nado (docs: https://docs.nado.xyz/developer-resources/api/endpoints)
const NADO_GATEWAY = "https://gateway.prod.nado.xyz/v1";
const NADO_ARCHIVE = "https://archive.prod.nado.xyz/v1";

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
  if (!s || s <= 0) return r;
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

/** ---------------- Variational ---------------- */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`, 9000);
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
      funding_rate_next_interval: rate8h, // 8h
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
      funding_interval_s: 28800,
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

/** ---------------- Hyperliquid ---------------- */
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

  let universe = null;
  let assetCtxs = null;

  if (Array.isArray(j) && j.length >= 2) {
    if (Array.isArray(j?.[0]?.universe)) universe = j[0].universe;
    if (Array.isArray(j?.[1])) assetCtxs = j[1];
  }
  if (!universe && Array.isArray(j?.universe)) universe = j.universe;
  if (!assetCtxs && Array.isArray(j?.assetCtxs)) assetCtxs = j.assetCtxs;
  if (!universe && Array.isArray(j?.result?.universe)) universe = j.result.universe;
  if (!assetCtxs && Array.isArray(j?.result?.assetCtxs)) assetCtxs = j.result.assetCtxs;
  if (!universe && Array.isArray(j?.data?.universe)) universe = j.data.universe;
  if (!assetCtxs && Array.isArray(j?.data?.assetCtxs)) assetCtxs = j.data.assetCtxs;

  if (!Array.isArray(universe) || !Array.isArray(assetCtxs) || !universe.length || !assetCtxs.length) {
    console.log("[hyperliquid] unexpected shape:", JSON.stringify(j).slice(0, 300));
    return [];
  }

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
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: null,
      hyperliquid_source: "info:metaAndAssetCtxs (index-aligned universe)",
    });
  }

  return rows;
}

/** ---------------- 01.xyz ----------------
 * Use /info to map market_id per target
 * Then /market/{id}/stats -> perpStats.hourly_funding_rate (1h) + mark_price + next_funding_time
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
  if (!markets.length) {
    console.log("[01xyz] markets empty shape:", JSON.stringify(info).slice(0, 250));
    return [];
  }

  // Build symbol -> market_id mapping
  // Common patterns seen in 01: "BTCUSD", "BTC-PERP", etc. We'll try multiple matches.
  const bySym = new Map();
  for (const m of markets) {
    const mid = toNum(m?.market_id ?? m?.id);
    if (mid === null) continue;

    const s1 = String(m?.symbol || "").toUpperCase();
    const s2 = String(m?.name || "").toUpperCase();
    const base = String(m?.base_symbol || m?.base || m?.base_asset || "").toUpperCase();

    // prefer explicit base if present
    const key = base || (s1.startsWith("BTC") ? "BTC" :
                         s1.startsWith("ETH") ? "ETH" :
                         s1.startsWith("SOL") ? "SOL" :
                         s1.startsWith("BNB") ? "BNB" : "");

    if (TARGETS.includes(key)) {
      // keep first match, but allow overwrite with more "perp-ish" symbol
      const isPerpish = s1.includes("PERP") || s2.includes("PERP") || s1.includes("-PERP") || s1.includes("SWAP");
      if (!bySym.has(key)) bySym.set(key, { market_id: mid, sym: s1 || s2, score: isPerpish ? 2 : 1 });
      else {
        const prev = bySym.get(key);
        const score = isPerpish ? 2 : 1;
        if (score > prev.score) bySym.set(key, { market_id: mid, sym: s1 || s2, score });
      }
    }
  }

  const rows = [];
  for (const sym of TARGETS) {
    const hit = bySym.get(sym);
    if (!hit) continue;

    let st;
    try {
      st = await fetchJson(`${O1_BASE}/market/${hit.market_id}/stats`, 12000);
    } catch (e) {
      console.log(`[01xyz] stats failed sym=${sym} market_id=${hit.market_id}:`, String(e?.message || e));
      continue;
    }

    const perp = st?.perpStats || st?.perp_stats || null;
    const rate1h =
      toNum(perp?.hourly_funding_rate) ??
      toNum(perp?.hourlyFundingRate) ??
      toNum(perp?.funding_rate_1h) ??
      null;

    const mark =
      toNum(st?.mark_price) ??
      toNum(st?.markPrice) ??
      toNum(perp?.mark_price) ??
      toNum(perp?.markPrice) ??
      null;

    const nextTs =
      pickField(perp, ["next_funding_time", "nextFundingTime", "next_funding_ts"]) ??
      pickField(st, ["next_funding_time", "nextFundingTime"]) ??
      null;

    const nextIso =
      nextTs != null && Number.isFinite(Number(nextTs))
        ? new Date(Number(nextTs) * (String(nextTs).length <= 10 ? 1000 : 1)).toISOString()
        : null;

    if (rate1h === null) {
      console.log(`[01xyz] missing hourly_funding_rate sym=${sym} market_id=${hit.market_id} shape=`, JSON.stringify(st).slice(0, 250));
      continue;
    }

    const rate8h = normalizeTo8h(rate1h, 3600);

    rows.push({
      exchange: "01xyz",
      symbol: sym,
      funding_rate_raw: rate1h,      // 1h
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: nextIso,
      o1_market_id: hit.market_id,
      o1_market_symbol: hit.sym,
      o1_source: "/info + /market/{id}/stats (perpStats.hourly_funding_rate)",
    });
  }

  return rows;
}

/** ---------------- Nado ----------------
 * 1) GET gateway /v1/symbols to get product_id by "BTC-PERP" etc.
 * 2) POST archive /v1 with { funding_rates: { product_ids: [...] } }
 *    Response is a map: product_id -> { funding_rate_x18, update_time }
 *    funding_rate_x18 is 24hr funding rate scaled by 1e18 -> convert -> 8h = 24h/3
 */
async function getNado() {
  // 1) symbols
  let symbolsRes;
  try {
    symbolsRes = await fetchJson(`${NADO_GATEWAY}/symbols`, 12000);
  } catch (e) {
    console.log("[nado] symbols query failed:", String(e?.message || e));
    return [];
  }

  // docs show map-like response under data.symbols (not an array)
  const symbolsMap = symbolsRes?.data?.symbols || symbolsRes?.symbols || null;
  if (!symbolsMap || typeof symbolsMap !== "object") {
    console.log("[nado] symbols empty/invalid shape:", JSON.stringify(symbolsRes).slice(0, 250));
    return [];
  }

  // target -> product_id (e.g., "SOL-PERP")
  const prodBySym = new Map();
  for (const sym of TARGETS) {
    const key = `${sym}-PERP`;
    const it = symbolsMap[key] || symbolsMap[key.toLowerCase()] || null;
    const pid = toNum(it?.product_id ?? it?.productId);
    if (pid !== null) prodBySym.set(sym, { product_id: pid, symbol_key: key });
  }

  const productIds = Array.from(prodBySym.values()).map((x) => x.product_id);
  if (!productIds.length) {
    console.log("[nado] no product_ids found for targets. keys present sample:", Object.keys(symbolsMap).slice(0, 10));
    return [];
  }

  // 2) funding rates (24h) via archive POST [ARCHIVE_ENDPOINT]
  let fr;
  try {
    fr = await fetchJson(
      `${NADO_ARCHIVE}`,
      12000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          funding_rates: { product_ids: productIds },
        }),
      }
    );
  } catch (e) {
    console.log("[nado] funding_rates query failed:", String(e?.message || e));
    return [];
  }

  // response is a map: { "2": { product_id, funding_rate_x18, update_time }, ... }
  const frMap = fr && typeof fr === "object" ? fr : null;
  if (!frMap || Array.isArray(frMap)) {
    console.log("[nado] funding_rates invalid shape:", JSON.stringify(fr).slice(0, 250));
    return [];
  }

  // Build product_id -> record
  const recByPid = new Map();
  for (const [k, v] of Object.entries(frMap)) {
    const pid = toNum(v?.product_id ?? k);
    if (pid === null) continue;
    recByPid.set(pid, v);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const p = prodBySym.get(sym);
    if (!p) continue;

    const rec = recByPid.get(p.product_id);
    if (!rec) continue;

    const x18 = rec?.funding_rate_x18 ?? rec?.fundingRateX18 ?? null;
    const r24 = x18 != null ? Number(x18) / 1e18 : null; // 24h funding
    if (!Number.isFinite(r24)) continue;

    const rate8h = r24 / 3; // 24h -> 8h

    const upd = toNum(rec?.update_time ?? rec?.updateTime);
    const sourceIso = upd ? new Date(upd * 1000).toISOString() : null;

    rows.push({
      exchange: "nado",
      symbol: sym,
      funding_rate_raw: r24,        // 24h raw (note!)
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: null,             // we can add mark via another endpoint later
      source_ts: sourceIso,
      nado_product_id: p.product_id,
      nado_symbol: p.symbol_key,
      nado_source: "gateway:/symbols + archive:funding_rates (24h -> 8h)",
    });
  }

  return rows;
}

function fillMissingMarks(rows) {
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

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e), asOf: new Date().toISOString(), rows: [] });
  }
}

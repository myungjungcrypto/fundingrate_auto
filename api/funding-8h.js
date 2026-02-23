// funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter, Hyperliquid, 01.xyz,
// Nado, Pacifica, Paradex, Extended and normalizes to 8h.

const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  BNB: "BNBUSDT",
};

const VARIATIONAL_BASE = "https://omni-client-api.prod.ap-northeast-1.variational.io";
const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const O1_BASE = "https://zo-mainnet.n1.xyz";

const NADO_GATEWAY = "https://gateway.prod.nado.xyz/v1";
const NADO_ARCHIVE = "https://archive.prod.nado.xyz/v1";

const PACIFICA_BASE = process.env.PACIFICA_BASE_URL || "https://api.pacifica.fi";
const PARADEX_BASE = process.env.PARADEX_BASE_URL || "https://api.prod.paradex.trade";
const EXTENDED_BASE = process.env.EXTENDED_BASE_URL || "https://api.starknet.extended.exchange";
const EXTENDED_FALLBACK_BASES = ["https://api.extended.exchange"];

// Optional plugin env overrides/fallbacks
// - PACIFICA_FUNDING_URL
// - PARADEX_FUNDING_URL
// - EXTENDED_FUNDING_URL

const PLUGIN_DEFAULT_INTERVAL_S = {
  pacifica: 3600,
  paradex: 28800,
  extended: 3600,
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

function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  return r / (365 * 3);
}

function normalizeTo8h(rate, intervalS) {
  const r = toNum(rate);
  const s = toNum(intervalS);
  if (r === null) return null;
  if (!s || s <= 0) return r;
  return r * (28800 / s);
}

function toIsoMaybe(x) {
  if (x === null || x === undefined || x === "") return null;

  if (typeof x === "number") {
    if (!Number.isFinite(x) || x <= 0) return null;
    // seconds vs milliseconds heuristic
    const ms = x > 1e12 ? x : x * 1000;
    return new Date(ms).toISOString();
  }

  const n = Number(x);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }

  const d = new Date(String(x));
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

function mergeRowsBySymbol(primary, fallback) {
  const bySym = new Map();
  for (const r of fallback || []) bySym.set(`${r.exchange}|${r.symbol}`, r);
  for (const r of primary || []) bySym.set(`${r.exchange}|${r.symbol}`, r);
  return Array.from(bySym.values());
}

function extractBaseSymbol(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return "";
  for (const base of TARGETS) {
    if (s === base) return base;
    if (s.startsWith(`${base}-`)) return base;
    if (s.startsWith(`${base}/`)) return base;
    if (s.startsWith(`${base}_`)) return base;
    if (s.startsWith(base) && /PERP|USD|USDT/.test(s)) return base;
  }
  return "";
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
      funding_rate_raw: rateAnnual,
      source_interval_s: 28800,
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
      source_interval_s: 28800,
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
      source_interval_s: interval,
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
      funding_rate_raw: rate1h,
      source_interval_s: 3600,
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

/** ---------------- 01.xyz ---------------- */
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

  const candBySym = new Map();
  for (const m of markets) {
    const mid = toNum(m?.market_id ?? m?.marketId ?? m?.id);
    if (mid === null) continue;

    const sym = String(m?.symbol || "").toUpperCase();
    for (const base of TARGETS) {
      if (!sym.includes(base)) continue;
      const score =
        (sym === `${base}USD` ? 3 :
        (sym.startsWith(base) && sym.endsWith("USD") ? 2 :
        sym.startsWith(base) ? 1 : 0));
      if (score <= 0) continue;

      if (!candBySym.has(base)) candBySym.set(base, []);
      candBySym.get(base).push({ market_id: mid, market_symbol: sym, score });
    }
  }

  for (const base of TARGETS) {
    const c = candBySym.get(base) || [];
    c.sort((a, b) => (b.score - a.score) || (a.market_id - b.market_id));
    candBySym.set(base, c);
  }

  const rows = [];
  for (const base of TARGETS) {
    const cands = candBySym.get(base) || [];
    if (!cands.length) continue;

    let picked = null;
    let st = null;

    for (let i = 0; i < Math.min(6, cands.length); i++) {
      const c = cands[i];
      try {
        st = await fetchJson(`${O1_BASE}/market/${c.market_id}/stats`, 12000);
      } catch (e) {
        console.log(`[01xyz] /market/${c.market_id}/stats failed base=${base}:`, String(e?.message || e));
        continue;
      }
      const perp = st?.perpStats || st?.perp_stats || null;
      if (perp && (perp.funding_rate != null || perp.fundingRate != null)) {
        picked = c;
        break;
      }
    }

    if (!picked || !st) {
      console.log(`[01xyz] no perpStats found base=${base}. tried=${Math.min(6, cands.length)}`);
      continue;
    }

    const perp = st?.perpStats || st?.perp_stats;

    const rate1h =
      toNum(perp?.funding_rate) ??
      toNum(perp?.fundingRate) ??
      toNum(perp?.funding_rate_1h) ??
      toNum(perp?.hourly_funding_rate) ??
      null;

    if (rate1h === null) {
      console.log(`[01xyz] missing funding_rate base=${base} market_id=${picked.market_id} shape=`, JSON.stringify(st).slice(0, 250));
      continue;
    }

    const mark =
      toNum(st?.mark_price) ??
      toNum(st?.markPrice) ??
      toNum(perp?.mark_price) ??
      toNum(perp?.markPrice) ??
      null;

    const nextIso =
      (typeof perp?.next_funding_time === "string" ? perp.next_funding_time : null) ??
      (typeof perp?.nextFundingTime === "string" ? perp.nextFundingTime : null) ??
      null;

    const rate8h = normalizeTo8h(rate1h, 3600);

    rows.push({
      exchange: "01xyz",
      symbol: base,
      funding_rate_raw: rate1h,
      source_interval_s: 3600,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: nextIso,
      o1_market_id: picked.market_id,
      o1_market_symbol: picked.market_symbol,
      o1_source: "/info + /market/{id}/stats (perpStats.funding_rate ~ 1h)",
    });
  }

  return rows;
}

/** ---------------- Nado ----------------
 * Docs reference:
 * - https://docs.nado.xyz/funding-rates
 * - https://docs.nado.xyz/developer-resources/api/subscriptions/events
 *
 * funding_rate_x18 is a 24h-equivalent quote (x18), updated frequently and
 * settled on an hourly cadence. We keep raw as 24h-equivalent and convert to 8h by /3.
 */
async function getNado() {
  let symbolsRes;
  try {
    symbolsRes = await fetchJson(`${NADO_GATEWAY}/symbols`, 12000);
  } catch (e) {
    console.log("[nado] symbols query failed:", String(e?.message || e));
    return [];
  }

  let symbolsList = null;
  if (Array.isArray(symbolsRes)) {
    symbolsList = symbolsRes;
  } else if (Array.isArray(symbolsRes?.data)) {
    symbolsList = symbolsRes.data;
  } else {
    const symbolsMap = symbolsRes?.data?.symbols || symbolsRes?.symbols || null;
    if (symbolsMap && typeof symbolsMap === "object" && !Array.isArray(symbolsMap)) {
      symbolsList = Object.values(symbolsMap);
    }
  }

  if (!Array.isArray(symbolsList) || symbolsList.length === 0) {
    console.log("[nado] symbols empty/invalid shape:", JSON.stringify(symbolsRes).slice(0, 250));
    return [];
  }

  const prodByBase = new Map();
  const want = new Set(TARGETS.map((s) => `${s}-PERP`));

  for (const it of symbolsList) {
    const s = String(it?.symbol || "").toUpperCase();
    if (!want.has(s)) continue;
    const base = s.replace("-PERP", "");
    const pid = toNum(it?.product_id ?? it?.productId);
    if (TARGETS.includes(base) && pid !== null) {
      prodByBase.set(base, { product_id: pid, symbol_key: s });
    }
  }

  const productIds = Array.from(prodByBase.values()).map((x) => x.product_id);
  if (!productIds.length) {
    console.log("[nado] no product_ids found. sample symbols:", symbolsList.slice(0, 10).map((x) => x.symbol));
    return [];
  }

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

  const inner =
    fr?.data?.funding_rates ||
    fr?.funding_rates ||
    fr?.data ||
    fr;

  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    console.log("[nado] funding_rates invalid shape:", JSON.stringify(fr).slice(0, 250));
    return [];
  }

  const recByPid = new Map();
  for (const [k, v] of Object.entries(inner)) {
    const pid = toNum(v?.product_id ?? k);
    if (pid === null) continue;
    recByPid.set(pid, v);
  }

  const rows = [];
  for (const base of TARGETS) {
    const p = prodByBase.get(base);
    if (!p) continue;

    const rec = recByPid.get(p.product_id);
    if (!rec) continue;

    const x18 = rec?.funding_rate_x18 ?? rec?.fundingRateX18 ?? null;
    const r24eq = x18 != null ? Number(x18) / 1e18 : null;
    if (!Number.isFinite(r24eq)) continue;

    const rate8h = r24eq / 3;
    const sourceIso = toIsoMaybe(rec?.update_time ?? rec?.updateTime);

    rows.push({
      exchange: "nado",
      symbol: base,
      funding_rate_raw: r24eq,
      source_interval_s: 3600, // settlement/update cadence
      funding_rate_window_s: 86400, // raw quote window
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: null,
      source_ts: sourceIso,
      nado_product_id: p.product_id,
      nado_symbol: p.symbol_key,
      nado_source: "gateway:/v1/symbols + archive:/v1 (24h-eq quote -> 8h)",
    });
  }

  return rows;
}

/** ---------------- Optional Plugin Exchange ---------------- */
async function getPluginExchange(exchange, envKey) {
  const url = String(process.env?.[envKey] || "").trim();
  if (!url) return [];

  let j;
  try {
    j = await fetchJson(url, 12000);
  } catch (e) {
    console.log(`[${exchange}] plugin fetch failed:`, String(e?.message || e));
    return [];
  }

  const items =
    Array.isArray(j) ? j :
    Array.isArray(j?.rows) ? j.rows :
    Array.isArray(j?.data) ? j.data :
    [];

  if (!items.length) return [];

  const bySym = new Map();
  for (const it of items) {
    const sym = String(it?.symbol || it?.raw_symbol || it?.ticker || "").toUpperCase().trim();
    if (!TARGETS.includes(sym)) continue;
    bySym.set(sym, it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const it = bySym.get(sym);
    if (!it) continue;

    const rateRaw =
      toNum(it?.funding_rate_1h) ??
      toNum(it?.fundingRate1h) ??
      toNum(it?.funding_rate) ??
      toNum(it?.fundingRate) ??
      toNum(it?.funding_rate_8h) ??
      toNum(it?.fundingRate8h) ??
      null;
    if (rateRaw == null) continue;

    const intervalS =
      toNum(it?.source_interval_s) ??
      toNum(it?.funding_source_interval_s) ??
      toNum(it?.funding_interval_source_s) ??
      toNum(it?.interval_source_s) ??
      toNum(it?.funding_interval_s) ??
      toNum(it?.fundingIntervalS) ??
      toNum(it?.interval_s) ??
      toNum(it?.intervalS) ??
      (PLUGIN_DEFAULT_INTERVAL_S[String(exchange || "").toLowerCase()] || 3600);

    const rate8h = normalizeTo8h(rateRaw, intervalS);
    const mark =
      toNum(it?.mark_price) ??
      toNum(it?.markPrice) ??
      toNum(it?.mark) ??
      null;

    rows.push({
      exchange,
      symbol: sym,
      funding_rate_raw: rateRaw,
      source_interval_s: intervalS,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts:
        it?.source_ts ??
        it?.timestamp ??
        it?.updated_at ??
        it?.updatedAt ??
        null,
      plugin_source: envKey,
    });
  }

  return rows;
}

/** ---------------- Pacifica ---------------- */
async function getPacifica() {
  const fallback = await getPluginExchange("pacifica", "PACIFICA_FUNDING_URL");

  let j;
  try {
    j = await fetchJson(`${PACIFICA_BASE}/api/v1/info/prices`, 12000, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    console.log("[pacifica] /api/v1/info/prices failed:", String(e?.message || e));
    return fallback;
  }

  const items =
    Array.isArray(j) ? j :
    Array.isArray(j?.data) ? j.data :
    Array.isArray(j?.rows) ? j.rows :
    [];

  if (!items.length) return fallback;

  const bySym = new Map();
  for (const it of items) {
    const sym = extractBaseSymbol(it?.symbol);
    if (!TARGETS.includes(sym)) continue;
    bySym.set(sym, it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const it = bySym.get(sym);
    if (!it) continue;

    const rate1h =
      toNum(it?.funding) ??
      toNum(it?.funding_rate) ??
      toNum(it?.next_funding) ??
      toNum(it?.next_funding_rate) ??
      null;
    if (rate1h == null) continue;

    const mark = toNum(it?.mark) ?? toNum(it?.mark_price) ?? null;
    const rate8h = normalizeTo8h(rate1h, 3600);

    rows.push({
      exchange: "pacifica",
      symbol: sym,
      funding_rate_raw: rate1h,
      source_interval_s: 3600,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: toIsoMaybe(it?.timestamp),
      pacifica_source: "/api/v1/info/prices (hourly funding)",
    });
  }

  return mergeRowsBySymbol(rows, fallback);
}

/** ---------------- Paradex ---------------- */
async function getParadex() {
  const fallback = await getPluginExchange("paradex", "PARADEX_FUNDING_URL");

  let j;
  try {
    j = await fetchJson(`${PARADEX_BASE}/v1/markets/summary?market=ALL`, 12000, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    console.log("[paradex] /v1/markets/summary failed:", String(e?.message || e));
    return fallback;
  }

  const items =
    Array.isArray(j?.results) ? j.results :
    Array.isArray(j) ? j :
    [];

  if (!items.length) return fallback;

  const rows = [];
  for (const sym of TARGETS) {
    const exact = items.find((it) => String(it?.symbol || "").toUpperCase() === `${sym}-USD-PERP`);
    const broad = exact || items.find((it) => {
      const m = String(it?.symbol || "").toUpperCase();
      return m.startsWith(`${sym}-`) && m.includes("PERP");
    });
    if (!broad) continue;

    const rate = toNum(broad?.funding_rate ?? broad?.future_funding_rate);
    if (rate == null) continue;

    rows.push({
      exchange: "paradex",
      symbol: sym,
      funding_rate_raw: rate,
      source_interval_s: 28800,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate,
      funding_rate_8h: rate,
      mark_price: toNum(broad?.mark_price),
      source_ts: toIsoMaybe(broad?.created_at),
      paradex_market: broad?.symbol || null,
      paradex_source: "/v1/markets/summary",
    });
  }

  return mergeRowsBySymbol(rows, fallback);
}

/** ---------------- Extended ---------------- */
async function getExtended() {
  const fallback = await getPluginExchange("extended", "EXTENDED_FUNDING_URL");

  const bases = [EXTENDED_BASE, ...EXTENDED_FALLBACK_BASES.filter((b) => b !== EXTENDED_BASE)];
  const rows = [];

  for (const baseUrl of bases) {
    let marketsResp = null;
    try {
      const q = TARGETS.map((s) => `market=${encodeURIComponent(`${s}-USD`)}`).join("&");
      marketsResp = await fetchJson(
        `${baseUrl}/api/v1/info/markets?${q}`,
        12000,
        { headers: { Accept: "application/json" } }
      );
    } catch (e) {
      console.log(`[extended] markets list failed base=${baseUrl}:`, String(e?.message || e));
    }

    const marketItems =
      Array.isArray(marketsResp?.data) ? marketsResp.data :
      Array.isArray(marketsResp?.markets) ? marketsResp.markets :
      [];

    const marketBySym = new Map();
    for (const it of marketItems) {
      const marketName =
        String(it?.market || "") ||
        String(it?.name || "") ||
        String(it?.symbol || "");
      const baseSym = extractBaseSymbol(marketName);
      if (!TARGETS.includes(baseSym)) continue;
      if (!marketBySym.has(baseSym)) marketBySym.set(baseSym, marketName);
    }

    for (const sym of TARGETS) {
      const marketCandidates = [
        marketBySym.get(sym),
        `${sym}-USD`,
        `${sym}-USD-PERP`,
        `${sym}-PERP`,
      ].filter(Boolean);

      let pickedMarket = null;
      let statsResp = null;

      for (const market of marketCandidates) {
        try {
          statsResp = await fetchJson(
            `${baseUrl}/api/v1/info/markets/${encodeURIComponent(market)}/stats`,
            12000,
            { headers: { Accept: "application/json" } }
          );
          pickedMarket = market;
          break;
        } catch (e) {
          // try next candidate
        }
      }

      if (!statsResp) continue;

      const payload = statsResp?.data ?? statsResp?.marketStats ?? statsResp;

      const rate1h =
        toNum(payload?.fundingRate) ??
        toNum(payload?.funding_rate) ??
        null;

      if (rate1h == null) continue;

      const mark =
        toNum(payload?.markPrice) ??
        toNum(payload?.mark_price) ??
        toNum(payload?.oraclePrice) ??
        toNum(payload?.oracle_price) ??
        toNum(payload?.indexPrice) ??
        toNum(payload?.index_price) ??
        null;

      const rate8h = normalizeTo8h(rate1h, 3600);

      rows.push({
        exchange: "extended",
        symbol: sym,
        funding_rate_raw: rate1h,
        source_interval_s: 3600,
        funding_interval_s: 28800,
        funding_rate_next_interval: rate8h,
        funding_rate_8h: rate8h,
        mark_price: mark,
        source_ts: toIsoMaybe(
          payload?.timestamp ??
          payload?.updated_at ??
          payload?.updatedAt ??
          payload?.nextFundingAt ??
          payload?.next_funding_at ??
          payload?.nextFundingRate
        ),
        extended_market: pickedMarket,
        extended_base: baseUrl,
        extended_source: "/api/v1/info/markets + /api/v1/info/markets/{market}/stats",
      });
    }

    if (rows.length) break; // stop at first working base
  }

  if (!rows.length) {
    console.log("[extended] no rows after trying market list + stats on all base URLs");
  }

  return mergeRowsBySymbol(rows, fallback);
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const asOf = new Date().toISOString();

    const [v, b, l, h, o1, nado, pacifica, paradex, extended] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(),
      getHyperliquid(),
      get01xyz(),
      getNado(),
      getPacifica(),
      getParadex(),
      getExtended(),
    ]);

    const rows = [...v, ...b, ...l, ...h, ...o1, ...nado, ...pacifica, ...paradex, ...extended];
    fillMissingMarks(rows);

    const exOrder = {
      variational: 0,
      binance: 1,
      lighter: 2,
      hyperliquid: 3,
      "01xyz": 4,
      nado: 5,
      pacifica: 6,
      paradex: 7,
      extended: 8,
    };

    rows.sort((a, b) => {
      const ea = exOrder[String(a.exchange || "").toLowerCase()] ?? 99;
      const eb = exOrder[String(b.exchange || "").toLowerCase()] ?? 99;
      if (ea !== eb) return ea - eb;
      return TARGETS.indexOf(String(a.symbol || "").toUpperCase()) -
        TARGETS.indexOf(String(b.symbol || "").toUpperCase());
    });

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e), asOf: new Date().toISOString(), rows: [] });
  }
}

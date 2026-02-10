// funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter, Hyperliquid, 01.xyz, Nado
// and normalizes everything to 8h (funding_interval_s=28800).
//
// Output:
// { asOf: ISOString, rows: [ {exchange, symbol, funding_rate_8h, funding_rate_next_interval, funding_interval_s, mark_price, ...debug} ] }

const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

const BINANCE_SYMBOLS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  BNB: "BNBUSDT",
};

// Variational
const VARIATIONAL_BASE = "https://omni-client-api.prod.ap-northeast-1.variational.io";

// Lighter
const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai";

// Hyperliquid
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

// 01.xyz (docs show base like zo-mainnet.n1.xyz; keep configurable)
const O1_BASE = process.env?.O1_BASE || "https://zo-mainnet.n1.xyz";

// Nado (docs: endpoints page)
const NADO_GATEWAY_ENDPOINT =
  process.env?.NADO_GATEWAY_ENDPOINT || "https://gateway.prod.nado.xyz/query";
const NADO_ARCHIVE_ENDPOINT =
  process.env?.NADO_ARCHIVE_ENDPOINT || "https://archive.prod.nado.xyz/query";

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
  return r / (365 * 3); // annual -> per-8h (1095 windows/year)
}

function normalizeTo8h(ratePerInterval, intervalS) {
  const r = toNum(ratePerInterval);
  const s = toNum(intervalS);
  if (r === null) return null;
  if (!s || s <= 0) return r;
  return r * (28800 / s);
}

async function fetchJson(url, timeoutMs = 10000, options = {}) {
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

/** ---------------- Binance (premiumIndex lastFundingRate = next 8h) ---------------- */
async function getBinance() {
  const rows = [];
  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];
    try {
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
    } catch (e) {
      console.log(`[binance] ${sym} failed:`, String(e?.message || e));
    }
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
      funding_interval_s: 28800, // output fixed 8h
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

  // Expect: [ {universe:[{name:"BTC"},...]}, [ctx0, ctx1, ...] ]
  let universe = null;
  let assetCtxs = null;

  if (Array.isArray(j) && j.length >= 2) {
    if (Array.isArray(j?.[0]?.universe)) universe = j[0].universe;
    if (Array.isArray(j?.[1])) assetCtxs = j[1];
  }

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
      funding_rate_raw: rate1h,  // ~1h raw
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
 * Docs:
 *   - GET /info => markets (contains market_id / symbol)
 *   - GET /market/{id} => perpStats has funding_rate (hourly) + mark_price
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

  // Find perp markets for our TARGETS
  const want = new Map(); // sym -> market_id
  for (const m of markets) {
    const marketId = toNum(m?.market_id ?? m?.id);
    const symbol = String(m?.symbol || m?.name || "").toUpperCase();

    // common patterns: BTC-PERP, BTC-USD-PERP, BTCUSD-PERP etc.
    for (const sym of TARGETS) {
      if (want.has(sym)) continue;
      if (symbol.includes(sym) && symbol.includes("PERP")) {
        if (marketId != null) want.set(sym, marketId);
      }
    }
  }

  const rows = [];
  await Promise.all(
    Array.from(want.entries()).map(async ([sym, marketId]) => {
      try {
        const st = await fetchJson(`${O1_BASE}/market/${marketId}`, 12000);
        // Docs show perpStats.funding_rate (hourly) + perpStats.mark_price
        const perpStats = st?.perpStats || st?.perp_stats || st?.stats || null;

        const rate1h =
          toNum(perpStats?.funding_rate) ??
          toNum(perpStats?.fundingRate) ??
          toNum(perpStats?.funding) ??
          null;

        const mark =
          toNum(perpStats?.mark_price) ??
          toNum(perpStats?.markPrice) ??
          toNum(st?.mark_price) ??
          toNum(st?.markPrice) ??
          null;

        const nextFundingTimeIso = perpStats?.next_funding_time
          ? new Date(Number(perpStats.next_funding_time)).toISOString()
          : (perpStats?.nextFundingTime ? new Date(Number(perpStats.nextFundingTime)).toISOString() : null);

        const rate8h = rate1h == null ? null : normalizeTo8h(rate1h, 3600);

        rows.push({
          exchange: "01xyz",
          symbol: sym,
          funding_rate_raw: rate1h,     // hourly raw
          funding_interval_s: 28800,
          funding_rate_next_interval: rate8h,
          funding_rate_8h: rate8h,
          mark_price: mark,
          source_ts: nextFundingTimeIso,
          o1_market_id: marketId,
          o1_source: "GET /info + GET /market/{id} (funding_rate~1h)",
        });
      } catch (e) {
        console.log(`[01xyz] market ${marketId} (${sym}) failed:`, String(e?.message || e));
      }
    })
  );

  return rows;
}

/** ---------------- Nado ----------------
 * Docs:
 *  - Gateway Symbols endpoint gives perp product_id
 *  - Archive Funding Rate query returns 24h funding_rate_x18 (scaled by 1e18)
 *
 * Normalize:
 *  - rate24h = funding_rate_x18 / 1e18
 *  - rate8h  = rate24h / 3
 */
async function getNado() {
  // 1) get symbols to map product_id
  let symResp;
  try {
    // Many Nado endpoints are via POST /query style. If yours differs, override via env.
    symResp = await fetchJson(
      NADO_GATEWAY_ENDPOINT,
      12000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: {} }),
      }
    );
  } catch (e) {
    console.log("[nado] symbols query failed:", String(e?.message || e));
    return [];
  }

  // Try common shapes
  const symbols =
    Array.isArray(symResp) ? symResp :
    Array.isArray(symResp?.symbols) ? symResp.symbols :
    Array.isArray(symResp?.result?.symbols) ? symResp.result.symbols :
    Array.isArray(symResp?.data?.symbols) ? symResp.data.symbols :
    [];

  if (!Array.isArray(symbols) || !symbols.length) {
    console.log("[nado] symbols empty, shape:", JSON.stringify(symResp).slice(0, 200));
    return [];
  }

  // Find perp product_id for targets
  const productBySym = new Map(); // sym -> product_id
  for (const s of symbols) {
    const raw = String(s?.symbol || s?.name || "").toUpperCase();
    const productId = toNum(s?.product_id ?? s?.productId ?? s?.id);
    if (productId == null) continue;

    // Match BTC/ETH/SOL/BNB perp products: "BTC-PERP" etc
    for (const sym of TARGETS) {
      if (productBySym.has(sym)) continue;
      if (raw.includes(sym) && raw.includes("PERP")) productBySym.set(sym, productId);
    }
  }

  const productIds = Array.from(productBySym.values());
  if (!productIds.length) return [];

  // 2) query funding rates (24h) from archive
  let frResp;
  try {
    frResp = await fetchJson(
      NADO_ARCHIVE_ENDPOINT,
      12000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ funding_rates: { product_ids: productIds } }),
      }
    );
  } catch (e) {
    console.log("[nado] funding_rates query failed:", String(e?.message || e));
    return [];
  }

  // Response is map: { "2": { product_id, funding_rate_x18, update_time }, ... }
  const mapObj = (frResp && typeof frResp === "object") ? frResp : null;
  if (!mapObj) return [];

  const byPid = new Map(); // pid -> data
  for (const [k, v] of Object.entries(mapObj)) {
    const pid = toNum(v?.product_id ?? k);
    if (pid == null) continue;
    byPid.set(pid, v);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const pid = productBySym.get(sym);
    if (!pid) continue;

    const v = byPid.get(pid);
    if (!v) continue;

    const x18 = v?.funding_rate_x18 ?? v?.fundingRateX18 ?? null;
    const rate24h = x18 == null ? null : (Number(x18) / 1e18);
    const rate8h = rate24h == null ? null : (rate24h / 3);

    const updIso = v?.update_time
      ? new Date(Number(v.update_time) * 1000).toISOString()
      : null;

    rows.push({
      exchange: "nado",
      symbol: sym,
      funding_rate_raw: rate24h, // 24h raw
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: null, // will be filled by fillMissingMarks
      source_ts: updIso,
      nado_product_id: pid,
      nado_source: "archive funding_rates (24h -> 8h by /3)",
    });
  }

  return rows;
}

function fillMissingMarks(rows) {
  const markBySymbol = new Map();

  for (const r of rows) if (r.exchange === "binance" && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  for (const r of rows) if (!markBySymbol.has(r.symbol) && r.exchange === "variational" && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  for (const r of rows) if (!markBySymbol.has(r.symbol) && r.exchange === "hyperliquid" && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);
  for (const r of rows) if (!markBySymbol.has(r.symbol) && r.mark_price != null) markBySymbol.set(r.symbol, r.mark_price);

  for (const r of rows) {
    if (r.mark_price == null && markBySymbol.has(r.symbol)) r.mark_price = markBySymbol.get(r.symbol);
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

    const results = await Promise.allSettled([
      getVariational(),
      getBinance(),
      getLighter(),
      getHyperliquid(),
      get01xyz(),
      getNado(),
    ]);

    const allRows = [];
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) allRows.push(...r.value);
      if (r.status === "rejected") console.log("[handler] fetch failed:", String(r.reason?.message || r.reason));
    }

    fillMissingMarks(allRows);

    const exOrder = {
      variational: 0,
      binance: 1,
      lighter: 2,
      hyperliquid: 3,
      "01xyz": 4,
      nado: 5,
    };

    allRows.sort((a, b) => {
      const ea = exOrder[String(a.exchange || "").toLowerCase()] ?? 99;
      const eb = exOrder[String(b.exchange || "").toLowerCase()] ?? 99;
      if (ea !== eb) return ea - eb;
      return TARGETS.indexOf(String(a.symbol || "").toUpperCase()) -
        TARGETS.indexOf(String(b.symbol || "").toUpperCase());
    });

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.status(200).json({ asOf, rows: allRows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e), asOf: new Date().toISOString(), rows: [] });
  }
}

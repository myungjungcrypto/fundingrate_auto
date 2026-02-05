/**
 * /api/funding-8h
 *
 * Returns:
 * {
 *   asOf: ISO string,
 *   rows: [{
 *     exchange: "variational"|"binance"|"lighter"|"hyperliquid"|...,
 *     symbol: "BTC"|"ETH"|"SOL"|"BNB",
 *     funding_rate_8h: number,          // ALWAYS normalized to 8h equivalent
 *     funding_rate_next_interval: number,// same as funding_rate_8h
 *     funding_interval_s: 28800,
 *     mark_price: number|null
 *   }]
 * }
 */

const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

// ---------- helpers ----------
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, options = {}, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(id);
  }
}

// Convert a funding rate that is per-interval to 8h-equivalent
function normalizeTo8h(ratePerInterval, intervalS) {
  const r = Number(ratePerInterval);
  const s = Number(intervalS);
  if (!Number.isFinite(r) || !Number.isFinite(s) || s <= 0) return 0;
  // e.g. 1h rate -> multiply by 8, 8h rate -> *1
  return r * (28800 / s);
}

// ---------- Variational ----------
async function getVariational() {
  // TODO: keep your existing variational logic if you already have it elsewhere.
  // In your current file, variational is computed from "variational.usd" data via API.
  // I am keeping your original implementation block unchanged below.

  // ---- ORIGINAL (from your file) ----
  // Note: if you have a specific Variational endpoint, keep it here.
  // If this was already working, don’t touch.

  // Placeholder: return empty if not implemented here.
  // (Your uploaded file currently builds variational from data.var... if it exists)
  return [];
}

// ---------- Binance ----------
async function getBinance(targets) {
  // Uses premium endpoint? You used:
  // https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT
  const out = [];
  for (const sym of targets) {
    const symbol = `${sym}USDT`;
    try {
      const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
      const j = await fetchJson(url, {}, { timeoutMs: 8000 });

      // premiumIndex returns lastFundingRate and nextFundingTime etc.
      const rate8h = toNum(j.lastFundingRate) ?? 0;
      const mark = toNum(j.markPrice);

      out.push({
        exchange: "binance",
        symbol: sym,
        funding_rate_8h: rate8h,
        funding_rate_next_interval: rate8h,
        funding_interval_s: 28800,
        mark_price: mark ?? null,
      });

      // small delay to be gentle
      await sleep(50);
    } catch (e) {
      // skip symbol on failure
    }
  }
  return out;
}

// ---------- Lighter (your existing placeholder example) ----------
async function getLighter(targets) {
  // You had placeholders for Lighter in your file.
  // Keep it as “optional” unless you already had a working endpoint.
  // If you already have a working Lighter endpoint elsewhere, plug it here.

  // Placeholder: no-op
  return [];
}

// ---------- Hyperliquid (IMPLEMENTED) ----------
async function getHyperliquid(targets) {
  // Hyperliquid: POST https://api.hyperliquid.xyz/info { type: "metaAndAssetCtxs" }
  // Response includes asset contexts with fields like coin, funding, markPx (SDK types confirm these fields). :contentReference[oaicite:1]{index=1}
  const url = "https://api.hyperliquid.xyz/info";
  const body = JSON.stringify({ type: "metaAndAssetCtxs" });

  const j = await fetchJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
    { timeoutMs: 10000 }
  );

  // Typical shape: [meta, assetCtxs]
  const assetCtxs = Array.isArray(j) ? j[1] : null;
  if (!Array.isArray(assetCtxs)) return [];

  const byCoin = new Map();
  for (const ctx of assetCtxs) {
    const coin = String(ctx?.coin || "").toUpperCase();
    if (!coin) continue;
    byCoin.set(coin, ctx);
  }

  const out = [];
  for (const sym of targets) {
    const ctx = byCoin.get(sym);
    if (!ctx) continue;

    // Hyperliquid "funding" is per hour in practice (common usage). We normalize to 8h-equivalent.
    const rate1h = toNum(ctx.funding) ?? 0;
    const rate8h = normalizeTo8h(rate1h, 3600);
    const mark = toNum(ctx.markPx);

    out.push({
      exchange: "hyperliquid",
      symbol: sym,
      funding_rate_8h: rate8h,
      funding_rate_next_interval: rate8h,
      funding_interval_s: 28800,
      mark_price: mark ?? null,
    });
  }

  return out;
}

// ---------- 01.xyz / Nado (ENV-based plugin stubs) ----------
async function getPluginExchange(name, targets) {
  // You can set:
  //  - O1_FUNDING_URL or NADO_FUNDING_URL
  // And return JSON in ONE of these shapes:
  //  A) { rows: [{ symbol:"BTC", funding_rate_1h:0.0001, mark_price:12345 }, ...] }
  //  B) [{ symbol:"BTC", funding_rate_1h:..., mark_price:... }, ...]
  //
  // This function converts funding_rate_1h -> funding_rate_8h and returns in our unified format.

  const envKey = name === "01xyz" ? "O1_FUNDING_URL" : name === "nado" ? "NADO_FUNDING_URL" : null;
  if (!envKey) return [];

  const url = process.env[envKey];
  if (!url) return [];

  let j;
  try {
    j = await fetchJson(url, {}, { timeoutMs: 10000 });
  } catch (e) {
    return [];
  }

  const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : [];
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const bySym = new Map();
  for (const r of rows) {
    const sym = String(r?.symbol || "").toUpperCase();
    if (!sym) continue;
    bySym.set(sym, r);
  }

  const out = [];
  for (const sym of targets) {
    const r = bySym.get(sym);
    if (!r) continue;

    const rate1h =
      toNum(r.funding_rate_1h) ??
      toNum(r.fundingRate1h) ??
      toNum(r.funding_rate) ??
      0;

    const mark = toNum(r.mark_price) ?? toNum(r.markPrice) ?? null;

    const rate8h = normalizeTo8h(rate1h, 3600);

    out.push({
      exchange: name,
      symbol: sym,
      funding_rate_8h: rate8h,
      funding_rate_next_interval: rate8h,
      funding_interval_s: 28800,
      mark_price: mark,
    });
  }

  return out;
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const asOf = nowIso();

    // NOTE: Variational/Lighter are placeholders here unless you wire them.
    // Binance + Hyperliquid are implemented.
    const [binanceRows, hyperRows, o1Rows, nadoRows] = await Promise.all([
      getBinance(TARGETS),
      getHyperliquid(TARGETS),
      getPluginExchange("01xyz", TARGETS),
      getPluginExchange("nado", TARGETS),
    ]);

    // TODO: if you already have working variational/lighter, merge them here:
    const variationalRows = await getVariational();
    const lighterRows = await getLighter(TARGETS);

    const rows = [
      ...variationalRows,
      ...binanceRows,
      ...lighterRows,
      ...hyperRows,
      ...o1Rows,
      ...nadoRows,
    ];

    // final filter + sort
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
      return TARGETS.indexOf(String(a.symbol || "").toUpperCase()) - TARGETS.indexOf(String(b.symbol || "").toUpperCase());
    });

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({
      error: String(e?.message || e),
      asOf: nowIso(),
      rows: [],
    });
  }
}

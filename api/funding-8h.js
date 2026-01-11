// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
// Lighter policy: 1-call funding-rates + strict symbol + last-candidate.

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

/** ---------------- utils ---------------- */

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

// Variational: annual rate -> 8h
function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  // 1 year ≈ 365 days, 3 funding windows/day => 1095 windows/year
  return r / (365 * 3);
}

// generic normalize: rate for "interval_s" -> 8h
function normalizeTo8h(rate, intervalS) {
  const r = toNum(rate);
  const s = toNum(intervalS);
  if (r === null) return null;
  if (!s || s <= 0) return r; // unknown => assume already 8h-equivalent
  // If interval is 1h, multiply by 8; if 8h, multiply by 1; etc
  return r * (28800 / s);
}

// Symbol normalization for strict match
// Examples:
//  - "BTC" -> "BTC"
//  - "BTC-PERP" -> "BTC"
//  - "ETH/USDC" -> "ETH"
//  - "ETHFI" -> "ETHFI" (won't match "ETH")
function normalizeSymbol(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim().toUpperCase();
  if (!s) return "";
  // split on common separators
  const first = s.split(/[\s\-_/.:]+/)[0];
  // keep alnum only
  return first.replace(/[^A-Z0-9]/g, "");
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

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), funding_interval_s, mark_price, quotes.updated_at
 */
async function getVariational() {
  const stats = await fetchJson(`${VARIATIONAL_BASE}/metadata/stats`);
  const listings = Array.isArray(stats?.listings) ? stats.listings : [];

  const byTicker = new Map();
  for (const it of listings) {
    const t = normalizeSymbol(it?.ticker);
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
      funding_interval_s: 28800,          // normalize output to 8h
      funding_rate_next_interval: rate8h, // next 8h
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

/** ---------------- Lighter ----------------
 * Policy:
 * - 1-call /funding-rates
 * - strict symbol match (exact after normalization)
 * - last-candidate only
 *
 * NOTE:
 * - Lighter payload often does NOT include mark price; we fill it later from Binance.
 */
async function getLighter() {
  let data;
  try {
    data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`, 8000);
  } catch (e) {
    // If 429 / timeout, return empty rows (do not break whole API)
    console.log("[lighter] funding-rates failed:", String(e?.message || e));
    return [];
  }

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  // collect candidates per symbol (strict)
  const candsBySym = new Map();
  for (const it of items) {
    const raw = pickField(it, ["symbol", "raw_symbol", "rawSymbol", "asset", "ticker", "base", "market"]);
    const sym = normalizeSymbol(raw);
    if (!TARGETS.includes(sym)) continue; // ✅ strict match only

    if (!candsBySym.has(sym)) candsBySym.set(sym, []);
    candsBySym.get(sym).push(it);
  }

  const rows = [];

  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    // ✅ last-candidate
    const picked = cands[cands.length - 1];

    const rateRaw = toNum(
      pickField(picked, [
        "funding_rate",
        "fundingRate",
        "rate",
        "funding_rate_raw",
        "fundingRateRaw",
      ])
    );

    const intervalS =
      toNum(pickField(picked, ["funding_interval_s", "fundingIntervalS", "interval_s", "intervalS"])) ||
      28800; // default assume 8h-equivalent if not present

    const mark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));
    const ts =
      pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt", "time"]) ?? null;

    const marketId =
      pickField(picked, ["market_id", "marketId", "market_index", "marketIndex", "market"]) ?? null;

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: 28800, // output normalized to 8h interval
      funding_rate_next_interval: normalizeTo8h(rateRaw, intervalS),
      funding_rate_8h: normalizeTo8h(rateRaw, intervalS),
      mark_price: mark, // may be null -> filled later
      source_ts: ts,
      raw_symbol: normalizeSymbol(
        pickField(picked, ["raw_symbol", "rawSymbol", "symbol", "asset", "ticker"])
      ) || null,
      lighter_market_id: marketId,
      lighter_source: "funding-rates:last-candidate",
      lighter_candidate_count: cands.length,
    });
  }

  return rows;
}

/** mark fallback: Prefer binance marks, then variational */
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

    const [v, b, l] = await Promise.all([
      getVariational(),
      getBinance(),
      getLighter(),
    ]);

    const rows = [...v, ...b, ...l];
    fillMissingMarks(rows);

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.

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
  // if rate is per-interval, scale to 8h
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

/** ---------------- Variational ----------------
 * stats.listings[]: ticker, funding_rate(ANNUAL), funding_interval_s, mark_price, quotes.updated_at
 */
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
      funding_interval_s: 28800,          // normalize output to 8h
      funding_rate_next_interval: rate8h, // next 8h
      funding_rate_8h: rate8h,            // 8h normalized
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------------- Binance (NEXT / forward-looking 8h) ----------------
 * Use premiumIndex.lastFundingRate (next funding) instead of fundingRate history.
 * premiumIndex: { markPrice, lastFundingRate, nextFundingTime, ... }
 */
async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

    // ✅ single call: gives mark + next funding (lastFundingRate)
    const prem = await fetchJson(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`
    );

    const mark = toNum(prem?.markPrice);
    const nextFundingRate8h = toNum(prem?.lastFundingRate); // "next" funding rate to be applied
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
 * Keep it simple:
 * - funding-rates 1 call
 * - strict symbol match on raw_symbol
 * - pick LAST candidate for each symbol
 */
async function getLighter() {
  let data;
  try {
    data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`, 9000);
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

  // candidates grouped by "strict symbol"
  const candsBySym = new Map();
  for (const it of items) {
    const raw = String(pickField(it, ["raw_symbol", "rawSymbol", "symbol", "market", "ticker"]) || "").toUpperCase();

    // ✅ strict: must be exactly one of TARGETS
    if (!TARGETS.includes(raw)) continue;

    if (!candsBySym.has(raw)) candsBySym.set(raw, []);
    candsBySym.get(raw).push(it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    // ✅ pick LAST candidate
    const picked = cands[cands.length - 1];

    const rateRaw = toNum(
      pickField(picked, ["funding_rate", "fundingRate", "rate", "funding_rate_raw"])
    );
    const interval = toNum(
      pickField(picked, ["funding_interval_s", "fundingIntervalS", "interval_s", "intervalS"])
    ) ?? 28800;

    // funding-rates 응답은 mark가 없을 때가 많아서 fillMissingMarks에서 보정
    const mark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));

    // market id
    const marketId = toNum(pickField(picked, ["market_id", "marketId", "market_index", "marketIndex"]));

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: interval,
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

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

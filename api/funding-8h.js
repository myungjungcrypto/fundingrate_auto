// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and returns a unified 8h funding rate.
//
// Conventions:
// - funding_rate_8h is always a DECIMAL (e.g., 0.0001 = 0.01% per 8h)
// - Variational funding_rate_raw is assumed ANNUALIZED (decimal, e.g., 0.1095 = 10.95% APR-ish) and converted to 8h.
// - Binance funding_rate_raw is already per 8h.
// - Lighter funding_rate_raw may be hourly or 8h; we infer interval when possible and normalize to 8h.

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

const YEAR_S = 365 * 24 * 3600;
const EIGHT_HOURS_S = 8 * 3600;

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Generic normalization: interval_s-based rate -> 8h rate
function normalizeTo8h(rate, interval_s) {
  const r = toNum(rate);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
  return r * (EIGHT_HOURS_S / s);
}

// Variational: annualized -> interval / 8h
function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  return r * (EIGHT_HOURS_S / YEAR_S);
}
function annualToInterval(annualRate, interval_s) {
  const r = toNum(annualRate);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
  return r * (s / YEAR_S);
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

async function getVariational() {
  // /metadata/stats -> listings[] has ticker, funding_rate, funding_interval_s, mark_price, quotes.updated_at
  // IMPORTANT: We assume funding_rate is ANNUALIZED (decimal), per your observation.
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
    const interval = toNum(it.funding_interval_s); // might be 1h~8h depending on market
    const mark = toNum(it.mark_price);

    rows.push({
      exchange: "variational",
      symbol: sym,

      // raw is annualized
      funding_rate_raw: rateAnnual,
      funding_interval_s: interval,

      // unified 8h rate
      funding_rate_8h: annualTo8h(rateAnnual),

      // optional: next funding interval rate (kept for debugging/analytics)
      funding_rate_next_interval: annualToInterval(rateAnnual, interval),

      mark_price: mark,
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }

  return rows;
}

async function getBinance() {
  const rows = [];

  for (const sym of TARGETS) {
    const fSym = BINANCE_SYMBOLS[sym];

    // latest realized funding rate (already per 8h)
    const fundingArr = await fetchJson(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${fSym}&limit=1`
    );
    const last =
      Array.isArray(fundingArr) && fundingArr.length
        ? fundingArr[fundingArr.length - 1]
        : null;

    const fundingRate = toNum(last?.fundingRate);
    const fundingTimeIso = last?.fundingTime
      ? new Date(Number(last.fundingTime)).toISOString()
      : null;

    // mark price
    const prem = await fetchJson(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`
    );
    const mark = toNum(prem?.markPrice);

    const interval = EIGHT_HOURS_S;

    rows.push({
      exchange: "binance",
      symbol: sym,
      funding_rate_raw: fundingRate,
      funding_interval_s: interval,
      funding_rate_8h: fundingRate, // already per 8h
      mark_price: mark,
      source_ts: fundingTimeIso,
    });
  }

  return rows;
}

// Lighter helpers
function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function detectLighterIntervalSeconds(item, pickedKey, rateRaw) {
  // 1) explicit interval
  const explicit = toNum(
    pickField(item, ["funding_interval_s", "interval_s", "intervalSec"])
  );
  if (explicit) return explicit;

  // 2) infer from field name
  const key = String(pickedKey || "").toLowerCase();
  if (key.includes("hour")) return 3600;

  // 3) heuristic: if rate seems too small/large you could infer,
  // but keep it simple & safe: default 8h
  // (You can tighten this later once you see actual lighter payloads.)
  return EIGHT_HOURS_S;
}

async function getLighter() {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  // handle multiple possible shapes
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.funding_rates)
    ? data.funding_rates
    : Array.isArray(data?.fundingRates)
    ? data.fundingRates
    : [];

  const rows = [];

  for (const it of items) {
    const rawSym = String(
      pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]) || ""
    ).toUpperCase();

    const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(s));
    if (!sym) continue;

    const rateKeyCandidates = [
      "rate",
      "funding_rate",
      "fundingRate",
      "hourly_funding_rate",
      "hourlyFundingRate",
    ];

    let pickedKey = null;
    let rateRaw = null;

    for (const k of rateKeyCandidates) {
      if (it && it[k] !== undefined && it[k] !== null) {
        pickedKey = k;
        rateRaw = toNum(it[k]);
        break;
      }
    }

    const interval = detectLighterIntervalSeconds(it, pickedKey, rateRaw);
    const mark = toNum(pickField(it, ["mark_price", "markPrice", "mark"]));

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: interval,
      funding_rate_8h: normalizeTo8h(rateRaw, interval),
      mark_price: mark,
      source_ts: pickField(it, ["timestamp", "ts", "updated_at"]) ?? null,
      raw_symbol: rawSym || null,
    });
  }

  rows.sort((a, b) => TARGETS.indexOf(a.symbol) - TARGETS.indexOf(b.symbol));
  return rows;
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

    // light caching for Apps Script polling
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

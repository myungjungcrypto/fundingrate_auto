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

function normalizeTo8h(rate, interval_s) {
  const r = toNum(rate);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
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

async function getVariational() {
  // docs: /metadata/stats -> listings[] has ticker, funding_rate, funding_interval_s, mark_price, quotes.updated_at
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

    const rateRaw = toNum(it.funding_rate);
    const interval = toNum(it.funding_interval_s);
    const mark = toNum(it.mark_price);

    rows.push({
      exchange: "variational",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: interval,
      funding_rate_8h: normalizeTo8h(rateRaw, interval),
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

    // latest realized funding rate
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

    const interval = 28800;

    rows.push({
      exchange: "binance",
      symbol: sym,
      funding_rate_raw: fundingRate,
      funding_interval_s: interval,
      funding_rate_8h: normalizeTo8h(fundingRate, interval),
      mark_price: mark,
      source_ts: fundingTimeIso,
    });
  }

  return rows;
}

// Lighter: try to be robust to field-name changes
function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function detectLighterIntervalSeconds(item, pickedKey) {
  const explicit = toNum(pickField(item, ["funding_interval_s", "interval_s", "intervalSec"]));
  if (explicit) return explicit;

  const key = String(pickedKey || "").toLowerCase();
  if (key.includes("hour")) return 3600; // common pattern

  return 28800;
}

async function getLighter() {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

  const rows = [];

  for (const it of items) {
    const rawSym = String(
      pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]) || ""
    ).toUpperCase();

    const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(s));
    if (!sym) continue;

    const rateKeyCandidates = [
      "funding_rate",
      "fundingRate",
      "hourly_funding_rate",
      "hourlyFundingRate",
      "rate",
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

    const interval = detectLighterIntervalSeconds(it, pickedKey);
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

    const [v, b, l] = await Promise.all([getVariational(), getBinance(), getLighter()]);
    const rows = [...v, ...b, ...l];

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

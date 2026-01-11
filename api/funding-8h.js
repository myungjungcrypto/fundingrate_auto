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

function annualTo8h(annualRate) {
  const r = toNum(annualRate);
  if (r === null) return null;
  // 1 year ≈ 365 days, 3 funding windows/day => 1095 windows/year
  return r / (365 * 3);
}

// interval_s 기반 8h 환산 (필요 시만)
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

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
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
      funding_rate_raw: rateAnnual, // annual
      funding_interval_s: 28800, // normalize output to 8h
      funding_rate_next_interval: rate8h,
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
 * NOTE:
 * - Your observation: the LAST entry per symbol is the correct one.
 * - So we group by symbol and keep only the last candidate.
 * - We treat Lighter returned rate as already 8h-equivalent (interval_s=28800).
 */
function lighterExtractSymbol_(it) {
  const raw = String(
    pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name", "base"]) || ""
  ).toUpperCase();

  // exact match only: BTC/ETH/SOL/BNB
  if (TARGETS.includes(raw)) return raw;

  // some APIs may use "BTC-PERP" or "BTC_PERP" etc.
  for (const s of TARGETS) {
    if (raw === s) return s;
    if (raw.startsWith(s + "-") || raw.startsWith(s + "_") || raw === s + "PERP" || raw.includes(`${s}-PERP`) || raw.includes(`${s}_PERP`)) {
      return s;
    }
  }

  return null;
}

function lighterExtractRate_(it) {
  // candidates (we will treat the extracted number as 8h funding)
  const keys = [
    "funding_rate_8h",
    "fundingRate8h",
    "funding_rate",
    "fundingRate",
    "rate",
    "nextFundingRate",
    "next_funding_rate",
    "hourly_funding_rate",
    "hourlyFundingRate",
  ];

  for (const k of keys) {
    const v = pickField(it, [k]);
    if (v !== null && v !== undefined) {
      const n = toNum(v);
      if (n !== null) return n;
    }
  }
  return null;
}

async function getLighter() {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  // keep last item per symbol (based on array order)
  const lastBySym = new Map();

  for (const it of items) {
    const sym = lighterExtractSymbol_(it);
    if (!sym) continue;

    // IMPORTANT: keep overwriting so the last one remains
    lastBySym.set(sym, it);
  }

  const rows = [];
  for (const sym of TARGETS) {
    const picked = lastBySym.get(sym);
    if (!picked) continue;

    const rate8h = lighterExtractRate_(picked);
    const mark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rate8h,
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h, // already 8h
      mark_price: mark,
      source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: String(pickField(picked, ["symbol", "ticker", "market", "marketSymbol", "name"]) || sym),
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

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

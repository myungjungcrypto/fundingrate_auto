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
      funding_rate_raw: rateAnnual,            // annual
      funding_interval_s: 28800,               // normalize output to 8h
      funding_rate_next_interval: rate8h,      // next 8h
      funding_rate_8h: rate8h,                 // 8h normalized
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
 * IMPORTANT: Lighter /funding-rates is treated as already "8h equivalent" rate.
 * So DO NOT multiply by 8.
 */
async function getLighter() {
  // 1) perp 마켓 목록에서 BTC/ETH/SOL/BNB의 market_index 확보 (가능하면 정확매칭용)
  let perpIndexBySym = new Map();

  try {
    const ob = await fetchJson(`${LIGHTER_BASE}/api/v1/orderBookDetails?type=perp`);

    const obItems =
      Array.isArray(ob) ? ob :
      Array.isArray(ob?.data) ? ob.data :
      Array.isArray(ob?.order_books) ? ob.order_books :
      Array.isArray(ob?.orderBooks) ? ob.orderBooks :
      [];

    for (const it of obItems) {
      const symRaw = lighterGetSymbol_(it);
      const sym = TARGETS.find((s) => symRaw === s || symRaw.includes(`${s}`));
      if (!sym) continue;

      const idx = lighterGetMarketIndex_(it);
      if (idx === null) continue;

      // 심볼당 첫 perp index만 저장 (라이터 마켓 1개라면 이게 정답)
      if (!perpIndexBySym.has(sym)) perpIndexBySym.set(sym, idx);
    }
  } catch (e) {
    console.log("[lighter] orderBookDetails failed:", String(e?.message || e));
  }

  // 2) funding-rates
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  // symbol별 후보 모으기
  const candsBySym = new Map();
  for (const it of items) {
    const rawSym = lighterGetSymbol_(it);
    const sym = TARGETS.find((s) => rawSym === s || rawSym.includes(`${s}`));
    if (!sym) continue;

    if (!candsBySym.has(sym)) candsBySym.set(sym, []);
    candsBySym.get(sym).push(it);
  }

  const rows = [];

  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    const wantedIdx = perpIndexBySym.get(sym);

    // 2-1) market_index로 정확 매칭 우선
    let picked = null;
    if (wantedIdx !== undefined) {
      picked = cands.find((it) => lighterGetMarketIndex_(it) === wantedIdx) || null;
    }

    // 2-2) 매칭 실패하면 ✅ "마지막 1개" 선택
    if (!picked) {
      console.log(
        `[lighter] fallback LAST pick for ${sym}. wantedIdx=${wantedIdx}, candCount=${cands.length}`
      );
      const idxs = cands.map((x) => lighterGetMarketIndex_(x));
      console.log(`[lighter] ${sym} candidate market_index list:`, JSON.stringify(idxs));

      picked = cands[cands.length - 1];
    }

    const rateRaw = lighterGetRateRaw_(picked);
    const interval = lighterGetIntervalS_(picked);
    const mark = toNum(pickField(picked, ["mark_price", "markPrice", "mark"]));

    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: interval,
      funding_rate_next_interval: rateRaw,
      funding_rate_8h: normalizeTo8h(rateRaw, interval),
      mark_price: mark,
      source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: lighterGetSymbol_(picked) || null,
      lighter_market_index: lighterGetMarketIndex_(picked),
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

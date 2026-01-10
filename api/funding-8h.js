// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h.
//
// Conventions:
// - funding_rate_8h: "8시간 기준"으로 환산된 펀딩레이트 (decimal, e.g. 0.0001 = 0.01%)
// - funding_rate_next_interval: 거래소의 "다음 펀딩 구간"에 적용될 레이트 (interval = funding_interval_s)
// - funding_rate_raw:
//    * variational: APR(연간, decimal)  (예: 0.1095 = 10.95% APR)
//    * binance: 8h fundingRate (decimal)
//    * lighter: hourly fundingRate(가정, decimal)  (문서상 매시간 펀딩 :contentReference[oaicite:1]{index=1})

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

const EIGHT_HOURS_S = 28800;
const YEAR_S = 365 * 24 * 60 * 60;

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Convert a "per-interval" rate to 8h equivalent: r * (8h / interval)
function normalizeIntervalRateTo8h(ratePerInterval, interval_s) {
  const r = toNum(ratePerInterval);
  const s = toNum(interval_s);
  if (r === null || s === null || s <= 0) return null;
  return r * (EIGHT_HOURS_S / s);
}

// Convert APR (annual, decimal) to "per-interval" rate by simple linear scaling.
// (APR * seconds_in_interval / seconds_in_year)
// If you want compounding, we can switch later.
function aprToIntervalRate(apr, interval_s) {
  const a = toNum(apr);
  const s = toNum(interval_s);
  if (a === null || s === null || s <= 0) return null;
  return a * (s / YEAR_S);
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function getVariational() {
  // docs: /metadata/stats -> listings[] has ticker, funding_rate (APR), funding_interval_s, mark_price, quotes.updated_at
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

    const apr = toNum(it.funding_rate); // ✅ APR (annual)
    const interval = toNum(it.funding_interval_s) ?? EIGHT_HOURS_S;
    const mark = toNum(it.mark_price);

    const nextInterval = aprToIntervalRate(apr, interval);
    const rate8h = normalizeIntervalRateTo8h(nextInterval, interval);

    rows.push({
      exchange: "variational",
      symbol: sym,
      funding_rate_raw: apr,
      funding_interval_s: interval,
      funding_rate_next_interval: nextInterval,
      funding_rate_8h: rate8h,
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

    const fundingRate = toNum(last?.fundingRate); // ✅ already 8h
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
      funding_rate_next_interval: fundingRate,
      funding_rate_8h: fundingRate,
      mark_price: mark,
      source_ts: fundingTimeIso,
    });
  }

  return rows;
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

// ✅ 핵심: ETHFI 같이 "ETH + (문자)" 는 매칭 금지
// 허용: ETH, ETH-PERP, ETH_PERP, ETH/USDC, ETH:USDC, ETHUSD, ETHUSDC, ETH-USD 등
function matchTargetSymbol(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return null;

  for (const t of TARGETS) {
    if (s === t) return t;

    if (s.startsWith(t)) {
      const next = s.charAt(t.length);
      // next가 없거나, 구분자/숫자면 OK. (문자 A-Z면 ETHFI 같은 케이스 -> NO)
      if (!next) return t;
      if (next >= "A" && next <= "Z") continue; // ✅ ETHFI, SOLV, RESOLV 같은 것 차단
      return t;
    }
  }
  return null;
}

// Lighter는 문서상 매시간 펀딩이 기본 :contentReference[oaicite:2]{index=2}
function detectLighterIntervalSeconds(item, pickedKey) {
  const explicit = toNum(
    pickField(item, ["funding_interval_s", "interval_s", "intervalSec", "intervalSeconds"])
  );
  if (explicit) return explicit;

  const key = String(pickedKey || "").toLowerCase();
  if (key.includes("hour")) return 3600;

  // ✅ default: 1h
  return 3600;
}

// choose best row among duplicates (exact symbol > derived symbol, and with mark > without mark)
function chooseBetterCandidate(prev, next) {
  if (!prev) return next;
  if (!next) return prev;

  const score = (r) => {
    let sc = 0;
    if (r?.raw_symbol === r?.symbol) sc += 3; // exact match
    else sc += 2;
    if (toNum(r?.mark_price) !== null) sc += 1;
    if (toNum(r?.funding_rate_raw) !== null) sc += 0.5;
    return sc;
  };

  const a = score(prev);
  const b = score(next);
  if (b > a) return next;
  if (a > b) return prev;

  // tie-breaker: later timestamp wins (if parsable)
  const ta = Date.parse(prev?.source_ts || "") || 0;
  const tb = Date.parse(next?.source_ts || "") || 0;
  return tb >= ta ? next : prev;
}

async function getLighter() {
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  const rateKeyCandidates = [
    "hourly_funding_rate",
    "hourlyFundingRate",
    "funding_rate",
    "fundingRate",
    "rate",
  ];

  // map: symbol -> best row
  const best = new Map();

  for (const it of items) {
    const rawSym = String(
      pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name", "asset"]) || ""
    ).toUpperCase();

    const sym = matchTargetSymbol(rawSym);
    if (!sym) continue;

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
    const mark = toNum(pickField(it, ["mark_price", "markPrice", "mark", "markprice"]));

    const nextInterval = rateRaw; // Lighter는 반환값이 "다음 1h"라고 가정
    const rate8h = normalizeIntervalRateTo8h(nextInterval, interval);

    const row = {
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: rateRaw,
      funding_interval_s: interval,
      funding_rate_next_interval: nextInterval,
      funding_rate_8h: rate8h,
      mark_price: mark,
      source_ts: pickField(it, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: rawSym || null,
    };

    best.set(sym, chooseBetterCandidate(best.get(sym), row));
  }

  // Return exactly 4 rows (BTC/ETH/SOL/BNB) if available
  const rows = [];
  for (const sym of TARGETS) {
    const r = best.get(sym);
    if (r) rows.push(r);
  }
  return rows;
}

export default async function handler(req, res) {
  try {
    const asOf = new Date().toISOString();

    const [v, b, l] = await Promise.all([getVariational(), getBinance(), getLighter()]);
    const rows = [...v, ...b, ...l];

    // ✅ mark_price가 비어있으면 (특히 Lighter) Binance → Variational 순으로 보정
    const markFallback = new Map();
    for (const r of b) if (toNum(r.mark_price) !== null) markFallback.set(r.symbol, r.mark_price);
    for (const r of v) if (!markFallback.has(r.symbol) && toNum(r.mark_price) !== null) markFallback.set(r.symbol, r.mark_price);

    for (const r of rows) {
      if (toNum(r.mark_price) === null) {
        const fb = markFallback.get(r.symbol);
        if (toNum(fb) !== null) r.mark_price = fb;
      }
    }

    // 정렬: exchange, symbol 순 (보기 좋게)
    const exOrder = { variational: 0, binance: 1, lighter: 2 };
    rows.sort((a, b) => {
      const ea = exOrder[a.exchange] ?? 99;
      const eb = exOrder[b.exchange] ?? 99;
      if (ea !== eb) return ea - eb;
      return TARGETS.indexOf(a.symbol) - TARGETS.indexOf(b.symbol);
    });

    // Apps Script 호출 대비 캐시
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({ asOf, rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

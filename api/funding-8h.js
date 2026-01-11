// api/funding-8h.js
// Aggregates funding/mark from Variational, Binance, Lighter and normalizes to 8h-equivalent.

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

/** ---------- helpers ---------- */
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

async function fetchJson(url, timeoutMs = 9000) {
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

/** ---------- Variational ---------- */
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
      funding_interval_s: 28800,
      funding_rate_next_interval: rate8h,
      funding_rate_8h: rate8h,
      mark_price: toNum(it.mark_price),
      source_ts: it?.quotes?.updated_at ?? null,
    });
  }
  return rows;
}

/** ---------- Binance (8h) ---------- */
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

/** ---------- Lighter helpers ---------- */
function lighterGetSymbol_(it) {
  const raw = pickField(it, ["symbol", "ticker", "market", "marketSymbol", "name"]);
  return String(raw || "").toUpperCase();
}

function lighterGetMarketIndex_(it) {
  // orderBookDetails 쪽은 market_index가 자주 보임
  const v = pickField(it, ["market_index", "marketIndex", "marketId", "orderBook", "order_book"]);
  const n = toNum(v);
  return n === null ? null : n;
}

function lighterGetRateRaw_(it) {
  const v = pickField(it, [
    "rate",
    "funding_rate",
    "fundingRate",
    "hourly_funding_rate",
    "hourlyFundingRate",
  ]);
  return toNum(v);
}

function normalizeLighterTo8hBySumming8Hourly_(hourlyRates) {
  // 8시간 동등값 = 최근 8번(8시간) hourly funding rate 합
  const xs = (hourlyRates || []).map(toNum).filter((x) => x !== null);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0);
}

async function lighterFetchLast8HourlyFundings_(marketIndex) {
  // fundings endpoint param 스펙이 환경마다 다를 수 있어서 여러 URL을 순차 시도
  const limit = 8;
  const urls = [
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketIndex}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketIndex}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketIndex}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketIndex}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?order_book=${marketIndex}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?orderBook=${marketIndex}&resolution=1h&limit=${limit}`,
    // resolution 파라미터가 없을 수도 있어서 fallback
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketIndex}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketIndex}&limit=${limit}`,
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        [];

      // funding rate 필드명도 케이스가 여러가지일 수 있어서 후보로 뽑기
      const rates = items
        .map((x) => toNum(pickField(x, ["funding_rate", "fundingRate", "rate"])))
        .filter((x) => x !== null);

      if (rates.length) {
        // 보통 최신이 뒤에 붙는 형태가 많아서 마지막 8개로 맞춤
        const last8 = rates.slice(-limit);
        return { rates: last8, source: url };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    `Lighter fundings fetch failed for marketIndex=${marketIndex}. lastErr=${String(
      lastErr?.message ?? lastErr
    )}`
  );
}

/** ---------- Lighter (hourly -> 8h equivalent) ---------- */

function lighterExtractMarketId_(it) {
  const v = pickField(it, ["marketId", "market_id", "marketIndex", "market_index", "id"]);
  const n = toNum(v);
  return n === null ? null : n;
}

async function lighterFetchLast8HourlyFundingsByMarketId_(marketId) {
  const limit = 8;

  // fundings endpoint 스펙이 애매해서 여러 케이스를 순차 시도
  const urls = [
    `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketId}&resolution=1h&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketId}&resolution=1h&limit=${limit}`,
    // resolution 없이도 시도
    `${LIGHTER_BASE}/api/v1/fundings?marketId=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_id=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?marketIndex=${marketId}&limit=${limit}`,
    `${LIGHTER_BASE}/api/v1/fundings?market_index=${marketId}&limit=${limit}`,
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const data = await fetchJson(url);

      const items =
        Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.fundings) ? data.fundings :
        Array.isArray(data?.rows) ? data.rows :
        [];

      const rates = items
        .map((x) => toNum(pickField(x, ["funding_rate", "fundingRate", "rate"])))
        .filter((x) => x !== null);

      if (rates.length) {
        const last8 = rates.slice(-limit);
        return { rates: last8, source: url };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    `Lighter fundings fetch failed for marketId=${marketId}. lastErr=${String(
      lastErr?.message ?? lastErr
    )}`
  );
}

async function getLighter() {
  // 1) funding-rates에서 후보들을 가져온다 (여기서 심볼+marketId를 확보)
  const data = await fetchJson(`${LIGHTER_BASE}/api/v1/funding-rates`);

  const items =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.funding_rates) ? data.funding_rates :
    Array.isArray(data?.fundingRates) ? data.fundingRates :
    [];

  // symbol별 후보 모으기 (배열 순서 유지)
  const candsBySym = new Map();
  for (const it of items) {
    const raw = lighterGetSymbol_(it);
    // 정확 심볼만 통과 (ETHFI/RESOLV 같은 오염 제거)
    if (!TARGETS.includes(raw)) continue;

    if (!candsBySym.has(raw)) candsBySym.set(raw, []);
    candsBySym.get(raw).push(it);
  }

  const rows = [];

  for (const sym of TARGETS) {
    const cands = candsBySym.get(sym) || [];
    if (!cands.length) continue;

    // ✅ last candidate 룰
    const picked = cands[cands.length - 1];

    const marketId = lighterExtractMarketId_(picked) ?? lighterExtractMarketId_(cands[0]);
    const lastRate = lighterGetRateRaw_(picked);

    // 2) 가능하면 fundings(시간별)로 최근 8개 합산 → 8h 동등값
    try {
      if (marketId !== null) {
        const { rates, source } = await lighterFetchLast8HourlyFundingsByMarketId_(marketId);
        const rate8hEquiv = rates.reduce((a, b) => a + b, 0);

        rows.push({
          exchange: "lighter",
          symbol: sym,
          funding_rate_raw: lastRate,        // funding-rates에서 본 "최근값"
          funding_interval_s: 28800,         // 출력 통일용(8h)
          funding_rate_next_interval: lastRate,
          funding_rate_8h: rate8hEquiv,      // ✅ 8h 동등값(최근 8개 hourly 합)
          mark_price: null,
          source_ts: null,
          raw_symbol: sym,
          lighter_market_id: marketId,
          lighter_source: source,
          lighter_candidate_count: cands.length,
        });

        continue;
      }
    } catch (e) {
      console.log(`[lighter] fundings failed, fallback to last candidate (${sym}):`, String(e?.message || e));
    }

    // 3) fundings 실패 시 fallback: funding-rates의 last candidate 값(너가 확인한 “정확한 값”)
    rows.push({
      exchange: "lighter",
      symbol: sym,
      funding_rate_raw: lastRate,
      funding_interval_s: 28800,
      funding_rate_next_interval: lastRate,
      funding_rate_8h: lastRate,
      mark_price: null,
      source_ts: pickField(picked, ["timestamp", "ts", "updated_at", "updatedAt"]) ?? null,
      raw_symbol: lighterGetSymbol_(picked) || sym,
      lighter_market_id: marketId,
      lighter_source: "funding-rates:last-candidate",
      lighter_candidate_count: cands.length,
    });
  }

  return rows;
}


/** ---------- marks fallback ---------- */
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

/** ---------- handler ---------- */
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

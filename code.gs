/******************************************************
 * ✅ 공통: UI 안전 alert (트리거/에디터 실행에서도 안 터짐)
 ******************************************************/
function safeAlert_(msg) {
  try {
    SpreadsheetApp.getUi().alert(String(msg));
  } catch (e) {
    Logger.log(String(msg));
    try { console.log(String(msg)); } catch(_) {}
  }
}

/******************************************************
 * ✅ onOpen: 메뉴 구성 (UI 가능할 때만)
 ******************************************************/
function onOpen(e) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('💰 잔액 업데이트')
      .addItem('🧰 전체 업데이트 (원클릭)', 'runAllUpdates')
      .addSeparator()
      .addItem('바이낸스1 잔액 가져오기', 'fetchBinance1Balance')
      .addItem('바이낸스2 잔액 가져오기', 'fetchBinance2Balance')
      .addItem('바이빗 잔액 가져오기', 'fetchBybitBalance')
      .addItem('비트겟 잔액 가져오기', 'fetchBitgetBalance')
      .addItem('OKX 잔액 가져오기', 'fetchOkxBalance')
      .addItem('총액 업데이트 (A5)', 'updateTotalAll')
      .addSeparator()
      .addItem('📈 시세 + 김프 업데이트', 'updateMarketPrices')
      .addSeparator()
      .addItem('바낸1 BTC 수량 업데이트', 'fetchBinance1BTC')
      .addItem('바낸2 BTC 수량 업데이트', 'fetchBinance2BTC')
      .addItem('바낸1 ETH 수량 업데이트', 'fetchBinance1ETH')
      .addItem('바낸2 ETH 수량 업데이트', 'fetchBinance2ETH')
      .addSeparator()
      .addItem('바낸1 ALT 요약 업데이트', 'fetchBinance1AltSummary')
      .addItem('바낸2 ALT 요약 업데이트', 'fetchBinance2AltSummary')
      .addSeparator()
      .addItem('Bybit ALT 총합(선물+지갑)', 'fetchBybitAltTotal')
      .addItem('Bitget ALT 총합(선물+지갑)', 'fetchBitgetAltTotal')
      .addItem('OKX ALT 총합(선물+지갑)', 'fetchOkxAltTotal')
      .addItem('ALT 총합 모두 업데이트', 'fetchAllAltTotals')
      .addToUi();

    // ✅ Funding 메뉴도 UI 가능할 때만 붙임
    try { funding_addMenu_(); } catch (_) {}
  } catch (err) {
    // 트리거/에디터 수동 실행 컨텍스트에서는 UI 없음 -> 조용히 종료
    Logger.log("onOpen skipped (no UI): " + err);
  }
}

/******************************************************
 * ============================
 *  A) 자산현황/잔액 업데이트 코드
 * ============================
 ******************************************************/

/***********************
 * 공용 헬퍼
 ***********************/
function _fetchJson_(url, headers) {
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: headers || {}
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) throw new Error(`HTTP ${code}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

function _fetchAndSetUSD_(url, sheetName, a1) {
  try {
    const j = _fetchJson_(url);
    if (j?.totalUSD === undefined || j?.totalUSD === null) throw new Error('totalUSD 없음');
    const v = Number(j.totalUSD) || 0;
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).getRange(a1).setValue(v);
    return v;
  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).getRange(a1).setValue(`ERR: ${e.message}`);
    return null;
  }
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function getJson_(url, headers) { return _fetchJson_(url, headers); }

/***********************
 * ALT 총합(선물+지갑)
 ***********************/
const _ALT_SHEET_ = '자산현황';
const _ALT_API_BASE_ = 'https://binance-proxy-beta.vercel.app/api/position-summary';
const _ROW_BYBIT_TOTAL_ = 35;
const _ROW_BITGET_TOTAL_ = 36;
const _ROW_OKX_TOTAL_ = 37;

function _setLabelValue_(row, label, value) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_ALT_SHEET_);
  if (!s) throw new Error('시트 "' + _ALT_SHEET_ + '" 없음');
  s.getRange('A' + row).setValue(label);
  s.getRange('B' + row).setValue(value);
}

function _getAltTotalUSD_(exchange) {
  const j = _fetchJson_(_ALT_API_BASE_ + '?exchange=' + exchange);
  const w = Number(j?.wallet?.altWalletUSD || 0);
  const f = Number(j?.futures?.altFuturesUSD || 0);
  return round2(w + f);
}

function fetchBybitAltTotal() {
  try {
    const total = _getAltTotalUSD_('bybit');
    _setLabelValue_(_ROW_BYBIT_TOTAL_, 'Bybit ALT(총합 USD)', total);
    safeAlert_('✅ Bybit ALT 총합: $' + total);
  } catch (e) {
    _setLabelValue_(_ROW_BYBIT_TOTAL_, 'Bybit ALT(총합 USD)', 'ERR');
    safeAlert_('❌ Bybit ALT 오류: ' + e.message);
  }
}

function fetchBitgetAltTotal() {
  try {
    const total = _getAltTotalUSD_('bitget');
    _setLabelValue_(_ROW_BITGET_TOTAL_, 'Bitget ALT(총합 USD)', total);
    safeAlert_('✅ Bitget ALT 총합: $' + total);
  } catch (e) {
    _setLabelValue_(_ROW_BITGET_TOTAL_, 'Bitget ALT(총합 USD)', 'ERR');
    safeAlert_('❌ Bitget ALT 오류: ' + e.message);
  }
}

function fetchOkxAltTotal() {
  try {
    const total = _getAltTotalUSD_('okx');
    _setLabelValue_(_ROW_OKX_TOTAL_, 'OKX ALT(총합 USD)', total);
    safeAlert_('✅ OKX ALT 총합: $' + total);
  } catch (e) {
    _setLabelValue_(_ROW_OKX_TOTAL_, 'OKX ALT(총합 USD)', 'ERR');
    safeAlert_('❌ OKX ALT 오류: ' + e.message);
  }
}

function fetchAllAltTotals() {
  let ok = 0, fail = 0, lines = [];
  function one(label, row, ex) {
    try {
      const total = _getAltTotalUSD_(ex);
      _setLabelValue_(row, label, total);
      lines.push(label + ': $' + total);
      ok++;
    } catch (e) {
      _setLabelValue_(row, label, 'ERR');
      lines.push(label + ': ❌');
      fail++;
    }
  }
  one('Bybit ALT(총합 USD)', _ROW_BYBIT_TOTAL_, 'bybit');
  one('Bitget ALT(총합 USD)', _ROW_BITGET_TOTAL_, 'bitget');
  one('OKX ALT(총합 USD)', _ROW_OKX_TOTAL_, 'okx');

  safeAlert_('✅ ALT 총합 업데이트 결과\n\n' + lines.join('\n') + `\n\n성공: ${ok} · 실패: ${fail}`);
}

/***********************
 * 개별 잔액 가져오기 (A1~A4 + A6)
 ***********************/
function fetchBinance1Balance() {
  const v = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/account-summary', '자산현황', 'A1');
  safeAlert_(v === null ? '❌ 오류(바이낸스1)' : `✅ 바이낸스1 총 USD: $${v}`);
}
function fetchBinance2Balance() {
  const v = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/account-summary?acct=2', '자산현황', 'A2');
  safeAlert_(v === null ? '❌ 오류(바이낸스2)' : `✅ 바이낸스2 총 USD: $${v}`);
}
function fetchBybitBalance() {
  const v = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/bybit-balance', '자산현황', 'A3');
  safeAlert_(v === null ? '❌ 오류(바이빗)' : `✅ 바이빗 총 USD: $${v}`);
}
function fetchBitgetBalance() {
  const v = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/bitget-balance', '자산현황', 'A4');
  safeAlert_(v === null ? '❌ 오류(비트겟)' : `✅ 비트겟 총 USD: $${v}`);
}
function fetchOkxBalance() {
  const v = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/okx-balance', '자산현황', 'A6');
  safeAlert_(v === null ? '❌ 오류(OKX)' : `✅ OKX 총 USD: $${v}`);
}

/***********************
 * 총액 업데이트 (A5)
 ***********************/
function updateTotalAll() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');
  const b1 = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/account-summary', '자산현황', 'A1');
  const b2 = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/account-summary?acct=2', '자산현황', 'A2');
  const by = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/bybit-balance', '자산현황', 'A3');
  const bg = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/bitget-balance', '자산현황', 'A4');
  const okx = _fetchAndSetUSD_('https://binance-proxy-beta.vercel.app/api/okx-balance', '자산현황', 'A6');

  const total = (Number(b1) || 0) + (Number(b2) || 0) + (Number(by) || 0) + (Number(bg) || 0) + (Number(okx) || 0);
  s.getRange('A5').setValue(total);

  safeAlert_(
    '✅ 총액 업데이트 완료\n\n' +
    `Binance1: ${b1 === null ? '❌' : `$${b1}`}\n` +
    `Binance2: ${b2 === null ? '❌' : `$${b2}`}\n` +
    `Bybit: ${by === null ? '❌' : `$${by}`}\n` +
    `Bitget: ${bg === null ? '❌' : `$${bg}`}\n` +
    `OKX: ${okx === null ? '❌' : `$${okx}`}\n` +
    '----------------------\n' +
    `Total (A5): $${total}`
  );
}

/***********************
 * 📈 시세 + 김치 프리미엄 (A7~B12)
 * - silent=true면 알림 생략(원클릭 실행 시)
 ***********************/
function updateMarketPrices(silent) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');

  const usdkRw = getUsdKrw();
  const { btcUsd, ethUsd } = getUsdFromCoinbase();
  const { btcKrw, ethKrw } = getUpbitKrw();

  const btcUsdVal = round2(btcUsd);
  const ethUsdVal = round2(ethUsd);
  const btcKrwVal = Math.round(btcKrw ?? 0);
  const ethKrwVal = Math.round(ethKrw ?? 0);
  const usdKrwVal = Math.round(usdkRw || 0);

  let btcKimchi = '';
  if (btcUsd && usdkRw && btcKrw) btcKimchi = round2(((btcKrw / (btcUsd * usdkRw)) - 1) * 100);

  sheet.getRange('A7').setValue('BTC (USD)'); sheet.getRange('B7').setValue(btcUsdVal);
  sheet.getRange('A8').setValue('BTC (KRW)'); sheet.getRange('B8').setValue(btcKrwVal);
  sheet.getRange('A9').setValue('ETH (USD)'); sheet.getRange('B9').setValue(ethUsdVal);
  sheet.getRange('A10').setValue('ETH (KRW)'); sheet.getRange('B10').setValue(ethKrwVal);
  sheet.getRange('A11').setValue('USD/KRW'); sheet.getRange('B11').setValue(usdKrwVal);
  sheet.getRange('A12').setValue('BTC 김치프리미엄 (%)'); sheet.getRange('B12').setValue(btcKimchi);

  if (!silent) safeAlert_('✅ 시세 + 김치프리미엄 업데이트 완료');
}

function getUsdFromCoinbase() {
  const h = { 'User-Agent': 'Mozilla/5.0 (AppsScript)' };
  let btcUsd = 0, ethUsd = 0;
  try {
    const jb = getJson_('https://api.exchange.coinbase.com/products/BTC-USD/ticker', h);
    const b = Number(jb?.price ?? jb?.last);
    if (b) btcUsd = b;
  } catch (e) {}
  try {
    const je = getJson_('https://api.exchange.coinbase.com/products/ETH-USD/ticker', h);
    const e = Number(je?.price ?? je?.last);
    if (e) ethUsd = e;
  } catch (e) {}
  return { btcUsd, ethUsd };
}

function getUpbitKrw() {
  try {
    const arr = getJson_('https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH', { 'Accept': 'application/json' });
    let btcKrw, ethKrw;
    for (const it of arr) {
      if (it.market === 'KRW-BTC') btcKrw = Number(it.trade_price);
      if (it.market === 'KRW-ETH') ethKrw = Number(it.trade_price);
    }
    if (btcKrw || ethKrw) return { btcKrw, ethKrw };
  } catch (e) {}

  try {
    const jb = getJson_('https://api.coinone.co.kr/ticker_new/?currency=btc');
    const je = getJson_('https://api.coinone.co.kr/ticker_new/?currency=eth');
    const btcKrw = Number(jb?.last);
    const ethKrw = Number(je?.last);
    if (btcKrw || ethKrw) return { btcKrw, ethKrw };
  } catch (e) {}

  try {
    const jb = getJson_('https://api.bithumb.com/public/ticker/BTC_KRW');
    const je = getJson_('https://api.bithumb.com/public/ticker/ETH_KRW');
    const btcKrw = Number(jb?.data?.closing_price);
    const ethKrw = Number(je?.data?.closing_price);
    if (btcKrw || ethKrw) return { btcKrw, ethKrw };
  } catch (e) {}

  return { btcKrw: null, ethKrw: null };
}

function getUsdKrw() {
  const reqs = [
    {
      url: 'https://binance-proxy-beta.vercel.app/api/usdkrw?t=' + Date.now(),
      parse: (t) => { try { const j = JSON.parse(t); return Number(j?.rate) || 0; } catch (_) { return 0; } }
    },
    {
      url: 'https://api.exchangerate.host/latest?base=USD&symbols=KRW',
      parse: (t) => { try { const j = JSON.parse(t); return Number(j?.rates?.KRW) || 0; } catch (_) { return 0; } }
    },
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (t) => { try { const j = JSON.parse(t); return Number(j?.rates?.KRW) || 0; } catch (_) { return 0; } }
    }
  ];

  const resps = UrlFetchApp.fetchAll(reqs.map(r => ({ url: r.url, method: 'get', muteHttpExceptions: true })));
  for (let i = 0; i < resps.length; i++) {
    try {
      const val = reqs[i].parse(resps[i].getContentText());
      if (val) return val;
    } catch (e) {}
  }
  return 0;
}

/***********************
 * 🔹 Binance BTC/ETH 수량 + ALT 요약
 ***********************/
function _writeBTC_(j, startRow) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');
  const spot = Number(j?.spot?.walletsTotalBTC) || 0;
  const fut = Number(j?.futures?.usdM_BTCnetQty) || 0;
  sheet.getRange(`A${startRow}`).setValue('Spot BTC'); sheet.getRange(`B${startRow}`).setValue(spot);
  sheet.getRange(`A${startRow + 1}`).setValue('Futures BTC (USDT-M)'); sheet.getRange(`B${startRow + 1}`).setValue(fut);
  sheet.getRange(`A${startRow + 2}`).setValue('Total BTC'); sheet.getRange(`B${startRow + 2}`).setValue(spot + fut);
}
function fetchBinance1BTC() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-btc-summary'); _writeBTC_(j, 14); safeAlert_('✅ Binance1 BTC 수량 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸1 BTC): ' + e.message); }
}
function fetchBinance2BTC() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-btc-summary?acct=2'); _writeBTC_(j, 17); safeAlert_('✅ Binance2 BTC 수량 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸2 BTC): ' + e.message); }
}

function _writeETH_(j, startRow) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');
  const spot = Number(j?.spot?.walletsTotalETH) || 0;
  const fut = Number(j?.futures?.usdM_ETHnetQty) || 0;
  sheet.getRange(`A${startRow}`).setValue('Spot ETH'); sheet.getRange(`B${startRow}`).setValue(spot);
  sheet.getRange(`A${startRow + 1}`).setValue('Futures ETH (USDT-M)'); sheet.getRange(`B${startRow + 1}`).setValue(fut);
  sheet.getRange(`A${startRow + 2}`).setValue('Total ETH'); sheet.getRange(`B${startRow + 2}`).setValue(spot + fut);
}
function fetchBinance1ETH() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-eth-summary'); _writeETH_(j, 21); safeAlert_('✅ Binance1 ETH 수량 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸1 ETH): ' + e.message); }
}
function fetchBinance2ETH() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-eth-summary?acct=2'); _writeETH_(j, 24); safeAlert_('✅ Binance2 ETH 수량 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸2 ETH): ' + e.message); }
}

function _writeAltSummary_(j, startRow) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');
  const w = round2(j?.altWalletUSD || 0);
  const f = round2(j?.altFuturesUSD || 0);
  const t = round2((j?.altTotalUSD) || (w + f));
  sheet.getRange(`A${startRow}`).setValue('ALT Wallet (USD)'); sheet.getRange(`B${startRow}`).setValue(w);
  sheet.getRange(`A${startRow + 1}`).setValue('ALT Futures (USD)'); sheet.getRange(`B${startRow + 1}`).setValue(f);
  sheet.getRange(`A${startRow + 2}`).setValue('ALT Total (USD)'); sheet.getRange(`B${startRow + 2}`).setValue(t);
}
function fetchBinance1AltSummary() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-alt-summary'); _writeAltSummary_(j, 28); safeAlert_('✅ Binance1 ALT 요약 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸1 ALT): ' + e.message); }
}
function fetchBinance2AltSummary() {
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-alt-summary?acct=2'); _writeAltSummary_(j, 31); safeAlert_('✅ Binance2 ALT 요약 업데이트 완료'); }
  catch (e) { safeAlert_('❌ 오류(바낸2 ALT): ' + e.message); }
}

/***********************
 * 🧰 원클릭 전체 업데이트
 ***********************/
function runAllUpdates() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('자산현황');
  const summary = [];
  let ok = 0, fail = 0;

  function trySet(label, cell, url) {
    try {
      const j = _fetchJson_(url);
      const v = Number(j.totalUSD) || 0;
      s.getRange(cell).setValue(v);
      summary.push(`${label}: $${v}`);
      ok++;
    } catch (e) {
      s.getRange(cell).setValue('ERR');
      summary.push(`${label}: ❌`);
      fail++;
    }
  }

  trySet('Binance1', 'A1', 'https://binance-proxy-beta.vercel.app/api/account-summary');
  trySet('Binance2', 'A2', 'https://binance-proxy-beta.vercel.app/api/account-summary?acct=2');
  trySet('Bybit', 'A3', 'https://binance-proxy-beta.vercel.app/api/bybit-balance');
  trySet('Bitget', 'A4', 'https://binance-proxy-beta.vercel.app/api/bitget-balance');
  trySet('OKX', 'A6', 'https://binance-proxy-beta.vercel.app/api/okx-balance');

  const total = (Number(s.getRange('A1').getValue()) || 0)
    + (Number(s.getRange('A2').getValue()) || 0)
    + (Number(s.getRange('A3').getValue()) || 0)
    + (Number(s.getRange('A4').getValue()) || 0)
    + (Number(s.getRange('A6').getValue()) || 0);
  s.getRange('A5').setValue(total);
  summary.push(`Total: $${total}`);

  // ✅ silent 모드로 실행(중간 alert 방지)
  try { updateMarketPrices(true); summary.push('Prices/Kimchi: ✅'); ok++; } catch (e) { summary.push('Prices/Kimchi: ❌'); fail++; }

  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-btc-summary'); _writeBTC_(j, 14); summary.push('BTC acct1: ✅'); ok++; } catch (e) { summary.push('BTC acct1: ❌'); fail++; }
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-btc-summary?acct=2'); _writeBTC_(j, 17); summary.push('BTC acct2: ✅'); ok++; } catch (e) { summary.push('BTC acct2: ❌'); fail++; }

  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-eth-summary'); _writeETH_(j, 21); summary.push('ETH acct1: ✅'); ok++; } catch (e) { summary.push('ETH acct1: ❌'); fail++; }
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-eth-summary?acct=2'); _writeETH_(j, 24); summary.push('ETH acct2: ✅'); ok++; } catch (e) { summary.push('ETH acct2: ❌'); fail++; }

  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-alt-summary'); _writeAltSummary_(j, 28); summary.push('ALT acct1: ✅'); ok++; } catch (e) { summary.push('ALT acct1: ❌'); fail++; }
  try { const j = _fetchJson_('https://binance-proxy-beta.vercel.app/api/binance-alt-summary?acct=2'); _writeAltSummary_(j, 31); summary.push('ALT acct2: ✅'); ok++; } catch (e) { summary.push('ALT acct2: ❌'); fail++; }

  try { const t = _getAltTotalUSD_('bybit'); _setLabelValue_(_ROW_BYBIT_TOTAL_, 'Bybit ALT(총합 USD)', t); summary.push('Bybit ALT: ✅'); ok++; } catch (e) { _setLabelValue_(_ROW_BYBIT_TOTAL_, 'Bybit ALT(총합 USD)', 'ERR'); summary.push('Bybit ALT: ❌'); fail++; }
  try { const t = _getAltTotalUSD_('bitget'); _setLabelValue_(_ROW_BITGET_TOTAL_, 'Bitget ALT(총합 USD)', t); summary.push('Bitget ALT: ✅'); ok++; } catch (e) { _setLabelValue_(_ROW_BITGET_TOTAL_, 'Bitget ALT(총합 USD)', 'ERR'); summary.push('Bitget ALT: ❌'); fail++; }
  try { const t = _getAltTotalUSD_('okx'); _setLabelValue_(_ROW_OKX_TOTAL_, 'OKX ALT(총합 USD)', t); summary.push('OKX ALT: ✅'); ok++; } catch (e) { _setLabelValue_(_ROW_OKX_TOTAL_, 'OKX ALT(총합 USD)', 'ERR'); summary.push('OKX ALT: ❌'); fail++; }

  safeAlert_('✅ 전체 업데이트 완료\n\n' + summary.join('\n') + `\n\n성공: ${ok} · 실패: ${fail}`);

  _logN34ToDiaryIfChanged_();
}

/***********************
 * 공통: 오늘 날짜 포맷
 ***********************/
function _todayYmd_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/***********************
 * 핵심: 자산현황!N34 → 일기장
 ***********************/
function _writeN34ToDiary_() {
  const ss = SpreadsheetApp.getActive();
  const sheetSrc = ss.getSheetByName('자산현황');
  const sheetDst = ss.getSheetByName('일기장');
  if (!sheetSrc) throw new Error('시트 "자산현황"을 찾을 수 없습니다.');
  if (!sheetDst) throw new Error('시트 "일기장"을 찾을 수 없습니다.');

  const value = sheetSrc.getRange('N34').getValue();
  const ymd = _todayYmd_();

  const lastRow = Math.max(sheetDst.getLastRow(), 1);
  const colA = sheetDst.getRange(1, 1, lastRow, 1).getValues();
  let targetRow = -1;

  for (let i = 0; i < colA.length; i++) {
    const v = colA[i][0];
    if (!v) continue;

    let asYmd = '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
      asYmd = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    } else {
      asYmd = String(v).trim();
    }

    if (asYmd === ymd) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    sheetDst.appendRow([ymd, value]);
  } else {
    sheetDst.getRange(targetRow, 2).setValue(value);
  }
}

/***********************
 * 변경 감지 기록 도우미
 ***********************/
const _PROP_ = PropertiesService.getScriptProperties();

function _logN34ToDiaryIfChanged_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const assetSheet = ss.getSheetByName("자산현황");
  const diarySheet = ss.getSheetByName("일기장");
  if (!assetSheet || !diarySheet) return;

  const n34Val = assetSheet.getRange("N34").getValue();
  const todayStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");

  const diaryDates = diarySheet.getRange("A:A").getValues().map(r => r[0]);
  const rowIndex = diaryDates.findIndex(v => v && Utilities.formatDate(new Date(v), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd") === todayStr);
  if (rowIndex === -1) return;

  const row = rowIndex + 1;
  const targetCell = diarySheet.getRange(row, 2);
  if (targetCell.getValue() !== n34Val) {
    targetCell.setValue(n34Val);
  }
}
function cronN34Sync() {
  _logN34ToDiaryIfChanged_();
}

/***********************
 * onEdit / onChange
 ***********************/
function onEdit(e) {
  try {
    if (!e) return;
    const range = e.range;
    const sheet = range.getSheet();
    if (sheet.getName() !== '자산현황') return;

    if (range.getA1Notation() === 'N34') {
      _writeN34ToDiary_();
      _PROP_.setProperty('LAST_N34_VALUE', String(sheet.getRange('N34').getValue()));
    }
  } catch (_) {}
}
function onChange(e) {
  try {
    _logN34ToDiaryIfChanged_();
  } catch (_) {}
}


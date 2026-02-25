/******************************************************
 * ============================
 *  B) funding.gs (Vercel -> Sheets + Optimizer)
 *  ✅ PATCHED: store timestamps as KST ISO strings (+09:00)
 *    - Replaces all new Date().toISOString() used for 기록 timestamp with funding_nowKstIso_()
 *    - Affects: 8h history, lighter hourly, bootstrap, updateCurrentNow fallback asOf
 *
 *  ✅ ADDED: Rolling funding PnL estimator (3/7/15d)  ← (cost 개념 완전 제거)
 *    - Uses funding_history(8h) rolling avg funding_rate_8h
 *    - Writes avg/cnt/coverage/source + pnl into positions sheet
 *    - 부족한 히스토리: coverage 부족하면 avg=0, source="insufficient->0" (지금 방식 그대로)
 *    - positions 우측에 TOTAL pnl(3/7/15) + exchange별 pnl(3/7/15) 요약 출력
 * ============================
 ******************************************************/

/**
 * funding.gs
 * Funding updater (Vercel -> Google Sheets)
 *
 * - Reads Vercel API URL from Script Properties first, then config sheet (key=funding_api_url)
 * - Writes latest snapshot to funding_current (overwrite) in the CURRENT spreadsheet
 * - Appends to funding_history in a SEPARATE spreadsheet (history archive)
 *
 * Hourly cadence 전략:
 * - Vercel은 거래소별 raw 주기(source_interval_s) + 8h 정규화값(funding_rate_8h)을 함께 반환
 * - Apps Script는 1시간 주기 거래소를 매시각 저장(lighter_hourly_history 탭 재사용)
 *   (버킷: 매시각 HH:59, 실행이 55~다음시각 05로 튀어도 같은 슬롯에 1번만 기록)
 * - 8시간 스냅샷(00:59/08:59/16:59) 기록 시,
 *   hourly 기록의 최근 8시간 평균으로 funding_rate_8h를 대체해서 기록
 *   (버킷: HH:59 기준으로 55~다음시각 05 허용, 슬롯당 1번만 기록)
 */

// ✅ 기본 히스토리 전용 스프레드시트 ID (fallback only)
const DEFAULT_HISTORY_SPREADSHEET_ID = "1MnV7-0CUWtzTIaR8sJ3pgZiGX-FNyMgg-6IGLHx8r9w";

// sheet names (current spreadsheet)
const FUNDING_SHEET_CONFIG = "config";
const FUNDING_SHEET_CURRENT = "funding_current";
const FUNDING_SHEET_POSITIONS = "positions";

// history spreadsheet sheet names
const FUNDING_SHEET_HISTORY_8H = "funding_history";
const FUNDING_SHEET_HOURLY = "lighter_hourly_history"; // legacy name 유지
const FUNDING_SHEET_LIGHTER_HOURLY = "lighter_hourly_history";

const FUNDING_HOURLY_EXCHANGES_CONFIG_KEY = "hourly_exchanges";
const FUNDING_DEFAULT_HOURLY_EXCHANGES = ["lighter", "hyperliquid", "01xyz", "nado", "pacifica", "extended"];
const FUNDING_HOURLY_SOURCE_INTERVAL_MAX_S = 3600;
const FUNDING_HOURLY_LOOKBACK_HOURS = 8;
const FUNDING_LAST_SLOT_KEY_HOURLY = "FUNDING_LAST_SLOT_KEY_HOURLY";
const FUNDING_LAST_SLOT_KEY_LIGHTER_HOURLY = "FUNDING_LAST_SLOT_KEY_LIGHTER_HOURLY"; // backward compat

const EX_ORDER = { variational: 0, binance: 1, lighter: 2, hyperliquid: 3, "01xyz": 4, nado: 5, pacifica: 6, paradex: 7, extended: 8 };

// default API URL
const DEFAULT_FUNDING_API_URL = "https://fundingrate-auto.vercel.app/api/funding-8h";

// Script Properties keys (보안/이관용)
const FUNDING_PROP_HISTORY_SPREADSHEET_ID = "FUNDING_HISTORY_SPREADSHEET_ID";
const FUNDING_PROP_LEGACY_HISTORY_SPREADSHEET_ID = "FUNDING_LEGACY_HISTORY_SPREADSHEET_ID";
const FUNDING_PROP_API_URL = "FUNDING_API_URL";
const FUNDING_PROP_SECURE_PREFIX = "FUNDING_CFG_";
const FUNDING_SECRET_MASK = "__SCRIPT_PROPERTY__";

// KST schedule: 00:59 / 08:59 / 16:59
const FUNDING_SCHEDULE_HOURS_KST = [0, 8, 16];
const FUNDING_SCHEDULE_MINUTE = 59;

// ✅ 버킷 허용 범위: (HH:59 기준) 55~(다음 시각)05
const SLOT_TOL_BEFORE_MIN = 50;
const SLOT_TOL_AFTER_MIN = 8;

// symbols
const TARGETS = ["BTC", "ETH", "SOL", "BNB"];

/** =========================
 * Rolling funding PnL config (strict: 부족하면 0)
 * ========================= */
const FUNDING_ROLL_MIN_COVERAGE = 0.5; // coverage < 0.5 => insufficient->0

// ===== Summary anchor (fixed write area) =====
const FUNDING_POS_SUMMARY_ANCHOR_PROP = "FUNDING_POS_SUMMARY_ANCHOR_COL";
const FUNDING_ROLLING_SUMMARY_ANCHOR_PROP = "FUNDING_ROLLING_SUMMARY_ANCHOR_COL";
const FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_PROP = "FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_COL";

/**
 * ✅ positions(8h/day) 요약 시작열 고정 앵커
 * - 이미 저장돼 있으면 그 값을 사용
 * - 없으면: 현재 마지막 컬럼 + 2 로 잡아서 저장
 */
function funding_getPositionsSummaryAnchorCol_(shPos) {
  const props = PropertiesService.getScriptProperties();
  const saved = Number(props.getProperty(FUNDING_POS_SUMMARY_ANCHOR_PROP) || 0);
  if (Number.isFinite(saved) && saved > 0) return saved;

  // Reuse existing left-most summary block if it exists.
  const existing = funding_findRow1TextCol_(shPos, "asOf");
  if (existing) {
    props.setProperty(FUNDING_POS_SUMMARY_ANCHOR_PROP, String(existing));
    return existing;
  }

  // Prefer anchoring next to core data headers, not sheet tail (prevents right drift).
  const endCol =
    funding_findRow1TextCol_(shPos, "funding_pnl_all_usd") ||
    funding_findRow1TextCol_(shPos, "funding_pnl_day_usd") ||
    shPos.getLastColumn();
  const anchor = endCol + 2;
  props.setProperty(FUNDING_POS_SUMMARY_ANCHOR_PROP, String(anchor));
  return anchor;
}

/**
 * ✅ rolling 요약 시작열 고정 앵커
 * - positions 요약 앵커 기준으로 오른쪽에 고정 배치 (겹침 방지)
 */
function funding_getRollingSummaryAnchorCol_(shPos) {
  const props = PropertiesService.getScriptProperties();
  const saved = Number(props.getProperty(FUNDING_ROLLING_SUMMARY_ANCHOR_PROP) || 0);
  if (Number.isFinite(saved) && saved > 0) return saved;

  // Reuse existing left-most rolling summary if present.
  const existing = funding_findRow1TextCol_(shPos, "ROLLING TOTAL funding_pnl");
  if (existing) {
    props.setProperty(FUNDING_ROLLING_SUMMARY_ANCHOR_PROP, String(existing));
    return existing;
  }

  const posAnchor = funding_getPositionsSummaryAnchorCol_(shPos);
  const anchor = posAnchor + 8; // pos 요약폭 5 + 여유 3
  props.setProperty(FUNDING_ROLLING_SUMMARY_ANCHOR_PROP, String(anchor));
  return anchor;
}

/**
 * ✅ 요약 앵커 리셋(레이아웃 다시 잡고 싶을 때)
 */
function funding_resetSummaryAnchors() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(FUNDING_POS_SUMMARY_ANCHOR_PROP);
  props.deleteProperty(FUNDING_ROLLING_SUMMARY_ANCHOR_PROP);
  props.deleteProperty(FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_PROP);
  safeAlert_("✅ Summary anchors reset. 다음 실행 시 새 위치로 고정됩니다.");
}

function funding_getOptRollingSummaryAnchorCol_(shOpt) {
  const props = PropertiesService.getScriptProperties();
  const saved = Number(props.getProperty(FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_PROP) || 0);
  if (Number.isFinite(saved) && saved > 0) return saved;

  const lastCol = shOpt.getLastColumn();
  const row1 = shOpt.getRange(1, 1, 1, Math.max(1, lastCol)).getValues()[0].map((v) => String(v || "").trim());

  // If summary already exists, reuse the left-most existing block.
  const existingCols = [];
  for (let i = 0; i < row1.length; i++) {
    if (row1[i] === "OPT ROLLING TOTAL funding_pnl") existingCols.push(i + 1);
  }
  if (existingCols.length > 0) {
    const anchor = existingCols[0];
    props.setProperty(FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_PROP, String(anchor));
    return anchor;
  }

  // Default anchor: right after fixed solution columns (note column).
  const noteCol = row1.indexOf("note") + 1; // 1-based
  const anchor = noteCol > 0 ? (noteCol + 2) : 11;
  props.setProperty(FUNDING_OPT_ROLLING_SUMMARY_ANCHOR_PROP, String(anchor));
  return anchor;
}

function funding_clearDuplicateOptRollingBlocks_(shOpt, keepCol) {
  const lastCol = shOpt.getLastColumn();
  if (lastCol < 1) return;
  const row1 = shOpt.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());
  const CLEAR_ROWS = 30;
  const WIDTH = 7;
  for (let i = 0; i < row1.length; i++) {
    if (row1[i] !== "OPT ROLLING TOTAL funding_pnl") continue;
    const c = i + 1;
    if (c === keepCol) continue;
    shOpt.getRange(1, c, CLEAR_ROWS, WIDTH).clearContent();
  }
}

function funding_clearDuplicatePositionsSummaryBlocks_(shPos, keepCol) {
  const lastCol = shPos.getLastColumn();
  if (lastCol < 1) return;
  const row1 = shPos.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());
  const SUMMARY_HEIGHT = 30;
  const SUMMARY_WIDTH = 5;
  for (let i = 0; i < row1.length; i++) {
    if (row1[i] !== "asOf") continue;
    const c = i + 1;
    if (c === keepCol) continue;
    shPos.getRange(1, c, SUMMARY_HEIGHT, SUMMARY_WIDTH).clearContent();
  }
}

function funding_clearDuplicateRollingSummaryBlocks_(shPos, keepCol) {
  const lastCol = shPos.getLastColumn();
  if (lastCol < 1) return;
  const row1 = shPos.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());
  const CLEAR_ROWS = 40;
  const SUMMARY_WIDTH = 7;
  for (let i = 0; i < row1.length; i++) {
    if (row1[i] !== "ROLLING TOTAL funding_pnl") continue;
    const c = i + 1;
    if (c === keepCol) continue;
    shPos.getRange(1, c, CLEAR_ROWS, SUMMARY_WIDTH).clearContent();
  }
}

/**
 * ✅ KST timestamp string (spreadsheet timezone 기준)
 * 예: 2026-01-16T08:57:45.203+09:00
 */
function funding_nowKstIso_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone(); // 보통 Asia/Seoul
  return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

/**
 * ✅ 임의 Date를 KST ISO 문자열로
 */
function funding_dateToKstIso_(d) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

/**
 * Funding menu
 */
function funding_addMenu_() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("Funding")
      .addItem("Init sheets (current/positions)", "funding_initSheets")
      .addSeparator()
      .addItem("Init optimizer sheets (opt_*)", "funding_initOptimizerSheets")
      .addItem("Refresh opt_rates (from funding_current)", "funding_refreshOptRates_")
      .addSeparator()
      .addItem("Update current now (no history)", "funding_updateCurrentNow")
      .addItem("Update positions PnL", "funding_updatePositionsPnl")
      .addItem("Seed positions rows (all exchanges)", "funding_seedPositionsTemplateRowsNow")
      .addItem("Update rolling funding PnL (3/7/15d)", "funding_updatePositionsRollingFundingPnl_3_7_15_30_all") // ✅ rolling pnl
      .addItem("Update OPT rolling funding PnL (3/7/15/30/all)", "funding_updateOptSolutionRollingFundingPnl_3_7_15_30_all")
      .addItem("Update current + positions", "funding_updateCurrentAndPositionsNow")
      .addSeparator()
      .addItem("Optimize allocation (maximize funding)", "funding_optimizeAllocation")
      .addItem("Estimate rebalance cost (positions -> opt)", "funding_estimateRebalanceTradingCostNow")
      .addSeparator()
      .addItem("Install 8h schedule + retry (00:59/08:59/16:59 KST)", "funding_install3xDailyTriggers")
      .addItem("Install hourly schedule (1h-cadence, every hour ~:59 KST)", "funding_installLighterHourlyTrigger")
      .addSeparator()
      .addItem("Bootstrap hourly history NOW (1 shot)", "funding_bootstrapLighterHourlySheetNow")
      .addSeparator()
      .addItem("Security setup (Script Properties)", "funding_setupDedicatedAccountSecurity_")
      .addItem("Migrate config secrets -> Script Properties", "funding_migrateConfigSecretsToScriptProperties")
      .addItem("Save legacy history id to Script Properties", "funding_setLegacyHistorySpreadsheetIdInScriptProperties")
      .addItem("Migrate legacy history (incremental)", "funding_migrateLegacyHistoryIncremental")
      .addItem("Verify history integrity (last 24h)", "funding_verifyHistoryIntegrityRecent24h")
      .addItem("Debug history access", "funding_debugHistorySpreadsheetAccess_")
      .addItem("Cutover freeze (remove triggers + read-only)", "funding_cutoverFreezeCurrentWorkbook")
      .addItem("Unfreeze workbook protections", "funding_unfreezeCurrentWorkbook")
      .addSeparator()
      .addItem("Remove Funding triggers", "funding_removeAllFundingTriggers")
      .addItem("Reset summary anchors", "funding_resetSummaryAnchors")
      .addToUi();
  } catch (e) {
    Logger.log("funding_addMenu_ skipped(no UI): " + e);
  }
}

/**
 * create/init config, funding_current, positions
 */
function funding_initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  funding_initSheet_(ss, FUNDING_SHEET_CONFIG, ["key", "value"]);
  funding_initSheet_(ss, FUNDING_SHEET_CURRENT, [
    "asOf",
    "exchange",
    "symbol",
    "funding_rate_8h",
    "interval_s",
    "mark_price",
  ]);

  // ✅ positions: rolling은 pnl만 (cost 컬럼 없음)
  const shPos = funding_initSheet_(ss, FUNDING_SHEET_POSITIONS, [
    "exchange",
    "symbol",
    "qty",
    "mark_price",
    "funding_rate_8h",
    "interval_s",
    "funding_pnl_8h_usd",
    "funding_pnl_day_usd",

    // rolling avg + coverage + pnl
    "avg_funding_3d",
    "cnt_3d",
    "coverage_3d",
    "avg_source_3d",
    "funding_pnl_3d_usd",

    "avg_funding_7d",
    "cnt_7d",
    "coverage_7d",
    "avg_source_7d",
    "funding_pnl_7d_usd",

    "avg_funding_15d",
    "cnt_15d",
    "coverage_15d",
    "avg_source_15d",
    "funding_pnl_15d_usd",

    "avg_funding_30d",
    "cnt_30d",
    "coverage_30d",
    "avg_source_30d",
    "funding_pnl_30d_usd",

    "avg_funding_all",
    "cnt_all",
    "coverage_all",
    "avg_source_all",
    "funding_pnl_all_usd",
  ]);

  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  if (!funding_findKeyRow_(shConfig, "funding_api_url")) {
    shConfig
      .getRange(shConfig.getLastRow() + 1, 1, 1, 2)
      .setValues([["funding_api_url", DEFAULT_FUNDING_API_URL]]);
  }
  if (!funding_findKeyRow_(shConfig, "funding_history_spreadsheet_id")) {
    shConfig
      .getRange(shConfig.getLastRow() + 1, 1, 1, 2)
      .setValues([["funding_history_spreadsheet_id", funding_getHistorySpreadsheetId_()]]);
  }
  if (!funding_findKeyRow_(shConfig, "legacy_history_spreadsheet_id")) {
    shConfig
      .getRange(shConfig.getLastRow() + 1, 1, 1, 2)
      .setValues([["legacy_history_spreadsheet_id", ""]]);
  }
  if (!funding_findKeyRow_(shConfig, FUNDING_HOURLY_EXCHANGES_CONFIG_KEY)) {
    shConfig
      .getRange(shConfig.getLastRow() + 1, 1, 1, 2)
      .setValues([[FUNDING_HOURLY_EXCHANGES_CONFIG_KEY, FUNDING_DEFAULT_HOURLY_EXCHANGES.join(",")]]);
  }

  const seeded = funding_ensurePositionTemplateRows_(
    shPos,
    funding_getPositionTemplateExchanges_(),
    TARGETS
  );

  safeAlert_(
    "✅ funding_initSheets 완료\n" +
    `- positions template rows appended: ${seeded.appended} (total template ${seeded.templateTotal})`
  );
}

/**
 * Manual: update funding_current only (no history)
 */
function funding_updateCurrentNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  const shCurrent = ss.getSheetByName(FUNDING_SHEET_CURRENT);

  if (!shConfig || !shCurrent) {
    throw new Error("config / funding_current 시트를 확인해줘. (Funding → Init sheets 먼저 실행)");
  }

  const apiUrl = funding_getApiUrl_(shConfig);
  if (!apiUrl) throw new Error("config 시트에 funding_api_url 값이 비어있어.");

  const data = funding_fetchJson_(apiUrl);

  // ✅ PATCH: fallback asOf도 KST로
  const asOf = data.asOf || funding_nowKstIso_();

  const rows = Array.isArray(data.rows) ? data.rows : [];
  funding_overwriteCurrent_(shCurrent, asOf, rows);
}

/**
 * Install 3 daily triggers near 00:59/08:59/16:59 (KST)
 */
function funding_install3xDailyTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "funding_recordHistorySnapshot") {
      ScriptApp.deleteTrigger(t);
    }
  }

  for (const hour of FUNDING_SCHEDULE_HOURS_KST) {
    ScriptApp.newTrigger("funding_recordHistorySnapshot")
      .timeBased()
      .everyDays(1)
      .atHour(hour)
      .nearMinute(FUNDING_SCHEDULE_MINUTE)
      .create();
  }

  // Reliability retry: run every 10 minutes, guard logic records only 8h slots.
  ScriptApp.newTrigger("funding_recordHistorySnapshot")
    .timeBased()
    .everyMinutes(10)
    .create();

  safeAlert_("✅ 8h 트리거 설치 완료 (daily 3 + retry every 10m)");
}

function funding_installLighterHourlyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "funding_recordLighterHourlySnapshot") {
      ScriptApp.deleteTrigger(t);
    }
  }

  ScriptApp.newTrigger("funding_recordLighterHourlySnapshot")
    .timeBased()
    .everyHours(1)
    .nearMinute(FUNDING_SCHEDULE_MINUTE)
    .create();

  safeAlert_("✅ Hourly(1h cadence) 트리거 설치 완료");
}

function funding_removeAllFundingTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    const fn = t.getHandlerFunction();
    if (fn === "funding_recordHistorySnapshot" || fn === "funding_recordLighterHourlySnapshot") {
      ScriptApp.deleteTrigger(t);
    }
  }
  safeAlert_("✅ Funding 트리거 제거 완료");
}

/**
 * Trigger target (8h)
 * - 버킷(슬롯) 방식: HH:59 기준 55~다음시각05 허용
 * - 슬롯당 1번만 기록
 */
function funding_recordHistorySnapshot() {
  const slotKey = funding_get8hSlotKeyKST_(new Date());
  if (!slotKey) return;

  const props = PropertiesService.getScriptProperties();
  const lastSlot = props.getProperty("FUNDING_LAST_SLOT_KEY_8H");
  if (lastSlot === slotKey) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  const shCurrent = ss.getSheetByName(FUNDING_SHEET_CURRENT);

  if (!shConfig || !shCurrent) {
    throw new Error("config / funding_current 시트를 확인해줘. (Funding → Init sheets 먼저 실행)");
  }

  const apiUrl = funding_getApiUrl_(shConfig);
  if (!apiUrl) throw new Error("config 시트에 funding_api_url 값이 비어있어.");

  const data = funding_fetchJson_(apiUrl);

  // ✅ PATCH: asOf 없을 때만 KST로 보정
  const asOf = data.asOf || funding_nowKstIso_();

  // ✅ PATCH: history timestamp는 무조건 KST 실행시각
  const ts = funding_nowKstIso_();

  let rows = Array.isArray(data.rows) ? data.rows : [];

  // ✅ hourly history 기반 8h 평균값 계산 (exchange|symbol 단위)
  const hourlyAgg = funding_get8hAvgFromHourly_();
  if (hourlyAgg && hourlyAgg.size) {
    rows = rows.map((r) => {
      const ex = String(r.exchange || "").toLowerCase();
      const sym = String(r.symbol || "").toUpperCase();
      const info = hourlyAgg.get(`${ex}|${sym}`);
      if (!info) return r;

      const avg = info.avg;
      const n = info.n;
      if (avg == null || n === 0) return r;

      return Object.assign({}, r, {
        funding_rate_8h: avg,
        funding_rate_next_interval: avg,
        funding_interval_s: 28800,
        hourly_source: `hourly:avg_8h_n${n}`,
      });
    });
  }

  funding_appendHistory8h_(ts, rows);               // ✅ KST timestamp
  funding_overwriteCurrent_(shCurrent, asOf, rows); // ✅ current는 API asOf 유지(없으면 KST)

  props.setProperty("FUNDING_LAST_SLOT_KEY_8H", slotKey);
}

/**
 * Trigger target (hourly): only Lighter rows
 * - 버킷(슬롯) 방식: HH:59 기준 55~다음시각05 허용
 * - 슬롯당 1번만 기록
 */
function funding_recordLighterHourlySnapshot() {
  const hourKey = funding_getHourlyKeyKST_(new Date());
  if (!hourKey) return;

  const props = PropertiesService.getScriptProperties();
  const lastKey = props.getProperty(FUNDING_LAST_SLOT_KEY_HOURLY) || props.getProperty(FUNDING_LAST_SLOT_KEY_LIGHTER_HOURLY);
  if (lastKey === hourKey) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  if (!shConfig) throw new Error("config 시트를 확인해줘. (Funding → Init sheets 먼저 실행)");

  const apiUrl = funding_getApiUrl_(shConfig);
  if (!apiUrl) throw new Error("config 시트에 funding_api_url 값이 비어있어.");

  const data = funding_fetchJson_(apiUrl);

  // ✅ PATCH: hourly history도 실행시각(KST)로 고정
  const ts = funding_nowKstIso_();

  const rows = Array.isArray(data.rows) ? data.rows : [];

  const hourlyRows = funding_pickHourlyRows_(rows, shConfig);
  if (hourlyRows.length) {
    funding_appendHourlySnapshots_(ts, hourlyRows);
  }

  props.setProperty(FUNDING_LAST_SLOT_KEY_HOURLY, hourKey);
  props.setProperty(FUNDING_LAST_SLOT_KEY_LIGHTER_HOURLY, hourKey);
}

/**
 * ✅ 8h 슬롯 키 (HH:59 기준)
 * - 허용: 55~59 => 해당 hour의 HH:59 슬롯
 * - 허용: 00~05 => "직전 hour"의 HH:59 슬롯 (예: 01:02 실행 => 00:59 슬롯)
 * - hour가 0/8/16인 슬롯만 통과
 */
function funding_get8hSlotKeyKST_(dateObj) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const hour = Number(Utilities.formatDate(dateObj, tz, "H")); // 0~23
  const minute = Number(Utilities.formatDate(dateObj, tz, "m")); // 0~59

  const inWindow = minute >= SLOT_TOL_BEFORE_MIN || minute <= SLOT_TOL_AFTER_MIN;
  if (!inWindow) return null;

  // minute <= after => "직전 hour" 슬롯로 귀속
  const bucketDate = new Date(dateObj.getTime());
  if (minute <= SLOT_TOL_AFTER_MIN) bucketDate.setHours(bucketDate.getHours() - 1);

  const bucketHour = Number(Utilities.formatDate(bucketDate, tz, "H"));
  if (!FUNDING_SCHEDULE_HOURS_KST.includes(bucketHour)) return null;

  const ymd = Utilities.formatDate(bucketDate, tz, "yyyy-MM-dd");
  return `${ymd} ${String(bucketHour).padStart(2, "0")}:59`;
}

/**
 * ✅ Hourly 슬롯 키 (HH:59 기준)
 * - 허용: 55~59 => 해당 hour의 HH:59 슬롯
 * - 허용: 00~05 => "직전 hour"의 HH:59 슬롯
 */
function funding_getHourlyKeyKST_(dateObj) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const minute = Number(Utilities.formatDate(dateObj, tz, "m"));

  const inWindow = minute >= SLOT_TOL_BEFORE_MIN || minute <= SLOT_TOL_AFTER_MIN;
  if (!inWindow) return null;

  const bucketDate = new Date(dateObj.getTime());
  if (minute <= SLOT_TOL_AFTER_MIN) bucketDate.setHours(bucketDate.getHours() - 1);

  const ymd = Utilities.formatDate(bucketDate, tz, "yyyy-MM-dd");
  const bucketHour = Number(Utilities.formatDate(bucketDate, tz, "H"));
  return `${ymd} ${String(bucketHour).padStart(2, "0")}:59`;
}

/** -------- history (separate spreadsheet): 8h -------- */
function funding_appendHistory8h_(timestampKstIso, rows) {
  const historyId = funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id가 비어있어.");

  const histSS = SpreadsheetApp.openById(historyId);
  const sh = histSS.getSheetByName(FUNDING_SHEET_HISTORY_8H) || histSS.insertSheet(FUNDING_SHEET_HISTORY_8H);

  // ✅ 새로 생성될 때만 timestamp_kst 헤더 생성 (기존 시트는 건드리지 않음)
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 6).setValues([[
      "timestamp_kst", "exchange", "symbol", "funding_rate_8h", "interval_s", "mark_price"
    ]]);
  }

  const values = rows.map((r) => [
    timestampKstIso,
    r.exchange,
    r.symbol,
    r.funding_rate_8h,
    r.funding_interval_s ?? r.interval_s ?? "",
    r.mark_price ?? "",
  ]);

  if (values.length) {
    sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  }
}

/** -------- history (separate spreadsheet): hourly (legacy lighter_hourly_history 탭 재사용) -------- */
function funding_appendHourlySnapshots_(timestampKstIso, hourlyRows) {
  const historyId = funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id가 비어있어.");

  const histSS = SpreadsheetApp.openById(historyId);
  const sh = histSS.getSheetByName(FUNDING_SHEET_HOURLY) || histSS.insertSheet(FUNDING_SHEET_HOURLY);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 6).setValues([[
      "timestamp_kst", "exchange", "symbol", "funding_rate_8h", "interval_s", "mark_price"
    ]]);
  }

  const values = hourlyRows
    .map((r) => {
      const ex = String(r.exchange || "").toLowerCase();
      const sym = String(r.symbol || "").toUpperCase();
      if (!ex || !TARGETS.includes(sym)) return null;

      const sourceIntervalS = funding_getRowSourceIntervalSeconds_(r) || 3600;

      return [
        timestampKstIso,
        ex,
        sym,
        r.funding_rate_8h,
        sourceIntervalS,
        r.mark_price ?? "",
      ];
    })
    .filter(Boolean);

  if (values.length) {
    sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  }
}

/**
 * backward compatible alias
 */
function funding_appendLighterHourly_(timestampKstIso, lighterRows) {
  funding_appendHourlySnapshots_(timestampKstIso, lighterRows);
}

/**
 * 최근 8시간 hourly 기록을 exchange|symbol 단위 평균으로 집계
 */
function funding_get8hAvgFromHourly_() {
  try {
    const historyId = funding_getHistorySpreadsheetId_();
    if (!historyId) return null;
    const histSS = SpreadsheetApp.openById(historyId);
    const sh = histSS.getSheetByName(FUNDING_SHEET_HOURLY);
    if (!sh || sh.getLastRow() < 2) return null;

    const lastRow = sh.getLastRow();
    const startRow = Math.max(2, lastRow - 4000 + 1);
    const numRows = lastRow - startRow + 1;

    const vals = sh.getRange(startRow, 1, numRows, 6).getValues();
    const cut = new Date(Date.now() - FUNDING_HOURLY_LOOKBACK_HOURS * 3600 * 1000);
    const acc = new Map();

    for (const row of vals) {
      const tsRaw = row[0];
      const d = (Object.prototype.toString.call(tsRaw) === "[object Date]" && !isNaN(tsRaw.getTime()))
        ? tsRaw
        : new Date(String(tsRaw || "").trim());
      if (!(d instanceof Date) || isNaN(d.getTime()) || d < cut) continue;

      const ex = String(row[1] || "").toLowerCase();
      const sym = String(row[2] || "").toUpperCase();
      if (!ex || !TARGETS.includes(sym)) continue;

      const rate = Number(row[3]);
      if (!Number.isFinite(rate)) continue;

      const key = `${ex}|${sym}`;
      if (!acc.has(key)) acc.set(key, { sum: 0, cnt: 0 });
      const item = acc.get(key);
      item.sum += rate;
      item.cnt += 1;
    }

    const out = new Map();
    for (const [key, v] of acc.entries()) {
      if (!v.cnt) continue;
      out.set(key, { avg: v.sum / v.cnt, n: v.cnt });
    }
    return out;
  } catch (e) {
    return null;
  }
}

/**
 * backward compatible alias
 */
function funding_getLighter8hAvgFromHourly_() {
  const agg = funding_get8hAvgFromHourly_();
  if (!agg) return null;

  const out = {};
  for (const sym of TARGETS) {
    const v = agg.get(`lighter|${sym}`);
    out[sym] = v ? { avg: v.avg, n: v.n } : { avg: null, n: 0 };
  }
  return out;
}

/** -------- current overwrite -------- */
function funding_overwriteCurrent_(shCurrent, asOf, rows) {
  if (shCurrent.getLastRow() === 0) {
    shCurrent
      .getRange(1, 1, 1, 6)
      .setValues([["asOf", "exchange", "symbol", "funding_rate_8h", "interval_s", "mark_price"]]);
  }

  const lastRow = shCurrent.getLastRow();
  if (lastRow > 1) shCurrent.getRange(2, 1, lastRow - 1, 6).clearContent();

  const exOrder = EX_ORDER;
  rows.sort((a, b) => {
    const ea = exOrder[String(a.exchange || "").toLowerCase()] ?? 99;
    const eb = exOrder[String(b.exchange || "").toLowerCase()] ?? 99;
    if (ea !== eb) return ea - eb;
    return (
      TARGETS.indexOf(String(a.symbol || "").toUpperCase()) -
      TARGETS.indexOf(String(b.symbol || "").toUpperCase())
    );
  });

  const currentValues = rows.map((r) => [
    asOf,
    r.exchange,
    r.symbol,
    r.funding_rate_8h,
    r.funding_interval_s ?? r.interval_s ?? "",
    r.mark_price ?? "",
  ]);

  if (currentValues.length) {
    shCurrent.getRange(2, 1, currentValues.length, currentValues[0].length).setValues(currentValues);
  }
}

/** -------- utilities -------- */
function funding_fetchJson_(url) {
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code}: ${text}`);
  return JSON.parse(text);
}
function funding_initSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}
function funding_getConfigValue_(shConfig, key) {
  if (!shConfig) return "";
  const values = shConfig.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) if (values[i][0] === key) return values[i][1];
  return "";
}
function funding_findKeyRow_(shConfig, key) {
  if (!shConfig) return null;
  const values = shConfig.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) if (values[i][0] === key) return i + 1;
  return null;
}

function funding_getHourlyExchangeSet_(shConfig) {
  const configured = String(funding_getConfigValue_(shConfig, FUNDING_HOURLY_EXCHANGES_CONFIG_KEY) || "").trim();
  const set = new Set(FUNDING_DEFAULT_HOURLY_EXCHANGES);
  if (!configured) return set;

  const items = configured
    .split(",")
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  for (const ex of items) set.add(ex);
  return set;
}

function funding_getRowSourceIntervalSeconds_(row) {
  const v =
    Number(row?.source_interval_s) ||
    Number(row?.funding_source_interval_s) ||
    Number(row?.funding_interval_source_s) ||
    Number(row?.interval_source_s) ||
    Number(row?.source_interval) ||
    Number(row?.funding_interval_raw_s) ||
    0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function funding_isHourlyCadenceRow_(row, hourlyExSet) {
  const ex = String(row?.exchange || "").trim().toLowerCase();
  const sym = String(row?.symbol || "").trim().toUpperCase();
  if (!ex || !TARGETS.includes(sym)) return false;

  const srcIntervalS = funding_getRowSourceIntervalSeconds_(row);
  if (srcIntervalS > 0) {
    return srcIntervalS <= FUNDING_HOURLY_SOURCE_INTERVAL_MAX_S;
  }

  return hourlyExSet.has(ex);
}

function funding_pickHourlyRows_(rows, shConfig) {
  const hourlyExSet = funding_getHourlyExchangeSet_(shConfig);
  return (rows || []).filter((r) => funding_isHourlyCadenceRow_(r, hourlyExSet));
}

function funding_getPositionTemplateExchanges_() {
  return Object.entries(EX_ORDER)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([ex]) => String(ex || "").toLowerCase());
}

function funding_ensurePositionTemplateRows_(shPos, exchanges, symbols) {
  if (!shPos) throw new Error("positions 시트를 찾을 수 없어.");

  const lastCol = Math.max(1, shPos.getLastColumn());
  const header = shPos.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());

  const iEx = header.indexOf("exchange");
  const iSym = header.indexOf("symbol");
  const iQty = header.indexOf("qty");
  if (iEx < 0 || iSym < 0) {
    throw new Error("positions 헤더에 exchange/symbol가 필요해.");
  }

  const existing = new Set();
  const lastRow = shPos.getLastRow();
  if (lastRow >= 2) {
    const vals = shPos.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (const row of vals) {
      const ex = String(row[iEx] || "").trim().toLowerCase();
      const sym = String(row[iSym] || "").trim().toUpperCase();
      if (!ex || !sym) continue;
      existing.add(`${ex}|${sym}`);
    }
  }

  const exList = (exchanges || []).map((ex) => String(ex || "").trim().toLowerCase()).filter(Boolean);
  const symList = (symbols || []).map((sym) => String(sym || "").trim().toUpperCase()).filter(Boolean);

  const out = [];
  for (const ex of exList) {
    for (const sym of symList) {
      const key = `${ex}|${sym}`;
      if (existing.has(key)) continue;

      const row = Array(lastCol).fill("");
      row[iEx] = ex;
      row[iSym] = sym;
      if (iQty >= 0) row[iQty] = 0;
      out.push(row);
      existing.add(key);
    }
  }

  if (out.length) {
    shPos.getRange(shPos.getLastRow() + 1, 1, out.length, lastCol).setValues(out);
  }

  return {
    appended: out.length,
    templateTotal: exList.length * symList.length,
  };
}

function funding_seedPositionsTemplateRowsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shPos = ss.getSheetByName(FUNDING_SHEET_POSITIONS);
  if (!shPos) throw new Error("positions 시트를 찾을 수 없어. Init sheets 먼저 실행해줘.");

  const seeded = funding_ensurePositionTemplateRows_(
    shPos,
    funding_getPositionTemplateExchanges_(),
    TARGETS
  );

  safeAlert_(
    "✅ positions template rows 반영 완료\n" +
    `- appended: ${seeded.appended}\n` +
    `- template total: ${seeded.templateTotal}`
  );
}

function funding_getScriptProps_() {
  return PropertiesService.getScriptProperties();
}

function funding_extractSpreadsheetId_(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";

  const m1 = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m1 && m1[1]) return m1[1];

  const m2 = s.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (m2 && m2[1]) return m2[1];

  return s;
}

function funding_isLikelySpreadsheetId_(id) {
  return /^[a-zA-Z0-9-_]{20,}$/.test(String(id || ""));
}

function funding_openSpreadsheetByIdSafe_(id, label) {
  const normalized = funding_extractSpreadsheetId_(id);
  if (!normalized) {
    throw new Error(`${label} spreadsheet id가 비어있어.`);
  }
  if (!funding_isLikelySpreadsheetId_(normalized)) {
    throw new Error(`${label} spreadsheet id 형식이 이상해. (value=${normalized})`);
  }
  try {
    return SpreadsheetApp.openById(normalized);
  } catch (e) {
    throw new Error(
      `${label} openById 실패: ${String(e && e.message ? e.message : e)}\n` +
      `id=${normalized}\n` +
      `- 시트 공유(편집권한) 여부와 id 값을 확인해줘.`
    );
  }
}

function funding_getHistorySpreadsheetId_() {
  const props = funding_getScriptProps_();
  const idProp = funding_extractSpreadsheetId_(props.getProperty(FUNDING_PROP_HISTORY_SPREADSHEET_ID));
  if (idProp) return idProp;
  return funding_extractSpreadsheetId_(DEFAULT_HISTORY_SPREADSHEET_ID);
}

function funding_getLegacyHistorySpreadsheetId_() {
  const props = funding_getScriptProps_();
  return funding_extractSpreadsheetId_(props.getProperty(FUNDING_PROP_LEGACY_HISTORY_SPREADSHEET_ID));
}

function funding_getApiUrl_(shConfig) {
  const props = funding_getScriptProps_();
  const fromProp = String(props.getProperty(FUNDING_PROP_API_URL) || "").trim();
  if (fromProp) return fromProp;
  const fromConfig = String(funding_getConfigValue_(shConfig, "funding_api_url") || "").trim();
  return fromConfig || DEFAULT_FUNDING_API_URL;
}

function funding_setConfigValue_(shConfig, key, value) {
  if (!shConfig) return;
  const row = funding_findKeyRow_(shConfig, key);
  if (row) {
    shConfig.getRange(row, 2).setValue(value);
    return;
  }
  shConfig.getRange(shConfig.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
}

function funding_getSecureConfigValue_(shConfig, key) {
  const props = funding_getScriptProps_();
  const propKey = funding_configKeyToPropKey_(key);
  const fromProp = String(props.getProperty(propKey) || "").trim();
  if (fromProp) return fromProp;

  const fromConfig = funding_getConfigValue_(shConfig, key);
  const raw = String(fromConfig == null ? "" : fromConfig).trim();
  if (!raw || raw === FUNDING_SECRET_MASK) return "";
  return fromConfig;
}

function funding_configKeyToPropKey_(key) {
  return FUNDING_PROP_SECURE_PREFIX + String(key || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function funding_isSensitiveConfigKey_(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return false;
  if (k === "funding_api_url" || k === "funding_history_spreadsheet_id" || k === "legacy_history_spreadsheet_id") {
    return false;
  }
  return /(key|secret|token|password|passwd|private|client_secret|access_key|api_key)/i.test(k);
}

function funding_removeFundingTriggersSilent_() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    const fn = t.getHandlerFunction();
    if (fn === "funding_recordHistorySnapshot" || fn === "funding_recordLighterHourlySnapshot") {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  return removed;
}

function funding_setupDedicatedAccountSecurity_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG) || funding_initSheet_(ss, FUNDING_SHEET_CONFIG, ["key", "value"]);
  const props = funding_getScriptProps_();

  const apiUrl = funding_getApiUrl_(shConfig);
  props.setProperty(FUNDING_PROP_API_URL, apiUrl);

  const historyFromConfig = funding_extractSpreadsheetId_(funding_getConfigValue_(shConfig, "funding_history_spreadsheet_id"));
  const historyId = historyFromConfig || funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id를 찾을 수 없어.");
  funding_openSpreadsheetByIdSafe_(historyId, "target history");
  props.setProperty(FUNDING_PROP_HISTORY_SPREADSHEET_ID, historyId);

  funding_setConfigValue_(shConfig, "funding_api_url", apiUrl);
  funding_setConfigValue_(shConfig, "funding_history_spreadsheet_id", historyId);
  funding_migrateConfigSecretsToScriptProperties(true);

  safeAlert_(
    "✅ Security setup 완료\n" +
      `- Script Properties: ${FUNDING_PROP_API_URL}, ${FUNDING_PROP_HISTORY_SPREADSHEET_ID}\n` +
      "- config 시트 민감값은 Script Properties로 마이그레이션됨"
  );
}

function funding_migrateConfigSecretsToScriptProperties(silent) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  if (!shConfig) throw new Error("config 시트를 찾을 수 없어. funding_initSheets 먼저 실행해줘.");

  const props = funding_getScriptProps_();
  const vals = shConfig.getDataRange().getValues();
  if (vals.length < 2) return;

  let moved = 0;
  for (let i = 1; i < vals.length; i++) {
    const key = String(vals[i][0] || "").trim();
    const value = vals[i][1];
    const strVal = String(value == null ? "" : value).trim();
    if (!key || !strVal || strVal === FUNDING_SECRET_MASK) continue;
    if (!funding_isSensitiveConfigKey_(key)) continue;

    const propKey = funding_configKeyToPropKey_(key);
    props.setProperty(propKey, strVal);
    shConfig.getRange(i + 1, 2).setValue(FUNDING_SECRET_MASK);
    moved++;
  }

  if (silent) return;

  if (moved > 0) {
    safeAlert_(`✅ config 민감값 ${moved}건을 Script Properties로 이관했어.`);
  } else {
    safeAlert_("ℹ️ 이관할 민감 config 값이 없었어.");
  }
}

function funding_setLegacyHistorySpreadsheetIdInScriptProperties() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  if (!shConfig) throw new Error("config 시트를 찾을 수 없어.");

  const legacyId = funding_extractSpreadsheetId_(funding_getConfigValue_(shConfig, "legacy_history_spreadsheet_id"));
  if (!legacyId) throw new Error("config 시트의 legacy_history_spreadsheet_id 값을 먼저 입력해줘.");
  funding_openSpreadsheetByIdSafe_(legacyId, "legacy history");

  const props = funding_getScriptProps_();
  props.setProperty(FUNDING_PROP_LEGACY_HISTORY_SPREADSHEET_ID, legacyId);
  safeAlert_("✅ legacy history spreadsheet id를 Script Properties에 저장했어.");
}

function funding_getHistoryHeadersBySheetName_(sheetName) {
  return ["timestamp_kst", "exchange", "symbol", "funding_rate_8h", "interval_s", "mark_price"];
}

function funding_extractHistoryKey_(header, row) {
  const iTs = header.indexOf("timestamp_kst") >= 0 ? header.indexOf("timestamp_kst") : header.indexOf("timestamp");
  const iEx = header.indexOf("exchange");
  const iSym = header.indexOf("symbol");
  if (iTs < 0 || iEx < 0 || iSym < 0) return "";

  const ts = String(row[iTs] || "").trim();
  const ex = String(row[iEx] || "").trim().toLowerCase();
  const sym = String(row[iSym] || "").trim().toUpperCase();
  if (!ts || !ex || !sym) return "";
  return `${ts}|${ex}|${sym}`;
}

function funding_copyHistorySheetIncremental_(legacyId, targetId, sheetName) {
  const srcSS = funding_openSpreadsheetByIdSafe_(legacyId, "legacy history");
  const dstSS = funding_openSpreadsheetByIdSafe_(targetId, "target history");

  const src = srcSS.getSheetByName(sheetName);
  if (!src || src.getLastRow() < 2) return { sheet: sheetName, scanned: 0, appended: 0, skipped: 0 };

  const headers = funding_getHistoryHeadersBySheetName_(sheetName);
  const dst = dstSS.getSheetByName(sheetName) || dstSS.insertSheet(sheetName);
  if (dst.getLastRow() === 0) dst.getRange(1, 1, 1, headers.length).setValues([headers]);

  const srcVals = src.getDataRange().getValues();
  const srcHeader = srcVals[0].map((v) => String(v || "").trim());
  const dstVals = dst.getDataRange().getValues();
  const dstHeader = (dstVals[0] || headers).map((v) => String(v || "").trim());

  const existing = new Set();
  for (let i = 1; i < dstVals.length; i++) {
    const k = funding_extractHistoryKey_(dstHeader, dstVals[i]);
    if (k) existing.add(k);
  }

  let scanned = 0;
  let appended = 0;
  let skipped = 0;
  const out = [];

  for (let i = 1; i < srcVals.length; i++) {
    const row = srcVals[i];
    scanned++;
    const k = funding_extractHistoryKey_(srcHeader, row);
    if (!k || existing.has(k)) {
      skipped++;
      continue;
    }

    const mapped = dstHeader.map((h) => {
      const j = srcHeader.indexOf(h);
      return j >= 0 ? row[j] : "";
    });
    out.push(mapped);
    existing.add(k);
    appended++;
  }

  if (out.length > 0) {
    dst.getRange(dst.getLastRow() + 1, 1, out.length, dstHeader.length).setValues(out);
  }

  return { sheet: sheetName, scanned, appended, skipped };
}

function funding_migrateLegacyHistoryIncremental() {
  const legacyId = funding_extractSpreadsheetId_(funding_getLegacyHistorySpreadsheetId_());
  if (!legacyId) throw new Error("FUNDING_LEGACY_HISTORY_SPREADSHEET_ID가 비어있어. 먼저 설정해줘.");

  const targetId = funding_extractSpreadsheetId_(funding_getHistorySpreadsheetId_());
  if (!targetId) throw new Error("FUNDING_HISTORY_SPREADSHEET_ID가 비어있어.");
  if (legacyId === targetId) throw new Error("legacy/target history id가 동일해. 값을 다시 확인해줘.");

  const srcSS = funding_openSpreadsheetByIdSafe_(legacyId, "legacy history");
  const dstSS = funding_openSpreadsheetByIdSafe_(targetId, "target history");

  const r1 = funding_copyHistorySheetIncremental_(legacyId, targetId, FUNDING_SHEET_HISTORY_8H);
  const r2 = funding_copyHistorySheetIncremental_(legacyId, targetId, FUNDING_SHEET_LIGHTER_HOURLY);

  safeAlert_(
    "✅ Legacy history 증분 이관 완료\n" +
      `- legacy: ${srcSS.getName()} (${legacyId})\n` +
      `- target: ${dstSS.getName()} (${targetId})\n` +
      `- ${r1.sheet}: scanned=${r1.scanned}, appended=${r1.appended}, skipped=${r1.skipped}\n` +
      `- ${r2.sheet}: scanned=${r2.scanned}, appended=${r2.appended}, skipped=${r2.skipped}`
  );
}

function funding_collectHistoryKeySetRecentHours_(spreadsheetId, sheetName, hours) {
  const ss = funding_openSpreadsheetByIdSafe_(spreadsheetId, `history(${sheetName})`);
  const sh = ss.getSheetByName(sheetName);
  const out = new Set();
  if (!sh || sh.getLastRow() < 2) return out;

  const vals = sh.getDataRange().getValues();
  const header = vals[0].map((v) => String(v || "").trim());
  const iTs = header.indexOf("timestamp_kst") >= 0 ? header.indexOf("timestamp_kst") : header.indexOf("timestamp");
  if (iTs < 0) return out;

  const cut = new Date(Date.now() - Number(hours || 24) * 3600 * 1000);

  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    const tsRaw = row[iTs];
    const d = Object.prototype.toString.call(tsRaw) === "[object Date]" ? tsRaw : new Date(String(tsRaw || "").trim());
    if (!(d instanceof Date) || isNaN(d.getTime()) || d < cut) continue;

    const k = funding_extractHistoryKey_(header, row);
    if (k) out.add(k);
  }
  return out;
}

function funding_debugHistorySpreadsheetAccess_() {
  const legacyId = funding_extractSpreadsheetId_(funding_getLegacyHistorySpreadsheetId_());
  const targetId = funding_extractSpreadsheetId_(funding_getHistorySpreadsheetId_());
  const lines = [];

  lines.push(`legacy_id=${legacyId || "(empty)"}`);
  lines.push(`target_id=${targetId || "(empty)"}`);

  try {
    const s1 = funding_openSpreadsheetByIdSafe_(legacyId, "legacy history");
    lines.push(`legacy_ok=${s1.getName()}`);
  } catch (e) {
    lines.push(`legacy_fail=${String(e && e.message ? e.message : e)}`);
  }

  try {
    const s2 = funding_openSpreadsheetByIdSafe_(targetId, "target history");
    lines.push(`target_ok=${s2.getName()}`);
  } catch (e) {
    lines.push(`target_fail=${String(e && e.message ? e.message : e)}`);
  }

  safeAlert_(lines.join("\n"));
}

function funding_verifyHistoryIntegrityRecent24h() {
  const legacyId = funding_getLegacyHistorySpreadsheetId_();
  if (!legacyId) throw new Error("FUNDING_LEGACY_HISTORY_SPREADSHEET_ID가 비어있어. 먼저 설정해줘.");

  const targetId = funding_getHistorySpreadsheetId_();
  if (!targetId) throw new Error("FUNDING_HISTORY_SPREADSHEET_ID가 비어있어.");

  const sheets = [FUNDING_SHEET_HISTORY_8H, FUNDING_SHEET_LIGHTER_HOURLY];
  const lines = [];

  for (const name of sheets) {
    const src = funding_collectHistoryKeySetRecentHours_(legacyId, name, 24);
    const dst = funding_collectHistoryKeySetRecentHours_(targetId, name, 24);

    let missing = 0;
    for (const k of src) if (!dst.has(k)) missing++;
    lines.push(`${name}: legacy=${src.size}, target=${dst.size}, missing_in_target=${missing}`);
  }

  safeAlert_("✅ 최근 24h 히스토리 무결성 체크\n" + lines.join("\n"));
}

function funding_cutoverFreezeCurrentWorkbook() {
  const removed = funding_removeFundingTriggersSilent_();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const me = Session.getEffectiveUser().getEmail();
  const sheets = ss.getSheets();
  const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
  let protectedCount = 0;

  for (const sh of sheets) {
    const p = sh.protect().setDescription(`[funding-cutover] ${stamp}`);
    p.setWarningOnly(false);
    const editors = p.getEditors();
    if (editors && editors.length) {
      for (const ed of editors) {
        const email = String(ed.getEmail ? ed.getEmail() : "").trim();
        if (email && email === me) continue;
        try {
          p.removeEditor(ed);
        } catch (_) {}
      }
    }
    if (me) p.addEditor(me);
    if (p.canDomainEdit()) p.setDomainEdit(false);
    protectedCount++;
  }

  safeAlert_(
    "✅ Cutover freeze 완료\n" +
      `- removed funding triggers: ${removed}\n` +
      `- protected sheets: ${protectedCount}`
  );
}

function funding_unfreezeCurrentWorkbook() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  let removed = 0;
  for (const sh of sheets) {
    const protections = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (const p of protections) {
      const desc = String(p.getDescription() || "");
      if (desc.indexOf("[funding-cutover]") === 0) {
        p.remove();
        removed++;
      }
    }
  }
  safeAlert_(`✅ cutover 보호 해제 완료: ${removed}개 보호 제거`);
}

/***********************
 * ✅ positions PnL + 요약표(총 펀딩/거래소별 gross/dir)
 ***********************/
function funding_updatePositionsPnl() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shPos = ss.getSheetByName(FUNDING_SHEET_POSITIONS);
  const shCur = ss.getSheetByName(FUNDING_SHEET_CURRENT);

  if (!shPos || !shCur) {
    throw new Error("positions / funding_current 시트를 찾을 수 없어. (Funding → Init sheets 먼저 실행)");
  }

  const curVals = shCur.getDataRange().getValues();
  if (curVals.length < 2) throw new Error("funding_current에 데이터가 없어. 먼저 Update current now 실행해줘.");

  const header = curVals[0].map(String);
  const idx = (name) => header.indexOf(name);

  const iAsOf = idx("asOf");
  const iEx = idx("exchange");
  const iSym = idx("symbol");
  const iRate8h = idx("funding_rate_8h");
  const iInterval = idx("interval_s");
  const iMark = idx("mark_price");

  if ([iEx, iSym, iRate8h, iInterval, iMark].some((x) => x < 0)) {
    throw new Error("funding_current 헤더가 기대한 형태가 아니야. (asOf/exchange/symbol/funding_rate_8h/interval_s/mark_price)");
  }

  const curMap = new Map();
  let currentAsOf = null;

  for (let r = 1; r < curVals.length; r++) {
    const row = curVals[r];
    const ex = String(row[iEx] || "").toLowerCase().trim();
    const sym = String(row[iSym] || "").toUpperCase().trim();
    if (!ex || !sym) continue;

    if (!currentAsOf) currentAsOf = row[iAsOf] || null;

    curMap.set(`${ex}|${sym}`, {
      funding_rate_8h: Number(row[iRate8h]) || 0,
      interval_s: Number(row[iInterval]) || 28800,
      mark_price: Number(row[iMark]) || null,
      asOf: row[iAsOf] || null,
    });
  }

  const posLastRow = shPos.getLastRow();
  if (posLastRow < 2) throw new Error("positions 시트에 포지션이 없어. (2행부터 exchange/symbol/qty 입력)");

  const posHeader = shPos.getRange(1, 1, 1, shPos.getLastColumn()).getValues()[0].map(String);
  const colIndex = (name) => posHeader.indexOf(name);

  const cEx = colIndex("exchange");
  const cSym = colIndex("symbol");
  const cQty = colIndex("qty");
  const cMark = colIndex("mark_price");
  const cRate = colIndex("funding_rate_8h");
  const cInterval = colIndex("interval_s");
  const cPnl8h = colIndex("funding_pnl_8h_usd");
  const cPnlDay = colIndex("funding_pnl_day_usd");

  if ([cEx, cSym, cQty].some((x) => x < 0)) {
    throw new Error("positions 헤더에 exchange/symbol/qty가 없어. Init sheets를 다시 확인해줘.");
  }

  const posVals = shPos.getRange(2, 1, posLastRow - 1, shPos.getLastColumn()).getValues();

  let total8h = 0;
  let totalDay = 0;

  const byEx = new Map(); // ex -> {p8h,pday,gross,dir}

  for (let i = 0; i < posVals.length; i++) {
    const exRaw = String(posVals[i][cEx] || "").trim();
    const symRaw = String(posVals[i][cSym] || "").trim();
    const qtyRaw = posVals[i][cQty];

    if (!exRaw || !symRaw) continue;

    const ex = exRaw.toLowerCase();
    const sym = symRaw.toUpperCase();
    const qty = Number(qtyRaw);

    if (!Number.isFinite(qty) || qty === 0) {
      if (cMark >= 0) posVals[i][cMark] = "";
      if (cRate >= 0) posVals[i][cRate] = "";
      if (cInterval >= 0) posVals[i][cInterval] = "";
      if (cPnl8h >= 0) posVals[i][cPnl8h] = "";
      if (cPnlDay >= 0) posVals[i][cPnlDay] = "";
      continue;
    }

    const key = `${ex}|${sym}`;
    const cur = curMap.get(key);

    if (!cur) {
      if (cMark >= 0) posVals[i][cMark] = "";
      if (cRate >= 0) posVals[i][cRate] = "ERR(no match)";
      if (cInterval >= 0) posVals[i][cInterval] = "";
      if (cPnl8h >= 0) posVals[i][cPnl8h] = "";
      if (cPnlDay >= 0) posVals[i][cPnlDay] = "";
      continue;
    }

    const mark = cur.mark_price;
    const rate8h = Number(cur.funding_rate_8h) || 0;
    const intervalS = Number(cur.interval_s) || 28800;

    const notionalSigned = mark == null ? null : qty * mark;

    // ✅ 기존 방식 유지: pnl8h = -notional * rate8h
    const pnl8h = notionalSigned == null ? null : -notionalSigned * rate8h;
    const pnlDay = pnl8h == null ? null : pnl8h * 3;

    if (cMark >= 0) posVals[i][cMark] = mark ?? "";
    if (cRate >= 0) posVals[i][cRate] = rate8h;
    if (cInterval >= 0) posVals[i][cInterval] = intervalS;
    if (cPnl8h >= 0) posVals[i][cPnl8h] = pnl8h == null ? "" : pnl8h;
    if (cPnlDay >= 0) posVals[i][cPnlDay] = pnlDay == null ? "" : pnlDay;

    if (pnl8h != null) {
      total8h += pnl8h;
      totalDay += pnlDay;

      if (!byEx.has(ex)) byEx.set(ex, { p8h: 0, pday: 0, gross: 0, dir: 0 });
      const acc = byEx.get(ex);
      acc.p8h += pnl8h;
      acc.pday += pnlDay;

      acc.dir += notionalSigned;
      acc.gross += Math.abs(notionalSigned);
    }
  }

  // Write only computed columns so qty/exchange/symbol (and any qty formulas) are never overwritten.
  const writeCols = [cMark, cRate, cInterval, cPnl8h, cPnlDay].filter((c) => c >= 0);
  for (const c of writeCols) {
    const colVals = posVals.map((row) => [row[c]]);
    shPos.getRange(2, c + 1, posVals.length, 1).setValues(colVals);
  }

  funding_writePositionsSummary_(shPos, currentAsOf, total8h, totalDay, byEx);

  const lines = [];
  for (const [ex, v] of byEx.entries()) {
    lines.push(`${ex}: 8h ${funding_fmtUsd_(v.p8h)} / day ${funding_fmtUsd_(v.pday)}`);
  }

  safeAlert_(
    "✅ positions 펀딩 PnL 계산 완료" +
      (currentAsOf ? `\n(asOf: ${currentAsOf})` : "") +
      `\n\n[합계]\n8h: ${funding_fmtUsd_(total8h)}\nDay: ${funding_fmtUsd_(totalDay)}` +
      (lines.length ? `\n\n[거래소별]\n${lines.join("\n")}` : "")
  );
}

 /** ✅ positions 요약표를 positions 시트 우측 "고정 앵커"에 생성/갱신
 * - 절대 열 삽입/확장 없음
 * - 항상 같은 박스에 덮어씀
 */
function funding_writePositionsSummary_(shPos, asOf, total8h, totalDay, byEx) {
  const c0 = funding_getPositionsSummaryAnchorCol_(shPos);
  const startRow = 1;

  const SUMMARY_WIDTH = 5;
  const SUMMARY_HEIGHT = 30;

  // Clean accidental duplicate blocks created on the right.
  funding_clearDuplicatePositionsSummaryBlocks_(shPos, c0);

  // ✅ 고정 박스만 클리어
  shPos.getRange(startRow, c0, SUMMARY_HEIGHT, SUMMARY_WIDTH).clearContent();

  shPos.getRange(1, c0, 1, 2).setValues([["asOf", asOf || ""]]);
  shPos.getRange(2, c0, 1, 2).setValues([["TOTAL funding (8h)", total8h]]);
  shPos.getRange(3, c0, 1, 2).setValues([["TOTAL funding (day)", totalDay]]);

  shPos.getRange(5, c0, 1, 5).setValues([
    ["exchange", "gross_oi_usd", "dir_usd", "funding_8h_usd", "funding_day_usd"],
  ]);

  const rows = [];
  const exList = Array.from(byEx.keys()).sort();
  for (const ex of exList) {
    const v = byEx.get(ex);
    rows.push([ex, v.gross, v.dir, v.p8h, v.pday]);
  }

  if (rows.length) {
    shPos.getRange(6, c0, rows.length, 5).setValues(rows);
  }
}


/**
 * 한 번에: current 업데이트 -> positions PnL 업데이트
 */
function funding_updateCurrentAndPositionsNow() {
  funding_updateCurrentNow();
  funding_updatePositionsPnl();
}

/**
 * bootstrap hourly now (guard 무시)
 */
function funding_bootstrapLighterHourlySheetNow() {
  const historyId = funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id가 비어있어.");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shConfig = ss.getSheetByName(FUNDING_SHEET_CONFIG);
  if (!shConfig) throw new Error("config 시트를 확인해줘. (Funding → Init sheets 먼저 실행)");

  const apiUrl = funding_getApiUrl_(shConfig);
  if (!apiUrl) throw new Error("config 시트에 funding_api_url 값이 비어있어.");

  const data = funding_fetchJson_(apiUrl);
  const ts = funding_nowKstIso_();

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const hourlyRows = funding_pickHourlyRows_(rows, shConfig);
  if (!hourlyRows.length) {
    throw new Error("이번 호출에서 hourly 대상 rows가 없어. (1h cadence 거래소 응답 확인 필요)");
  }

  funding_appendHourlySnapshots_(ts, hourlyRows);
  safeAlert_("✅ hourly_history 기록 완료\n" + `timestamp: ${ts}\nrows: ${hourlyRows.length}`);
}

function funding_bootstrapHourlySheetNow() {
  return funding_bootstrapLighterHourlySheetNow();
}

function funding_installHourlyTrigger() {
  return funding_installLighterHourlyTrigger();
}

function funding_recordHourlySnapshot() {
  return funding_recordLighterHourlySnapshot();
}

/******************************************************
 * ✅ Rolling funding PnL (3d/7d/15d) for positions
 * - strict rule: if coverage < ROLL_MIN_COVERAGE => avg=0, source="insufficient->0"
 * - NO funding_cost anywhere
 * - writes TOTAL pnl for 3/7/15d in positions summary area (separate column block)
 ******************************************************/

/**
 * Menu entry: update rolling funding pnl columns on positions
 */
function funding_updatePositionsRollingFundingPnl_3_7_15() {
  // backward compatible alias
  return funding_updatePositionsRollingFundingPnl_3_7_15_30_all();
}

/**
 * Menu entry: update rolling funding pnl columns on positions
 * - Adds 30d + ALL (entire funding_history period)
 */
function funding_updatePositionsRollingFundingPnl_3_7_15_30_all() {
  const rollMap = funding_buildRollingAvgMapFromHistory_();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shPos = ss.getSheetByName(FUNDING_SHEET_POSITIONS);
  if (!shPos) throw new Error("positions 시트를 찾을 수 없어.");

  const lastRow = shPos.getLastRow();
  if (lastRow < 2) throw new Error("positions 시트에 포지션이 없어. (2행부터 exchange/symbol/qty 입력)");

  // Ensure needed columns (if missing, add to the end)
  let header = shPos.getRange(1, 1, 1, shPos.getLastColumn()).getValues()[0].map(String);
  const ensure = (name) => funding_positionsEnsureColumn_(shPos, header, name);

  // 3d
  ensure("avg_funding_3d");
  ensure("cnt_3d");
  ensure("coverage_3d");
  ensure("avg_source_3d");
  ensure("funding_pnl_3d_usd");

  // 7d
  ensure("avg_funding_7d");
  ensure("cnt_7d");
  ensure("coverage_7d");
  ensure("avg_source_7d");
  ensure("funding_pnl_7d_usd");

  // 15d
  ensure("avg_funding_15d");
  ensure("cnt_15d");
  ensure("coverage_15d");
  ensure("avg_source_15d");
  ensure("funding_pnl_15d_usd");

  // 30d
  ensure("avg_funding_30d");
  ensure("cnt_30d");
  ensure("coverage_30d");
  ensure("avg_source_30d");
  ensure("funding_pnl_30d_usd");

  // ALL (entire history)
  ensure("avg_funding_all");
  ensure("cnt_all");
  ensure("coverage_all");
  ensure("avg_source_all");
  ensure("funding_pnl_all_usd");

  // Re-read header after potential insertions
  header = shPos.getRange(1, 1, 1, shPos.getLastColumn()).getValues()[0].map(String);
  const idx = (name) => header.indexOf(name);

  const iEx = idx("exchange");
  const iSym = idx("symbol");
  const iQty = idx("qty");
  const iMark = idx("mark_price");
  const iInterval = idx("interval_s"); // optional

  const iAvg3 = idx("avg_funding_3d");
  const iCnt3 = idx("cnt_3d");
  const iCov3 = idx("coverage_3d");
  const iSrc3 = idx("avg_source_3d");
  const iPnl3 = idx("funding_pnl_3d_usd");

  const iAvg7 = idx("avg_funding_7d");
  const iCnt7 = idx("cnt_7d");
  const iCov7 = idx("coverage_7d");
  const iSrc7 = idx("avg_source_7d");
  const iPnl7 = idx("funding_pnl_7d_usd");

  const iAvg15 = idx("avg_funding_15d");
  const iCnt15 = idx("cnt_15d");
  const iCov15 = idx("coverage_15d");
  const iSrc15 = idx("avg_source_15d");
  const iPnl15 = idx("funding_pnl_15d_usd");

  const iAvg30 = idx("avg_funding_30d");
  const iCnt30 = idx("cnt_30d");
  const iCov30 = idx("coverage_30d");
  const iSrc30 = idx("avg_source_30d");
  const iPnl30 = idx("funding_pnl_30d_usd");

  const iAvgAll = idx("avg_funding_all");
  const iCntAll = idx("cnt_all");
  const iCovAll = idx("coverage_all");
  const iSrcAll = idx("avg_source_all");
  const iPnlAll = idx("funding_pnl_all_usd");

  if ([iEx, iSym, iQty, iMark].some((x) => x < 0)) {
    throw new Error("positions 헤더에 exchange/symbol/qty/mark_price가 필요해.");
  }

  const numRows = lastRow - 1;
  const rng = shPos.getRange(2, 1, numRows, shPos.getLastColumn());
  const rows = rng.getValues();

  let total3 = 0, total7 = 0, total15 = 0, total30 = 0, totalAll = 0;
  const byEx = new Map(); // ex -> {p3,p7,p15,p30,pAll}

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    const ex = String(row[iEx] || "").trim().toLowerCase();
    const sym = String(row[iSym] || "").trim().toUpperCase();
    const qty = Number(row[iQty]);
    const mark = Number(row[iMark]);
    const intervalS = (iInterval >= 0 ? Number(row[iInterval]) : NaN);

    if (!ex || !sym || !Number.isFinite(qty) || qty === 0 || !Number.isFinite(mark) || mark <= 0) {
      row[iAvg3] = 0; row[iCnt3] = 0; row[iCov3] = 0; row[iSrc3] = ""; row[iPnl3] = 0;
      row[iAvg7] = 0; row[iCnt7] = 0; row[iCov7] = 0; row[iSrc7] = ""; row[iPnl7] = 0;
      row[iAvg15] = 0; row[iCnt15] = 0; row[iCov15] = 0; row[iSrc15] = ""; row[iPnl15] = 0;
      row[iAvg30] = 0; row[iCnt30] = 0; row[iCov30] = 0; row[iSrc30] = ""; row[iPnl30] = 0;
      row[iAvgAll] = 0; row[iCntAll] = 0; row[iCovAll] = 0; row[iSrcAll] = ""; row[iPnlAll] = 0;
      continue;
    }

    const key = `${ex}|${sym}`;
    const agg = rollMap.get(key);

    const effInterval = (Number.isFinite(intervalS) && intervalS > 0)
      ? intervalS
      : (agg && agg.interval_s ? agg.interval_s : 28800);

    const notional = qty * mark;

    const res3 = funding_rollPickAvg_(agg, 3, effInterval);
    const res7 = funding_rollPickAvg_(agg, 7, effInterval);
    const res15 = funding_rollPickAvg_(agg, 15, effInterval);
    const res30 = funding_rollPickAvg_(agg, 30, effInterval);
    const resAll = funding_rollPickAvgAll_(agg, effInterval);

    const pnl3 = funding_rollPnlUsd_(notional, res3.avg, 3, effInterval);
    const pnl7 = funding_rollPnlUsd_(notional, res7.avg, 7, effInterval);
    const pnl15 = funding_rollPnlUsd_(notional, res15.avg, 15, effInterval);
    const pnl30 = funding_rollPnlUsd_(notional, res30.avg, 30, effInterval);
    const pnlAll = funding_rollPnlUsdAll_(notional, agg);

    row[iAvg3] = res3.avg;
    row[iCnt3] = res3.cnt;
    row[iCov3] = res3.coverage;
    row[iSrc3] = res3.source;
    row[iPnl3] = pnl3;

    row[iAvg7] = res7.avg;
    row[iCnt7] = res7.cnt;
    row[iCov7] = res7.coverage;
    row[iSrc7] = res7.source;
    row[iPnl7] = pnl7;

    row[iAvg15] = res15.avg;
    row[iCnt15] = res15.cnt;
    row[iCov15] = res15.coverage;
    row[iSrc15] = res15.source;
    row[iPnl15] = pnl15;

    row[iAvg30] = res30.avg;
    row[iCnt30] = res30.cnt;
    row[iCov30] = res30.coverage;
    row[iSrc30] = res30.source;
    row[iPnl30] = pnl30;

    row[iAvgAll] = resAll.avg;
    row[iCntAll] = resAll.cnt;
    row[iCovAll] = resAll.coverage;
    row[iSrcAll] = resAll.source;
    row[iPnlAll] = pnlAll;

    total3 += pnl3; total7 += pnl7; total15 += pnl15; total30 += pnl30; totalAll += pnlAll;

    if (!byEx.has(ex)) byEx.set(ex, { p3: 0, p7: 0, p15: 0, p30: 0, pAll: 0 });
    const acc = byEx.get(ex);
    acc.p3 += pnl3; acc.p7 += pnl7; acc.p15 += pnl15; acc.p30 += pnl30; acc.pAll += pnlAll;
  }

  // Write only rolling output columns; do not rewrite qty/base columns.
  const rollWriteCols = [
    iAvg3, iCnt3, iCov3, iSrc3, iPnl3,
    iAvg7, iCnt7, iCov7, iSrc7, iPnl7,
    iAvg15, iCnt15, iCov15, iSrc15, iPnl15,
    iAvg30, iCnt30, iCov30, iSrc30, iPnl30,
    iAvgAll, iCntAll, iCovAll, iSrcAll, iPnlAll,
  ].filter((c) => c >= 0);
  for (const c of rollWriteCols) {
    const colVals = rows.map((row) => [row[c]]);
    shPos.getRange(2, c + 1, numRows, 1).setValues(colVals);
  }

  // ✅ rolling 요약은 positions 기본 요약(J열)과 충돌 방지 위해 P열부터 씀
  funding_writeRollingPnlSummary_(shPos, total3, total7, total15, total30, totalAll, byEx);

safeAlert_(
  `✅ rolling funding_pnl 업데이트 완료 (3/7/15/30d + ALL)
TOTAL 3d: ${funding_fmtUsd_(total3)}
TOTAL 7d: ${funding_fmtUsd_(total7)}
TOTAL 15d: ${funding_fmtUsd_(total15)}
TOTAL 30d: ${funding_fmtUsd_(total30)}
TOTAL ALL: ${funding_fmtUsd_(totalAll)}`
);

}

function funding_buildRollingAvgMapFromHistory_() {
  const historyId = funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id가 비어있어.");

  const histSS = SpreadsheetApp.openById(historyId);
  const sh = histSS.getSheetByName(FUNDING_SHEET_HISTORY_8H);
  if (!sh || sh.getLastRow() < 2) throw new Error("funding_history에 데이터가 없어.");

  const vals = sh.getDataRange().getValues();
  const h = vals[0].map(String);

  // header tolerant: timestamp_kst or timestamp (we only need time for filtering)
  let iTs = h.indexOf("timestamp_kst");
  if (iTs < 0) iTs = h.indexOf("timestamp");
  if (iTs < 0) iTs = 0;

  const iEx = h.indexOf("exchange");
  const iSym = h.indexOf("symbol");
  const iRate = h.indexOf("funding_rate_8h");
  const iInterval = h.indexOf("interval_s");

  if ([iEx, iSym, iRate].some((x) => x < 0)) {
    throw new Error("funding_history 헤더가 기대한 형태가 아니야. (exchange/symbol/funding_rate_8h/interval_s)");
  }

  const now = new Date();
  const cut30 = new Date(now.getTime() - 30 * 86400 * 1000);
  const cut15 = new Date(now.getTime() - 15 * 86400 * 1000);
  const cut7 = new Date(now.getTime() - 7 * 86400 * 1000);
  const cut3 = new Date(now.getTime() - 3 * 86400 * 1000);

  // key -> {sum3,cnt3,sum7,cnt7,sum15,cnt15,sum30,cnt30,sumAll,cntAll, interval_s, firstTs, lastTs}
  const map = new Map();

  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];
    const ex = String(row[iEx] || "").trim().toLowerCase();
    const sym = String(row[iSym] || "").trim().toUpperCase();
    const rate = Number(row[iRate]);
    const interval = Number(row[iInterval]) || 28800;

    if (!ex || !sym || !Number.isFinite(rate)) continue;

    const tsVal = row[iTs];
    const d = (Object.prototype.toString.call(tsVal) === "[object Date]" && !isNaN(tsVal.getTime()))
      ? tsVal
      : new Date(String(tsVal || "").trim());

    if (isNaN(d.getTime())) continue;

    const key = `${ex}|${sym}`;
    let a = map.get(key);
    if (!a) {
      a = {
        sum3: 0, cnt3: 0,
        sum7: 0, cnt7: 0,
        sum15: 0, cnt15: 0,
        sum30: 0, cnt30: 0,
        sumAll: 0, cntAll: 0,
        interval_s: interval,
        firstTs: d,
        lastTs: d,
      };
      map.set(key, a);
    }

    a.interval_s = interval;

    // track full period range (for coverage_all)
    if (d < a.firstTs) a.firstTs = d;
    if (d > a.lastTs) a.lastTs = d;

    // ALL: always include
    a.sumAll += rate; a.cntAll += 1;

    // windowed: only include when within each cut
    if (d >= cut30) { a.sum30 += rate; a.cnt30 += 1; }
    if (d >= cut15) { a.sum15 += rate; a.cnt15 += 1; }
    if (d >= cut7) { a.sum7 += rate; a.cnt7 += 1; }
    if (d >= cut3) { a.sum3 += rate; a.cnt3 += 1; }
  }

  return map;
}

function funding_rollPickAvg_(agg, days, interval_s) {
  const interval = Number(interval_s) || 28800;
  const expected = Math.round((days * 86400) / interval);

  const cnt = agg
    ? (days === 3 ? agg.cnt3 : days === 7 ? agg.cnt7 : days === 15 ? agg.cnt15 : agg.cnt30)
    : 0;
  const sum = agg
    ? (days === 3 ? agg.sum3 : days === 7 ? agg.sum7 : days === 15 ? agg.sum15 : agg.sum30)
    : 0;

  const coverage = expected > 0 ? (cnt / expected) : 0;

  if (cnt <= 0 || coverage < FUNDING_ROLL_MIN_COVERAGE) {
    return { avg: 0, cnt: cnt || 0, coverage, source: "insufficient->0" };
  }

  return { avg: sum / cnt, cnt, coverage, source: `${days}d` };
}



function funding_rollPickAvgAll_(agg, interval_s) {
  const interval = Number(interval_s) || 28800;

  const cnt = agg ? (agg.cntAll || 0) : 0;
  const sum = agg ? (agg.sumAll || 0) : 0;

  if (!cnt || cnt <= 0) return { avg: 0, cnt: 0, coverage: 0, source: "all" };

  // coverage_all: based on (last-first) time span, not "days"
  let coverage = 1;
  if (agg && agg.firstTs && agg.lastTs) {
    const first = (Object.prototype.toString.call(agg.firstTs) === "[object Date]") ? agg.firstTs : new Date(agg.firstTs);
    const last = (Object.prototype.toString.call(agg.lastTs) === "[object Date]") ? agg.lastTs : new Date(agg.lastTs);
    if (!isNaN(first.getTime()) && !isNaN(last.getTime())) {
      const spanSec = Math.max(0, (last.getTime() - first.getTime()) / 1000);
      const expected = Math.max(1, Math.round(spanSec / interval) + 1);
      coverage = expected > 0 ? (cnt / expected) : 1;
    }
  }

  return { avg: sum / cnt, cnt, coverage, source: "all" };
}

function funding_rollPnlUsdAll_(notionalUsd, agg) {
  if (!agg || !agg.cntAll) return 0;
  // total pnl over the entire recorded funding_history period
  return (-Number(notionalUsd) * (Number(agg.sumAll) || 0));
}
function funding_rollPnlUsd_(notionalUsd, avgRate8h, days, interval_s) {
  const interval = Number(interval_s) || 28800;
  const nIntervals = (days * 86400) / interval;
  return (-Number(notionalUsd) * (Number(avgRate8h) || 0)) * nIntervals;
}

function funding_writeRollingPnlSummary_(shPos, total3, total7, total15, total30, totalAll, byEx) {
  const SUMMARY_WIDTH = 7;      // 표시용 폭(여유)
  const TABLE_WIDTH = 6;        // exchange 테이블 실제 폭
  const CLEAR_ROWS = 40;

  // ✅ 고정 앵커(매번 같은 위치에 덮어씀)
  const c0 = funding_getRollingSummaryAnchorCol_(shPos);

  // Clean accidental duplicate rolling blocks created on the right.
  funding_clearDuplicateRollingSummaryBlocks_(shPos, c0);

  // ✅ 이 블록만 지우고 다시 씀 (오른쪽으로 늘어나지 않음)
  shPos.getRange(1, c0, CLEAR_ROWS, SUMMARY_WIDTH).clearContent();

  shPos.getRange(1, c0, 1, 2).setValues([["ROLLING TOTAL funding_pnl", "USD"]]);
  shPos.getRange(2, c0, 1, 2).setValues([["TOTAL 3d_funding_pnl_3d", total3]]);
  shPos.getRange(3, c0, 1, 2).setValues([["TOTAL 7d_funding_pnl_7d", total7]]);
  shPos.getRange(4, c0, 1, 2).setValues([["TOTAL 15d_funding_pnl_15d", total15]]);
  shPos.getRange(5, c0, 1, 2).setValues([["TOTAL 30d_funding_pnl_30d", total30]]);
  shPos.getRange(6, c0, 1, 2).setValues([["TOTAL All_funding_pnl_ALL", totalAll]]);

  shPos.getRange(8, c0, 1, TABLE_WIDTH).setValues([[
    "exchange", "pnl_3d_usd", "pnl_7d_usd", "pnl_15d_usd", "pnl_30d_usd", "pnl_all_usd"
  ]]);

  const out = [];
  const exList = Array.from(byEx.keys()).sort();
  for (const ex of exList) {
    const v = byEx.get(ex);
    out.push([ex, v.p3 || 0, v.p7 || 0, v.p15 || 0, v.p30 || 0, v.pAll || 0]);
  }

  if (out.length) {
    shPos.getRange(9, c0, out.length, TABLE_WIDTH).setValues(out);
  }
}

function funding_findRow1TextCol_(sh, text) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return null;

  const row1 = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let c = 0; c < row1.length; c++) {
    if (String(row1[c] || "").trim() === text) return c + 1; // 1-index
  }
  return null;
}


/**************************************
 * ✅ formatting / alerts / migration
 **************************************/

function funding_fmtUsd_(n) {
  const x = Number(n) || 0;
  const sign = x >= 0 ? "+" : "-";
  const abs = Math.abs(x);
  return `${sign}$${abs.toFixed(2)}`;
}

function safeAlert_(msg) {
  try {
    SpreadsheetApp.getUi().alert(String(msg));
  } catch (e) {
    Logger.log(String(msg));
  }
}

/**
 * ✅ 문자열/Date 값을 KST ISO(+09:00) 문자열로 변환 시도
 * - 이미 +09:00이면 그대로 유지
 * - ...Z(UTC) 또는 +00:00 등 파싱 가능한 ISO면 KST로 변환
 * - 파싱 불가하면 원본 유지
 */
function funding_toKstIsoFromAny_(v) {
  if (v == null || v === "") return "";

  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return funding_dateToKstIso_(v);
  }

  const s = String(v).trim();
  if (!s) return "";

  if (s.endsWith("+09:00") || s.endsWith("+0900")) return s;

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return funding_dateToKstIso_(d);
  }

  return s;
}

/**
 * ✅ 특정 시트의 1열(timestamp*)을 KST ISO 문자열로 일괄 변환
 * - 헤더 자체는 건드리지 않음
 */
function funding_migrateSheetTimestampColumnToKst_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return { sheet: sheetName, updated: 0, total: 0, skipped: 0, reason: "no sheet" };

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { sheet: sheetName, updated: 0, total: 0, skipped: 0, reason: "no data" };

  const numRows = lastRow - 1;
  const rng = sh.getRange(2, 1, numRows, 1);
  const vals = rng.getValues();

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < vals.length; i++) {
    const oldV = vals[i][0];
    if (oldV == null || oldV === "") { skipped++; continue; }

    const newS = funding_toKstIsoFromAny_(oldV);
    const oldS = (Object.prototype.toString.call(oldV) === "[object Date]" && !isNaN(oldV.getTime()))
      ? funding_dateToKstIso_(oldV)
      : String(oldV).trim();

    if (newS && newS !== oldS) {
      vals[i][0] = newS;
      updated++;
    } else {
      skipped++;
    }
  }

  if (updated > 0) rng.setValues(vals);

  return { sheet: sheetName, updated, total: numRows, skipped, reason: "ok" };
}

/**
 * ✅ 히스토리 스프레드시트의 timestamp 컬럼을 한 번에 KST로 마이그레이션
 */
function funding_migrateAllHistoryTimestampsToKst() {
  const historyId = funding_getHistorySpreadsheetId_();
  if (!historyId) throw new Error("history spreadsheet id가 비어있어.");

  const r1 = funding_migrateSheetTimestampColumnToKst_(historyId, FUNDING_SHEET_HISTORY_8H);
  const r2 = funding_migrateSheetTimestampColumnToKst_(historyId, FUNDING_SHEET_HOURLY);

  safeAlert_(
    "✅ timestamp -> KST 마이그레이션 완료\n" +
    `- ${r1.sheet}: updated ${r1.updated}/${r1.total} (skipped ${r1.skipped})\n` +
    `- ${r2.sheet}: updated ${r2.updated}/${r2.total} (skipped ${r2.skipped})`
  );
}

/**************************************
 * Optimizer (qty-based targets)
 * (이 아래는 너가 붙여준 기존 코드 그대로)
 **************************************/

// Optimizer sheets
const OPT_SHEET_INPUTS = "opt_inputs";
const OPT_SHEET_TARGETS = "opt_targets";
const OPT_SHEET_RATES = "opt_rates";
const OPT_SHEET_SOLUTION = "opt_solution";
const OPT_SHEET_REBALANCE_COST = "opt_rebalance_cost";
const OPT_DEFAULT_SLIPPAGE_API_URL = "https://slippage.vercel.app/api/slippage";

// Exchanges / symbols
const OPT_EXCHANGES = [
  "variational",
  "binance",
  "lighter",
  "hyperliquid",
  "01xyz",
  "nado",
  "pacifica",
  "paradex",
  "extended",
];
const OPT_SYMBOLS = ["BTC", "ETH", "SOL", "BNB"];

// Default input keys
const OPT_DEFAULT_INPUTS = [
  ["deposit_variational_usd", 250000],
  ["deposit_binance_usd", 600000],
  ["deposit_lighter_usd", 50000],
  ["deposit_hyperliquid_usd", 0],
  ["deposit_01xyz_usd", 0],
  ["deposit_nado_usd", 0],
  ["deposit_pacifica_usd", 0],
  ["deposit_paradex_usd", 0],
  ["deposit_extended_usd", 0],

  ["variational_min_gross_oi_usd", 3000000],

  ["variational_dir_limit_mult", 1.0],
  ["binance_dir_limit_mult", 2.0],
  ["lighter_dir_limit_mult", 1.0],
  ["hyperliquid_dir_limit_mult", 1.0],
  ["01xyz_dir_limit_mult", 1.0],
  ["nado_dir_limit_mult", 1.0],
  ["pacifica_dir_limit_mult", 1.0],
  ["paradex_dir_limit_mult", 1.0],
  ["extended_dir_limit_mult", 1.0],

  ["variational_fee_bps", 0],
  ["binance_fee_bps", 0],
  ["lighter_fee_bps", 0],
  ["hyperliquid_fee_bps", 0],
  ["01xyz_fee_bps", 0],
  ["nado_fee_bps", 0],
  ["pacifica_fee_bps", 0],
  ["paradex_fee_bps", 0],
  ["extended_fee_bps", 0],

  ["variational_slippage_bps", 0],
  ["binance_slippage_bps", 0],
  ["lighter_slippage_bps", 0],
  ["hyperliquid_slippage_bps", 0],
  ["01xyz_slippage_bps", 0],
  ["nado_slippage_bps", 0],
  ["pacifica_slippage_bps", 0],
  ["paradex_slippage_bps", 0],
  ["extended_slippage_bps", 0],

  ["use_live_slippage_api", "TRUE"],
  ["slippage_api_url", OPT_DEFAULT_SLIPPAGE_API_URL],

  ["binance_gross_max_mult", 5.0],
  ["lighter_gross_max_mult", 5.0],
  ["hyperliquid_gross_max_mult", 5.0],
  ["01xyz_gross_max_mult", 5.0],
  ["nado_gross_max_mult", 5.0],
  ["pacifica_gross_max_mult", 5.0],
  ["paradex_gross_max_mult", 5.0],
  ["extended_gross_max_mult", 5.0],

  ["sol_cap_mult", 0.8],
  ["bnb_cap_mult", 0.8],

  ["enable_variational_booster", "TRUE"],
  ["booster_step_usd", 50000],
  ["booster_assets", "BTC,ETH"],
  ["booster_hedge_order", "binance,hyperliquid,lighter,nado,01xyz,pacifica,paradex,extended"],
];

function funding_getDepositInputKey_(ex) {
  return `deposit_${ex}_usd`;
}

function funding_getDirLimitInputKey_(ex) {
  return `${ex}_dir_limit_mult`;
}

function funding_getGrossMaxMultInputKey_(ex) {
  return `${ex}_gross_max_mult`;
}

function funding_getFeeBpsInputKey_(ex) {
  return `${ex}_fee_bps`;
}

function funding_getSlippageBpsInputKey_(ex) {
  return `${ex}_slippage_bps`;
}

function funding_getGrossMaxMultByExchange_(inputs) {
  const out = {};
  for (const ex of OPT_EXCHANGES) {
    if (ex === "variational") {
      out[ex] = Infinity;
      continue;
    }

    let raw = inputs[funding_getGrossMaxMultInputKey_(ex)];
    // backward compatibility for old sheets that only had lighter_gross_max_mult
    if ((raw == null || String(raw).trim() === "") && ex === "lighter") {
      raw = inputs["lighter_gross_max_mult"];
    }
    const mult = Number(raw);
    out[ex] = Number.isFinite(mult) && mult > 0 ? mult : Infinity;
  }
  return out;
}

function funding_getTradingCostBpsByExchange_(inputs) {
  const feeBps = {};
  const slippageBps = {};
  for (const ex of OPT_EXCHANGES) {
    const fee = Number(inputs[funding_getFeeBpsInputKey_(ex)]);
    const slip = Number(inputs[funding_getSlippageBpsInputKey_(ex)]);
    feeBps[ex] = Number.isFinite(fee) && fee >= 0 ? fee : 0;
    slippageBps[ex] = Number.isFinite(slip) && slip >= 0 ? slip : 0;
  }
  return { feeBps, slippageBps };
}

function funding_isTrueLike_(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES" || s === "Y" || s === "ON";
}

function funding_buildSlippageApiEndpoint_(rawUrl) {
  const base = String(rawUrl == null ? "" : rawUrl).trim() || OPT_DEFAULT_SLIPPAGE_API_URL;
  if (!base) return "";
  if (base.indexOf("/api/slippage") >= 0) return base;
  return base.replace(/\/+$/, "") + "/api/slippage";
}

function funding_fetchLiveSlippageMap_(apiEndpoint, coin, qtyAbs, side) {
  const qty = Number(qtyAbs);
  if (!apiEndpoint || !coin || !(qty > 0)) return new Map();

  const qs =
    "coin=" + encodeURIComponent(String(coin).toUpperCase()) +
    "&qty=" + encodeURIComponent(String(funding_round_(qty))) +
    "&side=" + encodeURIComponent(String(side || "buy").toLowerCase());

  const sep = apiEndpoint.indexOf("?") >= 0 ? "&" : "?";
  const url = apiEndpoint + sep + qs;

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(`slippage API HTTP ${code}: ${text}`);
  }

  const payload = JSON.parse(text);
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const out = new Map();
  for (const r of rows) {
    const status = String(r?.status || "").toLowerCase();
    if (status && status !== "ok") continue;

    const ex = String(r?.exchange || r?.id || r?.name || "").trim().toLowerCase();
    if (!ex) continue;

    const feeBps = Number(r?.feeBps ?? r?.fee_bps ?? 0);
    const slippageBps = Number(r?.slippageBps ?? r?.slippage_bps ?? 0);

    out.set(ex, {
      feeBps: Number.isFinite(feeBps) ? feeBps : 0,
      slippageBps: Number.isFinite(slippageBps) ? slippageBps : 0,
      source: "live",
    });
  }
  return out;
}

function funding_initOptimizerSheets() {
  funding_initSheets();

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const shInputs = funding_initSheet_(ss, OPT_SHEET_INPUTS, ["key", "value"]);
  funding_ensureKeyValues_(shInputs, OPT_DEFAULT_INPUTS);

  const shTargets = funding_initSheet_(ss, OPT_SHEET_TARGETS, ["symbol", "target_qty (from positions)"]);
  shTargets.getRange(2, 1, OPT_SYMBOLS.length, 1).setValues(OPT_SYMBOLS.map((s) => [s]));
  shTargets.getRange(2, 2, OPT_SYMBOLS.length, 1).setFormulas(
    OPT_SYMBOLS.map((_, i) => [`=SUMIF(${FUNDING_SHEET_POSITIONS}!B:B, A${i + 2}, ${FUNDING_SHEET_POSITIONS}!C:C)`])
  );

  funding_initSheet_(ss, OPT_SHEET_RATES, ["exchange", "symbol", "funding_rate_8h", "mark_price", "asOf"]);

  const shSol = funding_initSheet_(ss, OPT_SHEET_SOLUTION, [
    "exchange",
    "symbol",
    "qty",
    "mark_price",
    "funding_rate_8h",
    "notional_usd",
    "pnl_8h_usd",
    "pnl_day_usd",
    "note",
  ]);
  shSol.getRange(2, 1, shSol.getMaxRows() - 1, shSol.getMaxColumns()).clearContent();

  try { funding_refreshOptRates_(); } catch (e) {}

  safeAlert_("✅ Optimizer sheets created: opt_inputs / opt_targets / opt_rates / opt_solution");
}

function funding_refreshOptRates_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shCur = ss.getSheetByName(FUNDING_SHEET_CURRENT);
  const shRates = ss.getSheetByName(OPT_SHEET_RATES);
  if (!shCur || !shRates) throw new Error("funding_current 또는 opt_rates 시트가 없어. Init 먼저.");

  const curVals = shCur.getDataRange().getValues();
  if (curVals.length < 2) throw new Error("funding_current에 데이터가 없어. Update current now 먼저.");

  const h = curVals[0].map(String);
  const idx = (name) => h.indexOf(name);

  const iAsOf = idx("asOf");
  const iEx = idx("exchange");
  const iSym = idx("symbol");
  const iRate = idx("funding_rate_8h");
  const iMark = idx("mark_price");

  if ([iEx, iSym, iRate, iMark].some((x) => x < 0)) throw new Error("funding_current 헤더를 확인해줘.");

  const rows = [];
  for (let r = 1; r < curVals.length; r++) {
    const row = curVals[r];
    const ex = String(row[iEx] || "").toLowerCase().trim();
    const sym = String(row[iSym] || "").toUpperCase().trim();
    if (!ex || !sym) continue;
    if (!OPT_EXCHANGES.includes(ex)) continue;
    if (!OPT_SYMBOLS.includes(sym)) continue;

    rows.push([ex, sym, Number(row[iRate]) || 0, Number(row[iMark]) || "", row[iAsOf] || ""]);
  }

  shRates.getRange(2, 1, shRates.getMaxRows() - 1, shRates.getMaxColumns()).clearContent();
  if (rows.length) shRates.getRange(2, 1, rows.length, 5).setValues(rows);
}


/**
 * Optimize
 */
function funding_optimizeAllocation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shInputs = ss.getSheetByName(OPT_SHEET_INPUTS);
  const shTargets = ss.getSheetByName(OPT_SHEET_TARGETS);
  const shRates = ss.getSheetByName(OPT_SHEET_RATES);
  const shSol = ss.getSheetByName(OPT_SHEET_SOLUTION);

  if (!shInputs || !shTargets || !shRates || !shSol) {
    throw new Error("opt_* 시트가 없어. Funding → Init optimizer sheets 먼저.");
  }

  try {
    funding_refreshOptRates_();
  } catch (e) {}

  // Keep opt_inputs schema up to date without overwriting user values.
  funding_ensureKeyValues_(shInputs, OPT_DEFAULT_INPUTS);
  const inputs = funding_readKeyValues_(shInputs);

  const dep = {};
  for (const ex of OPT_EXCHANGES) {
    dep[ex] = Number(inputs[funding_getDepositInputKey_(ex)] || 0);
  }

  const minGrossVar = Number(inputs["variational_min_gross_oi_usd"] || 3000000);

  const dirMult = {};
  for (const ex of OPT_EXCHANGES) {
    dirMult[ex] = Number(inputs[funding_getDirLimitInputKey_(ex)] || 1.0);
  }

  const capMult = {
    SOL: Number(inputs["sol_cap_mult"] || 0.8),
    BNB: Number(inputs["bnb_cap_mult"] || 0.8),
  };

  const grossMaxMult = funding_getGrossMaxMultByExchange_(inputs);

  const boosterEnabled = String(inputs["enable_variational_booster"] || "TRUE").toUpperCase() === "TRUE";
  const boosterStepUsd = Number(inputs["booster_step_usd"] || 50000);
  const boosterAssets = String(inputs["booster_assets"] || "BTC,ETH")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const boosterHedgeOrder = String(inputs["booster_hedge_order"] || "binance,lighter")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const targetQty = funding_readTargets_(shTargets);
  const rateMap = funding_readRates_(shRates);
  const markFallback = funding_buildMarkFallback_(rateMap);

  const alloc = {};
  for (const ex of OPT_EXCHANGES) {
    alloc[ex] = {};
    for (const sym of OPT_SYMBOLS) alloc[ex][sym] = 0;
  }

  const state = funding_initState_(OPT_EXCHANGES);

  // ---- Base allocation ----
  for (const sym of OPT_SYMBOLS) {
    const tgt = Number(targetQty[sym] || 0);
    if (!Number.isFinite(tgt) || tgt === 0) continue;

    const ranked = funding_rankExchangesForSymbol_(sym, tgt, rateMap, markFallback);
    let remaining = tgt;

    for (const ex of ranked) {
      if (remaining === 0) break;

      const allowed = funding_maxDeltaQtyAllowed_(
        ex,
        sym,
        remaining,
        dep,
        dirMult,
        capMult,
        grossMaxMult,
        state,
        rateMap,
        markFallback
      );
      if (allowed === 0) continue;

      alloc[ex][sym] += allowed;
      funding_applyDelta_(state, ex, sym, allowed, rateMap, markFallback);
      remaining = funding_round_(remaining - allowed);
    }

    if (Math.abs(remaining) > 1e-10) {
      for (const ex of OPT_EXCHANGES) {
        if (remaining === 0) break;

        const allowed = funding_maxDeltaQtyAllowed_(
          ex,
          sym,
          remaining,
          dep,
          dirMult,
          capMult,
          grossMaxMult,
          state,
          rateMap,
          markFallback
        );
        if (allowed === 0) continue;

        alloc[ex][sym] += allowed;
        funding_applyDelta_(state, ex, sym, allowed, rateMap, markFallback);
        remaining = funding_round_(remaining - allowed);
      }
    }

    if (Math.abs(remaining) > 1e-8) {
      throw new Error(`타겟 qty를 배분할 수 없어: ${sym} remaining=${remaining}. (제약이 너무 타이트하거나 mark/rate 누락)`);
    }
  }

  // ---- Booster ----
  if (boosterEnabled && dep.variational > 0 && minGrossVar > 0) {
    funding_applyVariationalBooster_(
      alloc,
      state,
      dep,
      dirMult,
      capMult,
      grossMaxMult,
      rateMap,
      markFallback,
      minGrossVar,
      boosterStepUsd,
      boosterAssets,
      boosterHedgeOrder
    );

    // ✅ HARD CHECK
    const chkVar = funding_calcExchangeStatsFromAlloc_(alloc, "variational", rateMap, markFallback);
    if (chkVar.gross < minGrossVar - 1e-6) {
      throw new Error(
        `🚨 Variational gross OI 미달\n` +
          `gross=${chkVar.gross.toFixed(2)} / min=${minGrossVar.toFixed(2)}\n` +
          `opt_inputs의 deposit/dir_limit/booster 설정을 확인해줘.`
      );
    }
  }

  // ---- Write solution ----
  funding_writeOptSolution_(
    shSol,
    alloc,
    rateMap,
    markFallback,
    dep,
    dirMult,
    capMult,
    grossMaxMult,
    minGrossVar
  );

  const summary = funding_buildConstraintSummary_(
    alloc,
    dep,
    dirMult,
    capMult,
    grossMaxMult,
    rateMap,
    markFallback,
    minGrossVar
  );

  let rebalanceText = "";
  try {
    const rebalance = funding_estimateRebalanceTradingCost_({ showAlert: false, writeSheet: true });
    rebalanceText =
      "\n\n[rebalance_trading_cost_estimate]\n" +
      `turnover: ${funding_fmtUsd_(rebalance.totals.totalTurnoverUsd)}\n` +
      `fee: ${funding_fmtUsd_(rebalance.totals.totalFeeUsd)}\n` +
      `slippage: ${funding_fmtUsd_(rebalance.totals.totalSlippageUsd)}\n` +
      `total_cost: ${funding_fmtUsd_(rebalance.totals.totalCostUsd)}`;
  } catch (e) {
    rebalanceText = `\n\n[rebalance_trading_cost_estimate] ERR: ${String(e && e.message ? e.message : e)}`;
  }

  safeAlert_("✅ Optimize allocation 완료\n\n" + summary.join("\n") + rebalanceText);
}

/**
 * positions -> opt_solution 리밸런싱 시 발생하는 추정 거래비용(수수료+슬리피지) 계산
 * - turnover_usd = |target_qty - current_qty| * mark_price
 * - fee_usd = turnover_usd * fee_bps / 10000
 * - slippage_usd = turnover_usd * slippage_bps / 10000
 */
function funding_estimateRebalanceTradingCostNow() {
  const result = funding_estimateRebalanceTradingCost_({ showAlert: true, writeSheet: true });
  return result;
}

function funding_estimateRebalanceTradingCost_(opts) {
  const options = opts || {};
  const showAlert = options.showAlert !== false;
  const writeSheet = options.writeSheet !== false;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shPos = ss.getSheetByName(FUNDING_SHEET_POSITIONS);
  const shSol = ss.getSheetByName(OPT_SHEET_SOLUTION);
  const shInputs = ss.getSheetByName(OPT_SHEET_INPUTS);
  const shRates = ss.getSheetByName(OPT_SHEET_RATES);
  if (!shPos || !shSol || !shInputs || !shRates) {
    throw new Error("positions / opt_solution / opt_inputs / opt_rates 시트를 확인해줘.");
  }

  funding_ensureKeyValues_(shInputs, OPT_DEFAULT_INPUTS);
  const inputs = funding_readKeyValues_(shInputs);
  const bps = funding_getTradingCostBpsByExchange_(inputs);
  const useLiveRaw = inputs["use_live_slippage_api"];
  const useLiveSlippage =
    String(useLiveRaw == null ? "" : useLiveRaw).trim() === ""
      ? true
      : funding_isTrueLike_(useLiveRaw);
  const slippageApiEndpoint = funding_buildSlippageApiEndpoint_(inputs["slippage_api_url"]);
  const liveSlippageCache = new Map(); // key: SYMBOL|qty|side -> Map(exchange -> {feeBps, slippageBps, source})
  const liveSlippageErrors = [];

  // keep mark info fresh when available
  try {
    funding_refreshOptRates_();
  } catch (_) {}

  const rateMap = funding_readRates_(shRates);
  const markFallback = funding_buildMarkFallback_(rateMap);

  const currentQtyMap = funding_readPositionQtyMap_(shPos);
  const targetMap = funding_readOptTargetMap_(shSol);
  const keys = new Set([...currentQtyMap.keys(), ...targetMap.keys()]);

  const symbolOrder = {};
  for (let i = 0; i < OPT_SYMBOLS.length; i++) symbolOrder[OPT_SYMBOLS[i]] = i;

  const rows = [];
  const byEx = new Map();
  let totalTurnover = 0;
  let totalFee = 0;
  let totalSlip = 0;
  let totalCost = 0;
  const missingMarks = [];

  for (const key of keys) {
    const parts = String(key).split("|");
    if (parts.length !== 2) continue;
    const ex = parts[0];
    const sym = parts[1];
    if (!OPT_EXCHANGES.includes(ex) || !OPT_SYMBOLS.includes(sym)) continue;

    const currentQty = Number(currentQtyMap.get(key) || 0);
    const tgt = targetMap.get(key) || { qty: 0, mark: null };
    const targetQty = Number(tgt.qty || 0);
    const deltaQty = funding_round_(targetQty - currentQty);
    if (!Number.isFinite(deltaQty) || Math.abs(deltaQty) < 1e-12) continue;

    const markDirect = Number(tgt.mark);
    const markRate = Number((rateMap.get(key) || {}).mark);
    const markFb = Number(markFallback[sym]);
    const mark =
      Number.isFinite(markDirect) && markDirect > 0
        ? markDirect
        : Number.isFinite(markRate) && markRate > 0
          ? markRate
          : Number.isFinite(markFb) && markFb > 0
            ? markFb
            : null;

    if (!(mark > 0)) {
      missingMarks.push(`${ex}|${sym}`);
      continue;
    }

    const turnoverUsd = Math.abs(deltaQty) * mark;
    const side = deltaQty > 0 ? "buy" : "sell";

    let feeBps = Number(bps.feeBps[ex] || 0);
    let slipBps = Number(bps.slippageBps[ex] || 0);
    let bpsSource = "manual";

    if (useLiveSlippage && slippageApiEndpoint) {
      const liveKey = `${sym}|${funding_round_(Math.abs(deltaQty))}|${side}`;
      let liveMap = liveSlippageCache.get(liveKey);
      if (!liveMap) {
        try {
          liveMap = funding_fetchLiveSlippageMap_(slippageApiEndpoint, sym, Math.abs(deltaQty), side);
        } catch (e) {
          liveMap = new Map();
          liveSlippageErrors.push(`${liveKey}: ${String(e && e.message ? e.message : e)}`);
        }
        liveSlippageCache.set(liveKey, liveMap);
      }
      const live = liveMap.get(ex);
      if (live) {
        feeBps = Number(live.feeBps || 0);
        slipBps = Number(live.slippageBps || 0);
        bpsSource = "live";
      } else {
        bpsSource = "manual_fallback";
      }
    }

    const feeUsd = turnoverUsd * feeBps / 10000;
    const slippageUsd = turnoverUsd * slipBps / 10000;
    const totalUsd = feeUsd + slippageUsd;

    totalTurnover += turnoverUsd;
    totalFee += feeUsd;
    totalSlip += slippageUsd;
    totalCost += totalUsd;

    if (!byEx.has(ex)) byEx.set(ex, { turnoverUsd: 0, feeUsd: 0, slippageUsd: 0, totalCostUsd: 0 });
    const acc = byEx.get(ex);
    acc.turnoverUsd += turnoverUsd;
    acc.feeUsd += feeUsd;
    acc.slippageUsd += slippageUsd;
    acc.totalCostUsd += totalUsd;

    rows.push([
      ex,
      sym,
      currentQty,
      targetQty,
      deltaQty,
      mark,
      turnoverUsd,
      feeBps,
      slipBps,
      feeUsd,
      slippageUsd,
      totalUsd,
      side,
      bpsSource,
    ]);
  }

  if (missingMarks.length) {
    const sample = missingMarks.slice(0, 8).join(", ");
    throw new Error(`리밸런싱 mark_price 누락: ${sample}${missingMarks.length > 8 ? " ..." : ""}`);
  }

  rows.sort((a, b) => {
    const exA = EX_ORDER[String(a[0] || "").toLowerCase()] ?? 999;
    const exB = EX_ORDER[String(b[0] || "").toLowerCase()] ?? 999;
    if (exA !== exB) return exA - exB;
    const sA = symbolOrder[String(a[1] || "").toUpperCase()] ?? 999;
    const sB = symbolOrder[String(b[1] || "").toUpperCase()] ?? 999;
    return sA - sB;
  });

  const asOf = funding_nowKstIso_();
  if (writeSheet) {
    funding_writeRebalanceCostSheet_(ss, asOf, rows, byEx, {
      totalTurnoverUsd: totalTurnover,
      totalFeeUsd: totalFee,
      totalSlippageUsd: totalSlip,
      totalCostUsd: totalCost,
    });
  }

  if (showAlert) {
    const liveQueryCount = useLiveSlippage ? liveSlippageCache.size : 0;
    const liveErrCount = liveSlippageErrors.length;
    safeAlert_(
      "✅ Rebalance 거래비용 추정 완료\n" +
      `asOf: ${asOf}\n` +
      `turnover: ${funding_fmtUsd_(totalTurnover)}\n` +
      `fee: ${funding_fmtUsd_(totalFee)}\n` +
      `slippage: ${funding_fmtUsd_(totalSlip)}\n` +
      `total_cost: ${funding_fmtUsd_(totalCost)}\n` +
      `trades: ${rows.length}` +
      (useLiveSlippage ? `\nlive_slippage_queries: ${liveQueryCount}` : "") +
      (useLiveSlippage ? `\nlive_slippage_errors: ${liveErrCount}` : "")
    );
  }

  return {
    asOf,
    rows,
    byExchange: byEx,
    totals: {
      totalTurnoverUsd: totalTurnover,
      totalFeeUsd: totalFee,
      totalSlippageUsd: totalSlip,
      totalCostUsd: totalCost,
    },
  };
}

function funding_readPositionQtyMap_(shPos) {
  const out = new Map();
  const lastRow = shPos.getLastRow();
  if (lastRow < 2) return out;

  const header = shPos.getRange(1, 1, 1, shPos.getLastColumn()).getValues()[0].map((v) => String(v || "").trim());
  const iEx = header.indexOf("exchange");
  const iSym = header.indexOf("symbol");
  const iQty = header.indexOf("qty");
  if ([iEx, iSym, iQty].some((x) => x < 0)) return out;

  const vals = shPos.getRange(2, 1, lastRow - 1, shPos.getLastColumn()).getValues();
  for (const row of vals) {
    const ex = String(row[iEx] || "").trim().toLowerCase();
    const sym = String(row[iSym] || "").trim().toUpperCase();
    if (!ex || !sym) continue;
    if (!OPT_EXCHANGES.includes(ex) || !OPT_SYMBOLS.includes(sym)) continue;
    const qty = Number(row[iQty]);
    out.set(`${ex}|${sym}`, Number.isFinite(qty) ? qty : 0);
  }
  return out;
}

function funding_readOptTargetMap_(shSol) {
  const out = new Map();
  const lastRow = shSol.getLastRow();
  if (lastRow < 2) return out;

  const header = shSol.getRange(1, 1, 1, shSol.getLastColumn()).getValues()[0].map((v) => String(v || "").trim());
  const iEx = header.indexOf("exchange");
  const iSym = header.indexOf("symbol");
  const iQty = header.indexOf("qty");
  const iMark = header.indexOf("mark_price");
  if ([iEx, iSym, iQty].some((x) => x < 0)) return out;

  const vals = shSol.getRange(2, 1, lastRow - 1, shSol.getLastColumn()).getValues();
  for (const row of vals) {
    const ex = String(row[iEx] || "").trim().toLowerCase();
    const sym = String(row[iSym] || "").trim().toUpperCase();
    if (!ex || !sym) continue;
    if (!OPT_EXCHANGES.includes(ex) || !OPT_SYMBOLS.includes(sym)) continue;

    const qty = Number(row[iQty]);
    const mark = iMark >= 0 ? Number(row[iMark]) : NaN;
    out.set(`${ex}|${sym}`, {
      qty: Number.isFinite(qty) ? qty : 0,
      mark: Number.isFinite(mark) && mark > 0 ? mark : null,
    });
  }
  return out;
}

function funding_writeRebalanceCostSheet_(ss, asOf, rows, byEx, totals) {
  const sh = ss.getSheetByName(OPT_SHEET_REBALANCE_COST) || ss.insertSheet(OPT_SHEET_REBALANCE_COST);

  const width = 14;
  const maxCols = Math.max(sh.getMaxColumns(), width);
  sh.getRange(1, 1, sh.getMaxRows(), maxCols).clearContent();

  sh.getRange(1, 1, 1, 2).setValues([["asOf", asOf]]);
  sh.getRange(2, 1, 1, 2).setValues([["TOTAL turnover_usd", totals.totalTurnoverUsd || 0]]);
  sh.getRange(3, 1, 1, 2).setValues([["TOTAL fee_usd", totals.totalFeeUsd || 0]]);
  sh.getRange(4, 1, 1, 2).setValues([["TOTAL slippage_usd", totals.totalSlippageUsd || 0]]);
  sh.getRange(5, 1, 1, 2).setValues([["TOTAL trading_cost_usd", totals.totalCostUsd || 0]]);

  const detailHeader = [
    "exchange",
    "symbol",
    "current_qty",
    "target_qty",
    "delta_qty",
    "mark_price",
    "turnover_usd",
    "fee_bps",
    "slippage_bps",
    "fee_usd",
    "slippage_usd",
    "total_cost_usd",
    "trade_side",
    "bps_source",
  ];
  sh.getRange(7, 1, 1, width).setValues([detailHeader]);
  if (rows.length) sh.getRange(8, 1, rows.length, width).setValues(rows);

  const summaryStart = 8 + rows.length + 2;
  sh.getRange(summaryStart, 1, 1, 5).setValues([["exchange_summary", "turnover_usd", "fee_usd", "slippage_usd", "total_cost_usd"]]);

  const exRows = Array.from(byEx.entries())
    .sort((a, b) => {
      const exA = EX_ORDER[String(a[0] || "").toLowerCase()] ?? 999;
      const exB = EX_ORDER[String(b[0] || "").toLowerCase()] ?? 999;
      return exA - exB;
    })
    .map(([ex, v]) => [ex, v.turnoverUsd, v.feeUsd, v.slippageUsd, v.totalCostUsd]);

  if (exRows.length) sh.getRange(summaryStart + 1, 1, exRows.length, 5).setValues(exRows);
}

/* =========================
 * Helpers: read / write
 * ========================= */

function funding_readTargets_(shTargets) {
  const vals = shTargets.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < vals.length; i++) {
    const sym = String(vals[i][0] || "").toUpperCase().trim();
    const qty = Number(vals[i][1]);
    if (!sym) continue;
    out[sym] = Number.isFinite(qty) ? qty : 0;
  }
  for (const s of OPT_SYMBOLS) if (out[s] == null) out[s] = 0;
  return out;
}

function funding_readRates_(shRates) {
  const vals = shRates.getDataRange().getValues();
  const out = new Map();
  for (let i = 1; i < vals.length; i++) {
    const ex = String(vals[i][0] || "").toLowerCase().trim();
    const sym = String(vals[i][1] || "").toUpperCase().trim();
    if (!ex || !sym) continue;
    out.set(`${ex}|${sym}`, {
      rate8h: Number(vals[i][2]) || 0,
      mark: vals[i][3] === "" ? null : Number(vals[i][3]),
      asOf: vals[i][4] || null,
    });
  }
  return out;
}

function funding_buildMarkFallback_(rateMap) {
  const out = {};
  for (const sym of OPT_SYMBOLS) out[sym] = null;

  const pref = [
    "binance",
    "hyperliquid",
    "variational",
    "lighter",
    "01xyz",
    "nado",
    "pacifica",
    "paradex",
    "extended",
  ];
  for (const sym of OPT_SYMBOLS) {
    for (const ex of pref) {
      const it = rateMap.get(`${ex}|${sym}`);
      if (it && it.mark != null && Number.isFinite(it.mark)) {
        out[sym] = it.mark;
        break;
      }
    }
  }
  return out;
}

/* =========================
 * Helpers: ranking & constraints
 * ========================= */

function funding_rankExchangesForSymbol_(sym, targetQty, rateMap, markFallback) {
  const isLong = targetQty > 0;
  const scored = [];

  for (const ex of OPT_EXCHANGES) {
    const it = rateMap.get(`${ex}|${sym}`) || {};
    const mark = it.mark != null && Number.isFinite(it.mark) ? it.mark : markFallback[sym] || 0;
    const rate = Number(it.rate8h) || 0;
    const v = mark * rate;
    scored.push({ ex, v });
  }

  scored.sort((a, b) => (isLong ? a.v - b.v : b.v - a.v));
  return scored.map((x) => x.ex);
}

function funding_initState_(exchanges) {
  const st = {};
  for (const ex of exchanges) {
    st[ex] = { gross: 0, dir: 0, qtyBySym: {}, perSymAbs: {} };
    for (const sym of OPT_SYMBOLS) {
      st[ex].qtyBySym[sym] = 0;
      st[ex].perSymAbs[sym] = 0;
    }
  }
  return st;
}

function funding_getMark_(ex, sym, rateMap, markFallback) {
  const it = rateMap.get(`${ex}|${sym}`);
  if (it && it.mark != null && Number.isFinite(it.mark)) return it.mark;
  return markFallback[sym] || 0;
}

function funding_applyDelta_(state, ex, sym, deltaQty, rateMap, markFallback) {
  const mark = funding_getMark_(ex, sym, rateMap, markFallback);
  if (!mark || !Number.isFinite(mark) || mark <= 0) return;

  const prevQty = Number(state[ex].qtyBySym[sym] || 0);
  const nextQty = prevQty + deltaQty;

  const prevNot = prevQty * mark;
  const nextNot = nextQty * mark;

  state[ex].dir += nextNot - prevNot;
  state[ex].gross += Math.abs(nextNot) - Math.abs(prevNot);

  state[ex].qtyBySym[sym] = nextQty;
  state[ex].perSymAbs[sym] = Math.abs(nextNot);
}

function funding_maxDeltaQtyAllowed_(
  ex,
  sym,
  desiredDeltaQty,
  dep,
  dirMult,
  capMult,
  grossMaxMult,
  state,
  rateMap,
  markFallback
) {
  if (desiredDeltaQty === 0) return 0;

  const mark = funding_getMark_(ex, sym, rateMap, markFallback);
  if (!mark || !Number.isFinite(mark) || mark <= 0) return 0;

  const curDir = Number(state[ex].dir || 0);
  const curGross = Number(state[ex].gross || 0);
  const prevQty = Number(state[ex].qtyBySym[sym] || 0);
  const prevAbsNot = Math.abs(prevQty * mark);

  const dirLimit = (dep[ex] || 0) * (dirMult[ex] || 0);
  const grossMult = Number(grossMaxMult[ex]);
  const grossMax = ex === "variational" || !Number.isFinite(grossMult) ? Infinity : (dep[ex] || 0) * grossMult;

  let low = -Infinity;
  let high = Infinity;

  // (1) Direction constraint
  if (Number.isFinite(dirLimit) && dirLimit >= 0) {
    const a = (-dirLimit - curDir) / mark;
    const b = (dirLimit - curDir) / mark;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
  }

  // (2) Gross max (all non-variational exchanges with *_gross_max_mult)
  if (Number.isFinite(grossMax)) {
    const grossWithoutSym = curGross - prevAbsNot;
    const remainAbsNot = grossMax - grossWithoutSym;
    if (remainAbsNot < 0) return 0;

    const bound = remainAbsNot / mark;
    low = Math.max(low, -bound - prevQty);
    high = Math.min(high, bound - prevQty);
  }

  // (3) SOL/BNB cap
  if (sym === "SOL" || sym === "BNB") {
    const cap = (dep[ex] || 0) * (capMult[sym] || 0);
    if (Number.isFinite(cap)) {
      const bound = cap / mark;
      low = Math.max(low, -bound - prevQty);
      high = Math.min(high, bound - prevQty);
    }
  }

  // (4) sign clamp
  if (desiredDeltaQty > 0) low = Math.max(low, 0);
  else high = Math.min(high, 0);

  if (low > high) return 0;

  let allowed = 0;
  if (desiredDeltaQty > 0) {
    allowed = Math.min(desiredDeltaQty, high);
    allowed = Math.max(allowed, low);
  } else {
    allowed = Math.max(desiredDeltaQty, low);
    allowed = Math.min(allowed, high);
  }

  if (!Number.isFinite(allowed)) return 0;
  if (Math.abs(allowed) < 1e-12) return 0;

  return funding_round_(allowed);
}

function funding_round_(x) {
  return Math.round(x * 1e12) / 1e12;
}

/* =========================
 * Booster
 * ========================= */

function funding_calcExchangeStatsFromAlloc_(alloc, ex, rateMap, markFallback) {
  let gross = 0;
  let dir = 0;
  const perSymAbs = {};
  for (const sym of OPT_SYMBOLS) perSymAbs[sym] = 0;

  for (const sym of OPT_SYMBOLS) {
    const qty = Number(alloc[ex][sym] || 0);
    const mark = funding_getMark_(ex, sym, rateMap, markFallback);
    const notional = qty * mark;
    gross += Math.abs(notional);
    dir += notional;
    perSymAbs[sym] = Math.abs(notional);
  }
  return { gross, dir, perSymAbs };
}

function funding_applyVariationalBooster_(
  alloc,
  state,
  dep,
  dirMult,
  capMult,
  grossMaxMult,
  rateMap,
  markFallback,
  minGrossVar,
  stepUsd,
  assets,
  hedgeOrder
) {
  // Build stats for all exchanges so any hedge_order member can be used safely.
  const stats = {};
  for (const ex of OPT_EXCHANGES) {
    stats[ex] = funding_calcExchangeStatsFromAlloc_(alloc, ex, rateMap, markFallback);
  }

  if (!Number.isFinite(minGrossVar) || minGrossVar <= 0) return;
  if (!Number.isFinite(stepUsd) || stepUsd <= 0) throw new Error("booster_step_usd가 0이거나 비정상");

  if (stats.variational.gross >= minGrossVar - 1e-6) return;

  const pool = (assets || [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => OPT_SYMBOLS.includes(s));
  if (pool.length < 2) throw new Error("booster_assets는 최소 2개 심볼이 필요해. 예: BTC,ETH");

  const grossMaxByEx = {};
  for (const ex of OPT_EXCHANGES) {
    const mult = Number(grossMaxMult[ex]);
    grossMaxByEx[ex] = ex === "variational" || !Number.isFinite(mult) ? Infinity : (Number(dep[ex]) || 0) * mult;
  }
  const ligGrossMax = grossMaxByEx.lighter;

  // ✅ 라이터를 부스터가 다 잡아먹지 않게 reserve 확보
  const lighterReserveGross = ligGrossMax > 0 ? Math.min(ligGrossMax * 0.2, 2 * stepUsd) : 0;

  // tie-break (동일 pnl이면 hedgeOrder 순서)
  const hedgeRank = {};
  (hedgeOrder || []).forEach((ex, i) => {
    hedgeRank[String(ex).toLowerCase()] = i;
  });

  function capUsd(ex, sym) {
    if (sym !== "SOL" && sym !== "BNB") return Infinity;
    const m = Number(capMult[sym] || 0);
    return (Number(dep[ex]) || 0) * m;
  }
  function rate8h(ex, sym) {
    const it = rateMap.get(`${ex}|${sym}`) || {};
    return Number(it.rate8h) || 0;
  }

  function applyBlock(hedgeEx, symShortOnVar, symLongOnVar, blockUsd) {
    const mvS = funding_getMark_("variational", symShortOnVar, rateMap, markFallback);
    const mvL = funding_getMark_("variational", symLongOnVar, rateMap, markFallback);
    const mhS = funding_getMark_(hedgeEx, symShortOnVar, rateMap, markFallback);
    const mhL = funding_getMark_(hedgeEx, symLongOnVar, rateMap, markFallback);

    if (!(mvS > 0 && mvL > 0 && mhS > 0 && mhL > 0)) {
      throw new Error("booster mark_price 누락. funding_current/opt_rates 확인 필요");
    }

    // deltas (USD notional = blockUsd)
    const dqVarS = -blockUsd / mvS; // var short
    const dqVarL = +blockUsd / mvL; // var long
    const dqHedS = +blockUsd / mhS; // hedge long
    const dqHedL = -blockUsd / mhL; // hedge short

    // --- BEFORE abs/signed notionals (정확한 gross/dir 변화량 계산) ---
    const prevVarQtyS = Number(alloc.variational[symShortOnVar] || 0);
    const prevVarQtyL = Number(alloc.variational[symLongOnVar] || 0);
    const prevHedQtyS = Number(alloc[hedgeEx][symShortOnVar] || 0);
    const prevHedQtyL = Number(alloc[hedgeEx][symLongOnVar] || 0);

    const prevVarNotS = prevVarQtyS * mvS,
      prevVarNotL = prevVarQtyL * mvL;
    const prevHedNotS = prevHedQtyS * mhS,
      prevHedNotL = prevHedQtyL * mhL;

    const prevVarAbs = Math.abs(prevVarNotS) + Math.abs(prevVarNotL);
    const prevHedAbs = Math.abs(prevHedNotS) + Math.abs(prevHedNotL);

    const prevVarDir = prevVarNotS + prevVarNotL;
    const prevHedDir = prevHedNotS + prevHedNotL;

    // --- APPLY ---
    alloc.variational[symShortOnVar] = prevVarQtyS + dqVarS;
    alloc.variational[symLongOnVar] = prevVarQtyL + dqVarL;
    alloc[hedgeEx][symShortOnVar] = prevHedQtyS + dqHedS;
    alloc[hedgeEx][symLongOnVar] = prevHedQtyL + dqHedL;

    // --- AFTER ---
    const nextVarNotS = alloc.variational[symShortOnVar] * mvS;
    const nextVarNotL = alloc.variational[symLongOnVar] * mvL;
    const nextHedNotS = alloc[hedgeEx][symShortOnVar] * mhS;
    const nextHedNotL = alloc[hedgeEx][symLongOnVar] * mhL;

    const nextVarAbs = Math.abs(nextVarNotS) + Math.abs(nextVarNotL);
    const nextHedAbs = Math.abs(nextHedNotS) + Math.abs(nextHedNotL);

    const nextVarDir = nextVarNotS + nextVarNotL;
    const nextHedDir = nextHedNotS + nextHedNotL;

    // ✅ 정확한 gross/dir 업데이트 (netting 반영!)
    stats.variational.gross += nextVarAbs - prevVarAbs;
    stats[hedgeEx].gross += nextHedAbs - prevHedAbs;

    stats.variational.dir += nextVarDir - prevVarDir;
    stats[hedgeEx].dir += nextHedDir - prevHedDir;

    // perSymAbs 업데이트(정확)
    stats.variational.perSymAbs[symShortOnVar] = Math.abs(nextVarNotS);
    stats.variational.perSymAbs[symLongOnVar] = Math.abs(nextVarNotL);
    stats[hedgeEx].perSymAbs[symShortOnVar] = Math.abs(nextHedNotS);
    stats[hedgeEx].perSymAbs[symLongOnVar] = Math.abs(nextHedNotL);
  }

  let iter = 0;
  while (stats.variational.gross < minGrossVar - 1e-6 && iter < 5000) {
    iter++;

    const remainingGross = minGrossVar - stats.variational.gross;
    let blockUsd = Math.min(stepUsd, remainingGross / 2);
    if (!Number.isFinite(blockUsd) || blockUsd <= 0) break;

    let best = null;

    for (const hedgeEx0 of hedgeOrder || []) {
      const hedgeEx = String(hedgeEx0 || "").toLowerCase().trim();
      if (!OPT_EXCHANGES.includes(hedgeEx)) continue;
      if (hedgeEx === "variational") continue;

      const hedgeGrossMax = Number(grossMaxByEx[hedgeEx]);
      if (Number.isFinite(hedgeGrossMax)) {
        const reserve = hedgeEx === "lighter" ? lighterReserveGross : 0;
        const after = Number(stats[hedgeEx].gross || 0) + 2 * blockUsd; // 후보 필터는 보수적으로 유지
        const safeMax = hedgeGrossMax - reserve;
        if (after > safeMax + 1e-6) continue;
      }

      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const a = pool[i];
          const b = pool[j];

          const checkCaps = (symShortOnVar, symLongOnVar) => {
            const mvS = funding_getMark_("variational", symShortOnVar, rateMap, markFallback);
            const mvL = funding_getMark_("variational", symLongOnVar, rateMap, markFallback);
            const mhS = funding_getMark_(hedgeEx, symShortOnVar, rateMap, markFallback);
            const mhL = funding_getMark_(hedgeEx, symLongOnVar, rateMap, markFallback);
            if (!(mvS > 0 && mvL > 0 && mhS > 0 && mhL > 0)) return false;

            const capVarS = capUsd("variational", symShortOnVar);
            const capVarL = capUsd("variational", symLongOnVar);
            const capHedS = capUsd(hedgeEx, symShortOnVar);
            const capHedL = capUsd(hedgeEx, symLongOnVar);

            const nextVarAbsS = Math.abs((Number(alloc.variational[symShortOnVar] || 0) + -blockUsd / mvS) * mvS);
            const nextVarAbsL = Math.abs((Number(alloc.variational[symLongOnVar] || 0) + +blockUsd / mvL) * mvL);
            const nextHedAbsS = Math.abs((Number(alloc[hedgeEx][symShortOnVar] || 0) + +blockUsd / mhS) * mhS);
            const nextHedAbsL = Math.abs((Number(alloc[hedgeEx][symLongOnVar] || 0) + -blockUsd / mhL) * mhL);

            if (nextVarAbsS > capVarS + 1e-6) return false;
            if (nextVarAbsL > capVarL + 1e-6) return false;
            if (nextHedAbsS > capHedS + 1e-6) return false;
            if (nextHedAbsL > capHedL + 1e-6) return false;
            return true;
          };

          const pnl1 = rate8h("variational", a) - rate8h(hedgeEx, a) + (rate8h(hedgeEx, b) - rate8h("variational", b));
          const pnl2 = rate8h("variational", b) - rate8h(hedgeEx, b) + (rate8h(hedgeEx, a) - rate8h("variational", a));

          if (checkCaps(a, b)) {
            const cand = { hedgeEx, symShortOnVar: a, symLongOnVar: b, pnlPerUsd: pnl1 };
            if (!best || cand.pnlPerUsd > best.pnlPerUsd + 1e-15) best = cand;
            else if (Math.abs(cand.pnlPerUsd - best.pnlPerUsd) <= 1e-15) {
              if ((hedgeRank[cand.hedgeEx] ?? 999) < (hedgeRank[best.hedgeEx] ?? 999)) best = cand;
            }
          }
          if (checkCaps(b, a)) {
            const cand = { hedgeEx, symShortOnVar: b, symLongOnVar: a, pnlPerUsd: pnl2 };
            if (!best || cand.pnlPerUsd > best.pnlPerUsd + 1e-15) best = cand;
            else if (Math.abs(cand.pnlPerUsd - best.pnlPerUsd) <= 1e-15) {
              if ((hedgeRank[cand.hedgeEx] ?? 999) < (hedgeRank[best.hedgeEx] ?? 999)) best = cand;
            }
          }
        }
      }
    }

    if (!best) {
      const safeMax = ligGrossMax - lighterReserveGross;
      throw new Error(
        `Variational min gross OI를 더 이상 채울 수 없어.\n` +
          `현재 var gross=${stats.variational.gross.toFixed(2)} / min=${minGrossVar.toFixed(2)}\n` +
          `lighter gross=${stats.lighter.gross.toFixed(2)} / safeMax=${(safeMax > 0 ? safeMax : 0).toFixed(2)} (reserve=${lighterReserveGross.toFixed(2)})\n` +
          `가능 원인: SOL/BNB cap 제한, hedge 거래소 gross_max 제한, hedge_order 후보 부족, mark/rate 누락.\n` +
          `해결: booster_assets(BTC,ETH) 유지 / hedge_order 확장 / sol_cap_mult·bnb_cap_mult 완화 / 각 거래소 *_gross_max_mult 상향`
      );
    }

    applyBlock(best.hedgeEx, best.symShortOnVar, best.symLongOnVar, blockUsd);
  }

  // ✅ 마지막에 '진짜 alloc' 기준으로 한번 더 검증(이제 통과해야 정상)
  const chk = funding_calcExchangeStatsFromAlloc_(alloc, "variational", rateMap, markFallback);
  if (chk.gross < minGrossVar - 1e-6) {
    throw new Error(`Variational min gross OI를 만족시키지 못했어.\n` + `gross=${chk.gross.toFixed(2)} < min=${minGrossVar.toFixed(2)}`);
  }
}

/* =========================
 * Write opt_solution + summary
 * ========================= */

function funding_writeOptSolution_(
  shSol,
  alloc,
  rateMap,
  markFallback,
  dep,
  dirMult,
  capMult,
  grossMaxMult,
  minGrossVar
) {
  const maxRows = shSol.getMaxRows();
  if (maxRows > 1) shSol.getRange(2, 1, maxRows - 1, shSol.getMaxColumns()).clearContent();

  const out = [];
  let total8h = 0;
  let totalDay = 0;

  for (const ex of OPT_EXCHANGES) {
    for (const sym of OPT_SYMBOLS) {
      const qty = Number(alloc[ex][sym] || 0);
      const it = rateMap.get(`${ex}|${sym}`) || {};
      const rate = Number(it.rate8h) || 0;
      const mark = funding_getMark_(ex, sym, rateMap, markFallback);

      const notional = qty * mark;
      const pnl8h = -notional * rate;
      const pnlDay = pnl8h * 3;

      total8h += pnl8h;
      totalDay += pnlDay;

      out.push([ex, sym, qty, mark || "", rate, notional, pnl8h, pnlDay, ""]);
    }
  }

  if (out.length) shSol.getRange(2, 1, out.length, 9).setValues(out);

  const totalRow = 2 + out.length + 1;
  shSol.getRange(totalRow, 1, 1, 9).setValues([["TOTAL", "", "", "", "", "", total8h, totalDay, ""]]);

  // ---- exchange summary ----
  const summaryStart = totalRow + 2;
  shSol.getRange(summaryStart, 1, 1, 9).setValues([
    [
      "exchange_summary",
      "gross_oi_usd",
      "dir_usd",
      "dir_limit_usd",
      "gross_rule",
      "sol_abs_usd",
      "sol_cap_usd",
      "bnb_abs_usd",
      "bnb_cap_usd",
    ],
  ]);

  const rows = [];
  for (const ex of OPT_EXCHANGES) {
    const s = funding_calcExchangeStatsFromAlloc_(alloc, ex, rateMap, markFallback);
    const dirLimit = (dep[ex] || 0) * (dirMult[ex] || 0);
    const grossMult = Number(grossMaxMult[ex]);
    const grossMax = ex === "variational" || !Number.isFinite(grossMult) ? null : (dep[ex] || 0) * grossMult;

    let grossRule = "";
    if (ex === "variational") grossRule = `min ${Number(minGrossVar || 0).toFixed(0)}`;
    else if (grossMax != null) grossRule = `max ${Number(grossMax).toFixed(0)}`;
    else grossRule = "none";

    const solCap = (dep[ex] || 0) * (capMult.SOL || 0);
    const bnbCap = (dep[ex] || 0) * (capMult.BNB || 0);

    rows.push([ex, s.gross, s.dir, dirLimit, grossRule, s.perSymAbs.SOL, solCap, s.perSymAbs.BNB, bnbCap]);
  }

  if (rows.length) shSol.getRange(summaryStart + 1, 1, rows.length, 9).setValues(rows);
}

function funding_buildConstraintSummary_(alloc, dep, dirMult, capMult, grossMaxMult, rateMap, markFallback, minGrossVar) {
  const lines = [];

  for (const ex of OPT_EXCHANGES) {
    const s = funding_calcExchangeStatsFromAlloc_(alloc, ex, rateMap, markFallback);
    const dirLimit = dep[ex] * dirMult[ex];
    const grossMult = Number(grossMaxMult[ex]);
    const grossMax = ex === "variational" || !Number.isFinite(grossMult) ? null : dep[ex] * grossMult;

    const okDir = Math.abs(s.dir) <= dirLimit + 1e-6;

    let okGross = true;
    let grossMsg = "";
    if (ex === "variational") {
      okGross = s.gross >= minGrossVar - 1e-6;
      grossMsg = `gross ${funding_fmtUsd_(s.gross)} (min ${funding_fmtUsd_(minGrossVar)})`;
    } else if (grossMax != null) {
      okGross = grossMax == null ? true : s.gross <= grossMax + 1e-6;
      grossMsg = `gross ${funding_fmtUsd_(s.gross)} (max ${funding_fmtUsd_(grossMax)})`;
    } else {
      grossMsg = `gross ${funding_fmtUsd_(s.gross)}`;
    }

    const solCap = dep[ex] * (capMult.SOL || 0);
    const bnbCap = dep[ex] * (capMult.BNB || 0);
    const okSol = s.perSymAbs.SOL <= solCap + 1e-6;
    const okBnb = s.perSymAbs.BNB <= bnbCap + 1e-6;

    lines.push(
      `[${ex}] ` +
        `dir ${funding_fmtUsd_(s.dir)} / limit ${funding_fmtUsd_(dirLimit)} ${okDir ? "OK" : "VIOLATION"} | ` +
        `${grossMsg} ${okGross ? "OK" : "VIOLATION"} | ` +
        `SOL ${funding_fmtUsd_(s.perSymAbs.SOL)} / cap ${funding_fmtUsd_(solCap)} ${okSol ? "OK" : "VIOLATION"} | ` +
        `BNB ${funding_fmtUsd_(s.perSymAbs.BNB)} / cap ${funding_fmtUsd_(bnbCap)} ${okBnb ? "OK" : "VIOLATION"}`
    );
  }

  return lines;
}

/* =========================
 * opt_inputs key/value helpers
 * ========================= */

function funding_readKeyValues_(sh) {
  const vals = sh.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < vals.length; i++) {
    const k = String(vals[i][0] || "").trim();
    if (!k) continue;
    out[k] = vals[i][1];
  }
  return out;
}

function funding_ensureKeyValues_(sh, kvPairs) {
  const vals = sh.getDataRange().getValues();
  const idxByKey = new Map();
  for (let i = 1; i < vals.length; i++) {
    const k = String(vals[i][0] || "").trim();
    if (k) idxByKey.set(k, i + 1);
  }

  for (const [k, v] of kvPairs) {
    const row = idxByKey.get(k);
    if (row) continue; // user value 유지
    sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[k, v]]);
  }
}

/**
 * ✅ Repair: positions 시트 rolling 컬럼(3/7/15/30/all) 헤더가 꼬였을 때 복구
 * - 없어진 헤더는 "시트 맨 끝"에 새 컬럼으로 추가
 * - 기존 데이터가 덮어써진 경우도, 다시 rolling 계산 돌리면 값은 재생성됨
 */
function funding_repairPositionsRollingColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FUNDING_SHEET_POSITIONS);
  if (!sh) throw new Error("positions 시트를 찾을 수 없어.");

  const lastCol = sh.getLastColumn();
  if (lastCol < 1) throw new Error("positions 시트가 비어있어.");

  // 1행 전체 헤더 읽기
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v || "").trim());

  // 필요한 rolling 컬럼들(3/7/15/30/all 전부)
  const required = [
    // 3d
    "avg_funding_3d","cnt_3d","coverage_3d","avg_source_3d","funding_pnl_3d_usd",
    // 7d
    "avg_funding_7d","cnt_7d","coverage_7d","avg_source_7d","funding_pnl_7d_usd",
    // 15d
    "avg_funding_15d","cnt_15d","coverage_15d","avg_source_15d","funding_pnl_15d_usd",
    // 30d
    "avg_funding_30d","cnt_30d","coverage_30d","avg_source_30d","funding_pnl_30d_usd",
    // all
    "avg_funding_all","cnt_all","coverage_all","avg_source_all","funding_pnl_all_usd",
  ];

  let added = 0;

  // helper: 맨 끝에 새 컬럼 추가
  function appendCol(colName) {
    const c = sh.getLastColumn();
    sh.insertColumnAfter(c);
    sh.getRange(1, c + 1).setValue(colName);
    added++;
  }

  // 없는 헤더는 끝에 추가
  for (const name of required) {
    if (header.indexOf(name) === -1) appendCol(name);
  }

  safeAlert_(
    added > 0
      ? `✅ positions rolling 컬럼 복구 완료: ${added}개 컬럼을 맨 끝에 추가했어.\n이제 rolling 업데이트를 다시 실행해줘.`
      : `✅ positions rolling 컬럼은 정상(추가할 것 없음).`
  );
}

function funding_positionsEnsureColumn_(sh, headerArr, name) {
  const i = headerArr.indexOf(name);
  if (i >= 0) return i;

  const lastCol = sh.getLastColumn(); // ✅ 실제 시트 마지막 컬럼 기준
  sh.insertColumnAfter(lastCol);
  sh.getRange(1, lastCol + 1).setValue(name);

  headerArr.push(name);
  return headerArr.length - 1; // 0-index
}

/**
 * ✅ OPT(ideal) 포지션 기준 rolling funding pnl (3/7/15/30/all)
 * - opt_solution 시트의 qty/mark_price 를 고정 포지션으로 가정
 * - funding_history(8h) rolling avg로 기간별 pnl 계산
 * - 결과는 opt_solution 오른쪽에 요약블록으로 출력
 */
function funding_updateOptSolutionRollingFundingPnl_3_7_15_30_all() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("opt_solution");
  if (!sh) throw new Error("opt_solution 시트를 찾을 수 없어. (Funding → Init optimizer sheets 먼저)");

  const lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error("opt_solution에 데이터가 없어. 먼저 Optimize allocation 실행해줘.");

  const lastCol = sh.getLastColumn();
  const vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = vals[0].map((v) => String(v || "").trim());

  const idx = (name) => header.indexOf(name);

  const iEx = idx("exchange");
  const iSym = idx("symbol");
  const iQty = idx("qty");
  const iMark = idx("mark_price");
  const iRate = idx("funding_rate_8h"); // optional (표시용)

  if ([iEx, iSym, iQty, iMark].some((x) => x < 0)) {
    throw new Error("opt_solution 헤더에 exchange/symbol/qty/mark_price가 필요해.");
  }

  // funding_history에서 rolling 집계(Map<ex|sym, sums/cnts/...>) 구축
  const rollMap = funding_buildRollingAvgMapFromHistory_();

  // opt_solution은 TOTAL 행이 있으니, 그 전까지만 포지션으로 취급
  // (exchange 컬럼이 "TOTAL"인 줄은 스킵)
  let total3 = 0, total7 = 0, total15 = 0, total30 = 0, totalAll = 0;
  const byEx = new Map(); // ex -> {p3,p7,p15,p30,pAll}

  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];

    const exRaw = String(row[iEx] || "").trim();
    if (!exRaw || exRaw.toUpperCase() === "TOTAL") continue;

    const ex = exRaw.toLowerCase();
    const sym = String(row[iSym] || "").trim().toUpperCase();
    const qty = Number(row[iQty]);
    const mark = Number(row[iMark]);

    if (!ex || !sym || !Number.isFinite(qty) || qty === 0 || !Number.isFinite(mark) || mark <= 0) continue;

    const key = `${ex}|${sym}`;
    const agg = rollMap.get(key);

    // interval은 history에 있으면 그거, 없으면 8h 기본값
    const intervalS = (agg && agg.interval_s) ? Number(agg.interval_s) : 28800;
    const notional = qty * mark;

    const res3 = funding_rollPickAvg_(agg, 3, intervalS);
    const res7 = funding_rollPickAvg_(agg, 7, intervalS);
    const res15 = funding_rollPickAvg_(agg, 15, intervalS);
    const res30 = funding_rollPickAvg_(agg, 30, intervalS);
    const resAll = funding_rollPickAvgAll_(agg, intervalS);

    const pnl3 = funding_rollPnlUsd_(notional, res3.avg, 3, intervalS);
    const pnl7 = funding_rollPnlUsd_(notional, res7.avg, 7, intervalS);
    const pnl15 = funding_rollPnlUsd_(notional, res15.avg, 15, intervalS);
    const pnl30 = funding_rollPnlUsd_(notional, res30.avg, 30, intervalS);
    const pnlAll = funding_rollPnlUsdAll_(notional, agg);

    total3 += pnl3; total7 += pnl7; total15 += pnl15; total30 += pnl30; totalAll += pnlAll;

    if (!byEx.has(ex)) byEx.set(ex, { p3: 0, p7: 0, p15: 0, p30: 0, pAll: 0 });
    const acc = byEx.get(ex);
    acc.p3 += pnl3; acc.p7 += pnl7; acc.p15 += pnl15; acc.p30 += pnl30; acc.pAll += pnlAll;
  }

  // ===== opt_solution 오른쪽 고정 박스에 요약 출력 (항상 같은 위치 덮어쓰기) =====
  const c0 = funding_getOptRollingSummaryAnchorCol_(sh);
  const CLEAR_ROWS = 30;
  const WIDTH = 7;

  // 기존에 오른쪽으로 밀려 생성된 중복 박스는 자동 정리
  funding_clearDuplicateOptRollingBlocks_(sh, c0);
  sh.getRange(1, c0, CLEAR_ROWS, WIDTH).clearContent();

  sh.getRange(1, c0, 1, 2).setValues([["OPT ROLLING TOTAL funding_pnl", "USD"]]);
  sh.getRange(2, c0, 1, 2).setValues([["TOTAL opt_funding_pnl_3d", total3]]);
  sh.getRange(3, c0, 1, 2).setValues([["TOTAL opt_funding_pnl_7d", total7]]);
  sh.getRange(4, c0, 1, 2).setValues([["TOTAL opt_funding_pnl_15d", total15]]);
  sh.getRange(5, c0, 1, 2).setValues([["TOTAL opt_funding_pnl_30d", total30]]);
  sh.getRange(6, c0, 1, 2).setValues([["TOTAL opt_funding_pnl_all", totalAll]]);

  sh.getRange(8, c0, 1, 6).setValues([[
    "exchange", "pnl_3d_usd", "pnl_7d_usd", "pnl_15d_usd", "pnl_30d_usd", "pnl_all_usd"
  ]]);

  const out = [];
  const exList = Array.from(byEx.keys()).sort();
  for (const ex of exList) {
    const v = byEx.get(ex);
    out.push([ex, v.p3 || 0, v.p7 || 0, v.p15 || 0, v.p30 || 0, v.pAll || 0]);
  }
  if (out.length) sh.getRange(9, c0, out.length, 6).setValues(out);

  safeAlert_(
`✅ OPT rolling funding_pnl 완료 (3/7/15/30 + ALL)
TOTAL 3d: ${funding_fmtUsd_(total3)}
TOTAL 7d: ${funding_fmtUsd_(total7)}
TOTAL 15d: ${funding_fmtUsd_(total15)}
TOTAL 30d: ${funding_fmtUsd_(total30)}
TOTAL ALL: ${funding_fmtUsd_(totalAll)}`
  );
}

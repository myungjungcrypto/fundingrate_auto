# Dedicated Account Migration Runbook

This runbook migrates your Funding workflow to a dedicated Google account with safe cutover.

## 0) Preconditions

- Source repo: `/Users/myunggeunjung/fundingrate_auto`
- New dedicated Google account is ready (2FA enabled).
- Existing (legacy) operating spreadsheet + history spreadsheet are known.

## 1) Clone Sheets in Dedicated Account

1. Log in with dedicated account.
2. Copy current operating spreadsheet (`config`, `funding_current`, `positions`, `opt_*`).
3. Copy history spreadsheet (`funding_history`, `lighter_hourly_history`).
4. Keep sharing minimal (owner + your main account view-only if needed).

## 2) Bind Apps Script and Push Local Source

1. Install clasp locally:
   - `npm i -g @google/clasp`
2. Login:
   - `clasp login`
3. In dedicated copied spreadsheet, open Apps Script and get Script ID.
4. Create `.clasp.json` from `.clasp.example.json` and set real Script ID.
5. Pull once:
   - `clasp pull`
6. Overwrite with local source (`funding.gs`, `code.gs`, `appsscript.json`) then push:
   - `clasp push`

## 3) Initial Secure Setup (from Funding menu)

Run in this order:

1. `Init sheets (current/positions)`
2. Fill `config`:
   - `funding_api_url`
   - `funding_history_spreadsheet_id` (new dedicated history sheet ID)
   - `legacy_history_spreadsheet_id` (old history sheet ID)
3. `Security setup (Script Properties)`
4. `Save legacy history id to Script Properties`
5. `Migrate config secrets -> Script Properties` (if any secret-like keys exist)

Notes:
- Secret-like keys in `config` are masked as `__SCRIPT_PROPERTY__`.
- Runtime reads API URL and history spreadsheet ID from Script Properties first.

## 4) History Migration and Validation

1. `Migrate legacy history (incremental)`
2. `Verify history integrity (last 24h)`
3. If mismatch exists, rerun incremental migration and verify again.

## 5) Trigger Setup and Functional Smoke Test

1. `Install 8h schedule (00:59/08:59/16:59 KST)`
2. `Install Lighter hourly schedule (every hour ~:59 KST)`
3. Run manually:
   - `Update current now (no history)`
   - `Bootstrap lighter_hourly_history NOW (1 shot)`
   - `Update positions PnL`
   - `Optimize allocation (maximize funding)`

## 6) Cutover

On legacy project:

1. Remove triggers (legacy should stop writing).

On dedicated project:

1. Keep triggers enabled.
2. Optional protection command on legacy workbook:
   - `Cutover freeze (remove triggers + read-only)`

## 7) Rollback

If issue is found:

1. On dedicated project: remove funding triggers.
2. On legacy project: restore legacy triggers.
3. Fix issue and rerun from section 4.

## Added Apps Script Operations

- `funding_setupDedicatedAccountSecurity_`
- `funding_migrateConfigSecretsToScriptProperties`
- `funding_setLegacyHistorySpreadsheetIdInScriptProperties`
- `funding_migrateLegacyHistoryIncremental`
- `funding_verifyHistoryIntegrityRecent24h`
- `funding_cutoverFreezeCurrentWorkbook`
- `funding_unfreezeCurrentWorkbook`


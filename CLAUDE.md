# Portfolio - Personal Portfolio Tracker

## Project Overview

A single-page application for tracking portfolio of securities such as stocks and ETFs (version 2: transaction-based — dividends, options, cash flows and a per-account ledger of held positions; see `design/VERSION_2.md` for the refactoring spec and `design/VERSION_2_PLAN.md` for the plan). Runs entirely locally in a bundled Chromium browser with no server, and no build step. Uses external services like Yahoo Finance MCP to retrieve price quotes and other asset data.

---

## Architecture

### Runtime Environment

- **Browser**: Chromium (standalone, bundled under `chrome`)
  - Windows: `chrome\chrome.exe` (manually downloaded by user)
  - macOS: `chrome/Chromium` (manually downloaded by user)
- **Launch**: `portfolio.bat` (Windows) / `portfolio.sh` (macOS) starts Chromium with required flags and opens `index.html`
- **Protocol**: `file://` (no local server)

**Required Chromium launch flags:**
```
--allow-file-access-from-files
--enable-features=FileSystemAccessAPI
--user-data-dir=<appDir>/chrome/profile   (macOS only — keeps profile local; Windows uses bundled Chromium's own profile)
--no-first-run                            (macOS only)
```

### File Structure

```
Portfolio/
├── CLAUDE.md               # This file
├── index.html              # Single entry point (HTML + CSS + JS)
├── app.css                 # Application styles
├── portfolio.bat           # Launches Chromium on Windows
├── portfolio.sh            # Launches Chromium on macOS 
└── chrome/                 # Chromium installs (gitignored)
    ├── 148.0.7778.179/     # Windows Chromium (as an example)
    ├── Chromium/           # macOS Chromium 
    └── profile/            # macOS Chromium user-data-dir
└── lib/
    ├── sql-wasm.js         # sql.js library (local copy, no CDN)
    ├── sql-wasm.wasm       # SQLite WASM binary (local copy)
    ├── tabulator.min.js    # Tabulator 6.x table library (local copy)
    ├── tabulator.min.css   # Tabulator default theme (local copy)
    └── d3.min.js           # D3 v7.9.0 (local copy) — Analyze > Asset performance and Reports > Portfolio trend charts
└── js/
    ├── schema.js           # SCHEMA_VERSION, SCHEMA_SQL (DDL + views), RULES_SEED (pre-populated import rules)
    ├── db.js               # DB global — sql.js wrapper (query, run, transaction, export, version check, change tracking)
    ├── engine.js           # Engine global — applies transactions to Ledger/Options/cash; rules, option symbols, rebuild
    ├── dialogs.js          # Dialogs global — modal alert/confirm/prompt/custom
    ├── import.js           # Import global — Import holdings (positions snapshot) and Import transactions
    ├── tab-portfolio.js    # PortfolioTab global — multi-instance portfolio tab + Holdings drill-down tabs
    ├── tab-accounts.js     # AccountsTab global — singleton accounts tab
    ├── tab-assets.js       # AssetsTab global — singleton assets tab (with note history)
    ├── tab-prices.js       # PricesTab global — singleton prices tab
    ├── tab-transactions.js # TransactionsTab global — multi-instance tab on the Transactions table
    ├── tab-ledger.js       # LedgerTab global — singleton Ledger view (the v1 Transactions tab repurposed) + Theme-filtered Ledger tabs
    ├── tab-options.js      # OptionsTab global — singleton Options view
    ├── tab-rules.js        # RulesTab global — singleton import Rules view
    ├── tab-query.js        # QueryTab global — multi-instance SQL query tab
    ├── tab-reports.js      # ReportsTab global — multi-instance Portfolio/Account performance report tabs
    ├── tab-dividends.js    # DividendsTab global — multi-instance Reports > Dividends tabs
    ├── tab-gains.js        # GainsTab global — multi-instance Reports > Gains/Losses tabs
    ├── tab-trend.js        # TrendTab global — multi-instance Reports > Portfolio trend tabs (D3 line chart)
    ├── tab-analysis.js     # AnalysisTab global — multi-instance Reports > Investments by theme and Analyze > Asset performance tabs
    └── app.js              # App/YahooFinance globals — init, menus, file ops, Update Prices, MCP client
└── tests/                  # Automated tests (QuickJS + Python sqlite3), see tests/README.md
```

### Data Storage

- **Format**: SQLite database file (`.db`) stored in a user-chosen local folder
- **Library**: `sql.js` (SQLite compiled to WASM) — chosen over `@sqlite.org/sqlite-wasm` because it does NOT require `SharedArrayBuffer`, which is unavailable under `file://` protocol
- **In-memory**: The entire database is loaded into `sql.js` in memory at startup; all reads and writes operate in-memory for performance

### File Access

The app uses the **File System Access API** (`showDirectoryPicker`) once at startup:
1. User is prompted to select their data folder
2. App scans the folder for `.db` files matching the naming pattern
3. User selects an existing database or creates a new one
4. DB file bytes are read and loaded into `sql.js`

### Save Strategy

On each explicit save (manual "Save" button):
- The current in-memory database is exported from `sql.js` as a `Uint8Array`
- Written to a **new file** with a timestamp suffix: `portfolio_YYYYMMDDHHMM.db`
- The previous file is left untouched (acts as implicit backup history)
- No file renaming or deletion occurs

Example history in data folder:
```
portfolio_202506011430.db
portfolio_202506021015.db
portfolio_202506121200.db   <- latest
```

### WASM Usage

The meaningful WASM component is `sql.js` (SQLite engine). All other application logic (filtering, formatting, UI event handling) is plain JavaScript — adding custom WASM for that would add complexity with no practical benefit at typical personal-finance data volumes.

---

## Application Startup Flow

1. `portfolio.bat` (Windows) / `portfolio.sh` (macOS) accept an optional first argument as a DATA_DIR override (default: `<appDir>/data`). Create DATA_DIR if absent, scan it for `.db` files, find the most recent by filename (descending sort — filenames are timestamped so alphabetical order equals chronological order), then launch Chromium with `?dataDir=<forwardSlashPath>&db=<filename>` appended to the URL. Spaces in DATA_DIR are encoded as `%20`. On macOS, `portfolio.sh` also strips the leading `/` from the DATA_DIR path before passing it as a URL parameter (see note 2 below).
2. `app.js` reads both URL parameters. `_dataDirUrl` is set to `file:///{dataDir}` when `?dataDir=` is present, or falls back to `{pageDir}data` when opening `index.html` directly. The DB is fetched from `${_dataDirUrl}/${dbFile}`. **Platform note**: Windows paths (`C:/foo`) have no leading slash, so `file:///C:/foo` is correct. macOS paths (`/Users/…`) would produce a 4-slash URL (`file:////Users/…`) if passed verbatim — `portfolio.sh` strips the leading `/` so the template produces the correct `file:///Users/…`.
3. `_lastFileHandle` is loaded from IndexedDB (`PortfolioApp` database, `handles` store, key `'dbFile'`) at startup so the Save/Open dialogs open in the correct folder across Chromium restarts.
4. If a file is found → `DB.loadFromBytes()`, which first checks `Info.Schema_Version` (see Data Schema). A database created before version 2.0 (no `Info` table) or by a newer version is refused with a `DB.VersionError`: the app shows "Cannot open <file>" and continues with a new empty database (step 5). On success, if `_lastFileHandle` is still null after the IDB load, `showOpenFilePicker` is attempted (with `id: 'portfolio-db'`) to acquire a handle for the auto-loaded file; on success the handle is persisted to IDB. This is a one-time step per fresh Chromium profile.
5. If no parameter, the fetch fails or the file is refused → `DB.createNew()` (empty v2 database with the `Info` row and the seeded import Rules).
6. Portfolio tab opens immediately — no welcome screen or folder picker.

Data folder: configurable via first argument to `portfolio.bat` / `portfolio.sh`; defaults to `data/` (created automatically by the launcher).

---

## Data Schema

The full specification is in `VERSION_2.md`; `js/schema.js` holds the DDL. Tables:

- **Info** — one row, `Schema_Version` (text, currently `'2.3'` = `SCHEMA_VERSION`). Set by `DB.createNew()`. `DB.loadFromBytes()` refuses files without an Info table (pre-2.0, no migration), below `SCHEMA_MIN_VERSION` (`'2.0'`) or with a newer version (versions are compared numerically per dotted part). Older 2.x files are **upgraded in memory** step by step by the `UPGRADES` map in `db.js` (`_checkVersion()`, keyed by source version; each step updates `Info.Schema_Version`), then `SCHEMA_SQL` runs; `loadFromBytes()` returns `{ upgradedFrom }`, the change counter is set to 1 so the upgraded database is saved, and the app shows a "Database Upgraded" notice (`_upgradeNotice`). Upgrade **2.0 → 2.1** adds `Ledger.Date` and fills it for every entry (active and inactive) from its reference transaction (`Transaction_ID`); entries without one (manual edits) get the date part of their `Timestamp`. Upgrade **2.1 → 2.2** has no schema change (Split/Distribution now keep the file's Amount as their cost basis): it replaces the old seeded descriptions of the DISTRIBUTION and REVERSE SPLIT rules, if unchanged, with the new ones. Upgrade **2.2 → 2.3** creates the **Balance** table and fills it by replaying, per account in chronological order (Date, Transaction_ID), every valid transaction that changes cash (Type Cash or Trade, Amount ≠ 0), starting from 0, each record linked to its transaction and its predecessor; when the replayed total differs from `Accounts.Cash` (manual cash edits) a final record without a transaction, dated on the upgrade day, brings it to `Accounts.Cash`; accounts with cash but no transactions get one such record.
- **Accounts** — Account_ID, Account, Name, Cash, Last_Updated, Currency, Active. Cash is maintained incrementally by the engine (Amount of Type Cash/Trade transactions) and can also be edited in the Accounts view.
- **Assets** — Symbol (PK), Description, Type (Stock/ETF/MF), Category, Theme, Active. No Notes column (moved to Notes). No FK from Transactions/Ledger: assets are created after the transactions and ledger entries.
- **Notes** — Note_ID, Symbol, Timestamp, Note. History of asset notes; the Assets view shows the latest.
- **Prices** — Date (`YYYY-MM-DD`), Symbol, Price, Currency, Valid. One daily closing price per symbol and date (`UNIQUE(Symbol, Date)`), written with an upsert (`_upsertPrice()` in `app.js`).
- **Transactions** — Transaction_ID, Account_ID, Date (`YYYY-MM-DD`), Type (Cash | Trade | Record | Other), Category (Equity | Option | Dividend | Fee | Interest | Margin | Tax | Transfer | Other), Effect (Trade | Cash | Other | Distribution | Split | Merger | Reinvestment | RSU | Snapshot), Symbol (equity ticker or canonical option symbol; NULL for cash-only), Quantity, Price, Amount (signed cash effect: + received, − paid), Currency, Description (from the Action column), Hash, Timestamp (entry time), Valid.
- **Ledger** — Holding_ID, Parent_ID, Transaction_ID, Date, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Currency, Active. **Date** (`YYYY-MM-DD`, indexed, since schema 2.1) is the date of the entry's reference transaction — the transaction that triggered the update (`Transaction_ID`); manual edits in the Ledger view are dated on the day of the edit. Timestamp remains the time the entry was written. Current snapshot of equity positions: one active entry per account + symbol (partial unique index). Options are not in the Ledger.
- **Balance** — Balance_ID, Parent_ID, Transaction_ID, Date, Timestamp, Account_ID, Cash, Currency, Active (since schema 2.3). Cash balance history per account, same model as the Ledger: one active record per account (partial unique index); every cash change (`Engine.adjustCash(accountId, delta, txn)` — recording, editing or deleting a Cash/Trade transaction, and `Engine.setCash` for the Cash field of the Accounts view) supersedes it with a record holding the new `Accounts.Cash` (`_recordBalance`): `Parent_ID` = the previous record, `Transaction_ID` and `Date` = the transaction causing the change (manual changes: NULL and today). The active record always equals `Accounts.Cash`, which stays the current value read by the views. A ledger rebuild does not touch it.
- **Options** — Option_ID, Parent_ID, Transaction_ID, Timestamp, Account_ID, Symbol, Asset, Expiration_Date, Strike, Quantity (contracts, negative = written), Cost_Basis (total; premium paid +, received −), Currency, Active. Same model as the Ledger. Options are tracked, not valued.
- **Mappings** — Mapping_ID, Header_Hash, Source, Target, Pattern; unique per Header_Hash + Source. Source is a field key: Account | Name | Date | Action | Symbol | Description | Quantity | Price | Amount | CostBasis | CurrentValue | Currency.
- **Rules** — Rule_ID, Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect (Ignore | Trade | Cash | Other | Distribution | Split | Merger | Reinvestment | RSU), Sign, Description, Active. 29 rules are seeded by `createNew()` from `RULES_SEED`.
- Views: **v_latest_price** (Symbol, Price, Date — latest valid price per symbol) and **v_holdings** (Symbol, Quantity, Cost_Basis — active Ledger entries with Quantity ≠ 0, summed per symbol). Use them instead of re-writing the latest-price/holdings subqueries.

### Transaction effects and the Ledger (`js/engine.js`)

Each transaction's Effect (copied from the matched rule; `Snapshot` for Import Holdings) determines its Type and how it is applied (`Engine.EFFECT_TYPE`, `Engine.applyTransaction()`):

| Effect | Type | Ledger / Options | Cash |
|---|---|---|---|
| Trade, Reinvestment | Trade | apply the arithmetic below | + Amount |
| Cash | Cash | — | + Amount |
| Other | Other | — | — |
| Distribution | Record | q + Δq, cost + Amount | — (Amount kept as the cost basis) |
| RSU | Record | q + Δq, cost + Δq × Price (the stock's close on the vesting date) | Amount 0 |
| Split | Record | q = Δq, cost = Amount (both replaced) | — (Amount kept as the cost basis) |
| Merger | Other | — (fixed by hand in the Ledger view) | Amount 0 |
| Snapshot | Record | set quantity and cost from the file (cost = quantity × unit price, × 100 for options) | — |

Ledger/Options arithmetic (`Engine.nextPosition(q, C, txn)`): buy or add to a position → `q+Δq`, `C + (−Amount)` (cost incl. fees); reduce → `q+Δq`, `C × (q+Δq)/q` (average cost); crossing zero → the closing part removes the basis, the opening part starts a new basis at the transaction's pro-rata Amount. Every change supersedes the active entry (old entry `Active=0`, new entry with `Parent_ID` = old entry, `Transaction_ID` and `Date` = that transaction's Date — set in `Engine.supersede()`, so imports, manual entry, edits and rebuilds are all dated the same way); manual edits have `Transaction_ID` NULL and today's Date. Entries with quantity 0 stay active (until a later transaction for the pair supersedes them) but are excluded by `v_holdings`, the Portfolio/Ledger/Options views, Update Prices and reports.

- **Edit** (`Engine.editTransaction(old, changes, { rebuild })`, `old` = the transaction as it was before the edit, kept by the caller): the transaction is updated **in place** and cash changes by the Amount delta. `Engine.editImpact(old, changes)` classifies the ledger effect beforehand: `none` (no position-relevant field — Account, Symbol, Quantity, Price, Amount, Effect, Date — changed, or no position affected), `latest` (the active entry A of the pair references the transaction: A is recalculated **in place** from its parent B + the edited transaction, `_rebuildChain`; if the edit moves the transaction to another account/symbol, A falls back to B's state and the transaction is applied to the new pair), `earlier` (an earlier, inactive entry R of the active chain references it) or `unlinked` (it affects a position but no entry of the active chain references it). For `earlier`/`unlinked` the Transactions view asks first: update the transaction only (ledger unchanged), update and rebuild (`rebuild: true` — `earlier`: the chain from R to the active entry is recalculated **in place**, each record re-applying its reference transaction as now stored, manual edits kept, invalid/moved transactions skipped; `unlinked`: `Engine.rebuildPair(accountId, symbol)` replays all of the asset's transactions into a new active entry), or cancel. Returns `{ impact, rebuilt }`.
- **Delete** (`Engine.deleteTransaction(txn, { rebuild })`): `Valid=0` and the Amount is reversed on cash. `Engine.deleteImpact(txn)` classifies it like `editImpact`: `latest` — the active entry A falls back **in place** to its parent's state (`_rebuildChain`); `earlier` — the Transactions view shows the same choice dialog as for edits (delete only: ledger unchanged; delete and rebuild: the chain from the referencing entry to the active entry recalculated **in place** without the transaction; cancel); `unlinked`/`none` — ledger unchanged. Returns `{ impact, rebuilt }`.
- **Rebuild**: `Engine.rebuildPair(accountId, symbol)` (Ledger view button, and edits/deletes of unlinked transactions) replays the valid Trade/Record transactions of **one account + symbol** by Date and supersedes its active entry (manual edits of that entry are lost; without transactions the entry is deactivated); returns `{ qty, cost, transactions }`. `Engine.rebuildAccount(accountId)` does the same for all Ledger/Options entries of an account (no longer used by the UI).
- Option symbols: canonical `<Ticker><YYYY><MM><DD><C|P><Strike>` (e.g. `NVDA20270115C360`, `NVDA20270115C182.5`). `Engine.normalizeOption()` also accepts Fidelity (`-GLD260821C515`), OCC (`NVDA270115C00360000`) and the alternative/Schwab format (`ANET 01/02/2026 137.00 C`, also with 1-digit month/day, 2-digit year or `$` before the strike) — imports and manual entries store the canonical form; options use a ×100 multiplier when Amount is computed.
- Amount (`Engine.resolveAmount`): the file's Amount when available, else `−Quantity × Price` (× 100 for options); `Sign` forces the sign; Merger/Snapshot/RSU are always 0; Distribution/Split keep the file's Amount (their cost basis; Type Record, so cash is unchanged), else 0 — never computed from the price. On import, a Distribution/Split row is also a duplicate when its hash with Amount 0 matches (rows imported before the Amount was kept).
- RSU price (`Engine.priceOn(symbol, date)`): the closing price from Prices on the date, or the last close within `RSU_PRICE_LOOKBACK_DAYS` (7) before it; stored as the transaction's Price. No RSU rule is seeded.
- Hash (`Engine.hash`): account, date, symbol, quantity, price and amount.
- Callers wrap engine writes in `DB.transaction(fn)` (BEGIN/COMMIT, ROLLBACK on error; nested calls join; async functions supported).

---

## Inputs

Accounts are entered in the Accounts view. Positions and transactions come from CSV imports or manual entry; assets are created (Yahoo Finance lookup) after the transactions and ledger entries that reference them. Neither import writes to Prices, except Import transactions storing the missing closing prices of RSU vesting dates; after an import the user is offered Tools > Update prices.

### CSV parsing and column mapping (shared)

- `Import.parseCsv(text)`: strips a BOM, discards empty rows before the header and blank rows, tolerates a trailing comma (extra empty cell), handles quoted fields with `""` escapes.
- The header row is hashed (`Import.headerHash`, BOM stripped, names trimmed). The mapping dialog is pre-populated from the Mappings rows of that **Header_Hash**; fields with no saved row for that hash (a new layout, or a field added later such as CurrentValue) are pre-selected by matching column names such as "Price ($)" → Price; confirming it upserts each Source → Target mapping for that hash. Each field has an optional extract regex (first capture group, or the full match).
- Row preparation (`Import.prepareRows`): trailing rows whose column count differs from the header — or, for transaction files, whose Date does not parse — are dropped (broker disclaimers); transaction rows are sorted by date, earliest first (same-date rows keep file order, reversed for newest-first files).
- Numbers accept `$`, `,`, `%`, `+` and `(123.45)`; dates accept `YYYY-MM-DD` and `MM/DD/YYYY` (the first date in the cell, e.g. "09/23/2026 as of 09/22/2026").
- Accounts are resolved from the Account/Name columns when mapped, otherwise one account is picked for the file.

### File > Import holdings… (positions snapshot)

Fields: Account, Name, Date, Symbol, Description, Quantity, Price, CostBasis, CurrentValue, Currency (Symbol, Quantity and Price or Cost Basis required). The snapshot **replaces** the account's state (`Engine.applySnapshot`): for every symbol in the file a Snapshot transaction (Type Record, unit Price = cost basis / units, where an option contract counts as 100 units) sets the quantity and cost basis; active Ledger/Options entries of the account whose symbols are not in the file are deactivated. Rows whose symbol matches `^SPAXX(\*+)`, `^USD(\*+)` or `^Cash` (case sensitive) are the account's cash: their Current Value (else Quantity, else Cost Basis) is summed and the cash balance is set to the total via a Cash transaction "Opening cash balance" with Amount = total − current cash. Without cash rows the cash balance is unchanged. One transaction date per file: from the Date column if mapped, otherwise prompted.

### File > Import transactions…

Fields: Account, Name, Date, Action, Symbol, Description, Quantity, Price, Amount, Currency (Date, Action, Symbol, Quantity and Amount or Price required). `Import.processTransactions` (inside `DB.transaction`):
1. The row's account is resolved first; rows of an account that is not found are counted as "account not found" and skipped (they are not rule-matched, so they never appear as ignored or unrecognized).
2. Each row's Action is classified by the active Rules (`Engine.classify`), in Rule_Order, first match wins; rules with Symbol_Required are skipped for rows without a symbol. `Asset` category resolves to Option or Equity from the symbol.
3. Effect Ignore → counted as ignored; no matching rule → listed as unrecognized (not stored; re-importing after adding a rule picks them up).
4. For Trade/Reinvestment rows whose Quantity has the same sign as the Amount (e.g. Schwab sells), the quantity is negated.
5. Amount is resolved, the Hash computed (from the file's values), and the row skipped as a duplicate when the hash matches a transaction recorded **before the import started** (identical rows within one file are all imported).
6. The transaction is recorded and applied (`Engine.record`). RSU rows get Price = `Engine.priceOn(symbol, date)`; before the import `Import.rsuPriceRequests` lists RSU rows whose date has no stored close and `_fetchRsuPrices` retrieves them with `get_chart` (7 days before the date up to the next day) into Prices; RSU rows still without a price are recorded with cost 0 and listed in the summary. Rows dated before the latest existing transaction of the same account + symbol are listed as "predating" (the ledger may need a rebuild).
7. A summary dialog shows Imported / Ignored / Duplicates / Account not found / Unrecognized (listed; known accounts only) / predating rows / asset lookup failures.

---

## UI Features

The application UI is organized as a menu strip and a collection of horizontal tabs. The menu strip contains the following submenus and commands therein:
File/
- New portfolio
- Open portfolio...
- Import holdings...
- Import transactions...
- Export portfolio...
- Save portfolio...
View/
- Portfolio
- Accounts
- Assets
- Prices
- Transactions
- Ledger
- Options
- Rules
Analyze/
- Portfolio performance  (Reports tab: holdings with Total / YTD / 50 Day gain/loss)
- Account performance    (prompts to select one account, same report scoped to it)
- Asset performance      (prompts for one symbol, opens a trend-analysis Analysis tab with indicators and a price chart — see below)
Reports/
- Investments by theme   (opens an Analysis tab: holdings value grouped by Theme, with account checkboxes; a Theme opens its Ledger entries — see below)
- Dividends              (opens a Dividends tab: year-to-date dividends per symbol with their yield — see below)
- Gains/Losses           (opens a Gains/Losses tab: short- and long-term realized gains per asset this year — see below)
- Portfolio trend        (opens a Portfolio Trend tab: line chart of the portfolio's and each account's value change over the last year — see below)
Tools/
- Update prices...
- Query database...

The New portfolio command creates a new (v2) database in memory with empty tables, the Info row and the seeded Rules.

The Open portfolio command loads a previously saved database from a local file; databases created before version 2.0 are refused and the current database stays open.

The Import holdings command imports a positions snapshot, the Import transactions command imports a transaction history (see Inputs above).

The Export portfolio command exports the current portfolio holdings as a CSV file named `portfolio_YYYY-MM-DD.csv`. Columns in order: Symbol, Quantity, Value, %Portfolio (from `v_holdings` and `v_latest_price`), Description, Type, Category, Notes (the latest note from the Notes table). Only symbols with a positive net quantity are included. The save picker opens in the same folder as the last database file.

The Save command saves in-memory database into a local file. The prefix prompt is pre-filled with the prefix of the last opened or saved file (e.g. "portfolio"); the save dialog opens in the same folder as that file. User may change the prefix; the application automatically adds a timestamp suffix (e.g. _202606121605) and the .db extension.

The Query database command opens a new Query tab. Multiple Query tabs may be open simultaneously. See the Query Tab section below.

The Portfolio performance command (Analyze menu) opens a new Reports tab. Multiple Reports tabs may be open simultaneously. See the Reports Tab section below.

The Account performance command (Analyze menu) first shows a Select Account dialog (active accounts only); on OK it opens a new Reports tab identical in every respect to Portfolio performance but limited to the selected account's Ledger rows — same table, same stored-price YTD / 50-day baseline logic, same summary strip, just account-scoped (Last Acquired too). See the Reports Tab section below.

The Investments by theme command (Reports menu) opens a new Analysis tab showing the value of the holdings grouped by Theme, for the accounts checked above the table. Multiple Analysis tabs may be open simultaneously. See the Analysis Tab section below.

The Dividends command (Reports menu) opens a new Dividends tab (see The Dividends Tab section below).

The Gains/Losses command (Reports menu) opens a new Gains/Losses tab (see The Gains/Losses Tab section below).

The Portfolio trend command (Reports menu) opens a new Portfolio Trend tab (see The Portfolio Trend Tab section below).

The Asset performance command (Analyze menu) prompts for one ticker symbol, then opens a new Analysis tab with that asset's trend-analysis report (moving averages, RSI, momentum slopes, fundamentals) next to a D3 line chart of its closing prices and 20/50/200-day averages — see "Asset Analysis (Analyze > Asset performance)" under the Analysis Tab section below.

The Portfolio, Accounts, Assets, Prices, Transactions, Ledger, Options and Rules commands open the corresponding tabs. See the definitions of these tabs below. **All tabs are closeable**; when the last tab is closed an empty-state message (`#tab-empty`) is shown.

The tab strip (`#tab-strip`) is a flex row containing a scrollable `#tab-bar` (tabs append here left-to-right in open order) and a Refresh button (`#tab-refresh`) anchored at the right end outside the scrollable area. Clicking the Refresh button re-loads data for the currently active tab (calls the appropriate module's `refresh()` function; Query tabs have no auto-refresh since the user controls execution).

Tabs are added on demand and each tab represents a filtered or aggregated view of the underlying data. Each View tab's space is vertically divided into two zones. The upper zone occupies 70-80% of the tab's space and displays a data table. The lower zone occupies the remaining tab's space and displays a form. The table and form content varies between tabs but the general layout is the same. The data table displays a filtered view of the data as rows and columns. The table can be sorted by any of the columns; column sort is tristate (ascending → descending → cleared) — clicking a sorted column a third time restores the natural data order (as returned by the underlying SQL query). Each table represents a dynamic view of the data. This means that if the underlying data are updated, the rendering of the data in the table should be automatically updated as well. Tabulator 6.3.0 is used for all data tables.

The table data view component should support the following functionality: sorting by any column, filtering by any column, row selection (one row at a time, selected row background should be different from the rest of the table), clicking on a cell value (see use cases below), and Delete key capture. If the Delete key is pressed on the keyboard it should be interpreted as a request to "delete" the selected record — **unless** focus is on an input, textarea, or select element in the form, in which case the Delete key is passed through to the browser for normal character deletion. When the delete action is triggered, the application verifies that there are no other records referring to this record (referential constraints) and presents the user with an explanation/confirmation dialog. If there are referential constraints, the application explains that the record cannot be deleted. If there are no referential constraints, the application asks for a delete confirmation and then sets the Active/Valid flag for this record to false.

Each form facilitates display of the additional data for the selected data record and allows editing of the selected data record. The form is dynamically linked to the data table. When user clicks on a row in the data table, the underlying record is considered selected and the form is updated to display the record's content. If the record is edited, an Accept button is shown. User has to click the Accept button to save the changes, otherwise the changes are silently ignored if user moved to another record. The form also has a New button that allows user to create a new record of the desired type. When user click the New button, form's content is nulled and is dissociated from the selected record.

All forms use a 3-column layout: left column (45% width) with up to 4 fields, middle column (45% width) with additional fields, and right column (10% width) containing action buttons arranged vertically — New at the top, Accept at the bottom, other buttons in between.

### The Portfolio Tab

When the application starts the "Portfolio" tab is displayed. It shows the current positions from the **active Ledger entries** (quantity ≠ 0) grouped by symbol, valued at the latest price (`v_latest_price`). Columns in order: Symbol (hyperlink), Quantity, Price, Value, Gain/Loss (`Value − Cost_Basis`), % Gain/Loss (`GainLoss / |Cost_Basis| × 100`; the absolute value keeps short positions' sign meaningful), % Portfolio, Action (an "Analyze" button per row). Cost basis is the Ledger's `Cost_Basis` (average cost) — the v1 FIFO helper `_computeCostBasisMap()` no longer exists. Options are not shown.

Clicking a Symbol opens a **Holdings** drill-down tab (`PortfolioTab.openHoldings(symbol, accountId)`, ids `hld-N`): one row per account holding the symbol — Account (hyperlink → Transactions tab filtered by account + symbol), Quantity, Avg Cost (`Cost_Basis / Quantity`), Cost Basis, Price, Value, Gain/Loss, % Gain/Loss — with a summary strip. An account-scoped Portfolio tab limits the drill-down to that account.

The Action column follows the Money app's `.act-btn` convention: a column-level `cellClick` handler checks `e.target.classList.contains('act-btn')`, then calls `AnalysisTab.openAssetFor(symbol)` (the Analyze > Asset performance report for that one symbol).

The form zone shows:

1. **Total portfolio value** — "Total Value: $X.XX (N)", N = number of rows. The total is the sum of position values plus the cash of the included accounts, except for a Theme-filtered tab (`PortfolioTab.open(accountId, theme)`), where cash is omitted. `% Portfolio` uses the same total as denominator.
2. **Transaction input** — supported formats (`PortfolioTab.parseEntry`; the v1 `@ price` / `at price` forms are no longer accepted):
   - `+100 AAPL $150` / `-50 MSFT $200` (sign determines buy/sell), optional date: `+1000 AAPL $350 2026-09-30`
   - `buy|bought|sell|sold N [shares of] SYMBOL $PRICE [YYYY-MM-DD]`
   - `sell all MSFT $291.5` / `buy all …` — `all` resolves to the quantity held per the active Ledger (or Options) entries, account-scoped when the tab is
   - option symbols in canonical form, e.g. `-2 NVDA20270115C360 $3.20` (Amount = −Quantity × Price × 100)

   Unknown equity symbols are validated with `YahooFinance.getQuote()`; for equity sales the Account selector only lists accounts holding enough shares. The confirmation dialog has Account, Date (default today), Symbol, Quantity, Price, Currency. OK records a Trade transaction through `Engine.record` (same path as imports: Ledger/Options update and cash change), then creates the asset if needed.

Multiple Portfolio tabs may be open simultaneously (one per account / theme). Form element IDs are scoped per instance (`<tabId>-…`).

### The Accounts Tab

Active accounts with columns Name (hyperlink → Portfolio tab for the account), Balance, Cash, Last Updated. Balance = `ROUND(SUM(Ledger.Quantity × latest price) + Cash, 2)` over the account's active Ledger entries (`v_latest_price`). Form: left Account, Name; middle Cash + Currency, Active. Deleting (deactivating) an account is refused while it has valid transactions.

### The Assets Tab

Active assets **with a non-zero quantity** (`v_holdings`, so assets that were sold out, or created in the view but not yet held, are not listed) — or **all active assets** (quantity 0 for those not held) when the **Show all assets** checkbox at the bottom left of the form is checked (unchecked by default, `_showAll`, reset when the tab is closed; `AssetsTab.loadData(showAll)`) with columns Symbol (hyperlink → Transactions tab for the symbol), Quantity (from `v_holdings`), Description, Type, Theme, Category, Notes (latest note), Action. The Action column shows an **Analyze** button (`AnalysisTab.openAssetFor(symbol)` — the Analyze > Asset performance report, as on the Portfolio tab) and, when the asset has notes, a **Notes** button that opens a scrollable popup with all notes in chronological order (`_showNotes`); the column-level `cellClick` tells them apart by `data-act`. Form: left Symbol, Description, Note; middle Type, Category, Theme (with the `.ac-*` autocomplete, `_attachThemeAutocomplete` / `_addAcKeyboard`). Accepting a new or changed Note inserts a row in the Notes table (the history is never overwritten). Deleting is refused while the asset has valid transactions, active ledger entries or prices.

### The Prices Tab

Every **active asset** with its description and latest price — an outer join of Assets and `v_latest_price` (Price and Date empty when no price is stored), plus any symbol that has prices but no Assets row: Symbol (hyperlink → Transactions), Description, Price, Date, Action. The Action column's **Update** button (`_updateRow`) stores the symbol's daily closes exactly like Tools > Update prices (`updateSymbolPrices(symbol)` in `app.js`, which `cmdUpdatePrices` also uses: from the later of today − 1 year and the last stored date through tomorrow, with the same throttling/retries); the button shows "…" while fetching, failures are shown in an alert, success refreshes the tab and calls `App.onDataChanged()`. Form: Symbol, Description; Price + Currency (the price can be entered by hand, e.g. for assets Yahoo Finance cannot quote); button Accept (upserts the entered price for today's date). There is no Update button in the form (removed; the Action column's Update replaces it).

### The Transactions Tab

Multi-instance (`txn-N`), built on the **Transactions table** (valid rows), optionally pre-filtered by account and/or symbol (label: symbol, else account name). Columns: Date, Account, Type, Category, Symbol, Quantity, Price, Amount, Description; natural order Date, Transaction_ID. Form: left Account, Date (`<input type="date">`), Effect / Category, Description; middle Symbol, Quantity, Price + Currency, Amount (blank = −Quantity × Price). Buttons: New, Delete, Accept.
- New + Accept → `Engine.record` (Category `Asset` resolves to Equity/Option; for Effect RSU with a blank Price, the stored close on the date is used, otherwise the user must enter it).
- Accept on an existing row → keeps a copy of the selected row (the transaction before the edit), checks `Engine.editImpact`; for `earlier`/`unlinked` a dialog (`_ledgerChoice`, radio options) offers: update the transaction only, update and rebuild the asset's ledger (from the ledger record referencing the transaction), or Cancel; then `Engine.editTransaction(before, edited, { rebuild })` in a `DB.transaction`.
- Delete (or the Delete key) → `Engine.deleteImpact`; `earlier` shows the ledger choice dialog (`_ledgerChoice(txn, impact, 'delete')`: delete only / delete and rebuild from the referencing ledger record / Cancel), otherwise a confirmation (for `latest` it explains that the ledger entry goes back to its state before the transaction); then `Engine.deleteTransaction(row, { rebuild })`.

### The Ledger Tab

Singleton (`led`, View > Ledger) — the v1 Transactions tab repurposed (`tab-ledger.js`). Shows the **active** Ledger entries with quantity ≠ 0: Account, Symbol (hyperlink → Transactions for account + symbol), Date (of the reference transaction), Quantity, Price (`Cost_Basis / Quantity`), Cost Basis, Value (`Quantity ×` the latest valid stored price from `v_latest_price`; tooltip shows that price and its date), Gain / Loss (`Value − Cost_Basis`, signed and green/red like the Portfolio tab), % Gain/Loss (`Gain/Loss / |Cost_Basis| × 100`, same formula and formatting as the Portfolio tab; `—` when the cost basis is 0); Value, Gain / Loss and % Gain/Loss are `—` when the symbol has no stored price. Form: left Account, Symbol (editable only for New); middle Quantity, Cost Basis + Currency. Buttons: New, Delete (also the Delete key; formerly Deactivate), Rebuild, Accept. Accept supersedes the entry as a manual edit (`Transaction_ID` NULL); Delete deactivates the entry (`Active=0`) and sets its `Timestamp` to the time of the deletion; Rebuild asks for confirmation (warning that manual edits of the entry are discarded) and runs `Engine.rebuildPair` for the selected entry's **account + symbol only**, reporting the rebuilt quantity and cost basis. **Filtered Ledger tabs** (`LedgerTab.openFiltered({ theme, accountIds })`, ids `ldf-N`, opened from Reports > Investments by theme) show the same view limited to one asset Theme and/or a set of accounts (`LedgerTab.loadData(filter)`).

### The Options Tab

Singleton (`opt`, View > Options): active option entries with quantity ≠ 0 and `Expiration_Date >= today`: Account, Symbol, Asset, Expiration Date, Strike, Quantity. Same form and buttons as the Ledger view (New, Deactivate, Accept; no Rebuild — the account rebuild also recalculates options). Options are not included in any portfolio value.

### The Rules Tab

Singleton (`rul`, View > Rules): active import rules ordered by Rule_Order: Order, Pattern, Case Sensitive, Symbol Required, Category, Effect, Sign, Description. Form: left Pattern, Description, Matching (Case Sensitive and Symbol Required checkboxes); middle Order, Category, Effect, Sign. Accept validates the regex (inline error); Delete sets `Active=0`. Rule changes apply to later imports only.

### The Query Tab

Multiple Query tabs may be open simultaneously (tab IDs `qry-1`, `qry-2`, …). Each Query tab is closeable. There is no form zone — the tab is divided into two vertical areas:

- **SQL zone** (top, 15% of tab height): a toolbar row with an "SQL" label and a Run button, plus a monospace `<textarea>` that fills the remaining height of the zone. Placeholder text is `SELECT * FROM Accounts;`.
- **Results zone** (bottom, 85% of tab height): a Tabulator table with `autoColumns: true` that is generated dynamically from whatever the query returns.

Execution is triggered by clicking Run or pressing Ctrl+Enter inside the textarea. `DB.query(sql)` is called; if it throws, the error message is displayed in red monospace in the results zone. If the query returns 0 rows, a "Query executed. No rows returned." message is shown. Otherwise a Tabulator table is built with columns auto-generated from the result set. Each subsequent run destroys the previous Tabulator instance before creating a new one. The Refresh button in the tab strip has no effect on Query tabs (user controls execution explicitly).

### The Reports Tab

Multiple Reports tabs may be open simultaneously — each invocation of Analyze > Portfolio performance or Analyze > Account performance opens a brand-new closeable tab (tab IDs `rpt-1`, `rpt-2`, …, counter shared across both commands), rather than reactivating a singleton. Unlike the View tabs, a Reports tab has no form zone: the panel is a table filling ~all of the space, with a summary strip anchored at the bottom.

The table shows one row per held asset — active Ledger entries with quantity ≠ 0, across all accounts for Portfolio performance or limited to `l.Account_ID = ?` for Account performance — with columns in order: Symbol (hyperlink — opens a Transactions tab filtered by that symbol), Quantity, Price (latest valid price from the Prices table), Value (`Quantity × Price`), Last Acquired, % Total G/L, % Asset G/L YTD, % 50 Day G/L.

**Last Acquired** is the most recent date the asset was acquired, from the valid Transactions of all accounts (or of the account for Account performance; `_lastAcquired`): the latest date of an acquisition — `Quantity > 0` with Effect Trade, Reinvestment, RSU or Distribution (sales don't count). If the asset has no acquisition, the other Record transactions with a non-zero quantity (Import holdings snapshots, splits) are used: the latest such date, displayed as **"before YYYY-MM-DD"** (tooltip: only known from a holdings snapshot or split) since the position was acquired on or before it. The column sorts by the date (`LastAcquired`, with the `LastAcquiredBefore` flag). `—` when neither exists.

**Account performance** (`ReportsTab.openAccount()`) reuses this exact same `_build`/`_computeReport` code as Portfolio performance, with an `accountId` threaded through the assets query and into `reportLabel` (resolved from the account's Name) wherever the UI previously said "Portfolio": the progress dialog title, the failure-summary dialog title, and the summary strip's "Avg {reportLabel} Performance:" label. It first prompts with a Select Account dialog (`_selectAccountDialog()` — active accounts only, a small custom `<select>` popup, alerting instead if there are no active accounts). The YTD / 50-day baseline lookup (`baselinePrice`) is unparameterized by account, since a symbol's baseline price is the same regardless of which account holds it.

% Total G/L is the asset's total gain/loss, same formula as the Portfolio tab's `% Gain/Loss` column: `(Value − CostBasis) / |CostBasis| × 100`, where `CostBasis` is the sum of the active Ledger entries' `Cost_Basis`. No MCP call needed for this column (unlike YTD / 50 Day) since it's derived entirely from local Ledger/Prices data. `—` if CostBasis is 0.

For each asset, % Asset G/L YTD and % 50 Day G/L are computed from **stored daily closing prices only** (the Prices table kept by Tools > Update prices, which covers the last year) — the report makes no Yahoo Finance calls and never writes prices (`ReportsTab.computeReport(accountId)`):
1. **YTD** (`ReportsTab.baselinePrice(symbol, 'YYYY-01-01')`): the baseline is the **first stored valid close on or after January 1** — normally the first market day of the year. If the asset's stored closes only start later in the year, it was issued (or first priced) after the year began, and that **first available close** is used. The cell tooltip shows the baseline close and date, marked "first stored close in the period" when it is more than 9 days after January 1.
2. **50 Day** (`ReportsTab.trailingBaseline(symbol, 50)`): the baseline is the stored close **50 trading days before the latest stored close** (the 51st most recent stored close). When fewer closes are stored, the earliest stored close is used (tooltip: "only N trading days stored"); with fewer than two stored closes the cell is `—`. Trading days are the stored daily closes, so keep prices current with Tools > Update prices.
3. The current price is the latest stored close (`v_latest_price`). `%Gain/Loss = (CurrentPrice − BaselinePrice) / BaselinePrice × 100`. An asset without a baseline shows `—` and is excluded from that column's portfolio-level average (not treated as 0%); the summary strip notes how many assets have no stored prices this year (hover lists them) and suggests Tools > Update prices.

The bottom summary strip reads **"Avg {reportLabel} Performance: Total xx%, YTD yy%, 50 Day zz%"** (each percentage bold and colored green/positive or red/negative) — three value-weighted averages, each `(ΣCurrentValue − ΣBaseValue) / ΣBaseValue × 100`:
- **Total** sums every asset's `Value`/`CostBasis` unconditionally (CostBasis is always known — no MCP dependency), so it's never `—` once any asset has a positive CostBasis.
- **YTD** / **50 Day** each sum only the assets that have a baseline for that column (`Quantity × BaselinePrice` as the baseline value) — assets without one are excluded from that particular average, not treated as 0%.

None of the three is a simple average of the per-row percentages (which would overweight small positions).

Because everything comes from the local database, the report is computed instantly — there is no progress dialog and no failure dialog.

Unlike other tabs, Reports tabs do **not** auto-recompute on `App.onDataChanged()` — only when the tab is first opened or the user clicks the tab-strip Refresh button while it's active (`autoRefresh: false`), so a report shows a stable snapshot while the user keeps working.

### The Analysis Tab

Multiple Analysis tabs may be open simultaneously — each invocation of Reports > Investments by theme (`AnalysisTab.openThemes()`) opens a brand-new closeable tab (tab IDs `aly-1`, `aly-2`, …, counter shared with Analyze > Asset performance) labeled "Investments by Theme". It is rendered as **plain HTML — no Tabulator** — styled after the "Spend by Category" report of the sibling `Money` app: a header block (`.rpt-header` with `.rpt-title` "Investments" and `.rpt-subtitle` "By Theme"), a `.rpt-filters` row of account checkboxes, and a fixed-width (560px) `<table class="rpt-table">` with a dark navy uppercase header row, zebra-striped body rows and a highlighted `<tfoot>` total row, inside a padded, self-scrolling `.rpt-report-layout` container (no form zone). `.rpt-report-layout` is a **distinct class from `.rpt-layout`** (the flex shell of the performance tabs in `tab-reports.js`). Percentages are formatted to 1 decimal place.

**Account checkboxes** (like the Dividends and Gains/Losses reports): one checkbox per **contributing account** (`AnalysisTab.contributingAccounts()` — active accounts with active Ledger entries of quantity ≠ 0 or a non-zero cash balance), all checked initially. Unchecking an account recalculates and redraws only the table (`_renderTable`); the unchecked set is kept on the panel (`panel._alyUnchecked`) across refreshes, newly contributing accounts appear checked, and with every account unchecked the table shows "No accounts selected."

The table has one row per distinct Theme (from the Assets table) plus one synthetic **Cash** row, with columns Theme, Value, %Portfolio, computed by `AnalysisTab.computeThemes(accountIds)` (`null` = all active accounts, else the checked Account_IDs):
1. All held symbols (active Ledger entries with quantity ≠ 0 of the selected active accounts) are valued at `Quantity × MostRecentPrice` (`v_latest_price`).
2. Values are grouped and summed by the asset's Theme. Assets with a blank/NULL Theme and symbols missing from the Assets table are grouped under **"(No Theme)"**.
3. The cash of the selected accounts is added as its own **Cash** row (only shown if non-zero).
4. All rows (Theme groups + Cash) are sorted together by Value descending.
5. `%Portfolio = RowValue / GrandTotal × 100`, where `GrandTotal` is the sum of all displayed rows. The `<tfoot>` row reads "Grand Total N Assets" (N = distinct symbols before grouping) and 100.0%.

Each Theme name is a `cell-link`; the Cash row's label is plain text. Clicking a Theme opens a **filtered Ledger tab** (`LedgerTab.openFiltered({ theme, accountIds })`, ids `ldf-N`): the active Ledger entries with quantity ≠ 0 of that Theme (`''` for "(No Theme)": blank theme or symbols missing from Assets) in the checked accounts (`accountIds` null when no account is unchecked, so all accounts). It is the regular Ledger view (same columns, form and buttons) limited by the filter; its label is `Ledger — Theme` followed by the account names (or "N accounts" for more than two) when only some accounts were checked.

`PortfolioTab.open(accountId, theme)` still accepts a Theme filter (a Theme-filtered Portfolio tab excludes cash from its total), although the theme report no longer opens it.

### The Dividends Tab

Reports > Dividends (`DividendsTab.open()`, `js/tab-dividends.js`) opens a new closeable tab (`dvd-N`) laid out like Investments by theme — plain HTML, no Tabulator: a `.rpt-header` ("Dividends", subtitle "Year to date — Jan 1, YYYY to <today>") and a `.rpt-table` with columns **Symbol, Dividend, ~Yield** (the header reads "~YIELD" — the tilde marks the yield as approximate) inside `.rpt-report-layout`. The data comes from `DividendsTab.computeDividends(today)`:
1. All valid Transactions of **Category Dividend** dated from January 1 of the current year through today, with `Amount` summed per symbol (symbols whose dividends net to 0, e.g. a reversed payment, are omitted). Foreign tax withheld is Category Tax and is not deducted.
2. **Yield** = the symbol's summed dividends ÷ its **average cost basis** × 100. The cost basis of each payout is that of the latest Ledger record of the payout's account + symbol — active or inactive — dated **at least a day before** the payout (`Ledger.Date < payout Date`, ties broken by Holding_ID; `DividendsTab.payouts()`), skipping records with quantity 0 — when the asset was sold after the ex-dividend date but before the payout, the state before the sale is used; the average cost basis is the mean of those cost bases. When the symbol pays in several accounts the per-account averages are added up (so the average reflects the whole holding — with one account it is simply the mean). Payouts without an earlier non-zero ledger record or with a cost basis ≤ 0 don't enter the average; dividends of an account with no cost basis at all (e.g. cash-like funds such as SPAXX, or a position first recorded on/after the payout date) count in the Dividend sum but not in the yield, and a symbol with no cost basis shows `—`. The cell tooltip shows the average cost basis and the number of payouts it is based on.
3. Rows are sorted by dividend amount, largest first. Each Symbol is a `cell-link` opening a Transactions tab for that symbol.
4. A `<tfoot>` **Grand Total** row shows "Grand Total N Assets" (the number of dividend-paying symbols), the total YTD dividends, and the total yield computed the same way over all assets: Σ dividends ÷ Σ average cost basis of the assets that have a cost basis.

**Account checkboxes**: between the header and the table, a `.rpt-filters` row has one checkbox per **contributing account** (`DividendsTab.contributingAccounts()` — accounts with valid YTD dividend transactions), all checked initially. Unchecking an account recalculates and redraws only the table (`_renderTable`) via `computeDividends(today, excludeIds)` with the unchecked Account_IDs: their dividend payouts are excluded from the sums and from the yields (each payout's cost basis comes from its own account's Ledger); the grand total (count, total, weighted yield) is recalculated. The unchecked set is kept on the panel (`panel._dvdUnchecked`) across refreshes; newly contributing accounts appear checked. If every account is unchecked the table shows "No accounts selected."

The tab refreshes automatically on `App.onDataChanged()` and with the tab-strip Refresh button.

### The Gains/Losses Tab

Reports > Gains/Losses (`GainsTab.open()`, `js/tab-gains.js`) opens a new closeable tab (`gns-N`) laid out like the Dividends tab: a `.rpt-header` ("Realized Gains/Losses", "Year to date — Jan 1, YYYY to <today>"), a `.rpt-filters` row with one checkbox per **contributing account** (`GainsTab.contributingAccounts()` — accounts with realized gains or losses this year; unchecked accounts are kept on `panel._gnsUnchecked` and excluded via `computeGains(today, excludeIds)`, redrawing only the table), and a `.rpt-table` with columns **Asset, Short Term, Long Term** (negative amounts in red, `.rpt-neg`), sorted by total gain, largest first; each Asset links to its Transactions tab. A `<tfoot>` Grand Total row shows "Grand Total N Assets" and the short- and long-term totals.

The **holding periods** come from the transaction history and the **amounts** from the Ledger (`GainsTab.realizations(today, excludeIds)`): for every account + symbol, **all** valid transactions up to today (also those before January 1, which build the lots) are processed in date order:
- **Lots** (for the holding periods): buys and reinvestments (Trade/Reinvestment, Quantity > 0), RSU vests and distributions, each dated on its transaction date. A **holdings snapshot** (Effect Snapshot, Import holdings) replaces the lots with one lot of the recorded quantity, dated on the snapshot date (the best information available); a **split** rescales the lots' quantities, keeping their dates (fallback lot cost: the split's Amount, shared out by quantity).
- **Sales** (Trade, Quantity < 0) are matched to the lots **last in, first out** (LIFO/FILO) to split the sold quantity by holding period: sale date − lot date of **1 year or more** (sale on or after the lot date + 1 year; Feb 29 + 1 year = Mar 1, `GainsTab.isLongTerm`) is long term, less is short term. Ledger quantities the lots don't explain take the date of the pair's first transaction.
- **Gain amount**: each matched part realizes its share of the sale Amount (proceeds net of fees, shared out by quantity) − part quantity × the **average cost of the position before the sale**: sale A created Ledger entry B (`Transaction_ID` = A, the latest one if several, e.g. after a rebuild) whose parent C (`B.Parent_ID`) holds the prior state, average cost `C.Cost_Basis / C.Quantity` (`_parentStates()`; options use the Options table the same way). So manual cost corrections in the Ledger view are reflected. The quantity closed is limited to C's quantity; a transaction without any Ledger/Options entry falls back to the lots' own cost (buys −Amount incl. fees, RSU Quantity × Price, distributions and splits their Amount).
- Selling more than is held opens a **short lot** (e.g. writing an option); a later buy closes it LIFO, realizing the premium (average from the parent record) − the cost of the buy, with the holding period measured from the opening sale.
- **Options** still open at their expiration date (parsed from the option symbol) expire worthless on that date: a long lot realizes −cost, a short lot its premium, at the active Options entry's average cost. Assignments/exercises are recorded with Effect Other and are not modeled separately (the share trades come as separate rows).
- Only realizations dated from January 1 through today are reported. Equity sales without any earlier holdings in the history (no cost basis, e.g. history before the first import) are not counted; a red note below the table (`.rpt-warning`) lists them (`unmatched`).

The tab refreshes automatically on `App.onDataChanged()` and with the tab-strip Refresh button.

### The Portfolio Trend Tab

Reports > Portfolio trend (`TrendTab.open()`, `js/tab-trend.js`) opens a new closeable tab (`trd-N`, "Portfolio Trend"): a `.rpt-header` ("Portfolio Trend", subtitle with the date range and number of trading days), an HTML legend (`.trd-legend`: one entry per line with its color and latest % change — the Portfolio line, then an **account checkbox** per account line), a D3 line chart filling the tab (`.trd-chart`, redrawn by a `ResizeObserver` disconnected in `onClose`) and a note below it.

The data comes from `TrendTab.computeTrend(today)`:
1. **Period**: from one year before today (same calendar day; Feb 29 → Feb 28) or the **earliest Ledger or Balance Date** when that is later, through today. The **days** are the dates with valid stored closes in Prices in that period (trading days).
2. **Positions on each day**: **all** Ledger records (active and inactive) are processed per account + symbol in Date order (ties by Holding_ID, so a rebuild's newer entry wins); the most recent record with `Date ≤ day` gives the quantity. A record that was deactivated **without a successor** (no Ledger record has it as Parent — Import holdings dropping a symbol, Deactivate in the Ledger view, a rebuild closing a symbol) is counted until the account's next holdings snapshot (Effect Snapshot, on or after its Date), or only on its own date when there is none.
3. **Value**: quantity × the symbol's latest valid close on or before the day (the earliest stored close when the history starts later); summed per account and over all accounts (portfolio). **Missing prices are fetched first**: `computeTrend` also returns `gaps` — per symbol, the first and last day it is held without a stored close on or within `STALE_DAYS` (4) calendar days before the day (no prices at all, history starting later, or stale closes, typically for assets sold since, which Tools > Update prices no longer fetches). `_render` turns them into requests (`TrendTab.gapRequests`: from a week before the gap through its last day; each request only once per session, `_attempted`), fetches them with `fetchPriceHistory(requests, title)` in `app.js` (progress dialog; `get_chart` via the shared `_fetchCloses` with the Update prices throttling and Too Many Requests retries, upserted into Prices), calls `App.onDataChanged()` for the other tabs (this tab is skipped while `panel._trdBusy`) and recalculates. Symbols still without any price are valued at 0 and listed in the note (`missing`); failed fetches are listed too. **Cash** is added: each account's cash on the day is its most recent **Balance** record with `Date ≤ day` (active or inactive, ties by Balance_ID; 0 before its first record), so an account's value = its holdings + its cash, and the portfolio = the sum over all accounts; accounts with cash but no holdings get a line too. Options are not included (not valued). Deposits and withdrawals still move the lines.
4. **% change**: each line is `(value / first non-zero value − 1) × 100`; days before an account's first value are blank. Accounts whose values are all 0 in the period get no line.

Chart (`_drawChart`): X axis = dates with a tick per month (`d3.timeMonth.every(1)`, "Jan YYYY" for January, else the month abbreviation); Y axis = % change from the first value (signed, faint grid, solid zero line); one line per account (`d3.schemeTableau10` colors, 1.5px) and the **Portfolio** line on top (dark navy, 2.5px). Hovering shows a dashed vertical line at the nearest day and a tooltip (`.trd-tip`) with every drawn line's % change and value.

**Account checkboxes**: all checked initially; unchecking an account hides its line and redraws the chart (`panel._trdDraw`, Y axis rescaled to the drawn lines) **without recalculating anything** — the Portfolio line always covers all accounts (`TrendTab.visibleSeries(t, uncheckedIds)` keeps the Portfolio series as computed). The unchecked set is kept on the panel (`panel._trdUnchecked`) across refreshes. The tab refreshes on `App.onDataChanged()` and with the tab-strip Refresh button.

#### Asset Analysis (Analyze > Asset performance)

`AnalysisTab.openAsset()` shows a `Dialogs.prompt` asking for **one** ticker symbol (uppercased; cancelling or blank input is a no-op; entering several symbols shows an alert, since the report works with one asset at a time). `AnalysisTab.openAssetFor(symbol)` skips the prompt — this is what the Portfolio tab's Action-column Analyze button calls. Each run opens a new closeable tab (still `aly-N` — the id counter is shared with Reports > Investments by theme) labeled `Asset: SYM`, laid out as a flex row (`.aly-asset-layout`): the indicator **card** on the left (`.aly-card-zone`, reusing the `.rpt-report-layout`/`.rpt-header`/`.rpt-table` styling with the `.aly-indicators` modifier — 62% label / 38% value) and the **price chart** on the right (`.aly-chart`, fills the remaining width and the tab height).

**Price chart** (D3 v7 from `lib/d3.min.js`, `_drawChart`/`_renderChart`/`_addCursorLine` in `tab-analysis.js`): covers **one full year** back from the latest close (`CHART_DAYS = 365` calendar days, ≈250 trading days; data from `AnalysisTab.chartSeries(quotes, ma20, ma50, ma200, rsi)`), not year-to-date. The upper panel draws the closing price (dark, 2px) plus the 20-, 50- and 200-day simple moving averages (orange / green / purple); the smaller lower panel (~24% of the height, same time axis, dates shown below it) draws the **RSI (14)** trend on a fixed 0–100 scale with faint dashed reference lines at 70 (overbought) and 30 (oversold). Averages and RSI are computed over the full ~24-month history fetched for the report, so they are defined for every charted day. Title (with the date range and number of trading days) and legend at the top, price axis on the left with faint horizontal grid lines. In each panel a **horizontal indicator line** follows the cursor: a faint dashed line at the cursor's height (`.aly-chart-cross`) with the corresponding value (price, or RSI) shown in a tag on the Y axis; it hides when the cursor leaves the panel. The chart is redrawn when its container is resized (a `ResizeObserver` per tab, disconnected in the tab's `onClose`). If `d3` is not loaded the chart area shows a message instead.

This is a direct port of `../Stocks/trend.py`'s single-ticker verbose report (`analyze(symbol, verbose=True)`), reproducing the same metrics, comparison thresholds, and line order, adapted from Python/yfinance/pandas to JS against this app's Yahoo Finance MCP tools:

- **Historical data**: `YahooFinance.getChart(symbol, ~24 months ago, today, '1d')` (mirrors `yf.Ticker(symbol).history(period="24mo")`). Symbols with fewer than 210 daily quotes (not enough for a stable 200-day MA) produce a card showing "Processing error: Not enough historical data…" instead of a crash — deliberately more graceful than trend.py, which would print `NaN`-laced lines in that scenario rather than erroring.
- **Moving averages**: 20/50/200-day simple moving averages computed via a rolling-sum `_sma()`, mirroring pandas' `.rolling(window=N).mean()`.
- **RSI(14)**: `_rsi()` replicates `helpers/rsi.py`'s Wilder smoothing exactly — `avgGain[0] = gain[0]`, then `avg[i] = (1-α)·avg[i-1] + α·x[i]` with `α = 1/14` — matching pandas' `.ewm(alpha=1/period, adjust=False)`.
- **Momentum slopes**: `_slope()` is a linear-regression slope (matches `scipy.stats.linregress`) of the last 10 data points for each of: raw MA20, MA50, MA200, and the relative differences `(MA20-MA50)/MA50` and `(MA20-MA200)/MA200`. `manalysis.py`'s bullish/bearish **crossover-date detection is intentionally not ported** — tracing trend.py's actual `print()` calls in verbose mode shows the crossover results and `insights` narrative are computed but never printed (the relevant lines are commented out); only the fixed 10-day-window slopes and current MA values are printed, and those don't depend on crossover dates at all.
- **Fundamentals**: one combined `YahooFinance.getQuoteSummary(symbol, ['price','summaryDetail','defaultKeyStatistics','financialData','assetProfile','fundProfile','fundPerformance'])` call per symbol (equity- and ETF-only modules are requested together since unneeded ones simply come back absent — cheaper than branching into two separate calls). `price.quoteType` selects between `_buildEquityLines()` (23 indicator rows) and `_buildEtfLines()` (17 rows), matching trend.py's `EQUITY`/`ETF` branches field-for-field where the MCP's data shape allows.
- **52-week change**: computed directly from the already-fetched historical closes (`latest / close ~365 days ago - 1`) for both the analyzed symbol and a shared **^GSPC** benchmark (fetched once per batch, reused across every card) — instead of trend.py's per-type approach (`info['52WeekChange']`/`SandP52WeekChange` for equities, a second `yf.Ticker('MSFT').info` lookup for ETFs), which isn't reliably present in this MCP server's `quote_summary` response for ETFs.
- **Percentage-scaling adaptations**: a few fields that yfinance's `.info` apparently already returns as percent-scaled numbers (so trend.py prints them without multiplying by 100) come back from this MCP server as true fractions (e.g. `dividendYield: 0.0035` for 0.35%) — `dividendYield`, ETF `expenseRatio`, `ytdReturn`, and `m3Return` are multiplied by ×100 here to render correctly; fields trend.py already scales itself (`earningsGrowth`, `profitMargins`, both 52-week-change figures) are left as-is.
- **Dropped line**: trend.py's equity report includes a `%lastmon` line (`sharesShort / sharesShortPriorMonth`). This MCP server's `defaultKeyStatistics.sharesShortPriorMonth` came back as a garbled date string rather than a share count in testing, making the metric unreportable, so the line (and its supporting `plmonth`/`priorMonth` calculation) was removed from `_buildEquityLines()` rather than shown with wrong or defaulted-to-zero data.
- Each indicator row shows a ▲ (green, `#27ae60`) or ▼ (red, `#c0392b`) marker from `_cmp(a,b)`/`_cmpPos(a,b)` — direct ports of trend.py's `c()`/`cp()` — instead of trend.py's literal `++`/`--` text prefixes.

A progress dialog ("Analyzing Asset") is shown while the symbol is processed, with a 0.1s delay after each MCP call (the ^GSPC benchmark chart, the symbol's chart and its quote_summary) to avoid throttling — same pattern as Tools/Update Prices and the Reports tab. Like the Reports tab, this tab does **not** auto-recompute on `App.onDataChanged()` (`autoRefresh: false`); the tab-strip Refresh button re-runs the report and chart for the same symbol (stored on the panel as `panel._alySymbol`).

---

## Additional Logic

Use Yahoo Finance MCP server https://gateway.mcpservers.org/yahoo-finance/mcp to retrieve price quotes and additional asset info when needed. 

When a new asset is created, use Yahoo Finance MCP server to retrieve the additional info. First, use tool  "get_quote" to retrieve "longName" and "quoteType". Use longName to populate the Description field. Use quoteType to determine asset type: if quoteType == "EQUITY" → Stock, if quoteType == "ETF" → ETF, if quoteType == "MUTUALFUND" → Mutual Fund. If the asset is Stock, use tool "quote_summary" with its module "assetProfile" to retrieve asset's "sector" and "industry" and concatenate their values to populate the Category field, e.g. if "industry": "Software - Infrastructure", and "sector": "Technology", then Category = "Technology, Software - Infrastructure". If the asset is ETF,  use tool "quote_summary" with its module "assetProfile" to retrieve asset's "category" to populate the Category field. 

The Tools/Update Prices command stores **daily closing prices** for all held assets (`v_holdings`: active Ledger entries with quantity ≠ 0). For each symbol it calls `YahooFinance.getChart(symbol, start, tomorrow, '1d')`, where `start` is the later of today − 1 year and the last stored price Date for the symbol (the last date is fetched again so an intraday price is replaced by the final close), and upserts one Prices row per candle (`_upsertPrice`, rounded to 2 decimals, date from `_isoToDate`: the UTC calendar date of the candle). Throttling: 0.1 s after each call; "Too Many Requests" (HTTP 429, JSON-RPC error or text result) waits 1 s and retries the same symbol up to 15 attempts, after which the update stops, keeps what was stored, and reports the symbol it stopped on. Failures (network error, error text, no candles) are listed in a result dialog via `_showResultDialog(summary, failures, title)`. The per-symbol fetch with retries is `_fetchCloses(symbol, start, end, onRetry)` (constants `PRICE_DELAY_MS`, `PRICE_RATE_LIMIT_WAIT_MS`, `PRICE_MAX_ATTEMPTS`), shared with `fetchPriceHistory(requests, title)`, which reports use to fetch missing price history. `App.ensureAsset()` returns `null` (asset already existed), `{ ok: true }` or `{ ok: false, reason }`.

---

## Development Notes

- All dependencies (`sql.js`, WASM binary, Tabulator, D3) must be stored locally under `lib/` — no CDN fetches, as `file://` protocol makes cross-origin requests unreliable
- Do not introduce a build step, bundler, or package manager — the app must remain a directly openable HTML file
- Keep all JS in `index.html` or as plain `.js` files loadable via `<script src="">` — no ES module imports from `file://` unless Chromium flags explicitly permit them
- Prefer simplicity: this is a single-user local tool, not a web service
- All JS objects are globals (no ES module export/import); load order in `index.html` is the dependency order
- Dates: Transactions.Date and Prices.Date are `YYYY-MM-DD` (`_todayStr()`, `_addDaysStr()`, `_isoToDate()` in `app.js`); entry timestamps (Transactions/Ledger/Options/Notes `Timestamp`) are `YYYY-MM-DD HH:MM:SS` local time via `_nowTs()`. There are no schema migrations from v1: `DB.loadFromBytes()` refuses pre-2.0 files (`DB.VersionError`) and never runs `SCHEMA_SQL` on them; upgrade steps between 2.x versions go in the `UPGRADES` map in `db.js` (add a step keyed by the previous version, bump `SCHEMA_VERSION`, add a test in `tests/test_db.js`).
- Notify open tabs of data changes via `App.onDataChanged()` — refreshes all open tabs whose `refresh` callback opted into auto-refresh. `App.Tabs.open(id, label, buildFn, opts)` accepts `opts.refresh`, `opts.onClose` (singleton tabs reset their module state) and `opts.autoRefresh` (default `true`); every tab gets a close button; tabs passing `autoRefresh: false` (currently only Reports tabs) still refresh via `refreshCurrent()` (the tab-strip Refresh button, when active) but are skipped by `refreshAll()`
- No welcome screen; app starts immediately with a Portfolio tab and either a loaded or new empty database
- `App.Tabs.closeAll()` + `PortfolioTab.open()` = `_resetTabs()` — called on File > New and File > Open
- `_lastFileHandle` (`FileSystemFileHandle`) is persisted to and loaded from IndexedDB (`PortfolioApp` / `handles` / `'dbFile'`) across Chromium restarts; updated on every successful Open or Save; on first launch with URL params it is bootstrapped by calling `showOpenFilePicker` once (silently skipped if Chromium requires a user gesture); File > Open uses `showOpenFilePicker()` with `id: 'portfolio-db'` and `startIn: _lastFileHandle` when available; File > Save uses `showSaveFilePicker()` with `id: 'portfolio-db'`, `suggestedName` pre-filled from `_lastPrefix + timestamp`, and `startIn: _lastFileHandle` when available; File > Import uses `id: 'portfolio-import'` (separate MRU folder) and `startIn: App._lastImportHandle` — note: the File System Access API does not support starting pickers at arbitrary path strings; folder memory is established via handles only
- Saved files should go into the `data/` subfolder so `portfolio.bat` auto-detects them on next launch
- Transactions, Ledger, Options and Rules tabs scope form element IDs as `ft-<tabId>-<fieldName>`; access via the `fld(id, name)` helper — never use bare `getElementById('ft-*')` in those modules
- Portfolio tab also supports multiple simultaneous instances (one per account); same `ft-<tabId>-<fieldName>` scoping applies
- Window close protection uses `beforeunload` with `e.preventDefault()` + `e.returnValue = ''`; modern Chromium ignores any custom message string and shows its own native dialog — custom dialogs in `beforeunload` are not supported
- Application version is defined as the global constant `APP_VERSION = '2.3'` at the top of `app.js`; displayed as `v{version}` prefix in the status bar (e.g. `v2.3 portfolio_202610051200.db`). The database schema version is separate: `SCHEMA_VERSION` in `schema.js`, stored in `Info.Schema_Version`
- Change counter: `DB.run()` increments `_changeCount` for every INSERT/UPDATE/DELETE; `DB.setChangeListener(fn)` registers a callback fired after each write; `DB.getChangeCount()` / `DB.resetChangeCount()` manage the count; `app.js` registers a listener that calls `_renderStatus()` to append `(+N)` to the status bar; count resets to 0 on `createNew()`, `loadFromBytes()`, and after a successful save
- `DB.exportBytes()` returns the in-memory database as a `Uint8Array` for writing to a file
- Tab IDs: singleton tabs use fixed IDs (`acc`, `ast`, `prc`, `led`, `opt`, `rul`); multi-instance tabs use auto-incremented IDs (`prt-N`, `hld-N`, `txn-N`, `qry-N`, `rpt-N`, `aly-N`, `dvd-N`, `gns-N`, `trd-N`, `ldf-N` — Theme-filtered Ledger tabs).
- Account-picker dialogs (`_selectAccountDialog()` in `tab-reports.js`): a `<select>`'s `.value` is always a string, but every other `accountId` in the app comes from a `DB.query()` result and is a genuine number. The dialog explicitly `Number(...)`s the selected value before resolving, for type consistency with every other `accountId` flow. **Note**: this was initially (incorrectly) suspected as the cause of `Report > Account performance` showing an empty table for non-default accounts — it wasn't; that turned out to be the Tabulator virtual-DOM redraw issue described below. The `Number()` coercion is still worth keeping (removes a real, if harmless, type inconsistency) but doesn't fix a rendering bug on its own.
- **Reports tab Tabulator first-render bug**: `tab-reports.js`'s table is the only Tabulator instance in the app built with `data: []` and populated later via `.replaceData()` after an async gap (the YTD/QTD baseline-price lookups, since removed) — every other Tabulator tab gets real data synchronously at construction. Everything *outside* Tabulator (the plain-HTML summary strip below it) rendered correctly on first load, isolating the bug to Tabulator specifically; the tab-strip Refresh button "fixed" it by triggering a second, later `replaceData()` call. A `redraw(true)` immediately after the first `replaceData()` was tried first and did **not** fix it, which ruled out a virtual-DOM row-height/sizing miscalculation as the cause. The actual cause: `new Tabulator(...)` returns before the table has finished its own internal build (DOM/column setup) — calling `.replaceData()` before that completes is a documented Tabulator race, and `_build()` was doing exactly that (kicking off `_computeReport()`, and therefore the eventual `replaceData()`, immediately after construction with no guarantee Tabulator was actually ready). Fix: `_build()` now defers the initial `_computeReport(id, accountId)` call to Tabulator's `tableBuilt` event (`table.on('tableBuilt', () => _computeReport(id, accountId))`) instead of calling it right after `new Tabulator(...)`, guaranteeing the table is genuinely ready before any data is loaded into it. The `redraw(true)` after `replaceData()` in `_computeReport()` was left in place as a harmless defensive measure but is not what fixes this.
- Transaction hash (`Engine.hash`): `${accountId}|${date}|${symbol}|${quantity}|${price}|${amount}_${base36 hash}` stored in `Transactions.Hash` (indexed, not unique) for duplicate detection on import
- `App._lastImportHandle` is stored on the `App` object (not a top-level variable) so `import.js` can access it
- `YahooFinance` is a global IIFE in `app.js` with methods `getQuote(symbol)`, `getQuoteSummary(symbol, module)`, and `getChart(symbol, period1, period2, interval = '1d')` (wraps the MCP `get_chart` tool; used by Tools > Update prices, RSU prices on import and Analyze > Asset performance); it uses the MCP streamable-HTTP transport with an `initialize` → `notifications/initialized` → `tools/call` flow; the session ID is maintained across calls in the same page load. The underlying MCP server (`yahoo-finance-mcp`) exposes four tools total — `get_quote`, `search`, `get_chart`, `quote_summary` — of which `search` is not currently used by the app.
- `Dialogs` is a global IIFE in `dialogs.js`; uses `#modal-backdrop` + `#modal-container` elements; never call `Dialogs.alert/confirm/prompt` from inside another `Dialogs.custom()` handler — use inline error elements instead; `Dialogs.alertHtml(bodyHtml, title)` accepts pre-sanitized HTML for the body (use when a formatted list is needed — callers must escape values with `_esc()` before interpolating)
- Testing: `python tests/run_tests.py` (one-time setup: `python -m pip install --target tests/.pylib quickjs`). The tests run the real `js/*.js` in QuickJS with a `SQL.Database` stand-in backed by Python `sqlite3` (`tests/harness.py`); they cover the DB layer, engine, imports, Update Prices, script loading and SQL compilation, not the UI. Add checks to the matching `tests/test_*.js` when changing data logic; see `tests/README.md`
- MCP call logging: every JSON response from `YahooFinance` is logged to `logs/mcp.log` in the browser's Origin Private File System (OPFS) — no user interaction required; the file is overwritten (truncated) at each app launch. Access via **Tools > Download MCP log…** (downloads as `mcp.log`) or via Chromium DevTools → Application → Storage → Origin private file system → `logs/mcp.log`. In-memory log array `_mcpLog` accumulates entries for the current session.
- Tab panel visibility: inactive `.tab-panel` elements use `visibility: hidden` (not `display: none`) so that Tabulator's virtual renderer retains layout and `scrollTop` is preserved across tab switches. All panels are `position: absolute; inset: 0` stacked inside `#tab-content`; only the active panel gets `visibility: visible; pointer-events: auto`.
- File > Export (`cmdExport` in `app.js`): queries `v_holdings` + `v_latest_price` (same aggregation as the Portfolio tab), joins with Assets for metadata columns, computes `%Portfolio` in JS, and writes a CSV via `showSaveFilePicker` with `id: 'portfolio-export'`.

---


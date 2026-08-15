# Portfolio - Personal Portfolio Tracker

## Project Overview

A single-page application for tracking portfolio of securities such as stocks and ETFs. Runs entirely locally in a bundled Chromium browser with no server, and no build step. Uses external services like Yahoo Finance MCP to retrieve price quotes and other asset data.

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
    └── tabulator.min.css   # Tabulator default theme (local copy)
└── js/
    ├── schema.js           # SCHEMA_SQL constant — DDL for all tables
    ├── db.js               # DB global — sql.js wrapper (query, run, export, change tracking)
    ├── dialogs.js          # Dialogs global — modal alert/confirm/prompt/custom
    ├── import.js           # Import global — CSV import flow
    ├── tab-portfolio.js    # PortfolioTab global — multi-instance portfolio tab
    ├── tab-accounts.js     # AccountsTab global — singleton accounts tab
    ├── tab-assets.js       # AssetsTab global — singleton assets tab
    ├── tab-prices.js       # PricesTab global — singleton prices tab
    ├── tab-transactions.js # TransactionsTab global — multi-instance transactions tab
    ├── tab-query.js        # QueryTab global — multi-instance SQL query tab
    ├── tab-reports.js      # ReportsTab global — multi-instance Portfolio/Account performance report tabs
    ├── tab-analysis.js     # AnalysisTab global — multi-instance Analyze tabs (Portfolio-by-Theme and Assets trend analysis implemented; Accounts still a stub)
    └── app.js              # App/YahooFinance globals — init, menus, file ops, MCP client
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
4. If a file is found and loads successfully → `DB.loadFromBytes()`. If `_lastFileHandle` is still null after the IDB load, `showOpenFilePicker` is attempted (with `id: 'portfolio-db'`) to acquire a handle for the auto-loaded file; on success the handle is persisted to IDB. This is a one-time step per fresh Chromium profile.
5. If no parameter or fetch fails → `DB.createNew()` (empty database with default Categories record).
6. Portfolio tab opens immediately — no welcome screen or folder picker.

Data folder: configurable via first argument to `portfolio.bat` / `portfolio.sh`; defaults to `data/` (created automatically by the launcher).

---

## Data Schema

The application's data schema manages the following entities:
- Accounts - brokerage accounts where stocks and ETFs are held
- Assets - investment assets: stocks, ETFs, mutual funds, etc.
- Prices - asset prices quotes
- Ledger - records of buying and selling assets
- Mappings - saved CSV column-to-field associations used to pre-populate the CSV import mapping dialog

Accounts table:
- Account_ID (primary key, integer, auto incremented)
- Account (text, account number or alphanumeric identifier)
- Name (text)
- Cash (amount of cash held in the account, float)
- Last_Updated (datetime stamp when account's ledger was last updated)
- Currency (text, default USD)
- Active (flag whether the account is active or not)

Assets table:
- Symbol (stock or ETF symbol, primary key)
- Description (text)
- Type (vocabulary: Stock, ETF, MF)
- Category (text)
- Theme (text, free-form user-assigned grouping, e.g. "AI", "Dividend Growth")
- Notes (text, free-form user notes)
- Active (flag whether the asset is active or not)

Prices table:
- Timestamp (datetime stamp of the price quote `YYYY-MM-DD HH:MM:SS`, indexed)
- Symbol (stock or ETF symbol, foreign key to Assets)
- Price (price per share, float)
- Currency (text, default USD)
- Valid (flag whether the price quote is valid, default is yes, invalid price quotes are not shown/considered)

Ledger table:
- Transaction_Hash (primary key, hash value computed from account, symbol, quantity, and price)
- Timestamp (datetime stamp of the transaction `YYYY-MM-DD HH:MM:SS`, indexed)
- Account_ID (foreign key to Accounts table, indexed)
- Symbol (stock or ETF symbol, foreign key to Assets)
- Quantity (number of shares bought/sold, float)
- Price (price per share, float)
- Currency (text, default USD)
- Valid (flag whether the transaction is valid, default is yes, invalid transactions are not shown/considered)

Mappings table:
- Mapping_ID (primary key, integer, auto incremented)
- Source (transaction field key, unique: Account | Name | Date | Symbol | Description | Quantity | Price | CostBasis | Currency)
- Target (CSV column name from the source file)
- Pattern (optional regex; if set, applied to the source value — first capture group used, or full match if no group)

---

## Inputs

Accounts are populated by the user and only through the user interface. 

Assets are populated when a first ledger transaction for the asset is entered. 

Price quotes are populated when new asset transactions are entered or retrieved from Yahoo finance using their MCP server upon user's request to update the quotes.

Ledger transactions can either be imported from a CSV file or entered manually by the user through the user interface. 

When importing from a CSV file, available data fields are mapped to the schema via user interface and ingested.  

File example:
```CSV
Account Number,Account Name,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Today's Gain/Loss Dollar,Today's Gain/Loss Percent,Total Gain/Loss Dollar,Total Gain/Loss Percent,Percent Of Account,Cost Basis Total,Average Cost Basis,Type
Y123456,Account A,AIRR,FIRST TR EXCHANGE TRADED FD VI RBA AMERN INDL RENAISSANCE ETF,2000,$133.25,+$2.35,$266500.00,+$4700.00,+1.79%,+$81717.21,+44.22%,5.26%,$184782.79,$92.39,Margin,
X45789,Account B,AMZN,AMAZON.COM INC,2600,$232.79,-$11.60,$605254.00,-$30160.00,-4.75%,+$325514.84,+116.36%,11.95%,$279739.16,$107.59,Margin,
```

CSV import uses a generic column-mapping dialog instead of hardcoded column names:

1. The file is parsed to extract the header row (column names).
2. Existing mappings are loaded from the `Mappings` table (keyed by Source column name).
3. A **CSV Column Mapping** dialog is shown with one row per transaction field (Account, Name, Date, Symbol, Description, Quantity, Price, Cost Basis, Currency). Each row has:
   - **Transaction Field** — fixed label (read-only)
   - **CSV Column** — dropdown: `— none —` + all column headers from the file
   - **Extract Pattern** — optional regex; if provided, the first capture group is used as the value (full match used if no capture group)
4. The dialog pre-populates dropdowns and patterns from the Mappings table (keyed by transaction field name: `Source` = field key, `Target` = CSV column name). If a saved column no longer exists in the current file, the dropdown resets to `— none —`.
5. The Import button shows an inline error unless Symbol, Quantity, and at least one of Price or Cost Basis are mapped to a CSV column.
6. On Import: mappings are saved back to the Mappings table (upsert by Source), then the user is asked to select an account, and transactions are inserted using the mapped field values.

Assets table field mapping (resolved at runtime from Mappings table):
- Symbol <- column(s) mapped to Symbol
- Description <- column(s) mapped to Description
- Category <- value retrieved from Yahoo Finance MCP service, see the definition below
- Type <- value retrieved from Yahoo Finance MCP service, see the definition below

Prices table field mapping (resolved at runtime from Mappings table):
- Timestamp <- column(s) mapped to Date, normalised to `YYYY-MM-DD HH:MM:SS`; defaults to current timestamp if unmapped
- Symbol <- column(s) mapped to Symbol
- Price <- column mapped to Price; if absent, derived as `CostBasis / |Quantity|`
- Currency <- column mapped to Currency, or USD if unmapped

Ledger table field mapping (resolved at runtime from Mappings table):
- Transaction_Hash <- computed from account, symbol, quantity, and price
- Timestamp <- column(s) mapped to Date, normalised to `YYYY-MM-DD HH:MM:SS`; defaults to current timestamp if unmapped
- Account_ID <- resolved from the column(s) mapped to Account/Name
- Symbol <- column(s) mapped to Symbol
- Quantity <- column(s) mapped to Quantity
- Price <- column mapped to Price; if absent, derived as `CostBasis / |Quantity|`
- Currency <- column mapped to Currency, or USD if unmapped

## Importing Logic

The Import command performs the following logical steps:

1. Displays the column mapping dialog to establish column to field mapping. Uses records from the Mappings table to prepopulate the dialog and updates the Mappings table following user's input.
2. If there is no CSV column with the account info, asks user to select the account.
3. **Asset enrichment pre-pass** — before inserting any rows, a single pass over the CSV collects every unique symbol not already present in the Assets table. An "Updating Assets" progress dialog (identical in style to the Update Prices dialog) is shown, and `App.ensureAsset()` is called for each new symbol with a 0.5 s delay between calls to avoid Yahoo Finance throttling. If all symbols are already known, this step is skipped entirely. After this step the main loop's `ensureAsset()` calls are instant no-ops.
4. Each new ledger record sourced is used to populate three tables. The Assets table is populated first if a new asset is encountered. For each new asset the Prices table is updated to record the transaction price as the baseline. Then each ledger record is inserted into the Ledger table with a unique transaction_hash computed from four values: account, symbol, quantity, and price.
5. After all rows are processed, the Cash balance of each affected account is updated: `Cash = ROUND(Cash + Σ(-qty × price), 2)`. Positive quantity (buy) decreases cash; negative quantity (sale) increases cash. `Last_Updated` is set to the current timestamp. Only successfully inserted rows (not duplicates) contribute to the delta.


---

## UI Features

The application UI is organized as a menu strip and a collection of horizontal tabs. The menu strip contains the following submenus and commands therein:
File/
- New
- Open...
- Import...
- Export...
- Save...
View/
- Portfolio
- Accounts
- Assets
- Prices
- Transactions
Analyze/
- Portfolio  (opens an Analysis tab: portfolio value grouped by Theme)
- Account    (prompts to select one account, opens an Analysis tab scoped to that account's assets — same Theme breakdown as Analyze/Portfolio)
- Assets     (prompts for symbols, opens a trend-analysis Analysis tab — see below)
Reports/
- Portfolio performance
- Account performance
Tools/
- Update prices...
- Query database...

The New command creates a new database in memory with empty tables. 

The Open command loads a previously saved database from a local file.

The Import command imports transactions from a CSV file.

The Export command exports the current portfolio holdings as a CSV file named `portfolio_YYYY-MM-DD.csv`. Columns in order: Symbol, Quantity, Value, %Portfolio (from the Portfolio tab aggregation), Description, Type, Category, Notes (from the Assets table). Only symbols with a positive net quantity are included. The save picker opens in the same folder as the last database file.

The Save command saves in-memory database into a local file. The prefix prompt is pre-filled with the prefix of the last opened or saved file (e.g. "portfolio"); the save dialog opens in the same folder as that file. User may change the prefix; the application automatically adds a timestamp suffix (e.g. _202606121605) and the .db extension.

The Query database command opens a new Query tab. Multiple Query tabs may be open simultaneously. See the Query Tab section below.

The Portfolio performance command (Reports menu) opens a new Reports tab. Multiple Reports tabs may be open simultaneously. See the Reports Tab section below.

The Account performance command (Reports menu) first shows a Select Account dialog (active accounts only); on OK it opens a new Reports tab identical in every respect to Portfolio performance but limited to the selected account's Ledger rows — same table, same YTD/QTD baseline-price logic, same summary strip, just account-scoped. See the Reports Tab section below.

The Analyze/Portfolio command opens a new Analysis tab showing portfolio value grouped by Theme. Multiple Analysis tabs may be open simultaneously. See the Analysis Tab section below.

The Analyze/Account command first shows a Select Account dialog (active accounts only); on OK it opens a new Analysis tab identical in layout to Analyze/Portfolio but scoped to the selected account — same Theme breakdown, same Cash-row/Grand-Total behavior, but limited to that account's Ledger rows and its own Cash balance rather than all accounts combined.

The Analyze/Assets command prompts for one or more ticker symbols, then opens a new Analysis tab with a side-by-side trend-analysis report per symbol (moving averages, RSI, momentum slopes, fundamentals) — see "Asset Analysis (Analyze > Assets)" under the Analysis Tab section below.

The Portfolio, Accounts, Assets, Prices, and Transaction commands open new Portfolio, Accounts, Assets, Prices, and Transactions tabs respectively. See the definitions of these tabs below.

The tab strip (`#tab-strip`) is a flex row containing a scrollable `#tab-bar` (tabs append here left-to-right in open order) and a Refresh button (`#tab-refresh`) anchored at the right end outside the scrollable area. Clicking the Refresh button re-loads data for the currently active tab (calls the appropriate module's `refresh()` function; Query tabs have no auto-refresh since the user controls execution).

Tabs are added on demand and each tab represents a filtered or aggregated view of the underlying data. Each View tab's space is vertically divided into two zones. The upper zone occupies 70-80% of the tab's space and displays a data table. The lower zone occupies the remaining tab's space and displays a form. The table and form content varies between tabs but the general layout is the same. The data table displays a filtered view of the data as rows and columns. The table can be sorted by any of the columns; column sort is tristate (ascending → descending → cleared) — clicking a sorted column a third time restores the natural data order (as returned by the underlying SQL query). Each table represents a dynamic view of the data. This means that if the underlying data are updated, the rendering of the data in the table should be automatically updated as well. Tabulator 6.3.0 is used for all data tables.

The table data view component should support the following functionality: sorting by any column, filtering by any column, row selection (one row at a time, selected row background should be different from the rest of the table), clicking on a cell value (see use cases below), and Delete key capture. If the Delete key is pressed on the keyboard it should be interpreted as a request to "delete" the selected record — **unless** focus is on an input, textarea, or select element in the form, in which case the Delete key is passed through to the browser for normal character deletion. When the delete action is triggered, the application verifies that there are no other records referring to this record (referential constraints) and presents the user with an explanation/confirmation dialog. If there are referential constraints, the application explains that the record cannot be deleted. If there are no referential constraints, the application asks for a delete confirmation and then sets the Active/Valid flag for this record to false.

Each form facilitates display of the additional data for the selected data record and allows editing of the selected data record. The form is dynamically linked to the data table. When user clicks on a row in the data table, the underlying record is considered selected and the form is updated to display the record's content. If the record is edited, an Accept button is shown. User has to click the Accept button to save the changes, otherwise the changes are silently ignored if user moved to another record. The form also has a New button that allows user to create a new record of the desired type. When user click the New button, form's content is nulled and is dissociated from the selected record.

All forms use a 3-column layout: left column (45% width) with up to 4 fields, middle column (45% width) with additional fields, and right column (10% width) containing action buttons arranged vertically — New at the top, Accept at the bottom, other buttons in between.

Each Analyze tab has a dedicated content which will be defined later.

### The Portfolio Tab

When the application starts and the database file is loaded, the application displays the "Portfolio" tab. The Portfolio tab renders an aggregate view of all the Ledger transactions grouped by the symbol. The table object displays the following columns in order: Symbol (asset symbol, hyperlink), Quantity (sum of quantities of all valid ledger transactions for this symbol), Price (latest asset price from the Prices table), Value (total value of owned shares), Gain/Loss (total gained or lost value computed based on the ledger record prices and the latest price known), % Gain/Loss (gain/loss as a percentage of cost basis: `GainLoss / CostBasis × 100`), % Portfolio (percent of the total portfolio value associated with the symbol), Action (an "Analyze" button per row).

Symbol works as a hyperlink — clicking it opens a Transactions tab filtered by that symbol. When the Portfolio tab is scoped to a specific account the filter includes both symbol and accountId; for the all-accounts view only the symbol is used.

The Action column follows the same pattern as the Money app's Transactions tab Action column (`../Money/js/tab-transactions.js`'s `actionsFormatter`/`.act-btn` convention, ported into `app.css`): a Tabulator column-level `cellClick` handler checks `e.target.classList.contains('act-btn')` before acting (so clicks on cell padding outside the button are ignored), then calls `AnalysisTab.openAssetsFor(symbol)` — the same Analyze > Assets trend-analysis report as the menu command, but run directly for that one symbol, skipping the "enter symbols" prompt dialog. `AnalysisTab.openAssets()` (the menu command) and `openAssetsFor()` (this button) both funnel into a shared private `_openAssetsForSymbols(symbols)` so the tab-opening/rendering logic isn't duplicated.

The form on the Portfolio tab is different from all other forms and does not represent a detailed view/edit for the selected tabulator record. Instead the form zone shows two elements stacked vertically:

1. **Total portfolio value** — a read-only line displaying "Total Value: $X.XX (N)", where N is the count of distinct assets (table rows — i.e. distinct symbols with a positive net quantity) in the current tab's scope. The dollar total is the sum of all position values (Quantity × Price) for the current tab's scope **plus** the cash balance of the included accounts: for the all-accounts tab, cash is summed across all active accounts; for an account-scoped tab, only that account's cash is included. Updated automatically on every data refresh. The `% Portfolio` column uses this combined total (assets + cash) as its denominator.
2. **Transaction input** — a single text field where the user can enter new ledger transactions. Supported formats:
   - `+100 AAPL @ 150` or `-50 MSFT @ 200` (sign prefix determines buy/sell)
   - `buy 100 AAPL at 150` / `bought 100 AAPL at 150` (positive quantity)
   - `sell 50 MSFT @ 200` / `sold 50 MSFT at 200` (negative quantity)
   - `sell all MSFT @ 291.5` / `buy all AAPL at 150` — `all` resolves to the current net quantity owned per the Ledger; for an account-scoped tab the sum is limited to that account, for the all-accounts tab it sums across all accounts

   When the user hits Enter, the input is parsed and the following steps run before the confirmation dialog is shown:
   - **Symbol validation** — if the symbol is not already in the Assets table, `YahooFinance.getQuote()` is called. If the call throws or returns no price data (`regularMarketPrice` and `regularMarketPreviousClose` both absent), an error dialog is shown asking the user to correct the transaction, and the flow stops.
   - **Account filtering for sells** — the Account selector in the confirmation dialog is populated only with accounts that hold at least the requested quantity of the symbol (per the Ledger). If no account has sufficient holdings, an error is shown instead of the dialog.

   The confirmation dialog contains: Account (selector), Symbol, Quantity (pre-filled with the resolved number when `all` was used), Price, Currency (default USD). All fields are required. User clicks OK to commit the transaction (same logic as import: ensures asset exists, seeds a price record if none, inserts Ledger row, updates Cash and Last_Updated on the account) or Cancel to abort. On success the Portfolio tab refreshes.

If user enters a negative quantity of shares, the application also updates the Cash field of the Accounts table record by the the amount of sale. For example, if user enters "-100 MSFT @ 291.5" or "sold 100 MSFT at 291.5", the Cash balance of the selected account should be increased by 29,500. If user enteres a positive quantity of share, the Cash balance should be decreased by the total amount of the new ledger record. The Last_Updated field of the selectd account should be updated with the current date.

Multiple Portfolio tabs may be open simultaneously (one per account). Each tab is independent with its own table and form state. Form element IDs are scoped per instance using the pattern `ft-<tabId>-<fieldName>` to prevent conflicts.

### The Accounts Tab

The Accounts tab renders all records from the Accounts table where Active flag is set. The table object displays the following fields in order: Name, Balance, Cash, Last Updated. The Name column works as a hyperlink — clicking it opens a new Portfolio tab filtered to that account.

Balance is a computed column: `ROUND(SUM(net_quantity × latest_price) + Cash, 2)` where net_quantity per symbol is derived from all valid Ledger rows for the account, and latest_price comes from the most recent valid Prices row per symbol (same `GROUP BY Symbol HAVING Timestamp = MAX(Timestamp)` pattern used elsewhere). Balance updates automatically whenever any Ledger or Price data changes (via `App.onDataChanged()` → `refreshAll()`), and can also be refreshed manually with the Refresh button in the tab strip.

The form on the Accounts tab displays the following fields for the selected account. Left column: Account, Name; Middle column: Cash + Currency (same line), Active. Each of the displayed fields can be edited. 

### The Assets Tab

The Assets tab renders all records from the Assets table where Active flag is set. The table object displays the following fields in order: Symbol, Quantity, Description, Type, Theme, Category, Notes. Quantity is the total net shares owned across all accounts (sum of all valid Ledger rows for the symbol). Symbol and Type columns are rendered at half the width of Description, Theme, Category, and Notes (`widthGrow: 1` vs `widthGrow: 2`). Each symbol works as a hyperlink — clicking it opens a new Transactions tab filtered to that asset.

The form on the Assets tab displays the following fields for the selected asset. Left column: Symbol, Description, Notes; Middle column: Type (dropdown box), Category, Theme. Each of the displayed fields can be edited. The Theme field is a free-text input with a custom autocomplete dropdown (`.ac-wrap` / `.ac-list` / `.ac-item` / `.ac-active` in `app.css`): on each keystroke it queries `SELECT DISTINCT Theme FROM Assets WHERE Theme LIKE '<text>%' AND Theme IS NOT NULL AND Theme <> '' ORDER BY Theme LIMIT 10` and renders matches as a dropdown positioned below the input; clicking a match (via `mousedown`, to fire before the input's `blur`) or navigating with Arrow Up/Down + Enter fills the field, Escape closes the dropdown, and losing focus closes it after a short delay. This is a reusable pattern (`_attachThemeAutocomplete` / `_addAcKeyboard` in `tab-assets.js`) — the same `.ac-*` CSS classes are intended for any future free-text field that should suggest from existing distinct values.

### The Prices Tab

The Prices tab renders the most recent record from each unique Symbol from the Prices table. The table object displays the following fields in order: Symbol, Description (from the Assets table), Price, Timestamp (timestamp of the most recent price quote available). Each symbol works as a hyperlink - when user click on the symbol a new Transactions tab is opened that display transactions for this asset only.

The form on the Prices tab displays the following fields for the selected asset. Left column: Symbol, Description; Middle column: Price + Currency (on the same line). Right column buttons: Update (top), Accept (bottom). Only the Price field is editable. The Update button (enabled after row selection) calls `YahooFinance.getQuote` for the selected symbol using `regularMarketPrice ?? regularMarketPreviousClose`, populates the Price field, and enables Accept — without writing to the database. If users enters or updates a price value and clicks Accept, a new record is added to the Prices table with the current timestamp. The tabulator view is updated to reflect the price changes.

### The Transactions Tab

Multiple Transactions tabs may be open simultaneously (one per account, symbol, or time frame). Each tab is independent with its own table and form state. Form element IDs are scoped per instance using the pattern `ft-<tabId>-<fieldName>` to prevent conflicts.

Each Transactions tab is named after its primary filter: symbol takes precedence over account name — so a tab filtered by both symbol and accountId is labelled with the symbol. A tab filtered by accountId only is labelled with the account name. The Transactions tab renders all ledger transactions for the selected account(s) where Valid flag is set to true. The data for the Transactions tab are assembled by joining Ledger and Accounts tables to resolve foreign keys. The table objects displays the following values in order: Name, Type(Buy or Sale based on the quantity sign: positive or negative), Timestamp, Symbol, Quantity, Price, Value(total value of the transaction). The data in the Transactions tab can be pre-filtered by a specific Account or Symbol (e.g. see navigation from the Accounts or Assets tabs). In that case only the transactions matching the specified Account ID or Symbol are displayed. By default, the transactions are sorted by Timestamp in an ascending order.

The form on the Transactions tab uses a 3-column layout. Left column (top to bottom): Account, Name, Timestamp (`<input type="datetime-local">`). Middle column (top to bottom): Symbol, Quantity, Price + Currency (on the same line). The form buttons are in the right column: New (top), Delete (middle), Accept (bottom). The New button resets the form. The Delete button invalidates the transaction and hides it from the view/consideration. The Accept button saves any edited form data including adding a new ledger transaction.

### The Query Tab

Multiple Query tabs may be open simultaneously (tab IDs `qry-1`, `qry-2`, …). Each Query tab is closeable. There is no form zone — the tab is divided into two vertical areas:

- **SQL zone** (top, 15% of tab height): a toolbar row with an "SQL" label and a Run button, plus a monospace `<textarea>` that fills the remaining height of the zone. Placeholder text is `SELECT * FROM Accounts;`.
- **Results zone** (bottom, 85% of tab height): a Tabulator table with `autoColumns: true` that is generated dynamically from whatever the query returns.

Execution is triggered by clicking Run or pressing Ctrl+Enter inside the textarea. `DB.query(sql)` is called; if it throws, the error message is displayed in red monospace in the results zone. If the query returns 0 rows, a "Query executed. No rows returned." message is shown. Otherwise a Tabulator table is built with columns auto-generated from the result set. Each subsequent run destroys the previous Tabulator instance before creating a new one. The Refresh button in the tab strip has no effect on Query tabs (user controls execution explicitly).

### The Reports Tab

Multiple Reports tabs may be open simultaneously — each invocation of Reports/Portfolio performance or Reports/Account performance opens a brand-new closeable tab (tab IDs `rpt-1`, `rpt-2`, …, counter shared across both commands), rather than reactivating a singleton. Unlike the View tabs, a Reports tab has no form zone: the panel is a table filling ~all of the space, with a summary strip anchored at the bottom.

The table shows one row per active asset — positive net quantity per the Ledger, across all accounts for Portfolio performance or limited to `l.Account_ID = ?` for Account performance — with columns in order: Symbol (hyperlink — opens a Transactions tab filtered by that symbol), Quantity, Price (latest valid price from the Prices table), Value (`Quantity × Price`), % Total G/L, % Asset G/L YTD, % Asset G/L QTD.

**Account performance** (`ReportsTab.openAccount()`) reuses this exact same `_build`/`_computeReport` code as Portfolio performance, with an `accountId` threaded through the assets query and into `reportLabel` (resolved from the account's Name) wherever the UI previously said "Portfolio": the progress dialog title, the failure-summary dialog title, and the summary strip's "Avg {reportLabel} Performance:" label. It first prompts with a Select Account dialog (`_selectAccountDialog()` — active accounts only, same small custom `<select>` popup pattern as `AnalysisTab.openAccount()`'s account picker, alerting instead if there are no active accounts). The YTD/QTD baseline-price lookup/cache logic (`_getBaseline`) is unchanged and unparameterized by account, since a symbol's baseline price is the same regardless of which account holds it.

% Total G/L is the asset's total gain/loss since acquisition, same formula as the Portfolio tab's `% Gain/Loss` column: `(Value − CostBasis) / CostBasis × 100`, where `CostBasis = SUM(Quantity × Price)` across that asset's valid Ledger rows (in scope) — pulled directly from the same `assets` query as Quantity/Price (no MCP call needed, unlike YTD/QTD). `—` if CostBasis is 0.

For each asset, % Asset G/L YTD and % Asset G/L QTD are computed against a baseline price captured on the first market day of the current calendar year and current calendar quarter, respectively:
1. The Prices table is checked first for a valid price already recorded for that symbol within the 9 days following the period start date (`YYYY-01-01` for YTD, `YYYY-{01,04,07,10}-01` for QTD). If found, that price is reused as the baseline (avoids re-fetching on every report run).
2. If no cached baseline exists, `YahooFinance.getChart(symbol, periodStart, periodStart+9days, '1d')` is called; the earliest returned daily candle's `close` is taken as the baseline price and inserted into the Prices table with a timestamp derived from that candle's actual date (which may differ from `periodStart` itself, e.g. New Year's Day/weekends), so subsequent report runs hit the cache.
3. `%Gain/Loss = (CurrentPrice − BaselinePrice) / BaselinePrice × 100`. If a baseline can't be found (new listing, delisted, MCP failure), the cell shows `—` and the asset is excluded from that period's portfolio-level average (not treated as 0%).

The bottom summary strip reads **"Avg {reportLabel} Performance: Total xx%, YTD yy%, QTD zz%"** (each percentage bold and colored green/positive or red/negative) — three value-weighted averages, each `(ΣCurrentValue − ΣBaseValue) / ΣBaseValue × 100`:
- **Total** sums every asset's `Value`/`CostBasis` unconditionally (CostBasis is always known — no MCP dependency), so it's never `—` once any asset has a positive CostBasis.
- **YTD**/**QTD** each sum only the assets that have a YTD/QTD baseline for that period (`Quantity × BaselinePrice` as the baseline value) — assets without a baseline are excluded from that particular average, not treated as 0%.

None of the three is a simple average of the per-row percentages (which would overweight small positions).

A progress dialog ("Computing Portfolio Performance") is shown while baseline lookups run, with a 0.1s delay between `get_chart` calls to avoid throttling — same pattern as Tools/Update Prices. If any baseline lookups fail, a failure summary dialog lists each failed `symbol (YTD|QTD)` and its reason after the report renders.

Unlike other tabs, Reports tabs do **not** auto-recompute on `App.onDataChanged()` (e.g. a new transaction entered elsewhere, an import, a price update) — only when the tab is first opened or the user explicitly clicks the tab-strip Refresh button while it's active. This is intentional: recomputing can pop the progress modal and make live `get_chart` calls, which would be disruptive if triggered silently for a Reports tab sitting in the background while the user works on another tab.

### The Analysis Tab

Multiple Analysis tabs may be open simultaneously — each invocation of Analyze/Portfolio or Analyze/Account opens a brand-new closeable tab (tab IDs `aly-1`, `aly-2`, …, counter shared across both commands), same instancing pattern as Reports/Query. Unlike every other tab in the app, this one is rendered as **plain HTML — no Tabulator** — since it's a small, static, non-sortable/non-filterable breakdown, styled to match the "Spend by Category" report tab from the sibling `Money` app (`../Money/js/tab-report-category.js` + its `app.css`) as closely as domain differences allow: a header block (`.rpt-header` containing `.rpt-title` "Portfolio Analysis" and `.rpt-subtitle` "By Theme") followed by a fixed-width (560px) `<table class="rpt-table">` with a dark navy (`#2c3e50`) uppercase header row, zebra-striped body rows, and a highlighted `<tfoot>` total row — all inside a padded, self-scrolling `.rpt-report-layout` container (no form zone).

`.rpt-report-layout` is a **distinct class from `.rpt-layout`** (the flex-based shell already owned by the Reports/Performance tab, which has different children and sizing needs) — reusing `.rpt-layout` here would have broken that tab's Tabulator zone. All the other classes (`.rpt-header`, `.rpt-title`, `.rpt-subtitle`, `.rpt-table`, `.rpt-col-name`, `.rpt-col-num`, `.rpt-total-row`, `.rpt-empty`) are exact ports of Money's values in `app.css`, since only the Analysis tab uses them (no naming conflicts there). Percentages are formatted to 1 decimal place (`.toFixed(1)`), matching Money's report exactly, rather than the 2-decimal precision used elsewhere in this app (Portfolio/Reports tabs).

The table has one row per distinct Theme (from the Assets table) plus one synthetic **Cash** row, with columns Theme, Value, %Portfolio, computed as follows:
1. All active symbols (positive net quantity per the Ledger) are valued at `Quantity × MostRecentPrice` (latest valid row per symbol in Prices).
2. Values are grouped and summed by the owning asset's Theme. Assets with a blank/NULL Theme are grouped together under the label **"(No Theme)"** rather than excluded, so the table still accounts for the full portfolio.
3. Total cash across all active Accounts is added as its own **Cash** row (only shown if non-zero) — Themes apply to assets, not cash, so there's no per-theme cash split.
4. All rows (Theme groups + Cash) are sorted together by Value descending.
5. `%Portfolio = RowValue / GrandTotal × 100`, where `GrandTotal` is the sum of all displayed rows (Theme groups + Cash) — i.e. the true total portfolio value. A `<tfoot>` **Grand Total** row at the bottom displays this total and always reads 100.0%, so the displayed rows are always internally consistent with the total (this is why Cash is shown as its own row rather than only folded into the denominator). The row's label reads "Grand Total N Assets" where N is the count of distinct assets (symbols) underlying the report — `assets.length` from the `_loadData()` query, before grouping by Theme — e.g. "Grand Total 26 Assets". This applies to both the all-portfolio and account-scoped views, since both share this same `_render`/`_loadData` code.

Each Theme name is a `cell-link` hyperlink; the Cash row's label is plain text (not clickable — there's no meaningful Portfolio-tab filter for cash). Clicking a Theme calls `PortfolioTab.open(accountId || null, theme)` (passing `''` for the synthetic "(No Theme)" group) to open a new Portfolio tab filtered to that Theme's assets — analogous to clicking an Account name on the Accounts tab, but filtering by `Assets.Theme` instead of/in addition to `Account_ID`.

`PortfolioTab.open(accountId, theme)` accepts an optional second `theme` argument (backward compatible — existing call sites passing zero or one argument are unaffected): when set, `_loadData` adds a `JOIN Assets` and filters `Theme = ?` (or `Theme IS NULL OR Theme = ''` for the empty-string sentinel). Both filters can be active together (drilling into a Theme from an already account-scoped Analysis tab): the tab label becomes `AccountName — ThemeName` in that case, just `AccountName` for an account-only filter, or just the Theme name (or "(No Theme)") for a theme-only filter; the tab is closeable whenever either filter is set. A Theme-scoped-only tab (no `accountId`) naturally falls into the same "sum cash across all active accounts" branch used by the unscoped all-accounts Portfolio tab — no special-casing was needed for that.

**Analyze/Account** (`AnalysisTab.openAccount()`) reuses this exact same `_build`/`_render`/`_loadData` code as Analyze/Portfolio, with an `accountId` threaded through everywhere `undefined` previously meant "all accounts": it first prompts with a Select Account dialog (`_selectAccountDialog()` — active accounts only, a `<select class="dlg-select">` in a small custom `Dialogs.custom()` popup, alerting instead if there are no active accounts), then opens the tab labeled `Portfolio Analysis — {AccountName}` with the on-page subtitle changed to `By Theme — {AccountName}`. `_loadData(accountId)` adds `AND l.Account_ID = ?` to the Ledger scope and switches the cash query to that one account's `Cash` (both are the same conditional branches the account-scoped Portfolio tab already uses — no new SQL patterns). Clicking a Theme from an account-scoped Analysis tab opens a Portfolio tab filtered to **both** that account and that Theme (see the combined-label behavior above).

#### Asset Analysis (Analyze > Assets)

`AnalysisTab.openAssets()` is a second entry point in the same module. Selecting Analyze/Assets shows a `Dialogs.prompt` asking for one or more ticker symbols (split on `/[\s,]+/`, uppercased, deduplicated). Cancelling or submitting blank input is a no-op. Otherwise a new closeable tab opens (still `aly-N` — the id counter is shared with Analyze/Portfolio) labeled `Assets: SYM1, SYM2, …` (truncated with a count suffix beyond 3 symbols), containing one report **card** per symbol laid out **side by side, left to right, in entry order**, inside a horizontally- and vertically-scrolling `.aly-assets-scroll` flex row (`overflow: auto`). Each card reuses the `.rpt-report-layout`/`.rpt-header`/`.rpt-table` styling from the Portfolio Analysis view above, with a `.aly-indicators` modifier class that overrides the column widths (62% label / 38% value, vs. the Theme table's 55/22.5/22.5) since this table only has two columns.

A third entry point, `AnalysisTab.openAssetsFor(symbol)`, skips the prompt and runs the report for one known symbol — this is what the Portfolio tab's Action-column Analyze button calls (see The Portfolio Tab section). Both `openAssets()` and `openAssetsFor()` funnel into a shared private `_openAssetsForSymbols(symbols)` that does the actual tab-opening.

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

A progress dialog ("Analyzing Assets") is shown while symbols are processed sequentially, with a 0.1s delay after each MCP call (chart + quote_summary per symbol, plus the one-time ^GSPC fetch) to avoid throttling — same pattern as Tools/Update Prices and the Reports tab. Like the Reports tab, this tab does **not** auto-recompute on `App.onDataChanged()` (`autoRefresh: false`); the tab-strip Refresh button re-runs the same symbol list (stored on the panel as `panel._alySymbols`).

---

## Additional Logic

Use Yahoo Finance MCP server https://gateway.mcpservers.org/yahoo-finance/mcp to retrieve price quotes and additional asset info when needed. 

When a new asset is created, use Yahoo Finance MCP server to retrieve the additional info. First, use tool  "get_quote" to retrieve "longName" and "quoteType". Use longName to populate the Description field. Use quoteType to determine asset type: if quoteType == "EQUITY" → Stock, if quoteType == "ETF" → ETF, if quoteType == "MUTUALFUND" → Mutual Fund. If the asset is Stock, use tool "quote_summary" with its module "assetProfile" to retrieve asset's "sector" and "industry" and concatenate their values to populate the Category field, e.g. if "industry": "Software - Infrastructure", and "sector": "Technology", then Category = "Technology, Software - Infrastructure". If the asset is ETF,  use tool "quote_summary" with its module "assetProfile" to retrieve asset's "category" to populate the Category field. 

The Tools/Update Prices command uses Yahoo Finance MCP server's get_quote tool to update prices for all portfolio assets. For all unique symbols with a positive total quantity based on the Ledger table (no join to Assets needed since Prices no longer carries a Type column), it uses get_quote tool and inserts new record in the Price table with the current date. The latest price is taken as `regularMarketPrice ?? regularMarketPreviousClose` for all asset types. Price value should be rounded to the two decimal points before updating the Prices table. In order to handle server request throttling, sleep 0.1 seconds after each get_quote tool invocation. After the progress dialog closes, if any assets failed (network error or price field absent from response), a failure summary dialog is shown listing each failed symbol and its error reason (`Dialogs.alertHtml` with a scrollable list). `App.ensureAsset()` returns `null` (asset already existed), `{ ok: true }` (success), or `{ ok: false, reason }` (failure) so callers can report failures. The shared helper `_showResultDialog(summary, failures, title)` in `app.js` renders a plain alert when there are no failures, or an HTML list when there are.

---

## Development Notes

- All dependencies (`sql.js`, WASM binary) must be stored locally under `lib/` — no CDN fetches, as `file://` protocol makes cross-origin requests unreliable
- Do not introduce a build step, bundler, or package manager — the app must remain a directly openable HTML file
- Keep all JS in `index.html` or as plain `.js` files loadable via `<script src="">` — no ES module imports from `file://` unless Chromium flags explicitly permit them
- Prefer simplicity: this is a single-user local tool, not a web service
- All JS objects are globals (no ES module export/import); load order in `index.html` is the dependency order
- Timestamps in Prices and Ledger are stored as `YYYY-MM-DD HH:MM:SS` (local time) using the global helper `_nowTs()` in `app.js`; the Transactions form uses `<input type="datetime-local">` and converts via `.replace(' ','T')` ↔ `.replace('T',' ')`. Existing databases are migrated automatically on load via the private `_migrate()` helper in `db.js`, which runs before `SCHEMA_SQL`. Current migrations: rename `Date → Timestamp` in Prices and Ledger; add `Notes TEXT` column to Assets; add `Theme TEXT` column to Assets; drop `Type` column from Prices.
- Notify open tabs of data changes via `App.onDataChanged()` — refreshes all open tabs whose `refresh` callback opted into auto-refresh. `App.Tabs.open(id, label, buildFn, opts)` accepts `opts.autoRefresh` (default `true`); tabs passing `autoRefresh: false` (currently only Reports tabs) still refresh via `refreshCurrent()` (the tab-strip Refresh button, when active) but are skipped by `refreshAll()`
- No welcome screen; app starts immediately with a Portfolio tab and either a loaded or new empty database
- `App.Tabs.closeAll()` + `PortfolioTab.open()` = `_resetTabs()` — called on File > New and File > Open
- `_lastFileHandle` (`FileSystemFileHandle`) is persisted to and loaded from IndexedDB (`PortfolioApp` / `handles` / `'dbFile'`) across Chromium restarts; updated on every successful Open or Save; on first launch with URL params it is bootstrapped by calling `showOpenFilePicker` once (silently skipped if Chromium requires a user gesture); File > Open uses `showOpenFilePicker()` with `id: 'portfolio-db'` and `startIn: _lastFileHandle` when available; File > Save uses `showSaveFilePicker()` with `id: 'portfolio-db'`, `suggestedName` pre-filled from `_lastPrefix + timestamp`, and `startIn: _lastFileHandle` when available; File > Import uses `id: 'portfolio-import'` (separate MRU folder) and `startIn: App._lastImportHandle` — note: the File System Access API does not support starting pickers at arbitrary path strings; folder memory is established via handles only
- Saved files should go into the `data/` subfolder so `portfolio.bat` auto-detects them on next launch
- Transactions tab supports multiple simultaneous instances; form element IDs are scoped per tab using `ft-<tabId>-<fieldName>`; access via `fld(inst, name)` helper — never use bare `getElementById('ft-*')` in that module
- Portfolio tab also supports multiple simultaneous instances (one per account); same `ft-<tabId>-<fieldName>` scoping applies
- Window close protection uses `beforeunload` with `e.preventDefault()` + `e.returnValue = ''`; modern Chromium ignores any custom message string and shows its own native dialog — custom dialogs in `beforeunload` are not supported
- Application version is defined as the global constant `APP_VERSION = '1.1'` at the top of `app.js`; displayed as `v{version}` prefix in the status bar (e.g. `v1.1 portfolio_202606142107.db`)
- Change counter: `DB.run()` increments `_changeCount` for every INSERT/UPDATE/DELETE; `DB.setChangeListener(fn)` registers a callback fired after each write; `DB.getChangeCount()` / `DB.resetChangeCount()` manage the count; `app.js` registers a listener that calls `_renderStatus()` to append `(+N)` to the status bar; count resets to 0 on `createNew()`, `loadFromBytes()`, and after a successful save
- `DB.exportBytes()` returns the in-memory database as a `Uint8Array` for writing to a file
- Tab IDs: singleton tabs use fixed IDs (`acc`, `ast`, `prc`); multi-instance tabs use auto-incremented IDs (`prt-1`, `prt-2`, …; `txn-1`, `txn-2`, …; `qry-1`, `qry-2`, …; `rpt-1`, `rpt-2`, …; `aly-1`, `aly-2`, …). `_stubTab()` in `app.js` is unused dead code — all three Analyze menu commands are now implemented, none remain stubs.
- Account-picker dialogs (`_selectAccountDialog()` in `tab-reports.js` and `tab-analysis.js`): a `<select>`'s `.value` is always a string, but every other `accountId` in the app comes from a `DB.query()` result and is a genuine number. Both dialogs explicitly `Number(...)` the selected value before resolving, for type consistency with every other `accountId` flow. **Note**: this was initially (incorrectly) suspected as the cause of `Report > Account performance` showing an empty table for non-default accounts — it wasn't; that turned out to be the Tabulator virtual-DOM redraw issue described below. The `Number()` coercion is still worth keeping (removes a real, if harmless, type inconsistency) but doesn't fix a rendering bug on its own.
- **Reports tab Tabulator first-render bug**: `tab-reports.js`'s table is the only Tabulator instance in the app built with `data: []` and populated later via `.replaceData()` after an async gap (the YTD/QTD baseline-price lookups) — every other Tabulator tab gets real data synchronously at construction. Everything *outside* Tabulator (the plain-HTML summary strip below it) rendered correctly on first load, isolating the bug to Tabulator specifically; the tab-strip Refresh button "fixed" it by triggering a second, later `replaceData()` call. A `redraw(true)` immediately after the first `replaceData()` was tried first and did **not** fix it, which ruled out a virtual-DOM row-height/sizing miscalculation as the cause. The actual cause: `new Tabulator(...)` returns before the table has finished its own internal build (DOM/column setup) — calling `.replaceData()` before that completes is a documented Tabulator race, and `_build()` was doing exactly that (kicking off `_computeReport()`, and therefore the eventual `replaceData()`, immediately after construction with no guarantee Tabulator was actually ready). Fix: `_build()` now defers the initial `_computeReport(id, accountId)` call to Tabulator's `tableBuilt` event (`table.on('tableBuilt', () => _computeReport(id, accountId))`) instead of calling it right after `new Tabulator(...)`, guaranteeing the table is genuinely ready before any data is loaded into it. The `redraw(true)` after `replaceData()` in `_computeReport()` was left in place as a harmless defensive measure but is not what fixes this.
- Transaction hash format: `${accountId}|${symbol}|${quantity}|${price}_${Math.abs(hash).toString(36)}` — used as the `Transaction_Hash` primary key for deduplication
- `App._lastImportHandle` is stored on the `App` object (not a top-level variable) so `import.js` can access it
- `YahooFinance` is a global IIFE in `app.js` with methods `getQuote(symbol)`, `getQuoteSummary(symbol, module)`, and `getChart(symbol, period1, period2, interval = '1d')` (wraps the MCP `get_chart` tool; used by the Reports tab for YTD/QTD baseline prices); it uses the MCP streamable-HTTP transport with an `initialize` → `notifications/initialized` → `tools/call` flow; the session ID is maintained across calls in the same page load. The underlying MCP server (`yahoo-finance-mcp`) exposes four tools total — `get_quote`, `search`, `get_chart`, `quote_summary` — of which `search` is not currently used by the app.
- `Dialogs` is a global IIFE in `dialogs.js`; uses `#modal-backdrop` + `#modal-container` elements; never call `Dialogs.alert/confirm/prompt` from inside another `Dialogs.custom()` handler — use inline error elements instead; `Dialogs.alertHtml(bodyHtml, title)` accepts pre-sanitized HTML for the body (use when a formatted list is needed — callers must escape values with `_esc()` before interpolating)
- Analyze tabs (Portfolio, Accounts, Assets under the Analyze menu) are currently stubs showing "Coming soon" — content not yet defined
- MCP call logging: every JSON response from `YahooFinance` is logged to `logs/mcp.log` in the browser's Origin Private File System (OPFS) — no user interaction required; the file is overwritten (truncated) at each app launch. Access via **Tools > Download MCP log…** (downloads as `mcp.log`) or via Chromium DevTools → Application → Storage → Origin private file system → `logs/mcp.log`. In-memory log array `_mcpLog` accumulates entries for the current session.
- Tab panel visibility: inactive `.tab-panel` elements use `visibility: hidden` (not `display: none`) so that Tabulator's virtual renderer retains layout and `scrollTop` is preserved across tab switches. All panels are `position: absolute; inset: 0` stacked inside `#tab-content`; only the active panel gets `visibility: visible; pointer-events: auto`.
- File > Export (`cmdExport` in `app.js`): queries the same portfolio aggregation as the Portfolio tab, joins with Assets for metadata columns, computes `%Portfolio` in JS, and writes a CSV via `showSaveFilePicker` with `id: 'portfolio-export'`.

---


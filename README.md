# Portfolio Tracker

A personal investment portfolio tracker that runs entirely on your local machine. No server, no cloud, no account required. Your data stays in a SQLite file on your own disk.

---

## Requirements

- A Chromium browser placed under the `chrome/` folder inside the application directory (see [Installation](#installation))
- Internet access only when fetching live prices from Yahoo Finance — all other functionality works offline

---

## Installation

1. Download or clone this repository to a local folder, e.g. `C:\Portfolio` on Windows or `~/Portfolio` on macOS.

2. Download a standalone Chromium build and place it inside the `chrome/` subfolder:

   **Windows** — extract the Chromium ZIP so that `chrome\chrome.exe` exists inside the application folder.

   **macOS** — place the Chromium app so that `chrome/Chromium.app` exists, then make the launcher executable:
   ```
   chmod +x portfolio.sh
   ```

3. The `data/` subfolder is created automatically on first launch. No other setup is needed.

---

## Launching the Application

**Windows**
```
portfolio.bat
```

**macOS**
```
./portfolio.sh
```

Both launchers start Chromium with the required flags, scan the `data/` folder for the most recent database file, and open it automatically. On the very first launch a new empty database is created.

**Custom data folder** — pass a path as the first argument to store your database elsewhere:
```
portfolio.bat  D:\MyInvestments
./portfolio.sh ~/Documents/MyInvestments
```

---

## First-Time Setup

When you launch Portfolio Tracker for the first time there is no data yet. The recommended setup order is:

1. **Add accounts** — open View > Accounts, click New, fill in Account (the account number or identifier) and Name, then click Accept.
2. **Import transactions** — use File > Import to load a CSV export from your broker (see [Importing Transactions](#importing-transactions)), or enter transactions manually from the Portfolio tab.
3. **Update prices** — use Tools > Update Prices to fetch current market prices from Yahoo Finance.

---

## Saving Your Data

All changes are held in memory until you explicitly save. Use **File > Save** — the application writes a new timestamped file (e.g. `portfolio_202506241530.db`) to your data folder and keeps the previous file untouched as a backup. The status string at the top right corner shows how many unsaved changes have accumulated since the last save (`+N`).

To open a previously saved file use **File > Open**.

**Your data is never saved automatically.** Save before closing the window.

---

## The Interface

The application is organized as a **menu bar** at the top and a **tab strip** below it. Tabs open on demand and stay open until you close them. The **Refresh** button at the right end of the tab strip reloads data for the currently active tab.

Each tab is split into two zones:
- **Table zone** (upper ~75%) — a sortable, filterable data table
- **Form zone** (lower ~25%) — a detail/edit form linked to the selected table row

Click any column header to sort; click again to reverse; click a third time to clear the sort. Type in any header filter box to filter rows by that column.

---

## Tabs

### Portfolio

The default tab, opened automatically on launch. Shows all holdings aggregated by symbol.

| Column | Description |
|---|---|
| Symbol | Asset ticker — click to open a Transactions tab for that symbol |
| Quantity | Net shares owned (sum of all buy/sell transactions) |
| Price | Most recent price on record |
| Value | Quantity × Price |
| Gain / Loss | Value minus cost basis (sum of quantity × purchase price across all transactions) |
| % Gain/Loss | Gain/Loss as a percentage of cost basis |
| % Portfolio | This position's share of total portfolio value |

The **Total Portfolio Value** is displayed at the top of the form zone.

**Entering a transaction directly** — type in the input box and press Enter. Supported formats:

```
+100 AAPL @ 182.50          buy 100 AAPL at 182.50
-50 MSFT @ 420.00           sell 50 MSFT at 420.00
bought 200 NVDA at 875      sold 100 TSLA at 245
sell all MSFT @ 420.00      buy all AAPL at 182.50
```

`all` means all shares currently owned for that symbol (scoped to the current account if the tab is account-specific). A confirmation dialog lets you review and adjust the details before committing.

**Per-account view** — click an account name or number in the Accounts tab to open a Portfolio tab filtered to that account only.

---

### Accounts

Shows all active brokerage accounts with their computed balance, cash, and last-updated date.

- Click **Account** or **Name** to open a Portfolio tab for that account.
- Select a row to edit the account details in the form below. Fields: Account, Name, Cash, Currency, Active.
- Click **New** to add an account.
- Press **Delete** with a row selected to deactivate the account (only allowed if it has no transactions).

**Balance** is computed as: assets value at latest known prices + cash balance. It refreshes automatically whenever price or transaction data changes.

---

### Assets

Shows all active assets (stocks, ETFs, mutual funds) with their type, category, and notes.

- Click **Symbol** to open a Transactions tab for that asset.
- Select a row to edit the asset details in the form below. Fields: Symbol (read-only), Description, Notes, Type, Category.
- Click **New** to add an asset manually. Description, Type, and Category are populated automatically from Yahoo Finance when a new asset is created via import or transaction entry.
- Press **Delete** with a row selected to deactivate the asset (only allowed if it has no transactions or price records).

---

### Prices

Shows the most recent price on record for each asset.

- Click **Symbol** to open a Transactions tab for that asset.
- Select a row, then click **Update** to fetch the current price from Yahoo Finance without writing it to the database yet. Review the value, then click **Accept** to save it.
- You can also type a price directly in the Price field and click **Accept**.

---

### Transactions

Shows individual ledger entries. Multiple Transactions tabs can be open at once — one per symbol or account.

- Tabs opened from the Portfolio tab are filtered by symbol (and account if in a per-account view).
- Tabs opened from the Accounts tab are filtered by account.
- Tabs opened from the Assets tab are filtered by symbol.
- Select a row to edit its details in the form. Click **Accept** to save changes.
- Click **New** to add a transaction manually.
- Click **Delete** (or press the Delete key) to invalidate the selected transaction.

Columns: Account, Name, Type (Buy/Sale), Timestamp, Symbol, Quantity, Price, Value.

---

### Query

Opens a free-form SQL query tab. Multiple Query tabs can be open simultaneously.

Type any SQL in the text area and press **Run** or **Ctrl+Enter**. Results appear in a table below. Useful for ad-hoc analysis or data inspection.

Available tables: `Accounts`, `Assets`, `Prices`, `Ledger`, `Mappings`.

Example queries:
```sql
-- All transactions for a symbol
SELECT * FROM Ledger WHERE Symbol = 'AAPL' AND Valid = 1 ORDER BY Timestamp;

-- Current holdings with latest prices
SELECT l.Symbol, SUM(l.Quantity) AS Qty, p.Price
FROM Ledger l
JOIN (SELECT Symbol, Price FROM Prices WHERE Valid=1
      GROUP BY Symbol HAVING Timestamp = MAX(Timestamp)) p
  ON l.Symbol = p.Symbol
WHERE l.Valid = 1
GROUP BY l.Symbol
HAVING SUM(l.Quantity) > 0;
```

---

## Importing Transactions

Use **File > Import** to load a CSV export from your broker.

### Step 1 — Map columns

A **CSV Column Mapping** dialog opens. For each transaction field, choose the matching column from your CSV file:

| Field | Description |
|---|---|
| Account | Account number/identifier |
| Name | Account name |
| Date | Transaction date |
| Symbol | Ticker symbol |
| Description | Asset description |
| Quantity | Number of shares (positive = buy, negative = sell) |
| Price | Price per share |
| Cost Basis | Total cost basis — used to compute price as `Cost Basis ÷ Quantity` when Price is not available |
| Currency | Currency code (defaults to USD if not mapped) |

Symbol, Quantity, and at least one of Price or Cost Basis must be mapped. All other fields are optional.

The **Extract Pattern** column accepts an optional regular expression. If provided, the first capture group (or the full match if no group) is extracted from the raw column value before it is used. This is useful for stripping prefixes, suffixes, or pulling a code from a longer string.

Mappings are remembered and pre-populated the next time you import from a file with the same column names.

### Step 2 — Select account (if needed)

If no Account or Name column is mapped, you will be prompted to select the account that all imported rows belong to.

### Step 3 — Asset enrichment

Before rows are inserted, any symbols not already in the Assets table are looked up on Yahoo Finance (with a 0.5 s delay between calls to avoid throttling). Full name, type, and category are populated automatically. A progress dialog shows the status. Any failures are reported in a summary when the dialog closes.

### Step 4 — Import

Transactions are inserted into the Ledger. Duplicate rows (same account, symbol, quantity, and price) are silently skipped. The Cash balance of each affected account is updated accordingly. A summary shows how many rows were imported and how many were skipped.

---

## Updating Prices

Use **Tools > Update Prices** to fetch current prices for all holdings with a positive net quantity. The app queries Yahoo Finance for each symbol with a 0.5 s delay between requests. A progress dialog tracks the status. Any failures are listed in a summary dialog when the update finishes.

Individual prices can also be updated from the Prices tab using the **Update** button in the form.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Delete | Deactivate/invalidate the selected record (with confirmation) |
| Ctrl+Enter | Run query (Query tab only) |
| Enter | Submit transaction input (Portfolio tab form) |

---

## Data Storage

Each save writes a new file named `portfolio_YYYYMMDDHHMM.db` to your data folder. Previous files are never deleted, so your entire save history serves as an automatic backup. To restore an earlier version, use **File > Open** and select the desired file.

The database is a standard SQLite file and can be opened with any SQLite tool (e.g. DB Browser for SQLite) for inspection or manual edits outside the application.

---

## Additional Notes

The Reports tab summary strip shows three value-weighted averages, each computed with the same shape of formula but
different inputs:

Common pattern: for each average, sum a "base value" and a "current value" across the relevant assets, then:
Avg% = (ΣCurrentValue − ΣBaseValue) / ΣBaseValue × 100
This is a portfolio-level weighted average, not a simple average of each row's individual percentage — a $50k position
and a $500 position both count proportionally to their size, so a big holding dominates the average the way it
should, rather than every symbol counting equally.

Total — gain/loss since acquisition:
- Base value per asset = CostBasis = Σ(Quantity × Price paid) across that asset's Ledger transactions
- Current value per asset = Value = Quantity × current Price
- Summed across every asset in the report (cost basis is always known locally — no external lookup needed)
- avgTotal = (ΣValue − ΣCostBasis) / ΣCostBasis × 100

YTD / QTD — gain/loss since a baseline date:
- Base value per asset = Quantity × BaselinePrice, where BaselinePrice is that asset's price on the first market day
of the current year (YTD) or current quarter (QTD) — either read from a cached Prices row or fetched once via
get_chart and cached for next time
- Current value per asset = the same Value as above
- Summed only across assets that have a baseline for that period — an asset with no baseline (new listing, delisted,
failed lookup) is excluded from that specific average rather than counted as 0%
- avgYTD/avgQTD = (Σcurrent − Σbase) / Σbase × 100

So Total is comprehensive (every asset always contributes), while YTD/QTD can each silently exclude a different subset
of assets depending on baseline availability — which is why it's possible, if a baseline lookup fails for a large
holding, for YTD/QTD to diverge more than you'd expect from Total.
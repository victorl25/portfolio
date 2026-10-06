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
2. **Import your positions** — use **File > Import holdings** to load a positions export from your broker (see [Importing Holdings](#importing-holdings-positions)). This sets each account's holdings, cost basis and cash.
3. **Import transactions** — use **File > Import transactions** to load your broker's transaction history (trades, dividends, interest, fees, options), or enter transactions manually from the Portfolio tab.
4. **Update prices** — use Tools > Update Prices to fetch daily closing prices from Yahoo Finance.

> **Version 2 databases.** Version 2 cannot open databases created by version 1.x. Such a file is refused with a message and the app starts with a new, empty database; set up the accounts again and import your positions. Version 1.x files are left untouched and can still be opened with version 1.1.

---

## Saving Your Data

All changes are held in memory until you explicitly save. Use **File > Save portfolio** — the application writes a new timestamped file (e.g. `portfolio_202506241530.db`) to your data folder and keeps the previous file untouched as a backup. The status string at the top right corner shows how many unsaved changes have accumulated since the last save (`+N`).

To open a previously saved file use **File > Open portfolio**.

**Your data is never saved automatically.** Save before closing the window.

---

## The Interface

The application is organized as a **menu bar** at the top and a **tab strip** below it. Tabs open on demand and stay open until you close them (every tab has a × button). The **Refresh** button at the right end of the tab strip reloads data for the currently active tab.

Each view tab is split into two zones:
- **Table zone** (upper ~75%) — a sortable, filterable data table
- **Form zone** (lower ~25%) — a detail/edit form linked to the selected table row

Click any column header to sort; click again to reverse; click a third time to clear the sort. Type in any header filter box to filter rows by that column.

---

## How Version 2 Tracks Your Portfolio

- **Transactions** record everything that happens in an account: trades, dividends, interest, fees, taxes, deposits and withdrawals, option trades, splits and spin-offs. Each transaction has an **Amount** — its effect on the account's cash (positive = received, negative = paid).
- The **Ledger** holds one current entry per account + symbol with the quantity held and the remaining **cost basis**. Each trade updates the entry: buys add their cost (including fees), sales reduce the cost proportionally (average cost). The previous entry is kept (inactive) as history.
- **Options** are tracked the same way, per account + option symbol (e.g. `NVDA20270115C360` = NVDA, 2027-01-15, call, strike 360). Options are listed but not included in the portfolio value.
- **Cash** in each account changes by the Amount of every cash-affecting transaction.
- **Prices** are daily closing prices.

---

## Tabs

### Portfolio

The default tab, opened automatically on launch. Shows your current positions (from the Ledger) aggregated by symbol.

| Column | Description |
|---|---|
| Symbol | Asset ticker — click to open the **Holdings** breakdown: one row per account with quantity, average cost, cost basis, value and gain/loss |
| Quantity | Shares held |
| Price | Most recent price on record |
| Value | Quantity × Price |
| Gain / Loss | Value minus cost basis |
| % Gain/Loss | Gain/Loss as a percentage of cost basis |
| % Portfolio | This position's share of total portfolio value (including cash) |
| Action | **Analyze** — trend analysis report for the asset |

The **Total Value** is displayed at the top of the form zone.

**Entering a transaction directly** — type in the input box and press Enter. Prices are written with a `$` sign; a date (`YYYY-MM-DD`) is optional and defaults to today:

```
+100 AAPL $182.50                 buy 100 AAPL $182.50
-50 MSFT $420.00 2026-09-30       sell 50 MSFT $420.00
bought 200 NVDA $875              sold 100 TSLA $245
sell all MSFT $420.00             -2 NVDA20270115C360 $3.20   (sell 2 call contracts)
```

`all` means all shares currently held for that symbol (scoped to the current account if the tab is account-specific). A confirmation dialog lets you review and adjust the details before committing. Option amounts use the ×100 contract multiplier.

**Per-account view** — click an account name in the Accounts tab to open a Portfolio tab filtered to that account only.

---

### Accounts

Shows all active brokerage accounts with their computed balance, cash, and last-updated date.

- Click **Name** to open a Portfolio tab for that account.
- Select a row to edit the account details in the form below. Fields: Account, Name, Cash, Currency, Active.
- Click **New** to add an account.
- Press **Delete** with a row selected to deactivate the account (only allowed if it has no transactions).

**Balance** is computed as: holdings value at latest known prices + cash balance.

---

### Assets

Shows all active assets (stocks, ETFs, mutual funds) with their type, theme, category and latest note.

- Click **Symbol** to open a Transactions tab for that asset.
- Select a row to edit the asset in the form below. Fields: Symbol (read-only), Description, Note, Type, Category, Theme.
- Notes keep their history: entering a new or changed note adds it to the history. Click the **Notes** button in the Action column to see all notes of an asset in chronological order.
- Click **New** to add an asset manually. Description, Type, and Category are populated automatically from Yahoo Finance when a new asset is created via import or transaction entry.
- Press **Delete** with a row selected to deactivate the asset (only allowed if it has no transactions, holdings or price records).

---

### Prices

Shows the most recent daily price on record for each asset.

- Click **Symbol** to open a Transactions tab for that asset.
- Select a row, then click **Update** to fetch the current price from Yahoo Finance without writing it to the database yet. Review the value, then click **Accept** to save it as today's price.
- You can also type a price directly in the Price field and click **Accept**.

---

### Transactions

Shows the recorded transactions. Multiple Transactions tabs can be open at once — one per symbol or account.

Columns: Date, Account, Type, Category, Symbol, Quantity, Price, Amount, Description.

- Select a row to edit it in the form. Click **Accept** to save changes. If the edited transaction is not the latest one for that account + symbol, it is applied on top of the current ledger entry and you are warned that the ledger may need to be rebuilt.
- Changing the Amount changes the account's cash by the difference.
- Click **New** to add a transaction manually (choose its Effect and Category; leave Amount blank to compute it from Quantity × Price).
- Click **Delete** (or press the Delete key) to delete the selected transaction; its Amount is reversed on the cash balance. If the ledger was built from it, you are warned that the ledger may need to be rebuilt.

---

### Ledger

Shows the current ledger entries (one per account + symbol). Positions that were sold down to zero are not shown.

- Select a row to edit its Quantity or Cost Basis and click **Accept** (e.g. to fix a position after a merger).
- Click **Deactivate** (or press Delete) to remove an entry, for example a closed position.
- Click **New** to add an entry for an account and symbol.
- Click **Rebuild** to recalculate the selected account's ledger and options by replaying all of its transactions in date order. This discards manual edits.

---

### Options

Shows open option positions (not expired, quantity not zero): Account, Symbol, Asset, Expiration Date, Strike, Quantity. Negative quantities are written (sold) contracts. Entries can be edited or deactivated like ledger entries.

---

### Rules

Shows the import rules used by **File > Import transactions** to recognize your broker's Action texts. Rules are checked in Order; the first match wins.

| Field | Meaning |
|---|---|
| Pattern | Regular expression matched against the Action text, e.g. `^(YOU BOUGHT)` |
| Case Sensitive | Whether letter case must match |
| Symbol Required | The rule only applies to rows that have a Symbol |
| Category | Category given to the transaction (`Asset` = Equity or Option, based on the symbol) |
| Effect | **Ignore** (skip the row), **Trade** (buy/sell: updates holdings and cash), **Cash** (cash only, e.g. dividends, interest, fees), **Other** (recorded only), **Distribution** (adds shares, no cash), **Split** (replaces the share quantity, no cash), **Merger** (recorded only; fix the ledger by hand), **Reinvestment** (treated as a Trade) |
| Sign | Forces the Amount positive (+1) or negative (−1) |

New databases come with rules for Fidelity and Schwab exports. Add a rule whenever an import reports unrecognized rows, then import the same file again — only the previously unrecognized rows are added.

---

### Query

Opens a free-form SQL query tab. Multiple Query tabs can be open simultaneously.

Type any SQL in the text area and press **Run** or **Ctrl+Enter**. Results appear in a table below.

Available tables: `Accounts`, `Assets`, `Notes`, `Prices`, `Transactions`, `Ledger`, `Options`, `Mappings`, `Rules`, `Info`, and the views `v_holdings` and `v_latest_price`.

Example queries:
```sql
-- All transactions for a symbol
SELECT * FROM Transactions WHERE Symbol = 'AAPL' AND Valid = 1 ORDER BY Date;

-- Current holdings with latest prices
SELECT h.Symbol, h.Quantity, h.Cost_Basis, p.Price, h.Quantity * p.Price AS Value
FROM v_holdings h LEFT JOIN v_latest_price p ON p.Symbol = h.Symbol;

-- Dividends received this year
SELECT Symbol, SUM(Amount) FROM Transactions
WHERE Category = 'Dividend' AND Valid = 1 AND Date >= '2026-01-01' GROUP BY Symbol;
```

---

## Importing

Both imports start the same way: choose a CSV file, then map its columns.

**Column mapping.** For each field, choose the matching column from your CSV file. The optional **Extract Pattern** is a regular expression; if provided, the first capture group (or the full match) is used. Mappings are remembered per file layout (the set of column headers), so files from different brokers keep separate mappings. Blank lines before the header and trailing notes or disclaimers after the last row are ignored.

If no Account or Name column is mapped, you are asked to select the account for the whole file.

New assets are looked up on Yahoo Finance (name, type, category) after the import. At the end you are offered to update prices.

### Importing Holdings (positions)

**File > Import holdings** loads a positions file (holdings as of one date). Map at least Symbol, Quantity, and Price or Cost Basis; map **Current Value** too so cash rows are valued correctly.

- The file **replaces** the account's holdings: each position's quantity and cost basis are set from the file; positions no longer in the file are removed.
- Rows for `SPAXX**`, `USD***` or `Cash…` are the account's cash: the cash balance is set to their total Current Value (or Quantity, or Cost Basis, when Current Value is not available). If the file has no cash rows, the cash balance is not changed.
- The date of the snapshot is taken from a mapped Date column, or you are asked for it.
- Option positions keep their total cost basis; the recorded unit price is per underlying share (cost basis ÷ (contracts × 100)).

### Importing Transactions

**File > Import transactions** loads a transaction history. Map at least Date, Action, Symbol, Quantity, and Amount or Price.

- Each row's Action is interpreted by the [import rules](#rules). Trades update the ledger (or options) and cash; dividends, interest, fees, taxes, deposits and withdrawals change cash; journal entries are skipped.
- Rows are processed in date order, earliest first.
- Transactions already recorded (same account, date, symbol, quantity, price and amount) are skipped, so importing an overlapping file again is safe.
- A summary shows how many rows were imported, ignored by the rules, skipped as duplicates, and unrecognized (listed so you can add rules), plus any transactions dated before existing ones for the same position (the ledger may then need a rebuild).

---

## Updating Prices

Use **Tools > Update Prices** to fetch **daily closing prices** for all current holdings: from one year ago (or from the last stored price) up to today. A progress dialog tracks the status; rate-limited requests are retried automatically. Any failures are listed in a summary dialog when the update finishes.

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
- Base value per asset = CostBasis = the asset's remaining cost basis from the Ledger
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
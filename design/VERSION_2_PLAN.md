# Version 2 — Refactoring Plan

Status: **Implemented on branch `v2` (uncommitted), 2026-10-05** — Phases 1–7 done; the Deferred items are not implemented.
Verification so far is automated only (`python tests/run_tests.py`, QuickJS + Python sqlite3 harness in `tests/`: schema/seed checks, 75 engine checks, 31 import checks on both example CSVs, 12 Update Prices checks (start date, upsert, 429 retries), script-load and entry-parser checks, and compilation of all 100 SQL statements against the v2 schema). The manual UI pass in Chromium is still to be done.
Spec: `VERSION_2.md` (updated 2026-10-05 with the answers from the previous plan review). Test data: `examples/transactions1.csv` (Fidelity), `examples/transactions2.csv` (Schwab).

---

## 1. Decisions (all reflected in VERSION_2.md)

**Database**

| Topic | Decision |
|---|---|
| v1 databases | Not migrated. A file without an `Info` table is refused with an explanation, and the app continues with a new empty database. |
| Schema version | `Info.Schema_Version` (text, `'2.0'`), one row. Later versions add upgrade steps between 2.x versions. |
| Mappings | Stored per `Header_Hash` of the CSV header row (BOM stripped, names trimmed). Unique per Header_Hash + Source. |

**Transactions**

| Topic | Decision |
|---|---|
| Columns | Type: Cash \| Trade \| Record \| Other. Category: Equity \| Option \| Dividend \| Fee \| Interest \| Margin \| Tax \| Transfer \| Other. **Effect**: Trade \| Cash \| Other \| Distribution \| Split \| Merger \| Reinvestment \| Snapshot. Amount is the signed cash effect. Description comes from Action. `Hash` = hash(account, date, symbol, qty, price, amount). |
| Edit | If the active Ledger/Options entry references the edited transaction → it's set inactive, and a new entry = its Parent + the edited transaction. Otherwise → the edited transaction is applied in full, with a warning that a rebuild may be needed. |
| Cash on edit | The account's cash changes by **ΔAmount** (new − previous). |
| Delete | Sets `Valid = 0`. If any Ledger/Options entry (active or inactive) references the transaction → warn that a rebuild may be needed, and ask for confirmation. The Ledger and Options are not changed automatically. **Cash: the deleted Amount is subtracted from the balance.** |
| Views | The current Transactions tab is repurposed as the **Ledger view** (View > Ledger). A **new Transactions view** (View > Transactions) is built on the Transactions table; symbol links in Portfolio, Assets and Prices open it. |

**Ledger and Options**

| Topic | Decision |
|---|---|
| Ledger updates | One active entry per account + symbol. New entry = Parent + transaction. The old entry is set inactive, and the new one has `Parent_ID` and `Transaction_ID`. |
| Ledger arithmetic | Buy: q+Δq, C+(−Amount). Sell: q+Δq, C×(q+Δq)/q. Crossing 0: the closing part is proportional, and the opening part starts a new basis at the transaction's price. Distribution: q+Δq, C (0 if new). Split: Δq replaces q, C kept (0 if new). Snapshot: quantity and cost from the file. |
| Zero quantity | Stays active (a later transaction for the pair supersedes it). Hidden from Portfolio, the Ledger and Options views, Update Prices and reports. |
| Rebuild | Per **account**, on request from the Ledger view, with a warning that manual edits are discarded. Replays the account's valid transactions in date order. Also recalculates Options. |
| Options | Same model and arithmetic as the Ledger. `Cost_Basis` is the total for the lot (premium paid +, received −). Not included in portfolio value. |

**Import rules and processing**

| Topic | Decision |
|---|---|
| Rules | Rule_Order, Pattern, Case_Sensitive, **Symbol_Required**, Category (`Asset` resolves to Equity or Option), Effect (Ignore \| Trade \| Cash \| Other \| Distribution \| Split \| Merger \| Reinvestment), Sign, Description, Active. A rule that requires a symbol is skipped for rows with an empty Symbol. |
| Seeded rules | 21 rules, including **45** (cash-like REINVESTMENT → Other), **112 ASSIGNED** and **114 EXERCISED** (both Effect **Other**: recorded only, because Fidelity reports the resulting share trade as a separate YOU SOLD/YOU BOUGHT row). |
| Row preparation | Discard empty rows before the header, then trailing rows (column count ≠ header, or Date doesn't parse). Then sort **chronologically, earliest first**, and process in that order. |
| Bad split row | The −1000 HON row has an empty Symbol in a correct file. Rule 80 requires a symbol, so the row is reported as Unrecognized. No special warning is needed. |
| Import Holdings | The snapshot **replaces** the account's state: quantity and cost are **set** for each symbol in the file, and entries for symbols missing from the file are deactivated. Cash rows (`^SPAXX(\*+)`, `^USD(\*+)`, `^Cash`, valued by Current Value, else Quantity, else Cost Basis) set the balance; the Cash transaction's Amount = total − current cash. |
| Import summary | Imported / Ignored / Skipped as duplicates / Unrecognized (listed), plus a list of imported transactions that **predate** existing ones for the same account + symbol. |
| Update Prices | Only active Ledger entries with quantity ≠ 0. Fetches from **today − 1 year**, or from the day after the last stored Date, whichever is later. |
| 1Y data | If the price data a 1-year change or chart needs isn't available → show an error message. |
| Schwab cash value | Ignored for now (no `Value` mapping field). |
| Code porting | All code that reads the Ledger or Prices is updated for the new schema. |
| Portfolio entry | **`$price` only**; the v1 `@ price` form is no longer accepted. Optional date, e.g. `+1000 AAPL $350 2026-09-30`. |
| Deferred | **Realized gains report** and **portfolio history / trend chart** are not in 2.0. Transactions, the Ledger history and daily Prices are kept so both can be added later. |

---

## 2. Open questions

None at the moment. All questions from the previous reviews are answered and recorded in §1 and in VERSION_2.md.

---

## 3. Schema

```sql
Info ( Schema_Version TEXT NOT NULL )                       -- one row, '2.0'

Accounts  -- unchanged; Cash updated by Amount of Type Cash/Trade transactions (and ΔAmount on edit)

Transactions (
  Transaction_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Account_ID INTEGER NOT NULL,          -- idx
  Date TEXT NOT NULL,                   -- YYYY-MM-DD, idx
  Type TEXT NOT NULL,                   -- Cash|Trade|Record|Other
  Category TEXT NOT NULL,               -- Equity|Option|Dividend|Fee|Interest|Margin|Tax|Transfer|Other
  Effect TEXT NOT NULL,                 -- Trade|Cash|Other|Distribution|Split|Merger|Reinvestment|Snapshot
  Symbol TEXT, Quantity REAL DEFAULT 0, Price REAL, Amount REAL DEFAULT 0,
  Currency TEXT DEFAULT 'USD', Description TEXT,
  Hash TEXT,                            -- idx
  Timestamp TEXT NOT NULL,              -- idx
  Valid INTEGER DEFAULT 1
)

Ledger (
  Holding_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Parent_ID INTEGER, Transaction_ID INTEGER,   -- Transaction_ID NULL for manual edits
  Timestamp TEXT NOT NULL, Account_ID INTEGER NOT NULL, Symbol TEXT NOT NULL,
  Quantity REAL NOT NULL, Cost_Basis REAL NOT NULL, Currency TEXT DEFAULT 'USD',
  Active INTEGER DEFAULT 1
)  -- partial unique idx (Account_ID, Symbol) WHERE Active=1; idx Transaction_ID

Options (
  Option_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Parent_ID INTEGER, Transaction_ID INTEGER,
  Timestamp TEXT NOT NULL, Account_ID INTEGER NOT NULL,
  Symbol TEXT NOT NULL, Asset TEXT NOT NULL, Expiration_Date TEXT NOT NULL, Strike REAL NOT NULL,
  Quantity INTEGER NOT NULL, Cost_Basis REAL NOT NULL, Currency TEXT DEFAULT 'USD',
  Active INTEGER DEFAULT 1
)  -- partial unique idx (Account_ID, Symbol) WHERE Active=1; idx Transaction_ID, Expiration_Date

Notes    ( Note_ID INTEGER PRIMARY KEY AUTOINCREMENT, Symbol, Timestamp, Note )
Prices   ( Date, Symbol, Price, Currency, Valid )     -- UNIQUE(Symbol, Date); upsert
Mappings ( Mapping_ID, Header_Hash, Source, Target, Pattern )   -- UNIQUE(Header_Hash, Source)
Rules    ( Rule_ID, Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect, Sign, Description, Active )
Assets   -- Notes column removed; created after Transactions/Ledger (no FK)

VIEW v_latest_price (Symbol, Price, Date)
VIEW v_holdings     (Symbol, Quantity, Cost_Basis)    -- active Ledger, Quantity <> 0
```

The `Transaction_ID` indexes support the delete check ("is this transaction referenced by any Ledger/Options entry?").

Effect → Type and handling:

| Effect | Type | Ledger / Options | Cash |
|---|---|---|---|
| Trade, Reinvestment | Trade | apply arithmetic | + Amount |
| Cash | Cash | — | + Amount (Sign applied) |
| Other | Other | — | — |
| Distribution | Record | q + Δq, C kept | Amount forced to 0 |
| Split | Record | q = Δq, C kept | Amount forced to 0 |
| Merger | Other | — (fixed by hand) | Amount forced to 0 |
| Snapshot | Record | set q and C | — (cash via a separate Cash txn) |

`Ignore` rows are never stored.

---

## 4. Refactoring plan (phased)

Note: the phases were not independently shippable — after Phase 1 the v1 views could not read the new schema until Phases 3–6 ported them.

### Phase 1 — Schema and versioning
- `js/schema.js`: v2 DDL, indexes and views. `createNew()` inserts the `Info` row and the 21 seeded rules.
- `js/db.js`: replace `_migrate` with `_checkVersion(db)`.
  - No `Info` table, a version below 2.0, or a newer version → refuse with an alert. On File > Open the current database is kept; at startup a new empty database is created.
  - Versions are compared numerically per dotted part.
  - `SCHEMA_SQL` never runs on a refused file.
- `DB.transaction(fn)` (BEGIN/COMMIT/ROLLBACK) so that imports, edits and rebuilds are atomic.

### Phase 2 — Core engine (new `js/engine.js`, global `Engine`)
- **Rows and rules:**
  - `loadRules()`: active rules compiled to RegExp, in Rule_Order.
  - `classify(row)`: honors `Symbol_Required`, resolves `Asset` to Equity or Option, and returns `{status, category, effect, type}`.
  - `normalizeOption(sym)` / `parseOption(sym)`: Fidelity `-GLD260821C515` and Schwab `NVDA 01/15/2027 360.00 C` → `NVDA20270115C360`.
  - `resolveAmount(row, cls)`: the file's Amount, else `−qty × price` (× 100 for options). Applies Sign, and forces 0 for Distribution, Split and Merger.
  - `hash(...)`.
- **Applying changes:**
  - `applyTransaction(txn)`: implements the Effect table and the Ledger arithmetic (one function per Effect). Supersedes the entry, sets `Parent_ID`/`Transaction_ID`, and updates `Accounts.Cash` and `Last_Updated`.
  - `applySnapshot(accountId, holdings, cashTotal, date)`: Import Holdings replace logic.
  - `editTransaction(old, edited)`: Parent rebuild or in-full apply (returns a flag so the UI can warn), plus the ΔAmount cash change.
  - `deleteTransaction(txn)`: reference check → the caller confirms → `Valid = 0`, and the Amount is subtracted from the account's cash.
  - `rebuildAccount(accountId)`: for every symbol, replays valid transactions in date order from an empty start and supersedes the Ledger/Options entries.

### Phase 3 — Imports (`js/import.js` restructured)
- **Shared:**
  - CSV parsing with row preparation: drop empty pre-header rows and trailing rows, sort earliest first (reversing within a date for newest-first files).
  - `headerHash()`, and mapping lookup and upsert by Header_Hash.
  - A generalized mapping dialog, with `_resolveField` de-duplicated.
- **Import holdings…**
  1. Map the columns.
  2. Pick the account.
  3. Enter the snapshot date.
  4. Split off the cash rows.
  5. Run `applySnapshot` in `DB.transaction`.
  6. Create missing Assets (after the Ledger).
  7. Offer Update Prices.
- **Import transactions…**
  1. Map the columns.
  2. Pick the account.
  3. Take a snapshot of the hashes already stored.
  4. Classify the rows.
  5. For each row, in date order: compute Amount and hash, skip duplicates, insert, then run `applyTransaction`. Note when a row predates the pair's latest transaction.
  6. Create missing Assets.
  7. Show the summary (four counts, Unrecognized list, predating list).
  8. Offer Update Prices.
- Neither import writes to Prices.

### Phase 4 — Prices
- `cmdUpdatePrices`: symbols from `v_holdings`. For each, call `getChart` from the later of today − 1 year and the day after the last stored Date. Upsert daily closes. Keep the 429 retry, throttling and progress dialog.
- Prices tab: shows `Date`; a manual price is upserted for today.
- Reports tab: the YTD/QTD baseline is read from Prices by Date.
- An error message when 1Y data isn't available.

### Phase 5 — Views
- **Ledger** (`js/tab-transactions.js` → repurposed as `js/tab-ledger.js`, singleton, View > Ledger):
  - Shows active entries with quantity ≠ 0. Columns: Account, Symbol, Quantity, Price (= Cost_Basis / Quantity), Cost Basis.
  - The form edits Quantity and Cost Basis. Accept supersedes the entry (`Transaction_ID` NULL). A Deactivate button sets the entry inactive.
  - A **Rebuild account** button warns that manual edits are discarded, then runs `rebuildAccount`.
- **Transactions** (new `js/tab-transactions.js`, multi-instance, View > Transactions and the symbol links):
  - Columns: Date, Account, Type, Category, Symbol, Quantity, Price, Amount, Description.
  - The form edits the transaction: Accept → `editTransaction` with a warning when applied in full; Delete → `deleteTransaction` with confirmation when referenced.
- **Options** (new, singleton): `Active=1`, quantity ≠ 0, not expired. Edit and deactivate form like the Ledger view.
- **Rules** (new, singleton): columns Order, Pattern, Case Sensitive, Symbol Required, Category, Effect, Sign, Description.
  - The form has checkboxes for Case Sensitive and Symbol Required, and dropdowns for Category, Effect and Sign.
  - Accept validates the regex inline; Delete sets the rule inactive.
- **Portfolio:**
  - Built from `v_holdings` + `v_latest_price`, with gain/loss from `Cost_Basis` (remove `_computeCostBasisMap`).
  - Clicking a symbol opens a per-account **Holdings** drill-down.
  - The entry parser accepts `$price` only (the `@` form is removed), an optional date, and option symbols. Entries go through `applyTransaction` with Effect Trade.
- **Assets:** shows the latest note. Saving a note inserts a Notes row. The Notes action button opens the history popup.
- **Accounts:** Balance = holdings value + Cash. The delete check counts Transactions.
- **All tabs** are closeable, with an empty-state placeholder.
- **Menus:**
  - File: New/Open/Import holdings/Import transactions/Export/Save portfolio…
  - View: Ledger, Transactions, Options, Rules.
- **Export:** read from `v_holdings`; Notes = the latest note.

### Phase 6 — Reports
- Port Performance and Analysis by Theme to `v_holdings`.

### Deferred (not in 2.0)
- **Realized gains report:** can later be derived from the Ledger Parent chain (average cost) or computed FIFO from Transactions.
- **Portfolio history / trend chart:** daily value = holdings replayed from Transactions × daily Prices + cash (Σ Amount), net of Transfer flows.

### Phase 7 — Docs
- `CLAUDE.md`, `README.md`, `FEATURES.md`.

### Verification
A throwaway Node script in the scratchpad (not in the repo) loads `sql.js` + `schema.js` + `engine.js` and runs these checks:
- **Version:** a v1 file is refused. A new database has `Schema_Version '2.0'` and 21 rules.
- **Row preparation:** blank pre-header rows and Fidelity's trailing disclaimer rows are dropped, and the rows are processed earliest first.
- **Rules on `transactions2.csv`:** Credit Interest and Margin Interest (no symbol) match rules 140/150 and change cash.
- **Rules on `transactions1.csv`:**
  - JOURNALED rows are ignored.
  - SPAXX REINVESTMENT matches rule 45 (Other, no cash).
  - FOREIGN TAX is −976.85 (Tax).
  - The HON split with the +500 row gives quantity 500, cost kept. The −1000 row with an empty Symbol is Unrecognized.
  - The HONA distribution creates a new entry with cost 0 and no cash change.
  - An ASSIGNED/EXERCISED row is stored as Other and changes neither the Ledger, Options nor cash.
- **Ledger arithmetic:**
  - Buy 100 at $10 (+$5 fee) → q 100, C 1,005.
  - Sell 40 → q 60, C 603.
  - Sell 60 → q 0, still active and hidden from Portfolio.
  - Crossing zero opens a short at the trade price.
- **Options:** the NVDA closing buy (Amount −1,413.27) updates the option entry and cost.
- **Snapshot:** a re-import with one symbol fewer sets quantities, deactivates the missing symbol, and the cash transaction Amount = total − current cash.
- **Edits:**
  - Editing the latest transaction gives a new entry from the Parent.
  - Editing an older transaction applies it in full (warning flag set).
  - Editing an Amount changes cash by ΔAmount.
- **Delete:** a referenced transaction triggers the warning flag; Valid = 0, the Ledger is unchanged, and cash goes down by the deleted Amount.
- **Rebuild:** `rebuildAccount` after date-ordered imports matches the incremental chain; manual edits are gone.
- **Dedupe:** re-importing the same file gives Imported 0. Identical rows within one file are all kept.
- **Prices:** with no stored prices, Update Prices fetches from today − 1 year; with stored prices, from the day after the last one.
- **Entry parser:** `+100 AAPL $150 2026-09-30` parses; `+100 AAPL @ 150` is rejected with the usage message.
- **Predating:** importing an older file after a newer one lists the predating rows.
- Manual UI pass run by you (I won't launch the app).

# Tests

Automated tests for the data and logic layers of the app. They run the real `js/*.js` files outside the
browser in [QuickJS](https://pypi.org/project/quickjs/) (an embedded JavaScript engine), with a small
stand-in for sql.js's `SQL.Database` backed by Python's `sqlite3` — the same SQLite engine sql.js compiles
to WebAssembly. Nothing here is loaded by the app, and there is no build step.

## Setup (once)

```
python -m pip install --target tests/.pylib quickjs
```

`tests/.pylib/` is local only (git-ignored); the harness adds it to the Python path.

## Run

```
python tests/run_tests.py
```

| Suite | File | Covers |
|---|---|---|
| static checks | `check_static.py` | every `js/*.js` parses; every SQL statement in `DB.query`/`DB.run` compiles against the v2 schema |
| db | `test_db.js` | new database (Info, seeded rules), constraints and views, save/reload, schema version check (pre-2.0, newer, a real v1 file from `data/` when present), `DB.transaction` rollback |
| engine | `test_engine.js` | option symbols, rule classification, amounts, ledger/options arithmetic, edit/delete/rebuild, account snapshots |
| import | `test_import.js` | CSV parsing and row preparation, Import transactions on the Fidelity and Schwab example files (`examples/`, when present — cash must match the broker's Cash Balance), duplicates, predating rows, Import holdings (cash rows by Current Value, option unit prices) |
| update prices | `test_prices.js` | Tools > Update Prices with a stubbed `YahooFinance.getChart`: start date, upsert, 429 retries |
| reports | `test_reports.js` | Portfolio/Account performance from stored prices only: YTD baselines (first close of the year, or the first available close for assets issued during it), 50-day baselines (50 trading days back, or the earliest stored close), Last Acquired, missing prices, weighted averages, account scope, no Yahoo calls |
| dividends | `test_dividends.js` | Reports > Dividends: YTD window, sums per symbol, yield on current value, assets without value, grand total and value-weighted yield, contributing accounts and excluding unchecked accounts |
| script load | `test_load.js` | all scripts load together in `index.html` order; Portfolio entry parser; date helpers |

`examples/` and `data/` are not in the repository; checks that need them are reported as `SKIP`.

Run a single suite with the harness, e.g. `python tests/harness.py js/import.js test_import.js`
(see the header of `harness.py` for the argument conventions). Test scripts use `ok(cond, msg)`,
`eq(actual, expected, msg)` and `skip(msg)`; `__ROOT` is the repo root.

The UI (Tabulator tables, forms, dialogs, file pickers) is not covered and needs a manual pass in Chromium.

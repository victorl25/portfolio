// Reports > Dividends (js/tab-dividends.js): YTD dividends per symbol, yield on current value,
// grand total with count, total and value-weighted average yield.
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA')");
const txn = (acc, date, sym, amount, category = 'Dividend', valid = 1) => DB.run(
  `INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Amount, Timestamp, Valid)
   VALUES (?,?,'Cash',?,'Cash',?,0,?,'t',?)`, [acc, date, category, sym, amount, valid]);
const ledger = (acc, sym, qty) => DB.run(
  'INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES (?,?,?,?,0)', ['t', acc, sym, qty]);
const price = (sym, date, p) => DB.run('INSERT INTO Prices (Date, Symbol, Price) VALUES (?,?,?)', [date, sym, p]);

ledger(1, 'MSFT', 100); ledger(2, 'MSFT', 50);        // 150 shares across accounts
ledger(1, 'JNJ', 200);
ledger(1, 'HON', 0);                                   // sold out
price('MSFT', '2026-10-09', 400); price('JNJ', '2026-10-09', 150); price('HON', '2026-10-09', 210);

txn(1, '2026-03-10', 'MSFT', 300); txn(2, '2026-06-11', 'MSFT', 150); txn(1, '2026-09-10', 'MSFT', 450);
txn(1, '2026-09-08', 'JNJ', 1500);
txn(1, '2026-05-04', 'HON', 350);                      // received, then sold: no current value
txn(1, '2026-08-31', 'SPAXX', 760.68);                 // cash-like fund: not in the ledger
txn(1, '2025-12-15', 'MSFT', 999);                     // last year: excluded
txn(1, '2026-10-11', 'MSFT', 999);                     // after "today": excluded
txn(1, '2026-07-01', 'JNJ', 777, 'Dividend', 0);       // deleted: excluded
txn(1, '2026-09-21', 'JNJ', -97.6, 'Tax');             // foreign tax is Category Tax: not a dividend
txn(1, '2026-02-02', 'XOM', 50); txn(1, '2026-02-03', 'XOM', -50);   // reversed: nets to 0, not listed

const d = DividendsTab.computeDividends('2026-10-10');
eq([d.yearStart, d.end], ['2026-01-01', '2026-10-10'], 'year-to-date window');
eq(d.rows.map(r => [r.Symbol, r.Dividend]), [['JNJ', 1500], ['MSFT', 900], ['SPAXX', 760.68], ['HON', 350]],
   'dividends summed per symbol, largest first');
const row = s => d.rows.find(r => r.Symbol === s);
eq([row('MSFT').Value, +row('MSFT').Yield.toFixed(4)], [60000, 1.5], 'MSFT: yield = 900 / (150 x 400)');
eq([row('JNJ').Value, +row('JNJ').Yield.toFixed(4)], [30000, 5], 'JNJ: yield = 1500 / (200 x 150)');
eq([row('HON').Value, row('HON').Yield, row('SPAXX').Yield], [null, null, null], 'no current value: no yield');
eq([d.count, +d.total.toFixed(2)], [4, 3510.68], 'grand total: dividend-paying assets and total dividends');
eq(+d.avgYield.toFixed(6), +((900 + 1500) / (60000 + 30000) * 100).toFixed(6), 'value-weighted average yield (held assets)');
eq(+d.avgYield.toFixed(6), +((1.5 * 60000 + 5 * 30000) / 90000).toFixed(6), '... equals the yields weighted by value');

DB.createNew();
const empty = DividendsTab.computeDividends('2026-10-10');
eq([empty.rows.length, empty.count, empty.total, empty.avgYield], [0, 0, 0, null], 'no dividends this year');

// Account checkboxes: contributing accounts, and the report limited to the checked ones
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA'),('A3','No dividends')");
ledger(1, 'MSFT', 100); ledger(2, 'MSFT', 50); ledger(3, 'MSFT', 10); ledger(2, 'JNJ', 200);
price('MSFT', '2026-10-09', 400); price('JNJ', '2026-10-09', 150);
txn(1, '2026-03-10', 'MSFT', 400); txn(2, '2026-03-10', 'MSFT', 200); txn(2, '2026-09-08', 'JNJ', 1500);
txn(3, '2025-12-01', 'MSFT', 50);                      // last year only: not a contributing account
eq(DividendsTab.contributingAccounts('2026-10-10').map(a => a.Name), ['Brokerage', 'IRA'], 'checkboxes: accounts with YTD dividends');

const all = DividendsTab.computeDividends('2026-10-10');
eq([all.rows.map(r => [r.Symbol, r.Dividend, r.Value]), all.total], [[['JNJ', 1500, 30000], ['MSFT', 600, 64000]], 2100],
   'all accounts: dividends, value over all holdings');
const same = DividendsTab.computeDividends('2026-10-10', []);
eq([same.rows.map(r => [r.Symbol, r.Dividend, r.Value]), same.total], [all.rows.map(r => [r.Symbol, r.Dividend, r.Value]), all.total],
   'all checked (nothing excluded) = the report over all accounts, incl. holdings in accounts without dividends');
const noIra = DividendsTab.computeDividends('2026-10-10', [2]);
eq([noIra.rows.map(r => [r.Symbol, r.Dividend, r.Value]), noIra.count, noIra.total, +noIra.avgYield.toFixed(6)],
   [[['MSFT', 400, 44000]], 1, 400, +(400 / 44000 * 100).toFixed(6)],
   'IRA unchecked: its dividends and holdings excluded (MSFT value = Brokerage + 3rd account), totals recalculated');
const noBrk = DividendsTab.computeDividends('2026-10-10', ['1']);
eq([noBrk.rows.map(r => [r.Symbol, r.Dividend, r.Value]), noBrk.total], [[['JNJ', 1500, 30000], ['MSFT', 200, 24000]], 1700],
   'Brokerage unchecked (string ids accepted)');
const none = DividendsTab.computeDividends('2026-10-10', [1, 2]);
eq([none.rows.length, none.total, none.avgYield], [0, 0, null], 'all contributing accounts unchecked: empty report');

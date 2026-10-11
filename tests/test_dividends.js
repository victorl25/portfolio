// Reports > Dividends (js/tab-dividends.js): YTD dividends per symbol; Yield = Σ dividends / average
// cost basis, the cost basis of each payout being that of the last ledger record (active or inactive)
// dated at least a day before it (per-account averages added up); account checkboxes exclude accounts.
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA'),('A3','No dividends')");
const txn = (acc, date, sym, amount, category = 'Dividend', valid = 1) => DB.run(
  `INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Amount, Timestamp, Valid)
   VALUES (?,?,'Cash',?,'Cash',?,0,?,'t',?)`, [acc, date, category, sym, amount, valid]);
const ledger = (acc, sym, date, qty, cost, active = 0) => DB.run(
  'INSERT INTO Ledger (Date, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Active) VALUES (?,?,?,?,?,?,?)',
  [date, date + ' 12:00:00', acc, sym, qty, cost, active]);

// Ledger histories (inactive records are the earlier states)
ledger(1, 'MSFT', '2026-01-10', 100, 30000);
ledger(1, 'MSFT', '2026-06-01', 150, 50000);
ledger(1, 'MSFT', '2026-09-10', 200, 70000, 1);   // same day as the September payout: not used for it
ledger(2, 'MSFT', '2026-02-01', 50, 20000, 1);
ledger(2, 'JNJ', '2026-09-08', 200, 30000, 1);    // only on the payout day: JNJ has no earlier record
ledger(1, 'HON', '2026-01-05', 100, 21000);
ledger(1, 'HON', '2026-07-01', 150, 33000);      // bought more before the ex-dividend date
ledger(1, 'HON', '2026-08-01', 0, 0, 1);          // sold after the ex-dividend date, before the payout
ledger(3, 'MSFT', '2026-01-02', 10, 3000, 1);

txn(1, '2026-03-10', 'MSFT', 300);    // basis 30000 (Jan 10)
txn(1, '2026-06-01', 'MSFT', 400);    // basis 30000 — the Jun 1 record is the same day, not a day earlier
txn(1, '2026-09-10', 'MSFT', 600);    // basis 50000 (Jun 1, inactive)
txn(2, '2026-06-11', 'MSFT', 150);    // basis 20000
txn(2, '2026-09-08', 'JNJ', 1500);    // no ledger record before the payout
txn(1, '2026-08-31', 'SPAXX', 760.68);   // cash-like fund: no ledger
txn(1, '2026-05-04', 'HON', 350);     // basis 21000
txn(1, '2026-09-01', 'HON', 10);      // prior state has quantity 0 -> the state before the sale: basis 33000
txn(1, '2025-12-15', 'MSFT', 999);                 // last year: excluded
txn(1, '2026-10-11', 'MSFT', 999);                 // after "today": excluded
txn(1, '2026-07-01', 'JNJ', 777, 'Dividend', 0);   // deleted: excluded
txn(1, '2026-09-21', 'JNJ', -97.6, 'Tax');         // foreign tax is Category Tax: not a dividend
txn(1, '2026-02-02', 'XOM', 50); txn(1, '2026-02-03', 'XOM', -50);   // reversed: nets to 0, not listed

const TODAY = '2026-10-10';
eq(DividendsTab.payouts(TODAY).filter(p => p.Symbol === 'HON').map(p => [p.Date, p.CostBasis]), [['2026-05-04', 21000], ['2026-09-01', 33000]],
   'quantity-0 ledger state before a payout is skipped in favour of the state before it');
eq(DividendsTab.payouts(TODAY).filter(p => p.Symbol === 'MSFT' && p.Account_ID === 1).map(p => [p.Date, p.CostBasis]),
   [['2026-03-10', 30000], ['2026-06-01', 30000], ['2026-09-10', 50000]],
   'cost basis before each payout: last ledger record at least a day earlier, inactive records included');

const d = DividendsTab.computeDividends(TODAY);
eq([d.yearStart, d.end], ['2026-01-01', '2026-10-10'], 'year-to-date window');
eq(d.rows.map(r => [r.Symbol, +r.Dividend.toFixed(2)]), [['JNJ', 1500], ['MSFT', 1450], ['SPAXX', 760.68], ['HON', 360]],
   'dividends summed per symbol, largest first');
const row = s => d.rows.find(r => r.Symbol === s);
const msftAvg1 = (30000 + 30000 + 50000) / 3, msftAvg2 = 20000;   // Brokerage: 3 payouts, IRA: 1 payout
eq([+row('MSFT').AvgCost.toFixed(4), +row('MSFT').Yield.toFixed(8)], [+(msftAvg1 + msftAvg2).toFixed(4), +(1450 / (msftAvg1 + msftAvg2) * 100).toFixed(8)],
   'MSFT yield = Σ dividends / average cost basis (per-account averages of the prior cost bases, added up)');
eq([row('HON').Payouts, row('HON').WithBasis, row('HON').AvgCost, +row('HON').Yield.toFixed(8)], [2, 2, 27000, +(360 / 27000 * 100).toFixed(8)],
   'sold after the ex-dividend date: the payout uses the state before the sale (quantity-0 record skipped)');
eq([row('JNJ').Yield, row('JNJ').WithBasis, row('SPAXX').Yield], [null, 0, null], 'no ledger record before the payout: no yield');
eq([d.count, +d.total.toFixed(2)], [4, 4070.68], 'grand total: dividend-paying assets and total dividends');
eq(+d.avgYield.toFixed(8), +((1450 + 360) / (msftAvg1 + msftAvg2 + 27000) * 100).toFixed(8),
   'grand total yield: Σ dividends / Σ average cost basis of the assets with a cost basis');

// Account checkboxes
eq(DividendsTab.contributingAccounts(TODAY).map(a => a.Name), ['Brokerage', 'IRA'], 'checkboxes: accounts with YTD dividends');
const noIra = DividendsTab.computeDividends(TODAY, [2]);
eq([noIra.rows.map(r => r.Symbol), +noIra.rows.find(r => r.Symbol === 'MSFT').Yield.toFixed(8), +noIra.total.toFixed(2)],
   [['MSFT', 'SPAXX', 'HON'], +(1300 / msftAvg1 * 100).toFixed(8), 2420.68],
   'IRA unchecked: its payouts excluded, yields and totals recalculated');
const noBrk = DividendsTab.computeDividends(TODAY, ['1']);
eq([noBrk.rows.map(r => [r.Symbol, r.Dividend]), +noBrk.avgYield.toFixed(8)], [[['JNJ', 1500], ['MSFT', 150]], +(150 / 20000 * 100).toFixed(8)],
   'Brokerage unchecked (string ids accepted)');
eq(DividendsTab.computeDividends(TODAY, [1, 2]).rows.length, 0, 'all contributing accounts unchecked: empty report');

DB.createNew();
const empty = DividendsTab.computeDividends(TODAY);
eq([empty.rows.length, empty.count, empty.total, empty.avgYield], [0, 0, 0, null], 'no dividends this year');

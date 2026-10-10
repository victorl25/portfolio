// Analyze > Portfolio / Account performance (js/tab-reports.js): stored daily closes only.
// YTD baseline = first stored close on or after Jan 1; 50-day baseline = the stored close 50 trading
// days before the latest one (earliest stored close when fewer); Last Acquired from Transactions.
globalThis.YahooFinance = { getChart() { throw new Error('reports must not call Yahoo Finance'); },
                            getQuote() { throw new Error('reports must not call Yahoo Finance'); } };
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA')");
const ledger = (acc, sym, qty, cost) => DB.run(
  'INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES (?,?,?,?,?)', ['t', acc, sym, qty, cost]);
const price = (sym, date, p) => DB.run('INSERT INTO Prices (Date, Symbol, Price) VALUES (?,?,?)', [date, sym, p]);
const txn = (acc, date, sym, qty, effect = 'Trade', valid = 1) => DB.run(
  `INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Amount, Timestamp, Valid)
   VALUES (?,?,?,?,?,?,?,0,'t',?)`, [acc, date, Engine.EFFECT_TYPE[effect], 'Equity', effect, sym, qty, valid]);

// Weekday closes between two dates: price = start + index
const weekdays = (from, to) => {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
const aaplDays = weekdays('2026-01-02', '2026-10-09');          // held all year
aaplDays.forEach((d, i) => price('AAPL', d, 100 + i));
price('AAPL', '2025-12-31', 95);
const newDays = weekdays('2026-08-31', '2026-10-09');           // issued in late August: < 51 closes
newDays.forEach((d, i) => price('NEWCO', d, 50 + i));
price('OLD', '2025-12-30', 40);                                  // a single close, last year

ledger(1, 'AAPL', 10, 1200); ledger(2, 'AAPL', 5, 500);
ledger(1, 'NEWCO', 20, 900); ledger(1, 'NOPX', 7, 70); ledger(2, 'OLD', 4, 400); ledger(1, 'GONE', 0, 0);

txn(1, '2026-02-10', 'AAPL', 10);
txn(2, '2026-06-01', 'AAPL', 5);
txn(1, '2026-07-01', 'AAPL', -3);                  // a sale is not an acquisition
txn(1, '2026-08-01', 'AAPL', 1, 'Trade', 0);       // invalid (deleted) transaction ignored
txn(1, '2026-09-01', 'NEWCO', 15);
txn(1, '2026-09-15', 'NEWCO', 5, 'RSU');           // RSU vest counts as an acquisition
txn(2, '2026-03-03', 'OLD', 4, 'Reinvestment');
txn(1, '2026-01-05', 'NOPX', 7, 'Snapshot');       // only a holdings snapshot -> "before" its date
txn(1, '2026-02-05', 'NOPX', 7, 'Snapshot');       // ... the latest one
txn(1, '2026-10-05', 'AAPL', 13, 'Snapshot');      // a later snapshot does not hide AAPL's real buy date
txn(2, '2026-04-01', 'OLD', 4, 'Split');           // OLD also has a reinvestment, which wins
txn(1, '2026-03-01', 'NOPX', 0, 'Snapshot');       // zero quantity record transactions are ignored

const TODAY = '2026-10-10';
const r = ReportsTab.computeReport(null, TODAY);
const row = s => r.rows.find(x => x.Symbol === s);
eq(r.rows.map(x => x.Symbol), ['AAPL', 'NEWCO', 'NOPX', 'OLD'], 'held assets only (quantity 0 excluded)');
ok(!('PctQTD' in r.rows[0]) && 'Pct50D' in r.rows[0] && 'avg50D' in r && !('avgQTD' in r), 'QTD replaced by 50-day G/L');

// YTD (unchanged): first close of the year, or first available for assets issued during the year
const nA = aaplDays.length, lastA = 100 + nA - 1;
eq([row('AAPL').Price, row('AAPL').BaseYTD.date, +row('AAPL').PctYTD.toFixed(6)], [lastA, '2026-01-02', +((lastA - 100) / 100 * 100).toFixed(6)], 'AAPL YTD');
eq([row('NEWCO').BaseYTD.date, row('NEWCO').BaseYTD.late], ['2026-08-31', true], 'NEWCO YTD from its first available close');

// 50-day: the close 50 trading days before the latest stored close
const b50 = row('AAPL').Base50D;
eq([b50.date, b50.price, b50.days, b50.late], [aaplDays[nA - 51], 100 + nA - 51, 50, false], 'AAPL 50-day baseline = 50 trading days back');
eq(+row('AAPL').Pct50D.toFixed(6), +((lastA - (100 + nA - 51)) / (100 + nA - 51) * 100).toFixed(6), 'AAPL 50-day G/L');
const nN = newDays.length, lastN = 50 + nN - 1;
eq([row('NEWCO').Base50D.date, row('NEWCO').Base50D.days, row('NEWCO').Base50D.late, +row('NEWCO').Pct50D.toFixed(6)],
   [newDays[0], nN - 1, true, +((lastN - 50) / 50 * 100).toFixed(6)], 'fewer than 51 closes: from the earliest available close');
eq([row('NOPX').Pct50D, row('OLD').Pct50D], [null, null], 'no 50-day G/L without at least two stored closes');
eq(ReportsTab.trailingBaseline('AAPL', 5).date, aaplDays[nA - 6], 'trailing baseline helper');

// Last Acquired: most recent valid acquisition (buy, reinvestment, RSU, distribution), all accounts
eq(r.rows.map(x => [x.LastAcquired, x.LastAcquiredBefore]),
   [['2026-06-01', false], ['2026-09-15', false], ['2026-02-05', true], ['2026-03-03', false]],
   'Last Acquired (portfolio): acquisitions first; snapshot-only asset -> latest snapshot date flagged "before"');

// Weighted 50-day average over the assets with a baseline
const start50 = 15 * (100 + nA - 51) + 20 * 50, cur50 = 15 * lastA + 20 * lastN;
eq(+r.avg50D.toFixed(6), +((cur50 - start50) / start50 * 100).toFixed(6), '50-day average weighted by value');

// Account performance: same logic, Last Acquired limited to the account
const brk = ReportsTab.computeReport(1, TODAY);
eq(brk.rows.map(x => [x.Symbol, x.LastAcquired, x.LastAcquiredBefore]),
   [['AAPL', '2026-02-10', false], ['NEWCO', '2026-09-15', false], ['NOPX', '2026-02-05', true]], 'Last Acquired per account');
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A3','Snap only')");
ledger(3, 'SPLITCO', 10, 100);
txn(3, '2026-05-05', 'SPLITCO', 10, 'Split');
eq(ReportsTab.computeReport(3, TODAY).rows.map(x => [x.LastAcquired, x.LastAcquiredBefore]), [['2026-05-05', true]], 'split-only position: "before" the split date');
const ira = ReportsTab.computeReport(2, TODAY);
eq([ira.label, ira.rows.map(x => x.LastAcquired), ira.missing], ['IRA', ['2026-06-01', '2026-03-03'], ['OLD']], 'account-scoped report');

eq(DB.query('SELECT COUNT(*) AS n FROM Prices')[0].n, nA + 1 + nN + 1, 'Prices table untouched by the report');

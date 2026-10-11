// Reports > Portfolio trend (js/tab-trend.js): daily account and portfolio values from all Ledger records
// (most recent by Date, active or inactive) × the latest stored close, as % change from the first value.
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA'),('A3','Empty')");
const led = (id, parent, acc, sym, date, qty, active) => DB.run(
  'INSERT INTO Ledger (Holding_ID, Parent_ID, Date, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Active) VALUES (?,?,?,?,?,?,?,0,?)',
  [id, parent, date, date + ' 12:00:00', acc, sym, qty, active]);
led(1, null, 1, 'AAPL', '2025-06-01', 10, 0);
led(2, 1,    1, 'AAPL', '2026-03-02', 20, 1);    // superseded on 2026-03-02
led(3, null, 1, 'TSLA', '2026-01-05', 2, 0);     // deactivated, no snapshot after it: counted on its own date only
led(4, null, 1, 'ZZZ',  '2026-01-05', 1, 1);     // no stored price
led(5, null, 2, 'MSFT', '2026-01-05', 5, 0);     // dropped by the holdings snapshot of 2026-02-02
led(6, null, 2, 'XOM',  '2026-02-02', 4, 1);
DB.run(`INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Price, Amount, Timestamp, Valid)
        VALUES (2, '2026-02-02', 'Record', 'Equity', 'Snapshot', 'XOM', 4, 50, 0, 't', 1)`);
const px = (date, sym, price, valid = 1) => DB.run('INSERT INTO Prices (Date, Symbol, Price, Valid) VALUES (?,?,?,?)', [date, sym, price, valid]);
px('2025-01-02', 'AAPL', 80);                          // before the window
px('2025-10-10', 'AAPL', 100);
px('2026-01-05', 'AAPL', 100); px('2026-01-05', 'MSFT', 200); px('2026-01-05', 'TSLA', 300);
px('2026-02-02', 'AAPL', 110); px('2026-02-02', 'MSFT', 210); px('2026-02-02', 'XOM', 50);
px('2026-03-02', 'AAPL', 120);
px('2026-10-09', 'AAPL', 150); px('2026-10-09', 'XOM', 60);
px('2026-10-10', 'AAPL', 999, 0);                      // invalid: not a trading day of the chart
px('2026-10-11', 'AAPL', 160);                         // after today

const t = TrendTab.computeTrend('2026-10-10');
eq([t.start, t.days], ['2025-10-10', ['2025-10-10', '2026-01-05', '2026-02-02', '2026-03-02', '2026-10-09']],
   'one year back (ledger starts earlier); days = dates with valid stored closes');
const s = name => t.series.find(x => x.name === name);
eq(t.series.map(x => x.name), ['Portfolio', 'Brokerage', 'IRA'], 'portfolio line first, then accounts with values (by name)');
eq(s('Brokerage').values, [1000, 1000 + 600, 1100, 2400, 3000],
   'account values: most recent ledger record by Date x latest close; deactivated entry only on its date');
eq(s('IRA').values, [0, 1000, 200, 200, 240], 'entry dropped by a later holdings snapshot counted until the snapshot date');
eq(s('Portfolio').values, [1000, 2600, 1300, 2600, 3240], 'portfolio = sum of the accounts');
const r2 = a => a.map(v => v == null ? null : Math.round(v * 100) / 100);
eq(r2(s('Portfolio').pct), [0, 160, 30, 160, 224], '% change from the first value');
eq(r2(s('IRA').pct), [null, 0, -80, -80, -76], '% change from the first non-zero value (nothing before it)');
eq(t.missing, ['ZZZ'], 'symbols without stored prices reported');
eq(t.gaps, [{ symbol: 'XOM', from: '2026-03-02', to: '2026-03-02' }, { symbol: 'ZZZ', from: '2026-01-05', to: '2026-10-09' }],
   'price gaps: held days without a close within 4 days (XOM not priced on 2026-03-02), symbols without prices');
eq(TrendTab.gapRequests(t), [{ symbol: 'XOM', from: '2026-02-23', to: '2026-03-02' }, { symbol: 'ZZZ', from: '2025-12-29', to: '2026-10-09' }],
   'fetch requests start a week before each gap');
const ira = s('IRA').accountId;
const vis = TrendTab.visibleSeries(t, new Set([ira]));
eq([vis.map(x => x.name), vis[0].values, r2(vis[0].pct)], [['Portfolio', 'Brokerage'], [1000, 2600, 1300, 2600, 3240], [0, 160, 30, 160, 224]],
   'unchecked account: its line hidden, portfolio line unchanged (still includes it)');
eq(TrendTab.visibleSeries(t, [String(s('Brokerage').accountId), ira]).map(x => x.name), ['Portfolio'], 'all accounts unchecked: portfolio line only');


// Cash: each day adds the account's most recent Balance record (by Date, ties by Balance_ID), 0 before the first
const bal = (id, parent, acc, date, cash, active) => DB.run(
  'INSERT INTO Balance (Balance_ID, Parent_ID, Date, Timestamp, Account_ID, Cash, Active) VALUES (?,?,?,?,?,?,?)',
  [id, parent, date, date + ' 12:00:00', acc, cash, active]);
bal(1, null, 1, '2025-11-01', 500, 0);
bal(2, 1,    1, '2026-02-02', 300, 0);
bal(3, 2,    1, '2026-03-02', 100, 0);
bal(4, 3,    1, '2026-03-02', 50, 1);     // same date: the later record wins
bal(5, null, 2, '2025-09-01', 20, 1);     // before the period: applies from the first day
bal(6, null, 3, '2026-02-02', 100, 1);    // account with cash only
const tc = TrendTab.computeTrend('2026-10-10');
const sc = name => tc.series.find(x => x.name === name);
eq(sc('Brokerage').values, [1000, 1600 + 500, 1100 + 300, 2400 + 50, 3000 + 50], 'holdings + cash balance on each day');
eq(sc('IRA').values, [20, 1020, 220, 220, 260], 'cash balance recorded before the period applies from the first day');
eq(sc('Empty').values, [0, 0, 100, 100, 100], 'account with cash only gets a line');
eq(sc('Portfolio').values, [1020, 3120, 1720, 2770, 3410], 'portfolio = holdings + cash of all accounts');
eq(r2(sc('IRA').pct), [0, 5000, 1000, 1000, 1200], '% change includes cash');
DB.run('DELETE FROM Balance');

// Ledger history shorter than a year: starts at the earliest ledger date; earlier closes back-fill nothing
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('B1','Solo')");
led(1, null, 1, 'NVDA', '2026-05-01', 10, 1);
px('2026-04-01', 'NVDA', 50); px('2026-05-01', 'NVDA', 100); px('2026-06-01', 'NVDA', 90);
const t2 = TrendTab.computeTrend('2026-10-10');
eq([t2.start, t2.days, t2.series.map(x => x.name), r2(t2.series[0].pct)],
   ['2026-05-01', ['2026-05-01', '2026-06-01'], ['Portfolio', 'Solo'], [0, -10]], 'starts at the earliest ledger date');
DB.run("DELETE FROM Prices WHERE Date = '2026-05-01'");
eq(TrendTab.computeTrend('2026-10-10').series[0].values, [900], 'latest close on or before each day (no close on the first ledger day)');

DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('C1','Cash first')");
bal(1, null, 1, '2026-04-01', 1000, 1);
led(1, null, 1, 'NVDA', '2026-05-01', 10, 1);
px('2026-04-01', 'NVDA', 50); px('2026-05-01', 'NVDA', 100);
const t4 = TrendTab.computeTrend('2026-10-10');
eq([t4.start, t4.days, t4.series[0].values], ['2026-04-01', ['2026-04-01', '2026-05-01'], [1000, 2000]],
   'period starts at the earliest Ledger or Balance date');

DB.createNew();
const t3 = TrendTab.computeTrend('2026-10-10');
eq([t3.start, t3.days.length, t3.series.length], [null, 0, 0], 'no ledger entries: empty trend');

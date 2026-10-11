// Reports > Gains/Losses (js/tab-gains.js): lots matched last in, first out per account + symbol,
// short term (< 1 year) / long term (1 year or more), record transactions dated on the record date.
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('A1','Brokerage'),('A2','IRA'),('A3','Quiet')");
const t = (acc, date, effect, sym, qty, amount, price = null, valid = 1) => DB.run(
  `INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Price, Amount, Timestamp, Valid)
   VALUES (?,?,?,?,?,?,?,?,?,'t',?)`,
  [acc, date, Engine.EFFECT_TYPE[effect], Engine.isOption(sym) ? 'Option' : 'Equity', effect, sym, qty, price, amount, valid]);
const TODAY = '2026-10-10';

eq([GainsTab.isLongTerm('2025-10-10', '2026-10-10'), GainsTab.isLongTerm('2025-10-11', '2026-10-10'),
    GainsTab.isLongTerm('2024-02-29', '2025-03-01'), GainsTab.isLongTerm('2024-02-29', '2025-02-28')],
   [true, false, true, false], 'holding period: 1 year or more is long term (Feb 29 + 1 year = Mar 1)');

// AAPL: LIFO — the 2026 lot is sold first (short term), then part of the 2024 lot (long term)
t(1, '2024-03-01', 'Trade', 'AAPL', 100, -10000);
t(1, '2026-02-01', 'Trade', 'AAPL', 50, -7500);
t(1, '2026-06-01', 'Trade', 'AAPL', -80, 16000);
t(1, '2026-07-01', 'Trade', 'AAPL', -5, 1000, null, 0);        // deleted sale: ignored
t(2, '2026-01-15', 'Trade', 'AAPL', 10, -2000);                 // other account: its own lots
t(2, '2026-09-01', 'Trade', 'AAPL', -10, 1500);
// exactly one year / one day short of a year
t(1, '2025-10-10', 'Trade', 'MSFT', 10, -4000); t(1, '2026-10-10', 'Trade', 'MSFT', -10, 5000);
t(1, '2025-10-11', 'Trade', 'NVDA', 10, -4000); t(1, '2026-10-10', 'Trade', 'NVDA', -10, 5000);
// partial sale last year (excluded), the rest this year at a loss
t(1, '2024-01-01', 'Trade', 'TSLA', 10, -1000); t(1, '2025-06-01', 'Trade', 'TSLA', -5, 800); t(1, '2026-03-01', 'Trade', 'TSLA', -5, 300);
// record transactions: snapshot (lots replaced, dated on the snapshot), RSU, split, distribution
t(1, '2023-01-01', 'Trade', 'HON', 100, -5000);
t(1, '2026-01-05', 'Snapshot', 'HON', 100, 0, 210);             // cost 21000 dated 2026-01-05
t(1, '2026-05-01', 'Trade', 'HON', -100, 25000);
t(1, '2025-03-01', 'RSU', 'GOOG', 10, 0, 150);
t(1, '2026-04-01', 'Trade', 'GOOG', -10, 2000);
t(1, '2024-05-01', 'Trade', 'XYZ', 100, -1000);
t(1, '2026-02-01', 'Split', 'XYZ', 50, 1500);                   // 1-for-2: 50 shares, cost replaced by the Amount, date kept
t(1, '2026-03-01', 'Trade', 'XYZ', -50, 3000);
t(1, '2026-06-29', 'Distribution', 'HONA', 500, 10000);         // cost: the Amount
t(1, '2026-09-01', 'Trade', 'HONA', -500, 50000);
// sale without earlier holdings: no cost basis, not included, reported
t(1, '2026-06-29', 'Trade', 'XME', -100, 10000);
// options: written and bought back; written and expired; bought and expired; not yet expired
t(1, '2026-07-01', 'Trade', 'NVDA20260918C200', -2, 600); t(1, '2026-08-01', 'Trade', 'NVDA20260918C200', 2, -200);
t(1, '2026-05-01', 'Trade', 'GLD20260821C515', -7, 700);
t(1, '2026-05-01', 'Trade', 'MSFT20260620P100', 1, -150);
t(1, '2026-09-01', 'Trade', 'AAPL20261016C300', -1, 90);
// last year's realized gain only
t(1, '2024-01-01', 'Trade', 'OLD', 10, -100); t(1, '2025-12-31', 'Trade', 'OLD', -10, 500);

const g = GainsTab.computeGains(TODAY);
const row = s => g.rows.find(r => r.Symbol === s) || null;
const st = s => [row(s)?.ShortTerm, row(s)?.LongTerm];
eq(st('AAPL'), [2500 - 500, 3000], 'AAPL: LIFO lots (2026 lot short term, then 2024 lot long term) + IRA loss');
eq([st('MSFT'), st('NVDA')], [[0, 1000], [1000, 0]], 'held exactly 1 year: long term; one day less: short term');
eq(st('TSLA'), [0, -200], "partial sale last year excluded; this year's sale of the remaining lot at a loss");
eq(st('HON'), [4000, 0], 'holdings snapshot replaces the lots and dates them on the snapshot');
eq([st('GOOG'), st('XYZ'), st('HONA')], [[0, 500], [0, 1500], [40000, 0]], 'RSU (cost = qty x price), split (cost = Amount, date kept), distribution (cost = Amount)');
eq([st('NVDA20260918C200'), st('GLD20260821C515'), st('MSFT20260620P100')], [[400, 0], [700, 0], [-150, 0]],
   'options: written + bought back, written + expired (premium kept), bought + expired (premium lost)');
eq([row('AAPL20261016C300'), row('OLD'), row('XME')], [null, null, null], 'not yet expired, realized last year, unmatched: no row');
eq(g.unmatched.map(u => [u.Symbol, u.Date, u.Quantity]), [['XME', '2026-06-29', 100]], 'sales without earlier holdings reported');
eq(g.rows[0].Symbol, 'HONA', 'rows sorted by total gain, largest first');
eq([g.count, g.shortTerm, g.longTerm], [g.rows.length, 2000 + 1000 + 4000 + 40000 + 400 + 700 - 150, 3000 + 1000 - 200 + 500 + 1500],
   'grand total: assets, short term and long term');

// Account checkboxes
eq(GainsTab.contributingAccounts(TODAY).map(a => a.Name), ['Brokerage', 'IRA'], 'checkboxes: accounts with gains this year');
eq(GainsTab.computeGains(TODAY, [2]).rows.find(r => r.Symbol === 'AAPL').ShortTerm, 2500, 'IRA unchecked: its AAPL loss excluded');
const onlyIra = GainsTab.computeGains(TODAY, ['1']);
eq([onlyIra.rows.map(r => [r.Symbol, r.ShortTerm, r.LongTerm]), onlyIra.unmatched.length], [[['AAPL', -500, 0]], 0], 'Brokerage unchecked');
eq(GainsTab.computeGains(TODAY, [1, 2]).rows.length, 0, 'all contributing accounts unchecked: empty report');

// With Ledger/Options entries (Engine.record): LIFO lots give the holding periods, the amounts use the
// average cost of the parent record of the entry each sale created
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('B1','Brokerage')");
const rec = (date, sym, qty, amount) => Engine.record({ Account_ID: 1, Date: date, Effect: 'Trade',
  Category: Engine.isOption(sym) ? 'Option' : 'Equity', Symbol: sym, Quantity: qty, Price: null, Amount: amount, Currency: 'USD' });
rec('2024-03-01', 'AAPL', 100, -10000);
rec('2026-02-01', 'AAPL', 50, -7500);            // parent of the first sale: 150 shares, cost 17500
const sale1 = rec('2026-06-01', 'AAPL', -80, 16000);
const sale2 = rec('2026-09-01', 'AAPL', -70, 7000);   // parent: 70 shares, cost 17500 x 70/150
const sale1Entry = DB.query('SELECT Parent_ID FROM Ledger WHERE Transaction_ID=?', [sale1.Transaction_ID])[0];
eq(DB.query('SELECT Quantity, Cost_Basis FROM Ledger WHERE Holding_ID=?', [sale1Entry.Parent_ID])[0], { Quantity: 150, Cost_Basis: 17500 },
   'sale A -> ledger entry B -> parent C (the position before the sale)');
const avg = 17500 / 150;
const ev = GainsTab.realizations(TODAY).events.filter(e => e.Symbol === 'AAPL').map(e => [e.Date, e.Long, +e.Gain.toFixed(2)]);
eq(ev, [['2026-06-01', false, +(10000 - 50 * avg).toFixed(2)], ['2026-06-01', true, +(6000 - 30 * avg).toFixed(2)],
        ['2026-09-01', true, +(7000 - 70 * avg).toFixed(2)]],
   'LIFO lots split each sale into short/long term; the gains use the average cost of the parent ledger record');
rec('2025-01-02', 'MSFT', 10, -1000);
Engine.supersede('Ledger', 1, 'MSFT', Engine.activeEntry('Ledger', 1, 'MSFT'), 10, 1500, null);   // manual cost correction
rec('2026-03-01', 'MSFT', -10, 2000);
rec('2026-06-29', 'XME', -100, 10000);           // ledger entry without a parent: no earlier position
rec('2026-07-01', 'NVDA20260918C200', -2, 600); rec('2026-08-01', 'NVDA20260918C200', 2, -200);
rec('2026-05-01', 'GLD20260821C515', -7, 700);
const g2 = GainsTab.computeGains(TODAY);
const st2 = s => { const r = g2.rows.find(x => x.Symbol === s); return r ? [r.ShortTerm, r.LongTerm] : null; };
eq(st2('AAPL'), [Math.round((10000 - 50 * avg) * 100) / 100, Math.round((13000 - 100 * avg) * 100) / 100], 'AAPL short/long term totals');
eq(st2('MSFT'), [0, 500], 'manual ledger edit: the corrected cost basis (1500) is used, not the purchase amount');
eq([st2('XME'), g2.unmatched.map(u => u.Symbol)], [null, ['XME']], 'sale without an earlier position: not counted, reported');
eq([st2('NVDA20260918C200'), st2('GLD20260821C515')], [[400, 0], [700, 0]], 'options: bought back (parent premium) and expired (active entry)');

DB.createNew();
eq([GainsTab.computeGains(TODAY).rows.length, GainsTab.contributingAccounts(TODAY).length], [0, 0], 'no transactions: empty report');

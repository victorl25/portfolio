// Engine: option symbols, rule classification, amounts, ledger/options arithmetic, edit/delete/rebuild, snapshots (js/engine.js)
DB.createNew();
eq(DB.query('SELECT Schema_Version v FROM Info')[0].v, '2.0', 'schema version');
eq(DB.query('SELECT COUNT(*) n FROM Rules')[0].n, RULES_SEED.length, 'seeded rules');
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X1','Margin',0),('X2','IRA',0)");

// ── Option symbols
eq(Engine.normalizeOption(' -GLD260821C515'), 'GLD20260821C515', 'Fidelity option symbol');
eq(Engine.normalizeOption('-NVDA270115C360'), 'NVDA20270115C360', 'Fidelity option symbol 2');
eq(Engine.normalizeOption('NVDA 01/15/2027 360.00 C'), 'NVDA20270115C360', 'Schwab option symbol');
eq(Engine.normalizeOption('ANET 01/02/2026 137.00 C'), 'ANET20260102C137', 'alternative format');
eq(Engine.normalizeOption(' anet  1/2/26  $137.50 p '), 'ANET20260102P137.5', 'alternative format: 1-digit month/day, 2-digit year, $, lowercase');
eq(Engine.normalizeOption('ANET 13/40/2026 137.00 C') !== null, true, 'alternative format is not date-validated (as before)');
eq(Engine.normalizeOption('NVDA270115C00182500'), 'NVDA20270115C182.5', 'OCC option symbol');
eq(Engine.normalizeOption('NVDA20260101C182.5'), 'NVDA20260101C182.5', 'canonical option symbol');
eq(Engine.normalizeOption('AAPL'), null, 'equity is not an option');
eq(Engine.normalizeOption('BRK.B'), null, 'BRK.B is not an option');
eq(Engine.parseOption('NVDA20270115P182.5'), { asset: 'NVDA', expiration: '2027-01-15', right: 'P', strike: 182.5 }, 'parse option');
eq(Engine.normalizeSymbol(' msft '), 'MSFT', 'normalize equity');

// ── Rule classification (actual example rows)
const rules = Engine.loadRules();
const cls = (a, s) => { const c = Engine.classify(a, s, rules); return [c.status, c.effect || null, c.category || null, c.type || null]; };
eq(cls('JOURNALED VS X77-762215-2 AUTO-JOURNAL ISHARES TR (IHI) (Cash)', 'IHI'), ['ignored', null, null, null], 'JOURNALED ignored');
eq(cls('DIVIDEND RECEIVED MICROSOFT CORP (MSFT) (Margin)', 'MSFT'), ['import', 'Cash', 'Dividend', 'Cash'], 'Fidelity dividend');
eq(cls('REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)', 'SPAXX'), ['import', 'Other', 'Other', 'Other'], 'SPAXX reinvestment -> rule 45');
eq(cls('REINVESTMENT MICROSOFT CORP (MSFT) (Margin)', 'MSFT'), ['import', 'Reinvestment', 'Equity', 'Trade'], 'MSFT reinvestment');
eq(cls('YOU BOUGHT CLOSING TRANSACTION CALL (NVDA) NVIDIA', ' -NVDA270115C360'), ['import', 'Trade', 'Option', 'Trade'], 'option buy -> Option category');
eq(cls('YOU SOLD HONEYWELL INTL INC COM (HON) (Margin)', 'HON'), ['import', 'Trade', 'Equity', 'Trade'], 'equity sale');
eq(cls('REVERSE SPLIT R/S FROM 438516106#REOR', 'HON'), ['import', 'Split', 'Equity', 'Record'], 'reverse split');
eq(cls('REVERSE SPLIT R/S TO 438516205#REOR', ''), ['unrecognized', null, null, null], 'split row without symbol is unrecognized');
eq(cls('DISTRIBUTION SPINOFF FROM:(HON ) HONEYWELL AEROSPACE', 'HONA'), ['import', 'Distribution', 'Equity', 'Record'], 'distribution');
eq(cls('EXPIRED CALL (GLD) SPDR GOLD', ' -GLD260821C515'), ['import', 'Other', 'Other', 'Other'], 'expired');
eq(cls('ASSIGNED as of 2026-08-21 CALL (NVDA)', '-NVDA260821C200'), ['import', 'Other', 'Option', 'Other'], 'assigned recorded only');
eq(cls('FOREIGN TAX PAID SOCIEDAD QUIMICA (SQM)', 'SQM'), ['import', 'Cash', 'Tax', 'Cash'], 'foreign tax');
eq(cls('Credit Interest', ''), ['import', 'Cash', 'Interest', 'Cash'], 'Schwab credit interest without symbol');
eq(cls('Margin Interest', ''), ['import', 'Cash', 'Margin', 'Cash'], 'Schwab margin interest without symbol');
eq(cls('Qualified Dividend', 'MSFT'), ['import', 'Cash', 'Dividend', 'Cash'], 'Schwab qualified dividend');
eq(cls('Cash Dividend', ''), ['unrecognized', null, null, null], 'dividend without symbol unrecognized (symbol required)');
eq(cls('DEPOSIT Electronic', ''), ['import', 'Cash', 'Transfer', 'Cash'], 'deposit case-insensitive');
eq(cls('Something new', 'X'), ['unrecognized', null, null, null], 'unknown action');

// ── Amounts
eq(Engine.resolveAmount({ amount: -976.85, effect: 'Cash', sign: -1 }), -976.85, 'tax keeps negative');
eq(Engine.resolveAmount({ amount: 976.85, effect: 'Cash', sign: -1 }), -976.85, 'tax sign forced');
eq(Engine.resolveAmount({ amount: -500, effect: 'Cash', sign: 1 }), 500, 'deposit sign forced');
eq(Engine.resolveAmount({ amount: null, quantity: 100, price: 10.5, effect: 'Trade', symbol: 'AAPL' }), -1050, 'computed equity amount');
eq(Engine.resolveAmount({ amount: null, quantity: -2, price: 3.2, effect: 'Trade', symbol: 'NVDA20270115C360' }), 640, 'computed option amount x100');
eq(Engine.resolveAmount({ amount: 110095, quantity: 500, effect: 'Distribution' }), 0, 'distribution amount 0');
eq(Engine.resolveAmount({ amount: 113900, quantity: 500, effect: 'Split' }), 0, 'split amount 0');

const cash = id => DB.query('SELECT Cash FROM Accounts WHERE Account_ID=?', [id])[0].Cash;
const led  = (acc, sym) => Engine.activeEntry('Ledger', acc, sym);
const T = (o) => Engine.record(Object.assign({ Account_ID: 1, Date: '2026-09-01', Category: 'Equity', Effect: 'Trade', Currency: 'USD' }, o));

// ── Ledger arithmetic: buy 100 @10 + $5 fee, sell 40, sell 60
const t1 = T({ Symbol: 'ABC', Quantity: 100, Price: 10, Amount: -1005 });
let e = led(1, 'ABC');
eq([e.Quantity, e.Cost_Basis, e.Parent_ID, e.Transaction_ID], [100, 1005, null, t1.Transaction_ID], 'buy creates entry');
eq(cash(1), -1005, 'buy reduces cash');
const t2 = T({ Date: '2026-09-02', Symbol: 'ABC', Quantity: -40, Price: 12, Amount: 479 });
const e2 = led(1, 'ABC');
eq([e2.Quantity, e2.Cost_Basis, e2.Parent_ID, e2.Transaction_ID], [60, 603, e.Holding_ID, t2.Transaction_ID], 'partial sell: proportional cost, parent link');
eq(DB.query('SELECT Active FROM Ledger WHERE Holding_ID=?', [e.Holding_ID])[0].Active, 0, 'parent deactivated');
T({ Date: '2026-09-03', Symbol: 'ABC', Quantity: -60, Price: 12, Amount: 720 });
e = led(1, 'ABC');
eq([e.Quantity, e.Cost_Basis, e.Active], [0, 0, 1], 'full sale: qty 0 stays active');
eq(DB.query("SELECT COUNT(*) n FROM v_holdings WHERE Symbol='ABC'")[0].n, 0, 'qty 0 hidden from v_holdings');
eq(cash(1), -1005 + 479 + 720, 'cash after sales');
// crossing zero: hold 10 @ $100 = 1000, sell 30 @ $50 (Amount 1500) -> short 20, basis -1000
T({ Symbol: 'XYZ', Quantity: 10, Price: 100, Amount: -1000 });
T({ Symbol: 'XYZ', Quantity: -30, Price: 50, Amount: 1500 });
e = led(1, 'XYZ');
eq([e.Quantity, e.Cost_Basis], [-20, -1000], 'crossing zero opens a short at the trade price');
// buy to cover half of the short: proportional
T({ Symbol: 'XYZ', Quantity: 10, Price: 40, Amount: -400 });
e = led(1, 'XYZ');
eq([e.Quantity, e.Cost_Basis], [-10, -500], 'buy to cover reduces short proportionally');

// ── Split / Distribution
T({ Symbol: 'HON', Quantity: 1000, Price: 232.21, Amount: -232210 });
const hs = T({ Date: '2026-06-29', Effect: 'Split', Symbol: 'HON', Quantity: 500, Price: null, Amount: 0 });
e = led(1, 'HON');
eq([e.Quantity, e.Cost_Basis, hs.Type, hs.Amount], [500, 232210, 'Record', 0], 'split replaces qty, keeps cost, Record type');
const cBefore = cash(1);
T({ Date: '2026-06-29', Effect: 'Distribution', Symbol: 'HONA', Quantity: 500, Price: null, Amount: 0 });
e = led(1, 'HONA');
eq([e.Quantity, e.Cost_Basis], [500, 0], 'distribution new entry with cost 0');
eq(cash(1), cBefore, 'distribution does not change cash');
T({ Date: '2026-07-01', Effect: 'Distribution', Symbol: 'HONA', Quantity: 50, Amount: 0 });
eq(led(1, 'HONA').Quantity, 550, 'distribution adds to existing qty');

// ── Cash / Other effects
const cb = cash(1);
const div = T({ Category: 'Dividend', Effect: 'Cash', Symbol: 'MSFT', Quantity: 0, Price: null, Amount: 910 });
eq([cash(1), div.Type], [cb + 910, 'Cash'], 'dividend adds cash');
eq(led(1, 'MSFT'), null, 'dividend does not touch ledger');
const oth = T({ Category: 'Other', Effect: 'Other', Symbol: 'SPAXX', Quantity: 760.68, Price: 1, Amount: -760.68 });
eq([cash(1), oth.Type, led(1, 'SPAXX')], [cb + 910, 'Other', null], 'Other effect changes nothing');

// ── Options: sell to open 20 calls, buy to close 20 (Amount -1413.27)
const sym = 'NVDA20270115C360';
T({ Category: 'Option', Symbol: sym, Quantity: -20, Price: 3, Amount: 5987 });
let o = Engine.activeEntry('Options', 1, sym);
eq([o.Quantity, o.Cost_Basis, o.Asset, o.Expiration_Date, o.Strike], [-20, -5987, 'NVDA', '2027-01-15', 360], 'option opened');
T({ Category: 'Option', Symbol: sym, Quantity: 8, Price: 0.7, Amount: -565.31 });
o = Engine.activeEntry('Options', 1, sym);
eq([o.Quantity, o.Cost_Basis], [-12, -3592.2], 'option partially closed (proportional)');
T({ Category: 'Option', Symbol: sym, Quantity: 12, Price: 0.7, Amount: -847.96 });
o = Engine.activeEntry('Options', 1, sym);
eq([o.Quantity, o.Cost_Basis, o.Active], [0, 0, 1], 'option closed, qty 0 stays active');
eq(led(1, sym), null, 'options never in Ledger');

// ── Edit: latest transaction -> rebuilt from parent
const a1 = T({ Account_ID: 2, Symbol: 'AAA', Quantity: 100, Price: 10, Amount: -1000 });
const a2 = T({ Account_ID: 2, Date: '2026-09-05', Symbol: 'AAA', Quantity: 50, Price: 10, Amount: -500 });
eq([led(2, 'AAA').Quantity, cash(2)], [150, -1500], 'two buys');
let r = Engine.editTransaction(a2, { Quantity: 60, Amount: -600 });
e = led(2, 'AAA');
eq([e.Quantity, e.Cost_Basis, r.warning, cash(2)], [160, 1600, false, -1600], 'edit latest: parent + edited, cash delta');
eq(DB.query('SELECT Quantity FROM Ledger WHERE Holding_ID=?', [e.Parent_ID])[0].Quantity, 150, 'new entry parented to superseded entry');
// Edit an older transaction -> applied in full, warning
r = Engine.editTransaction(a1, { Quantity: 120, Amount: -1200 });
e = led(2, 'AAA');
eq([e.Quantity, r.warning, cash(2)], [280, true, -1800], 'edit older: applied in full with warning; cash by delta only');
// Edit only the description: nothing else changes
r = Engine.editTransaction(DB.query('SELECT * FROM Transactions WHERE Transaction_ID=?', [a1.Transaction_ID])[0], { Description: 'note' });
eq([led(2, 'AAA').Quantity, cash(2), r.warning], [280, -1800, false], 'description edit has no effect');

// ── Delete
eq(Engine.isReferenced(a2.Transaction_ID), true, 'referenced transaction');
const a2row = DB.query('SELECT * FROM Transactions WHERE Transaction_ID=?', [a2.Transaction_ID])[0];
Engine.deleteTransaction(a2row);
eq([DB.query('SELECT Valid FROM Transactions WHERE Transaction_ID=?', [a2.Transaction_ID])[0].Valid, cash(2), led(2, 'AAA').Quantity],
   [0, -1200, 280], 'delete: invalid, cash reversed, ledger unchanged');
const c2 = T({ Account_ID: 2, Category: 'Interest', Effect: 'Cash', Symbol: null, Quantity: 0, Amount: 0.29 });
eq(Engine.isReferenced(c2.Transaction_ID), false, 'cash txn not referenced');

// ── Rebuild account 2: valid txns a1 (120) only -> 120 / 1200; manual edit discarded
Engine.supersede('Ledger', 2, 'AAA', led(2, 'AAA'), 999, 1, null);
T({ Account_ID: 2, Effect: 'Distribution', Symbol: 'ZZZ', Quantity: 5, Amount: 0 });
DB.run('UPDATE Ledger SET Active=0 WHERE Account_ID=2 AND Symbol=?', ['ZZZ']);   // manually deactivated
let counts = Engine.rebuildAccount(2);
e = led(2, 'AAA');
eq([e.Quantity, e.Cost_Basis], [120, 1200], 'rebuild replays valid transactions, discards manual edit');
eq(led(2, 'ZZZ') && led(2, 'ZZZ').Quantity, 5, 'rebuild restores replayed positions');
// Rebuild account 1 matches the incremental chain (all imported in date order except the split/HON test which is dated earlier)
const before1 = DB.query('SELECT Symbol, Quantity, Cost_Basis FROM Ledger WHERE Account_ID=1 AND Active=1 ORDER BY Symbol');
Engine.rebuildAccount(1);
const after1 = DB.query('SELECT Symbol, Quantity, Cost_Basis FROM Ledger WHERE Account_ID=1 AND Active=1 ORDER BY Symbol');
eq(after1.filter(x => x.Symbol !== 'HON'), before1.filter(x => x.Symbol !== 'HON'), 'rebuild matches incremental chain');
eq(Engine.activeEntry('Options', 1, sym).Quantity, 0, 'rebuild keeps closed option entry at 0');

// ── Snapshot (Import Holdings replace)
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X3','Snap',100)");
let s = Engine.applySnapshot(3, '2026-10-01', [
  { symbol: 'AIRR', quantity: 2000, costBasis: 184782.79 },
  { symbol: 'AMZN', quantity: 2600, costBasis: 279739.16 },
  { symbol: '-NVDA270115C360', quantity: -20, costBasis: -5987 }], 5000);
eq([led(3, 'AIRR').Cost_Basis, led(3, 'AMZN').Quantity, Engine.activeEntry('Options', 3, sym).Quantity, cash(3)],
   [184782.79, 2600, -20, 5000], 'snapshot sets positions and cash');
const cashTxn = DB.query("SELECT * FROM Transactions WHERE Account_ID=3 AND Description='Opening cash balance'")[0];
eq([cashTxn.Amount, cashTxn.Type], [4900, 'Cash'], 'opening cash amount = total - current');
eq(DB.query("SELECT Price FROM Transactions WHERE Account_ID=3 AND Effect='Snapshot' ORDER BY Transaction_ID").map(r => r.Price),
   [184782.79 / 2000, 279739.16 / 2600, 2.9935], 'snapshot unit prices (options: per underlying share, x100)');
s = Engine.applySnapshot(3, '2026-10-02', [{ symbol: 'AIRR', quantity: 1500, costBasis: 138587.09 }], 3000);
eq([led(3, 'AIRR').Quantity, led(3, 'AMZN'), Engine.activeEntry('Options', 3, sym), cash(3), s.deactivated],
   [1500, null, null, 3000, 2], 're-snapshot replaces and deactivates missing symbols');
s = Engine.applySnapshot(3, '2026-10-03', [{ symbol: 'AIRR', quantity: 1500, costBasis: 138587.09 }], null);
eq(cash(3), 3000, 'snapshot without cash rows leaves cash unchanged');
Engine.rebuildAccount(3);
eq([led(3, 'AIRR').Quantity, led(3, 'AIRR').Cost_Basis], [1500, 138587.09], 'rebuild replays snapshots');
Engine.applySnapshot(3, '2026-10-04', [{ symbol: 'AIRR', quantity: 1500, costBasis: 138587.09 },
                                       { symbol: 'NVDA 01/15/2027 360.00 C', quantity: -3, costBasis: -960.5 }], null);
Engine.rebuildAccount(3);
eq(Engine.activeEntry('Options', 3, sym).Cost_Basis, -960.5, 'rebuild restores the option snapshot cost (x100)');

// ── RSU: Record type, no cash, cost basis = quantity × closing price on the vesting date
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X9','RSU',0)");
const A9 = DB.query("SELECT Account_ID FROM Accounts WHERE Account='X9'")[0].Account_ID;
DB.run("INSERT INTO Prices (Date, Symbol, Price) VALUES ('2026-03-13','MSFT',400),('2026-03-16','MSFT',410.5),('2026-01-02','MSFT',380)");
eq(Engine.priceOn('MSFT', '2026-03-16'), 410.5, 'price on the vesting date');
eq(Engine.priceOn('MSFT', '2026-03-15'), 400, 'weekend vesting uses the last close before it');
eq(Engine.priceOn('MSFT', '2026-02-20'), null, 'no close within the lookback window');
eq(Engine.resolveAmount({ amount: 4105, quantity: 10, price: 410.5, effect: 'RSU', symbol: 'MSFT' }), 0, 'RSU amount is 0');
const rsu = Engine.record({ Account_ID: A9, Date: '2026-03-16', Effect: 'RSU', Category: 'Equity', Symbol: 'MSFT',
                            Quantity: 10, Price: Engine.priceOn('MSFT', '2026-03-16'), Amount: 0 });
eq([rsu.Type, led(A9, 'MSFT').Quantity, led(A9, 'MSFT').Cost_Basis, cash(A9)], ['Record', 10, 4105, 0], 'RSU vest: qty and cost added, cash unchanged');
T({ Account_ID: A9, Date: '2026-04-01', Symbol: 'MSFT', Quantity: -4, Price: 420, Amount: 1680 });
Engine.record({ Account_ID: A9, Date: '2026-06-15', Effect: 'RSU', Category: 'Equity', Symbol: 'MSFT', Quantity: 5, Price: 450, Amount: 0 });
eq([led(A9, 'MSFT').Quantity, led(A9, 'MSFT').Cost_Basis], [11, 4713], 'second vest adds to the averaged basis');
Engine.rebuildAccount(A9);
eq([led(A9, 'MSFT').Quantity, led(A9, 'MSFT').Cost_Basis], [11, 4713], 'rebuild replays RSU vests');
ok(Engine.EFFECTS.includes('RSU') && Engine.EFFECT_TYPE.RSU === 'Record', 'RSU effect available (Rules/Transactions dropdowns)');

// ── Transaction atomicity
(async () => {
  const n0 = DB.query('SELECT COUNT(*) n FROM Transactions')[0].n;
  try { await DB.transaction(() => { T({ Symbol: 'ROLL', Quantity: 1, Amount: -1 }); throw new Error('x'); }); } catch {}
  eq(DB.query('SELECT COUNT(*) n FROM Transactions')[0].n, n0, 'rollback undoes record()');
  eq(led(1, 'ROLL'), null, 'rollback undoes ledger');
})();

// Engine: option symbols, rule classification, amounts, ledger/options arithmetic, edit/delete/rebuild, snapshots (js/engine.js)
DB.createNew();
eq(DB.query('SELECT Schema_Version v FROM Info')[0].v, '2.3', 'schema version');
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
eq(cls('Cash Dividend', ''), ['import', 'Cash', 'Dividend', 'Cash'], 'dividend without symbol: rule 260 (Cash Div, no symbol required)');
eq(cls('Qualified Dividend', ''), ['unrecognized', null, null, null], 'other dividend without symbol unrecognized (rule 120 requires a symbol)');
eq([cls('Exchange In', '')[0], cls('SHORT VS MARGIN', 'X')[0], cls('fee', '')[2]], ['ignored', 'ignored', 'Fee'], 'rules 240, 200, 250 (case insensitive)');
eq(cls('expired call (GLD)', ' -GLD260821C515')[0], 'import', 'EXPIRED is case insensitive');
eq(cls('DEPOSIT Electronic', ''), ['import', 'Cash', 'Transfer', 'Cash'], 'deposit case-insensitive');
eq(cls('Something new', 'X'), ['unrecognized', null, null, null], 'unknown action');

// ── Amounts
eq(Engine.resolveAmount({ amount: -976.85, effect: 'Cash', sign: -1 }), -976.85, 'tax keeps negative');
eq(Engine.resolveAmount({ amount: 976.85, effect: 'Cash', sign: -1 }), -976.85, 'tax sign forced');
eq(Engine.resolveAmount({ amount: -500, effect: 'Cash', sign: 1 }), 500, 'deposit sign forced');
eq(Engine.resolveAmount({ amount: null, quantity: 100, price: 10.5, effect: 'Trade', symbol: 'AAPL' }), -1050, 'computed equity amount');
eq(Engine.resolveAmount({ amount: null, quantity: -2, price: 3.2, effect: 'Trade', symbol: 'NVDA20270115C360' }), 640, 'computed option amount x100');
eq(Engine.resolveAmount({ amount: 110095, quantity: 500, effect: 'Distribution' }), 110095, 'distribution keeps the file amount (cost basis)');
eq(Engine.resolveAmount({ amount: 113900, quantity: 500, effect: 'Split' }), 113900, 'split keeps the file amount (cost basis)');
eq([Engine.resolveAmount({ amount: null, quantity: 500, price: 10, effect: 'Split', symbol: 'HON' }),
    Engine.resolveAmount({ amount: null, quantity: 500, price: 10, effect: 'Distribution', symbol: 'HONA' })], [0, 0],
   'split/distribution without a file amount: 0, never computed from the price');
eq(Engine.resolveAmount({ amount: 5000, quantity: 10, effect: 'RSU' }), 0, 'RSU amount 0');

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
const cBefore = cash(1);
const hs = T({ Date: '2026-06-29', Effect: 'Split', Symbol: 'HON', Quantity: 500, Price: null, Amount: 113900 });
e = led(1, 'HON');
eq([e.Quantity, e.Cost_Basis, hs.Type, hs.Amount], [500, 113900, 'Record', 113900], 'split replaces qty and cost basis (Amount), Record type');
eq(cash(1), cBefore, 'split does not change cash');
T({ Date: '2026-06-29', Effect: 'Distribution', Symbol: 'HONA', Quantity: 500, Price: null, Amount: 110095 });
e = led(1, 'HONA');
eq([e.Quantity, e.Cost_Basis], [500, 110095], 'distribution new entry: quantity and cost basis from the Amount');
eq(cash(1), cBefore, 'distribution does not change cash');
T({ Date: '2026-07-01', Effect: 'Distribution', Symbol: 'HONA', Quantity: 50, Amount: 905 });
eq([led(1, 'HONA').Quantity, led(1, 'HONA').Cost_Basis], [550, 111000], 'distribution adds quantity and Amount to the existing entry');
T({ Date: '2026-07-02', Effect: 'Distribution', Symbol: 'HONA', Quantity: 50, Amount: 0 });
eq([led(1, 'HONA').Quantity, led(1, 'HONA').Cost_Basis], [600, 111000], 'distribution with Amount 0 keeps the cost basis');

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

// ── Edit: latest transaction -> its ledger record recalculated in place from the parent
const a1 = T({ Account_ID: 2, Symbol: 'AAA', Quantity: 100, Price: 10, Amount: -1000 });
const a2 = T({ Account_ID: 2, Date: '2026-09-05', Symbol: 'AAA', Quantity: 50, Price: 10, Amount: -500 });
eq([led(2, 'AAA').Quantity, cash(2)], [150, -1500], 'two buys');
const txnRow = id => DB.query('SELECT t.*, a.Name FROM Transactions t JOIN Accounts a ON a.Account_ID = t.Account_ID WHERE Transaction_ID=?', [id])[0];
const ledCount = () => DB.query("SELECT COUNT(*) AS n FROM Ledger WHERE Account_ID=2 AND Symbol='AAA'")[0].n;
const recA = led(2, 'AAA'), recB = DB.query('SELECT * FROM Ledger WHERE Holding_ID=?', [recA.Parent_ID])[0], n0 = ledCount();
eq([Engine.editImpact(txnRow(a2.Transaction_ID), { Quantity: 60 }).impact, Engine.editImpact(txnRow(a1.Transaction_ID), { Quantity: 60 }).impact,
    Engine.editImpact(txnRow(a1.Transaction_ID), { Description: 'x' }).impact], ['latest', 'earlier', 'none'], 'editImpact: latest / earlier / none');
let r = Engine.editTransaction(txnRow(a2.Transaction_ID), { Quantity: 60, Amount: -600 });
e = led(2, 'AAA');
eq([r.impact, e.Holding_ID, e.Parent_ID, e.Quantity, e.Cost_Basis, ledCount(), cash(2)], ['latest', recA.Holding_ID, recB.Holding_ID, 160, 1600, n0, -1600],
   'edit latest: active record A replaced in place by parent B + edited transaction; cash delta');
eq(DB.query('SELECT Quantity FROM Ledger WHERE Holding_ID=?', [recB.Holding_ID])[0].Quantity, 100, 'parent record unchanged');
// Edit an earlier transaction, "update the transaction only": ledger unchanged
r = Engine.editTransaction(txnRow(a1.Transaction_ID), { Quantity: 120, Amount: -1200 });
eq([r.impact, r.rebuilt, led(2, 'AAA').Quantity, led(2, 'AAA').Cost_Basis, cash(2), DB.query('SELECT Quantity FROM Transactions WHERE Transaction_ID=?', [a1.Transaction_ID])[0].Quantity],
   ['earlier', false, 160, 1600, -1800, 120], 'edit earlier, transaction only: transaction and cash updated, ledger unchanged');
// Edit only the description: nothing else changes
r = Engine.editTransaction(txnRow(a1.Transaction_ID), { Description: 'note' });
eq([led(2, 'AAA').Quantity, cash(2), r.impact], [160, -1800, 'none'], 'description edit has no effect');
// Edit an earlier transaction with "rebuild": chain recalculated in place from the record referencing it
r = Engine.editTransaction(txnRow(a1.Transaction_ID), { Quantity: 130, Amount: -1300 }, { rebuild: true });
e = led(2, 'AAA');
eq([r.impact, r.rebuilt, e.Holding_ID, e.Quantity, e.Cost_Basis, ledCount(), cash(2)], ['earlier', true, recA.Holding_ID, 130 + 60, 1300 + 600, n0, -1900],
   'edit earlier + rebuild: records from the referencing one to the active one recalculated in place');
eq([DB.query('SELECT Quantity, Cost_Basis, Date FROM Ledger WHERE Holding_ID=?', [recB.Holding_ID])[0]], [{ Quantity: 130, Cost_Basis: 1300, Date: '2026-09-01' }],
   'the record referencing the edited transaction is recalculated too');
r = Engine.editTransaction(txnRow(a1.Transaction_ID), { Date: '2026-08-15' }, { rebuild: true });
eq([DB.query('SELECT Date FROM Ledger WHERE Holding_ID=?', [recB.Holding_ID])[0].Date, led(2, 'AAA').Quantity], ['2026-08-15', 190],
   'rebuild takes the edited date');
// Not applied to the ledger ("unlinked"): transaction only, or rebuild the asset from all of its transactions
const o1 = T({ Account_ID: 2, Date: '2026-09-07', Effect: 'Other', Category: 'Equity', Symbol: 'AAA', Quantity: 10, Amount: 0 });
eq(Engine.editImpact(txnRow(o1.Transaction_ID), { Effect: 'Trade', Amount: -100 }).impact, 'unlinked', 'editImpact: unlinked');
r = Engine.editTransaction(txnRow(o1.Transaction_ID), { Effect: 'Trade', Amount: -100 });
eq([r.impact, led(2, 'AAA').Quantity, cash(2)], ['unlinked', 190, -2000], 'unlinked, transaction only: ledger unchanged');
r = Engine.editTransaction(txnRow(o1.Transaction_ID), { Amount: -110 }, { rebuild: true });
eq([r.impact, r.rebuilt, led(2, 'AAA').Quantity, led(2, 'AAA').Cost_Basis, led(2, 'AAA').Transaction_ID], ['unlinked', true, 200, 2010, o1.Transaction_ID],
   'unlinked + rebuild: the asset replayed from all of its transactions (new active record)');
// Moving the latest transaction to another symbol: the old record falls back to its parent, the new pair gets it
const m1 = T({ Account_ID: 2, Date: '2026-09-10', Symbol: 'MMM', Quantity: 5, Amount: -50 });
const mRec = led(2, 'MMM');
r = Engine.editTransaction(txnRow(m1.Transaction_ID), { Symbol: 'NNN' });
eq([r.impact, DB.query('SELECT Quantity, Active FROM Ledger WHERE Holding_ID=?', [mRec.Holding_ID])[0], led(2, 'NNN').Quantity],
   ['latest', { Quantity: 0, Active: 1 }, 5], 'moved to another symbol: old record back to its parent state (0), new pair applied');

// ── Delete
eq(Engine.isReferenced(a2.Transaction_ID), true, 'referenced transaction');
const a2row = DB.query('SELECT * FROM Transactions WHERE Transaction_ID=?', [a2.Transaction_ID])[0];
Engine.deleteTransaction(a2row);
eq([DB.query('SELECT Valid FROM Transactions WHERE Transaction_ID=?', [a2.Transaction_ID])[0].Valid, cash(2), led(2, 'AAA').Quantity],
   [0, -2060 + 600, 200], 'delete: invalid, cash reversed, ledger unchanged');
const c2 = T({ Account_ID: 2, Category: 'Interest', Effect: 'Cash', Symbol: null, Quantity: 0, Amount: 0.29 });
// Delete with the ledger choice: latest -> active record back to its parent in place; earlier -> unchanged or rebuilt in place
const d1 = T({ Account_ID: 2, Date: '2026-09-20', Symbol: 'DDD', Quantity: 100, Amount: -1000 });
const d2 = T({ Account_ID: 2, Date: '2026-09-21', Symbol: 'DDD', Quantity: 20, Amount: -300 });
const d3 = T({ Account_ID: 2, Date: '2026-09-22', Symbol: 'DDD', Quantity: 30, Amount: -600 });
const dActive = led(2, 'DDD'), dCount = () => DB.query("SELECT COUNT(*) AS n FROM Ledger WHERE Account_ID=2 AND Symbol='DDD'")[0].n;
eq([Engine.deleteImpact(txnRow(d3.Transaction_ID)).impact, Engine.deleteImpact(txnRow(d1.Transaction_ID)).impact, Engine.deleteImpact(txnRow(c2.Transaction_ID)).impact],
   ['latest', 'earlier', 'none'], 'deleteImpact: latest / earlier / none');
let rd = Engine.deleteTransaction(txnRow(d3.Transaction_ID));
eq([rd.impact, led(2, 'DDD').Holding_ID, led(2, 'DDD').Quantity, led(2, 'DDD').Cost_Basis, dCount()], ['latest', dActive.Holding_ID, 120, 1300, 3],
   'delete latest: active record replaced in place by its parent state');
rd = Engine.deleteTransaction(txnRow(d1.Transaction_ID));
eq([rd.impact, rd.rebuilt, led(2, 'DDD').Quantity, DB.query('SELECT Valid FROM Transactions WHERE Transaction_ID=?', [d1.Transaction_ID])[0].Valid],
   ['earlier', false, 120, 0], 'delete earlier, transaction only: ledger unchanged');
DB.run('UPDATE Transactions SET Valid=1 WHERE Transaction_ID=?', [d1.Transaction_ID]);   // restore and delete with rebuild
rd = Engine.deleteTransaction(txnRow(d1.Transaction_ID), { rebuild: true });
eq([rd.impact, rd.rebuilt, led(2, 'DDD').Holding_ID, led(2, 'DDD').Quantity, led(2, 'DDD').Cost_Basis, dCount()], ['earlier', true, dActive.Holding_ID, 20, 300, 3],
   'delete earlier + rebuild: chain recalculated in place without the deleted transaction');
eq(Engine.isReferenced(c2.Transaction_ID), false, 'cash txn not referenced');

// ── Rebuild account 2: valid AAA txns a1 (130, -1300) + o1 (10, -110) -> 140 / 1410; manual edit discarded
Engine.supersede('Ledger', 2, 'AAA', led(2, 'AAA'), 999, 1, null);
T({ Account_ID: 2, Effect: 'Distribution', Symbol: 'ZZZ', Quantity: 5, Amount: 0 });
DB.run('UPDATE Ledger SET Active=0 WHERE Account_ID=2 AND Symbol=?', ['ZZZ']);   // manually deactivated
let counts = Engine.rebuildAccount(2);
e = led(2, 'AAA');
eq([e.Quantity, e.Cost_Basis], [140, 1410], 'rebuild replays valid transactions, discards manual edit');
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

// ── Editing a holdings snapshot transaction (Effect Snapshot) — regression: the Transactions form had no
// "Snapshot" effect option, so the edit was saved with an empty effect and failed with "undefined"
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X8','Snap edit',0)");
const A8 = DB.query("SELECT Account_ID FROM Accounts WHERE Account='X8'")[0].Account_ID;
Engine.applySnapshot(A8, '2026-01-02', [{ symbol: 'SNAPX', quantity: 100, costBasis: 5000 }], null);
const snapTxn = DB.query("SELECT t.*, a.Name FROM Transactions t JOIN Accounts a ON a.Account_ID = t.Account_ID WHERE t.Account_ID=? AND t.Symbol='SNAPX'", [A8])[0];
let r8 = Engine.editTransaction(snapTxn, { Price: 60, Effect: 'Snapshot', Type: undefined, Amount: 0 });
eq([r8.impact, led(A8, 'SNAPX').Quantity, led(A8, 'SNAPX').Cost_Basis, DB.query('SELECT Effect, Type, Price FROM Transactions WHERE Transaction_ID=?', [snapTxn.Transaction_ID])[0]],
   ['latest', 100, 6000, { Effect: 'Snapshot', Type: 'Record', Price: 60 }], 'snapshot price edit: entry rebuilt, effect/type kept (undefined changes ignored)');
let err8 = null; try { Engine.editTransaction(snapTxn, { Effect: '' }); } catch (e) { err8 = e; }
ok(err8 instanceof Error && /Unknown transaction effect/.test(err8.message), 'empty effect rejected with a clear message: ' + (err8 && err8.message));
err8 = null; try { Engine.record({ Account_ID: A8, Date: '2026-01-03', Effect: 'Bogus', Symbol: 'SNAPX', Quantity: 1, Amount: -1 }); } catch (e) { err8 = e; }
ok(err8 instanceof Error && /Unknown transaction effect "Bogus"/.test(err8.message), 'unknown effect rejected on insert');

// ── Ledger.Date: the date of the reference transaction, for every entry written above
// (trades, edits, rebuilds, snapshots, splits, distributions, RSU vests)
eq(DB.query(`SELECT COUNT(*) AS n FROM Ledger l LEFT JOIN Transactions t ON t.Transaction_ID = l.Transaction_ID
             WHERE l.Transaction_ID IS NOT NULL AND (l.Date IS NULL OR l.Date <> t.Date)`)[0].n, 0,
   'every Ledger entry is dated by its reference transaction');
eq(DB.query("SELECT COUNT(*) AS n FROM Ledger WHERE Transaction_ID IS NULL AND Date <> substr(Timestamp, 1, 10)")[0].n, 0,
   'manual Ledger edits are dated on the day of the edit');
const rebuiltA9 = led(A9, 'MSFT');
eq(rebuiltA9.Date, DB.query('SELECT Date FROM Transactions WHERE Transaction_ID=?', [rebuiltA9.Transaction_ID])[0].Date,
   'rebuilt entry dated by the last replayed transaction');

// ── Balance: every cash change supersedes the account's active Balance record
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('BAL','Balance test',0)");
const BA = DB.query("SELECT Account_ID FROM Accounts WHERE Account='BAL'")[0].Account_ID;
const bals = () => DB.query('SELECT Balance_ID, Parent_ID, Transaction_ID, Date, Cash, Active FROM Balance WHERE Account_ID=? ORDER BY Balance_ID', [BA]);
const activeBal = () => bals().filter(b => b.Active);
const bDep = Engine.record({ Account_ID: BA, Date: '2026-02-01', Effect: 'Cash', Category: 'Transfer', Amount: 1000, Currency: 'USD' });
const bBuy = Engine.record({ Account_ID: BA, Date: '2026-02-05', Effect: 'Trade', Category: 'Equity', Symbol: 'BALX', Quantity: 10, Price: 30, Amount: -300, Currency: 'USD' });
Engine.record({ Account_ID: BA, Date: '2026-02-06', Effect: 'Distribution', Category: 'Equity', Symbol: 'BALY', Quantity: 5, Amount: 100, Currency: 'USD' });
let bl = bals();
eq(bl.map(b => [b.Transaction_ID, b.Date, b.Cash, b.Active]), [[bDep.Transaction_ID, '2026-02-01', 1000, 0], [bBuy.Transaction_ID, '2026-02-05', 700, 1]],
   'cash-changing transactions create Balance records (dated by the transaction); a distribution does not');
eq(bl[1].Parent_ID, bl[0].Balance_ID, 'Balance record references the previous one');
Engine.editTransaction(bBuy, { Amount: -350 });
eq([activeBal().length, activeBal()[0].Cash, activeBal()[0].Transaction_ID, activeBal()[0].Parent_ID], [1, 650, bBuy.Transaction_ID, bl[1].Balance_ID],
   'edit: new Balance record with the changed cash, linked to the edited transaction');
Engine.deleteTransaction({ ...bDep });
eq([activeBal()[0].Cash, activeBal()[0].Transaction_ID, activeBal()[0].Date], [-350, bDep.Transaction_ID, '2026-02-01'], 'delete: reversal recorded');
const nBefore = bals().length;
Engine.setCash(BA, -350);
eq(bals().length, nBefore, 'manual cash edit without a change: no record');
Engine.setCash(BA, 25);
eq([activeBal()[0].Cash, activeBal()[0].Transaction_ID, activeBal()[0].Date, cash(BA)], [25, null, _nowTs().slice(0, 10), 25],
   'manual cash edit (Accounts view): record without a transaction, dated today');
eq(DB.query('SELECT COUNT(*) AS n FROM Accounts a JOIN Balance b ON b.Account_ID = a.Account_ID AND b.Active = 1 WHERE ROUND(b.Cash, 2) <> ROUND(a.Cash, 2)')[0].n, 0,
   'active Balance record = Accounts.Cash for every account');

// ── rebuildPair (Ledger view Rebuild): only the selected account + symbol is rebuilt
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('RP','Pair rebuild',0)");
const RP = DB.query("SELECT Account_ID FROM Accounts WHERE Account='RP'")[0].Account_ID;
Engine.record({ Account_ID: RP, Date: '2026-03-01', Effect: 'Trade', Category: 'Equity', Symbol: 'PA', Quantity: 10, Amount: -100, Currency: 'USD' });
Engine.record({ Account_ID: RP, Date: '2026-03-02', Effect: 'Trade', Category: 'Equity', Symbol: 'PA', Quantity: 5, Amount: -60, Currency: 'USD' });
Engine.record({ Account_ID: RP, Date: '2026-03-01', Effect: 'Trade', Category: 'Equity', Symbol: 'PB', Quantity: 7, Amount: -70, Currency: 'USD' });
Engine.supersede('Ledger', RP, 'PA', led(RP, 'PA'), 999, 1, null);   // manual edits of both pairs
Engine.supersede('Ledger', RP, 'PB', led(RP, 'PB'), 888, 1, null);
const rp = Engine.rebuildPair(RP, 'PA');
eq([rp, led(RP, 'PA').Quantity, led(RP, 'PA').Cost_Basis, led(RP, 'PB').Quantity], [{ qty: 15, cost: 160, transactions: 2 }, 15, 160, 888],
   'rebuildPair: the pair replayed from its transactions (manual edit discarded); other symbols of the account untouched');
DB.run("UPDATE Transactions SET Valid=0 WHERE Account_ID=? AND Symbol='PB'", [RP]);
eq([Engine.rebuildPair(RP, 'PB'), led(RP, 'PB')], [{ qty: 0, cost: 0, transactions: 0 }, null], 'rebuildPair without valid transactions: entry deactivated');

// ── Transaction atomicity
(async () => {
  const n0 = DB.query('SELECT COUNT(*) n FROM Transactions')[0].n;
  try { await DB.transaction(() => { T({ Symbol: 'ROLL', Quantity: 1, Amount: -1 }); throw new Error('x'); }); } catch {}
  eq(DB.query('SELECT COUNT(*) n FROM Transactions')[0].n, n0, 'rollback undoes record()');
  eq(led(1, 'ROLL'), null, 'rollback undoes ledger');
})();

// CSV parsing, row preparation, Import transactions and Import holdings (js/import.js).
// The broker example files live in examples/ (not in the repo); those checks are skipped when absent.
const EX = __ROOT + '/examples/';
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X1','Fidelity',0),('X2','Schwab',0)");
const cash = id => DB.query('SELECT Cash FROM Accounts WHERE Account_ID=?', [id])[0].Cash;
const led  = (acc, sym) => Engine.activeEntry('Ledger', acc, sym);
const m = (col) => col ? { col, pattern: null } : null;

// ── CSV parsing basics
let csv = Import.parseCsv('\uFEFF\n\n"A","B",\n1,"x, y",\n2,"say ""hi""",\n\n"Disclaimer text"\n');
eq(csv.headers, ['A', 'B'], 'BOM, leading blank rows and trailing header comma handled');
eq(csv.rows.length, 3, 'blank lines dropped');
eq(csv.rows[1], ['2', 'say "hi"'], 'escaped quotes');
eq(Import.parseCsv('A,B\n1,2').headerHash, Import.parseCsv('\uFEFF A , B \n3,4').headerHash, 'header hash ignores BOM and spaces');
ok(Import.parseCsv('A,B\n').headerHash !== Import.parseCsv('A,C\n').headerHash, 'different headers, different hash');
let rows = Import.prepareRows(csv, { A: m('A') }, false);
eq(rows.length, 2, 'trailing disclaimer row dropped (column count)');

if (__exists(EX + 'transactions1.csv') && __exists(EX + 'transactions2.csv')) {
// ── Fidelity transactions (corrected: the -1000 HON split row has an empty Symbol)
const fidText = __readFile(EX + 'transactions1.csv').replace(',"-1000",', ',"-1000",')
  .replace('(438516106) (Margin),HON,', '(438516106) (Margin),,');
csv = Import.parseCsv(fidText + '\n\n"The data and information in this spreadsheet is provided to you solely for your use"\n"Date downloaded 10/05/2026"\n');
const fidMap = { Date: m('Run Date'), Action: m('Action'), Symbol: m('Symbol'), Description: m('Description'),
                 Quantity: m('Quantity'), Price: m('Price ($)'), Amount: m('Amount ($)') };
rows = Import.prepareRows(csv, fidMap, true);
eq(rows.length, 37, 'Fidelity: 37 transaction rows, footer dropped');
eq(Import._dbg = rows[0].d, '2026-06-29', 'sorted earliest first');
let res = Import.processTransactions(rows, fidMap, () => 1);
eq(res.stats.ignored, 2, 'Fidelity: 2 JOURNALED rows ignored');
eq(res.unrecognized.map(u => u.action.slice(0, 20)), ['REVERSE SPLIT R/S TO'], 'Fidelity: only the symbol-less split row unrecognized');
eq(res.stats.imported, 34, 'Fidelity: 34 imported');
// cash change must equal the broker's Cash Balance change over the file
const bal = rows.map(r => parseFloat(r.vals[csv.headers.indexOf('Cash Balance ($)')]));
const amt = rows.map(r => parseFloat(r.vals[csv.headers.indexOf('Amount ($)')]) || 0);
const firstIdx = bal.findIndex(b => isFinite(b));
let lastIdx = -1; bal.forEach((b, i) => { if (isFinite(b)) lastIdx = i; });
const expected = Math.round((bal[lastIdx] - (bal[firstIdx] - amt[firstIdx])) * 100) / 100;
eq(Math.round(cash(1) * 100) / 100, expected, 'Fidelity: cash change equals Cash Balance column change');
eq([led(1, 'HON').Quantity, led(1, 'HONA').Quantity, led(1, 'HONA').Cost_Basis], [0, 500, 110095], 'HON split then sold 500; HONA distributed at the Amount (110095)');
eq(Engine.activeEntry('Options', 1, 'NVDA20270115C360').Quantity, 20, 'NVDA closing buy recorded on Options');
eq(DB.query("SELECT Type, Effect FROM Transactions WHERE Symbol='SPAXX' ORDER BY Effect").map(r => r.Type + '/' + r.Effect),
   ['Cash/Cash', 'Cash/Cash', 'Cash/Cash', 'Other/Other', 'Other/Other', 'Other/Other'], 'SPAXX dividends are Cash, reinvestments are Other');
eq(DB.query("SELECT Amount, Category FROM Transactions WHERE Category='Tax'")[0], { Amount: -976.85, Category: 'Tax' }, 'foreign tax');
eq([...res.newAssets.keys()].sort(), ['HON', 'HONA', 'IHI', 'SLVP', 'TFC', 'XME', 'ENS'].sort(), 'Fidelity: equity assets to create');
eq(led(1, 'XME').Quantity, -1000, 'XME sold without a position goes short (no opening position in this file)');

// Re-import: everything is a duplicate
res = Import.processTransactions(rows, fidMap, () => 1);
eq([res.stats.imported, res.stats.duplicates, res.stats.ignored], [0, 34, 2], 'Fidelity re-import: all duplicates');

// ── Schwab transactions (positive sale quantities, $ amounts, no symbol for interest)
csv = Import.parseCsv(__readFile(EX + 'transactions2.csv'));
const swMap = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Description: m('Description'),
                Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
rows = Import.prepareRows(csv, swMap, true);
res = Import.processTransactions(rows, swMap, () => 2);
eq([res.stats.imported, res.stats.ignored, res.unrecognized.length], [48, 0, 0], 'Schwab: all 48 rows imported');
const swTotal = Math.round(rows.reduce((s, r) => s + (parseFloat(r.vals[7].replace(/[$,]/g, '')) || 0), 0) * 100) / 100;
eq(Math.round(cash(2) * 100) / 100, swTotal, 'Schwab: cash equals sum of Amount column');
eq(DB.query("SELECT Quantity FROM Transactions WHERE Account_ID=2 AND Symbol='IJT' AND Date='2026-09-23'")[0].Quantity, -1000, 'Schwab sell quantity made negative');
eq(DB.query("SELECT COUNT(*) n FROM Transactions WHERE Account_ID=2 AND Category IN ('Interest','Margin') AND Symbol IS NULL")[0].n, 5, 'interest rows without symbol imported');
const bug = led(2, 'BUG');
eq([bug.Quantity, bug.Cost_Basis], [2000, 86149.9], 'BUG two buys same day');

} else {
  skip('examples/transactions1.csv and transactions2.csv not found: broker file checks not run');
  DB.run("INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES ('t',2,'BUG',2000,86149.9)");
  DB.run("INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Amount, Timestamp) VALUES (2,'2026-09-23','Trade','Equity','Trade','BUG',1,-1,'t')");
}

// Predating: importing an older transaction after newer ones
csv = Import.parseCsv('Date,Action,Symbol,Quantity,Price,Amount\n01/05/2026,Buy,BUG,10,$40,-$400\n');
const pm = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
res = Import.processTransactions(Import.prepareRows(csv, pm, true), pm, () => 2);
eq(res.predating.length, 1, 'predating transaction reported');

// Amount fallback when the file has no Amount column
csv = Import.parseCsv('Date,Action,Symbol,Quantity,Price\n2026-10-01,Buy,AAPL,10,250\n2026-10-02,Sell,NVDA 01/15/2027 360.00 C,-2,3.5\n');
const fm = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Quantity: m('Quantity'), Price: m('Price') };
res = Import.processTransactions(Import.prepareRows(csv, fm, true), fm, () => 2);
eq(DB.query("SELECT Amount FROM Transactions WHERE Date IN ('2026-10-01','2026-10-02') AND Effect='Trade' ORDER BY Date").map(r => r.Amount),
   [-2500, 700], 'amount computed from qty x price (x100 for options)');

// ── Import Holdings (positions snapshot) with cash rows: valued by Current Value, then Quantity, then Cost Basis
csv = Import.parseCsv('Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,\n' +
  'X1,Fidelity,SPAXX**,HELD IN MONEY MARKET,5000,,"$5,100.25",,\n' +
  'X1,Fidelity,AIRR,FIRST TR ETF,2000,$133.25,$266500.00,$184782.79,\n' +
  'X1,Fidelity, -NVDA270115C360,CALL NVDA,-20,$3.00,-$6000,-$5987.00,\n' +
  'X1,Fidelity,Pending Activity,,,,$12.00,,\n' +
  'X2,Schwab,AMZN,AMAZON,2600,$232.79,$605254.00,$279739.16,\n' +
  'X2,Schwab,Cash & Cash Investments,,,,$1000.00,,\n' +
  'X2,Schwab,USD***,,,,,,\n' +
  '"Date downloaded Oct-05-2026"\n');
const am = { Account: m('Account Number'), Symbol: m('Symbol'), Description: m('Description'), Quantity: m('Quantity'),
             CostBasis: m('Cost Basis Total'), CurrentValue: m('Current Value') };
rows = Import.prepareRows(csv, am, false);
eq(rows.length, 7, 'positions: footer dropped, trailing comma tolerated');
const accRes = (row) => ({ X1: 1, X2: 2 })[row.vals[0]] || null;
const snap = Import.collectSnapshot(rows, am, accRes);
eq([snap.perAccount.get(1).cash, snap.perAccount.get(2).cash, snap.perAccount.get(1).holdings.length, snap.skipped, snap.cashRowsWithoutValue],
   [5100.25, 1000, 2, 1, 1], 'cash rows use Current Value (not Quantity), Pending Activity skipped, cash row without any value counted');
const noCv = Import.collectSnapshot(rows, { ...am, CurrentValue: null }, accRes);
eq([noCv.perAccount.get(1).cash, noCv.perAccount.get(2).cash], [5000, null], 'without a Current Value column: Quantity, else no cash');
for (const [acc, a] of snap.perAccount) Engine.applySnapshot(acc, '2026-10-05', a.holdings, a.cash);
eq([cash(1), led(1, 'AIRR').Cost_Basis, Engine.activeEntry('Options', 1, 'NVDA20270115C360').Quantity, led(1, 'HONA')],
   [5100.25, 184782.79, -20, null], 'snapshot replaces account 1 (cash set, HONA deactivated)');
eq([Engine.activeEntry('Options', 1, 'NVDA20270115C360').Cost_Basis,
    DB.query("SELECT Price FROM Transactions WHERE Account_ID=1 AND Symbol='NVDA20270115C360' AND Effect='Snapshot'")[0].Price],
   [-5987, 2.9935], 'option snapshot: unit price = cost basis / (contracts x 100), cost basis kept');
eq([led(2, 'AMZN').Quantity, led(2, 'BUG')], [2600, null], 'snapshot replaces account 2');
eq(cash(2), 1000, 'account 2 cash set from its Current Value');

// Rows of accounts that are not found are counted first and never reach rule matching
csv = Import.parseCsv('Date,Account,Action,Symbol,Quantity,Price,Amount\n' +
  '2026-10-01,X1,Buy,ZZA,10,$5,-$50\n' +
  '2026-10-01,X1,Mystery action,ZZA,0,,$1\n' +
  '2026-10-01,NOPE,Mystery action,ZZB,0,,$1\n' +
  '2026-10-01,NOPE,JOURNALED VS X,ZZB,5,,$0\n' +
  '2026-10-01,NOPE,Buy,ZZB,1,$5,-$5\n');
const um = { Date: m('Date'), Account: m('Account'), Action: m('Action'), Symbol: m('Symbol'),
             Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
res = Import.processTransactions(Import.prepareRows(csv, um, true), um, row => row.vals[1] === 'X1' ? 1 : null);
eq([res.stats.unknownAccount, res.unrecognized.length, res.stats.ignored, res.stats.imported], [3, 1, 0, 1],
   'unknown-account rows counted before rule matching (not unrecognized, not ignored)');
eq(res.unrecognized.map(u => u.symbol), ['ZZA'], 'only unmatched rows of known accounts are listed');

// RSU rows: price from the stored daily closes on the vesting date, not from the file
DB.run("INSERT INTO Rules (Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect) VALUES (5, '^(RSU VEST)', 1, 1, 'Asset', 'RSU')");
DB.run("INSERT INTO Prices (Date, Symbol, Price) VALUES ('2026-09-15','RSUA',101.25)");
csv = Import.parseCsv('Date,Action,Symbol,Quantity,Price,Amount\n' +
  '2026-09-15,RSU VEST,RSUA,20,,\n' +
  '2026-09-16,RSU VEST,RSUB,7,$1.00,$0\n');
const rm = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
rows = Import.prepareRows(csv, rm, true);
eq(Import.rsuPriceRequests(rows, rm, () => 1), [{ symbol: 'RSUB', date: '2026-09-16' }], 'only RSU rows without a stored close need a fetch');
const cashBeforeRsu = cash(1);
res = Import.processTransactions(rows, rm, () => 1);
eq([res.stats.imported, led(1, 'RSUA').Cost_Basis, led(1, 'RSUB').Quantity, led(1, 'RSUB').Cost_Basis, cash(1)],
   [2, 2025, 7, 0, cashBeforeRsu], 'RSU: cost = qty x close on the date; missing close gives cost 0; cash unchanged');
eq(res.rsuWithoutPrice, [{ date: '2026-09-16', symbol: 'RSUB', qty: 7 }], 'RSU rows without a price are reported');
eq(DB.query("SELECT Type, Price, Amount FROM Transactions WHERE Symbol='RSUB'")[0], { Type: 'Record', Price: null, Amount: 0 }, 'file price not used for RSU');

// Alternative option symbol format in a transaction file is converted before recording
csv = Import.parseCsv('Date,Action,Symbol,Quantity,Price,Amount\n' +
  '2025-12-01,Sell,ANET 01/02/2026 137.00 C,-3,$2.10,$628.50\n' +
  '2025-12-15,Buy,ANET 01/02/2026 137.00 C,1,$0.50,-$50.65\n');
const om = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
res = Import.processTransactions(Import.prepareRows(csv, om, true), om, () => 1);
eq(DB.query("SELECT Symbol, Category, Quantity FROM Transactions WHERE Symbol LIKE 'ANET%' ORDER BY Date"),
   [{ Symbol: 'ANET20260102C137', Category: 'Option', Quantity: -3 }, { Symbol: 'ANET20260102C137', Category: 'Option', Quantity: 1 }],
   'alternative option symbols stored in the standard format');
const anet = Engine.activeEntry('Options', 1, 'ANET20260102C137');
eq([anet.Quantity, anet.Asset, anet.Expiration_Date, anet.Strike, led(1, 'ANET 01/02/2026 137.00 C')], [-2, 'ANET', '2026-01-02', 137, null],
   'option position recorded on the Options table, not the Ledger');

// ── Split / Distribution: the file's Amount is the cost basis; rows imported earlier with Amount 0 are duplicates
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('X1','Fidelity',1000)");
const sdMap = { Date: m('Date'), Action: m('Action'), Symbol: m('Symbol'), Quantity: m('Quantity'), Price: m('Price'), Amount: m('Amount') };
const sdCsv = 'Date,Action,Symbol,Quantity,Price,Amount\n'
  + '06/01/2026,YOU BOUGHT HONEYWELL,HON,1000,232.21,-232210\n'
  + '06/29/2026,REVERSE SPLIT R/S FROM HON,HON,500,,113900\n'
  + '06/29/2026,DISTRIBUTION SPINOFF HONA,HONA,500,,110095\n';
Engine.record({ Account_ID: 1, Date: '2026-06-23', Effect: 'Distribution', Category: 'Equity', Symbol: 'SMERY', Quantity: 4000,
  Price: null, Amount: 0, Hash: Engine.hash(1, '2026-06-23', 'SMERY', 4000, null, 0) });   // imported before: Amount 0
res = Import.processTransactions(Import.prepareRows(Import.parseCsv(sdCsv
  + '06/23/2026,DISTRIBUTION SIEMENS ENERGY,SMERY,4000,,146740\n'), sdMap, true), sdMap, () => 1);
eq([res.stats.imported, res.stats.duplicates], [3, 1], 'distribution stored earlier with Amount 0: duplicate');
eq([led(1, 'HON').Quantity, led(1, 'HON').Cost_Basis, led(1, 'HONA').Quantity, led(1, 'HONA').Cost_Basis, cash(1)],
   [500, 113900, 500, 110095, 1000 - 232210], 'split replaces quantity and cost basis, distribution adds both; cash unchanged by them');

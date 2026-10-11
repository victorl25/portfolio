// All app scripts load together in index.html order; Portfolio entry parser; date helpers
const order = ['dialogs', 'import', 'tab-portfolio', 'tab-accounts', 'tab-assets', 'tab-prices', 'tab-transactions',
               'tab-ledger', 'tab-options', 'tab-rules', 'tab-query', 'tab-reports', 'tab-analysis', 'tab-dividends', 'tab-gains', 'tab-trend', 'app'];
const html = __readFile(__ROOT + '/index.html');
const scripts = [...html.matchAll(/<script src="js\/([\w-]+)\.js">/g)].map(m => m[1]);
eq(scripts, ['schema', 'db', 'engine', ...order], 'index.html script order');
for (const g of ['PortfolioTab', 'AccountsTab', 'AssetsTab', 'PricesTab', 'TransactionsTab', 'LedgerTab', 'OptionsTab',
                 'RulesTab', 'QueryTab', 'ReportsTab', 'AnalysisTab', 'DividendsTab', 'GainsTab', 'TrendTab', 'Import', 'App', 'YahooFinance', 'cmdUpdatePrices',
                 '_upsertPrice', '_isoToDate', '_todayStr', '_addDaysStr'])
  ok(typeof (0, eval)(g) !== 'undefined', `global ${g} defined`);
eq(APP_VERSION, '2.3', 'APP_VERSION');

// Portfolio entry parser
const P = PortfolioTab.parseEntry;
eq(P('+100 AAPL $150'), { quantity: 100, symbol: 'AAPL', price: 150, date: null }, '+qty sym $price');
eq(P('-50 msft $200.5 2026-09-30'), { quantity: -50, symbol: 'MSFT', price: 200.5, date: '2026-09-30' }, '-qty with date');
eq(P('+1000 AAPL $350 2026-09-30').date, '2026-09-30', 'spec example');
eq(P('buy 100 AAPL $150'), { symbol: 'AAPL', price: 150, date: null, quantity: 100 }, 'buy');
eq(P('sold 50 shares of MSFT $291.5 2026-10-01'), { symbol: 'MSFT', price: 291.5, date: '2026-10-01', quantity: -50 }, 'sold shares of');
eq(P('sell all MSFT $291.5'), { symbol: 'MSFT', price: 291.5, date: null, quantity: null, all: true, sell: true }, 'sell all');
eq(P('-2 NVDA20270115C360 $3.20'), { quantity: -2, symbol: 'NVDA20270115C360', price: 3.2, date: null }, 'option entry');
eq(P('+100 AAPL @ 150'), null, '@ syntax rejected');
eq(P('buy 100 AAPL at 150'), null, 'at syntax rejected');
eq(P('+100 BRK.B $450'), { quantity: 100, symbol: 'BRK.B', price: 450, date: null }, 'dotted symbol');

// Date helpers
eq(_isoToDate('2026-10-02T13:30:00.000Z'), '2026-10-02', 'candle at market open');
eq(_isoToDate('2026-10-02T00:00:00.000Z'), '2026-10-02', 'candle at midnight UTC');
eq(_addDaysStr('2026-01-01', -365), '2025-01-01', 'year ago');
eq(_addDaysStr('2026-02-28', 1), '2026-03-01', 'add day');

// Analyze > Asset performance: one asset at a time, chart data and D3
ok(typeof AnalysisTab.openAsset === 'function' && typeof AnalysisTab.openAssetFor === 'function' && !AnalysisTab.openAssets,
   'Asset performance entry points (openAsset / openAssetFor), no multi-asset openAssets');
const menu = id => (html.match(new RegExp(`id="${id}">([^<]*)<`)) || [])[1];
const section = name => (html.match(new RegExp(`id="menu-${name}">[\\s\\S]*?</div>\\s*</div>`)) || [''])[0];
eq(['analyze-portfolio-performance', 'analyze-account-performance', 'analyze-asset-performance', 'report-themes']
     .map(k => menu('cmd-' + k)),
   ['Portfolio performance', 'Account performance', 'Asset performance', 'Investments by theme'], 'Analyze / Reports menu labels');
ok(!/cmd-report-portfolio-theme|cmd-report-account-theme/.test(html), 'Portfolio/Account by theme merged into Investments by theme');
ok(/Portfolio performance[\s\S]*Account performance[\s\S]*Asset performance/.test(section('analyze')) && !/by theme/.test(section('analyze')),
   'performance commands under Analyze');
ok(section('reports').includes('Investments by theme') && !/performance/.test(section('reports')), 'Investments by theme under Reports');
const appJs = __readFile(__ROOT + '/js/app.js');
const wired = id => (appJs.match(new RegExp(`cmd\\('${id}'\\)[^\\n]*?(\\w+Tab\\.\\w+)\\(`)) || [])[1];
eq(['cmd-analyze-portfolio-performance', 'cmd-analyze-account-performance', 'cmd-analyze-asset-performance', 'cmd-report-themes'].map(wired),
   ['ReportsTab.open', 'ReportsTab.openAccount', 'AnalysisTab.openAsset', 'AnalysisTab.openThemes'], 'menu commands wired to the reports');
ok(typeof LedgerTab.openFiltered === 'function', 'LedgerTab.openFiltered (theme drill-down)');
const ledJs = __readFile(__ROOT + '/js/tab-ledger.js');
ok(/btn-delete" disabled[^>]*>Delete</.test(ledJs) && !/Deactivate</.test(ledJs), 'Ledger form: Delete button (was Deactivate)');
ok(/UPDATE Ledger SET Active=0, Timestamp=\? WHERE Holding_ID=\?/.test(ledJs), 'Ledger Delete updates the Timestamp of the deactivated entry');
ok(/Engine\.rebuildPair\(accountId, symbol\)/.test(ledJs) && !/rebuildAccount/.test(ledJs), 'Ledger Rebuild: selected account + symbol only');
// Assets view: held assets only by default, all active assets with "Show all assets"
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('S1','A')");
DB.run("INSERT INTO Assets (Symbol, Active) VALUES ('HELD',1),('SOLD',1),('NEVER',1),('GONE',0)");
DB.run("INSERT INTO Ledger (Date, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Active) VALUES ('2026-01-01','t',1,'HELD',5,50,1),('2026-01-01','t',1,'SOLD',0,0,1)");
eq(AssetsTab.loadData(false).map(r => [r.Symbol, r.Quantity]), [['HELD', 5]], 'Assets view: owned assets only (default)');
eq(AssetsTab.loadData(true).map(r => [r.Symbol, r.Quantity]), [['HELD', 5], ['NEVER', 0], ['SOLD', 0]], 'Assets view, Show all assets: also quantity 0 (active assets)');
eq(AssetsTab.loadData().length, 1, 'Show all assets unchecked by default');
// Prices view: all active assets (outer join), with or without prices, plus priced symbols missing from Assets
DB.run("UPDATE Assets SET Description = Symbol || ' Inc'");
DB.run("INSERT INTO Prices (Date, Symbol, Price, Currency, Valid) VALUES ('2026-10-01','HELD',10,'USD',1),('2026-10-02','HELD',11,'USD',1),('2026-10-03','HELD',99,'USD',0),('2026-10-01','ORPHAN',5,'USD',1)");
eq(PricesTab.loadData().map(r => [r.Symbol, r.Description, r.Price, r.Date]),
   [['HELD', 'HELD Inc', 11, '2026-10-02'], ['NEVER', 'NEVER Inc', null, null], ['ORPHAN', null, 5, '2026-10-01'], ['SOLD', 'SOLD Inc', null, null]],
   'Prices view: every active asset with its latest valid price (empty without prices); priced symbols not in Assets kept; inactive assets left out');

// Reports > Investments by theme: value per Theme over the checked accounts; drill-down Ledger filter
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name, Cash, Active) VALUES ('T1','Brokerage',100,1),('T2','IRA',50,1),('T3','Empty',0,1),('T4','Closed',0,0)");
DB.run("INSERT INTO Assets (Symbol, Theme, Active) VALUES ('AAPL','Tech',1),('MSFT','Tech',1),('XOM','Energy',1),('ODD','',1)");
const thLed = (acc, sym, qty, active = 1) => DB.run(
  "INSERT INTO Ledger (Date, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Active) VALUES ('2026-01-02','t',?,?,?,0,?)", [acc, sym, qty, active]);
thLed(1, 'AAPL', 10); thLed(1, 'XOM', 5); thLed(2, 'MSFT', 2); thLed(2, 'AAPL', 1); thLed(2, 'ODD', 3); thLed(2, 'NEW', 4);
thLed(1, 'MSFT', 100, 0); thLed(3, 'XOM', 0);   // inactive entry, quantity 0: not held
DB.run("INSERT INTO Prices (Date, Symbol, Price, Valid) VALUES ('2026-10-01','AAPL',200,1),('2026-10-01','MSFT',400,1),('2026-10-01','XOM',100,1),('2026-10-01','ODD',10,1),('2026-10-01','NEW',5,1)");
eq(AnalysisTab.contributingAccounts().map(a => a.Name), ['Brokerage', 'IRA'], 'checkboxes: active accounts with holdings or cash');
const thRows = r => r.rows.map(x => [x.label, x.value]);
const all = AnalysisTab.computeThemes(null);
eq([thRows(all), all.grand, all.assetCount], [[['Tech', 2200 + 800], ['Energy', 500], ['Cash', 150], ['(No Theme)', 30 + 20]], 3700, 5],
   'all accounts: themes (symbols missing from Assets under (No Theme)) + cash, by value');
const ira = AnalysisTab.computeThemes([2]);
eq([thRows(ira), ira.grand], [[['Tech', 1000], ['(No Theme)', 50], ['Cash', 50]], 1100], 'one account checked: its holdings and cash only');
eq(AnalysisTab.computeThemes([]).rows.length, 0, 'no accounts checked: empty report');
const ledSyms = f => LedgerTab.loadData(f).map(r => `${r.Name}:${r.Symbol}`);
eq(ledSyms({ theme: 'Tech', accountIds: null }), ['Brokerage:AAPL', 'IRA:AAPL', 'IRA:MSFT'], 'theme drill-down: active Ledger entries of the theme, all accounts');
eq(ledSyms({ theme: 'Tech', accountIds: [2] }), ['IRA:AAPL', 'IRA:MSFT'], 'theme drill-down limited to the checked accounts');
eq(ledSyms({ theme: '', accountIds: null }), ['IRA:NEW', 'IRA:ODD'], '(No Theme) drill-down: blank theme and symbols missing from Assets');
eq([ledSyms({ theme: 'Energy', accountIds: [] }), ledSyms(undefined).length], [[], 6], 'no accounts: empty; unfiltered Ledger view unchanged');
DB.run("UPDATE Ledger SET Cost_Basis = 1500 WHERE Account_ID = 1 AND Symbol = 'AAPL' AND Active = 1");
DB.run("INSERT INTO Prices (Date, Symbol, Price, Valid) VALUES ('2026-09-01','AAPL',150,1),('2026-10-05','AAPL',90,0)");   // older; newer but invalid
DB.run("DELETE FROM Prices WHERE Symbol = 'NEW'");
const ledVal = sym => { const r = LedgerTab.loadData().find(x => x.Name === 'Brokerage' && x.Symbol === sym) || LedgerTab.loadData().find(x => x.Symbol === sym);
                        return [r.Value, r.GainLoss, r.GainLossPct, r.LastPrice, r.PriceDate]; };
eq(ledVal('AAPL'), [2000, 500, 500 / 1500 * 100, 200, '2026-10-01'],
   'Ledger Value = quantity x latest valid price; Gain/Loss = Value - Cost Basis; % Gain/Loss = Gain/Loss / |Cost Basis|');
eq(ledVal('NEW'), [null, null, null, null, null], 'Ledger: no stored price -> no Value, Gain/Loss or % Gain/Loss');
eq(ledVal('XOM').slice(0, 3), [500, 500, null], 'Ledger: cost basis 0 -> no % Gain/Loss');
DB.run("UPDATE Ledger SET Quantity = -2, Cost_Basis = -1000 WHERE Account_ID = 2 AND Symbol = 'MSFT' AND Active = 1");
eq(ledVal('MSFT').slice(0, 3), [-800, 200, 20], 'Ledger: short position (negative basis) -> % on the absolute basis');
ok(html.indexOf('lib/d3.min.js') > 0 && html.indexOf('lib/d3.min.js') < html.indexOf('js/tab-analysis.js'), 'D3 loaded before the analysis tab');
ok(typeof d3 !== 'undefined' && /^7\./.test(d3.version), 'D3 v7 available as a global');

// ~2 years of weekday quotes (as fetched: 730 calendar days) ending 2026-10-08, closing at 13:30Z (market open)
const quotes = [];
for (let t = Date.UTC(2024, 9, 9); t <= Date.UTC(2026, 9, 8); t += 86400000) {
  const d = new Date(t);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  quotes.push({ date: new Date(t + 13.5 * 3600000).toISOString(), close: 100 + quotes.length });
}
const N = quotes.length;
const sma = (w) => quotes.map((_, i) => i >= w - 1 ? quotes.slice(i - w + 1, i + 1).reduce((s, q) => s + q.close, 0) / w : null);
const rsi = quotes.map((_, i) => 50 + (i % 10));
const series = AnalysisTab.chartSeries(quotes, sma(20), sma(50), sma(200), rsi);
const day = d => d.toISOString().slice(0, 10);
eq([day(series[0].date), day(series[series.length - 1].date)], ['2025-10-08', '2026-10-08'], 'chart covers one full year back from the latest close (not year-to-date)');
ok(series.length >= 250 && series.length <= 262, `about a year of trading days (${series.length})`);
const lastP = series[series.length - 1];
eq([lastP.close, lastP.ma20, lastP.ma200, lastP.rsi], [100 + N - 1, 100 + N - 1 - 9.5, 100 + N - 1 - 99.5, rsi[N - 1]], 'last point: close, averages and RSI');
ok(series.every(d => d.ma200 != null && d.rsi != null), 'every charted day has its 200-day average and RSI (computed over the full history)');
const short = AnalysisTab.chartSeries(quotes.slice(0, 120), sma(20).slice(0, 120), sma(50).slice(0, 120), sma(200).slice(0, 120));
eq([short.length, short[0].ma20, short[19].ma20 != null, short[119].ma200, short[0].rsi], [120, null, true, null, null],
   'short history: all points, averages null until available, no RSI series given');

// Crosshair: the price at the cursor is the inverted y scale
const y = d3.scaleLinear().domain([100, 200]).range([400, 0]);
eq(+y.invert(100).toFixed(2), 175, 'cursor y -> price');
const path = d3.line().defined(d => d.v != null).x(d => d.x).y(d => d.v)([{ x: 0, v: 1 }, { x: 1, v: null }, { x: 2, v: 3 }, { x: 3, v: 4 }]);
eq(path, 'M0,1ZM2,3L3,4', 'average lines skip days without a value');

eq(menu('cmd-report-dividends'), 'Dividends', 'Reports > Dividends menu item');
ok(/Dividends/.test(section('reports')), 'Dividends under Reports');
eq(wired('cmd-report-dividends'), 'DividendsTab.open', 'Reports > Dividends wired');

eq(menu('cmd-report-gains'), 'Gains/Losses', 'Reports > Gains/Losses menu item');
ok(section('reports').includes('Gains/Losses'), 'Gains/Losses under Reports');
eq(wired('cmd-report-gains'), 'GainsTab.open', 'Reports > Gains/Losses wired');
eq([menu('cmd-report-trend'), wired('cmd-report-trend')], ['Portfolio trend', 'TrendTab.open'], 'Reports > Portfolio trend menu item wired');
ok(section('reports').includes('Portfolio trend'), 'Portfolio trend under Reports');
ok(html.indexOf('lib/d3.min.js') < html.indexOf('js/tab-trend.js'), 'D3 loaded before the trend tab');

// Transactions form: every stored effect can be shown in the Effect dropdown (incl. Snapshot from Import holdings)
const txSrc = __readFile(__ROOT + '/js/tab-transactions.js');
ok(/\[\.\.\.Engine\.EFFECTS\.filter\(e => e !== 'Ignore'\), 'Snapshot'\]/.test(txSrc), 'Transactions form Effect options include Snapshot');
ok([...Engine.EFFECTS, 'Snapshot'].every(e => e === 'Ignore' || Engine.EFFECT_TYPE[e]), 'every selectable effect has a transaction Type');

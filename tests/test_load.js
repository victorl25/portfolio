// All app scripts load together in index.html order; Portfolio entry parser; date helpers
const order = ['dialogs', 'import', 'tab-portfolio', 'tab-accounts', 'tab-assets', 'tab-prices', 'tab-transactions',
               'tab-ledger', 'tab-options', 'tab-rules', 'tab-query', 'tab-reports', 'tab-analysis', 'tab-dividends', 'app'];
const html = __readFile(__ROOT + '/index.html');
const scripts = [...html.matchAll(/<script src="js\/([\w-]+)\.js">/g)].map(m => m[1]);
eq(scripts, ['schema', 'db', 'engine', ...order], 'index.html script order');
for (const g of ['PortfolioTab', 'AccountsTab', 'AssetsTab', 'PricesTab', 'TransactionsTab', 'LedgerTab', 'OptionsTab',
                 'RulesTab', 'QueryTab', 'ReportsTab', 'AnalysisTab', 'DividendsTab', 'Import', 'App', 'YahooFinance', 'cmdUpdatePrices',
                 '_upsertPrice', '_isoToDate', '_todayStr', '_addDaysStr'])
  ok(typeof (0, eval)(g) !== 'undefined', `global ${g} defined`);
eq(APP_VERSION, '2.0', 'APP_VERSION');

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
eq(['analyze-portfolio-performance', 'analyze-account-performance', 'analyze-asset-performance', 'report-portfolio-theme', 'report-account-theme']
     .map(k => menu('cmd-' + k)),
   ['Portfolio performance', 'Account performance', 'Asset performance', 'Portfolio by theme', 'Account by theme'], 'Analyze / Reports menu labels');
ok(/Portfolio performance[\s\S]*Account performance[\s\S]*Asset performance/.test(section('analyze')) && !/by theme/.test(section('analyze')),
   'performance commands under Analyze');
ok(/Portfolio by theme[\s\S]*Account by theme/.test(section('reports')) && !/performance/.test(section('reports')), 'by-theme commands under Reports');
const appJs = __readFile(__ROOT + '/js/app.js');
const wired = id => (appJs.match(new RegExp(`cmd\\('${id}'\\)[^\\n]*?(\\w+Tab\\.\\w+)\\(`)) || [])[1];
eq(['cmd-analyze-portfolio-performance', 'cmd-analyze-account-performance', 'cmd-analyze-asset-performance', 'cmd-report-portfolio-theme', 'cmd-report-account-theme'].map(wired),
   ['ReportsTab.open', 'ReportsTab.openAccount', 'AnalysisTab.openAsset', 'AnalysisTab.openPortfolio', 'AnalysisTab.openAccount'], 'menu commands wired to the same reports');
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

// All app scripts load together in index.html order; Portfolio entry parser; date helpers
const order = ['dialogs', 'import', 'tab-portfolio', 'tab-accounts', 'tab-assets', 'tab-prices', 'tab-transactions',
               'tab-ledger', 'tab-options', 'tab-rules', 'tab-query', 'tab-reports', 'tab-analysis', 'app'];
const html = __readFile(__ROOT + '/index.html');
const scripts = [...html.matchAll(/<script src="js\/([\w-]+)\.js">/g)].map(m => m[1]);
eq(scripts, ['schema', 'db', 'engine', ...order], 'index.html script order');
for (const g of ['PortfolioTab', 'AccountsTab', 'AssetsTab', 'PricesTab', 'TransactionsTab', 'LedgerTab', 'OptionsTab',
                 'RulesTab', 'QueryTab', 'ReportsTab', 'AnalysisTab', 'Import', 'App', 'YahooFinance', 'cmdUpdatePrices',
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

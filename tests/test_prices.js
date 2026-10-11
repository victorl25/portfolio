// Tools > Update Prices (cmdUpdatePrices in js/app.js) with a stubbed YahooFinance.getChart and UI (stubs_ui.js)
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('X1','A')");
DB.run("INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES ('t',1,'AAPL',10,1000),('t',1,'MSFT',0,0),('t',1,'NVDA',5,500)");

const calls = [];
let behaviour = {};   // symbol -> function(attempt) returning a chart or throwing
YahooFinance.getChart = async (symbol, p1, p2, interval) => {
  calls.push({ symbol, p1, p2, interval });
  const n = calls.filter(c => c.symbol === symbol).length;
  return behaviour[symbol](n);
};
const today = _todayStr();
const yearAgo = _addDaysStr(today, -365);
const candles = (...rows) => ({ quotes: rows.map(([d, c]) => ({ date: d + 'T13:30:00.000Z', close: c })) });

(async () => {
  // 1. No stored prices: start = today − 1 year; MSFT (qty 0) skipped; null closes ignored; rounding
  behaviour = {
    AAPL: () => candles(['2026-10-01', 250.123], ['2026-10-02', null], ['2026-10-03', 251]),
    NVDA: () => candles(['2026-10-03', 180.5]),
  };
  await cmdUpdatePrices();
  eq(calls.map(c => c.symbol), ['AAPL', 'NVDA'], 'only held symbols (qty 0 skipped)');
  eq([calls[0].p1, calls[0].p2, calls[0].interval], [yearAgo, _addDaysStr(today, 1), '1d'], 'fetch from today - 1 year to tomorrow');
  eq(DB.query("SELECT Date, Price FROM Prices WHERE Symbol='AAPL' ORDER BY Date"),
     [{ Date: '2026-10-01', Price: 250.12 }, { Date: '2026-10-03', Price: 251 }], 'daily closes stored, null close skipped, rounded');
  ok(/2 symbol\(s\) succeeded \(3 daily closes\), 0 failed/.test(dialogLog.pop()), 'summary message');

  // 2. Stored prices: start = last stored date (refetched, upserted)
  calls.length = 0;
  behaviour.AAPL = () => candles(['2026-10-03', 252.5], ['2026-10-04', 253]);
  await cmdUpdatePrices();
  eq(calls[0].p1, '2026-10-03', 'fetch from the last stored date');
  eq(DB.query("SELECT Date, Price FROM Prices WHERE Symbol='AAPL' ORDER BY Date").map(r => r.Price), [250.12, 252.5, 253],
     'last date replaced by the final close, new date added');

  // 3. Rate limit: two 429s then success
  calls.length = 0;
  behaviour.AAPL = n => { if (n <= 2) throw new Error('MCP error 429'); return candles(['2026-10-05', 254]); };
  behaviour.NVDA = () => 'Error: Too Many Requests';     // text result: retried too
  let nv = 0; behaviour.NVDA = () => (++nv <= 1 ? 'Error: Too Many Requests' : candles(['2026-10-05', 181]));
  await cmdUpdatePrices();
  eq(calls.filter(c => c.symbol === 'AAPL').length, 3, 'AAPL retried after 429s');
  eq(calls.filter(c => c.symbol === 'NVDA').length, 2, 'NVDA retried after a Too Many Requests text result');
  ok(/0 failed/.test(dialogLog.pop()), 'retries succeed');

  // 4. Persistent rate limit: stops after 15 attempts, reports the symbol
  calls.length = 0;
  behaviour.AAPL = () => { throw new Error('MCP error 429'); };
  await cmdUpdatePrices();
  eq(calls.length, 15, 'stops after 15 attempts');
  ok(/terminated.*AAPL/.test(dialogLog.pop()), 'termination reported');

  // 5. Other failures listed
  calls.length = 0;
  behaviour.AAPL = () => { throw new Error('network down'); };
  behaviour.NVDA = () => ({ quotes: [] });
  await cmdUpdatePrices();
  ok(/0 symbol\(s\) succeeded.*2 failed/.test(dialogLog.pop()), 'failures counted');

  // 6. fetchPriceHistory (reports fetching missing price history): from..to + 1 day, failures, rate limit stops
  calls.length = 0;
  behaviour.SOLD = () => candles(['2026-01-05', 12.345], ['2026-01-06', 13]);
  behaviour.GONE = () => ({ quotes: [] });
  let fph = await fetchPriceHistory([{ symbol: 'SOLD', from: '2026-01-01', to: '2026-01-06' }, { symbol: 'GONE', from: '2026-02-01', to: '2026-02-03' }]);
  eq(calls.map(c => [c.symbol, c.p1, c.p2]), [['SOLD', '2026-01-01', '2026-01-07'], ['GONE', '2026-02-01', '2026-02-04']], 'history fetched from..to + 1 day');
  eq([fph.updated, fph.closes, fph.failures], [1, 2, [{ symbol: 'GONE', reason: 'no price data in response' }]], 'result counts and failures');
  eq(DB.query("SELECT Date, Price FROM Prices WHERE Symbol='SOLD' ORDER BY Date").map(r => [r.Date, r.Price]), [['2026-01-05', 12.35], ['2026-01-06', 13]],
     'fetched closes stored');
  calls.length = 0;
  behaviour.SOLD = () => { throw new Error('MCP error 429'); };
  fph = await fetchPriceHistory([{ symbol: 'SOLD', from: '2026-01-01', to: '2026-01-06' }, { symbol: 'GONE', from: '2026-02-01', to: '2026-02-03' }]);
  eq([calls.length, fph.failures.map(f => f.symbol)], [15, ['SOLD', 'GONE']], 'persistent rate limit: stops, remaining requests reported');
  eq((await fetchPriceHistory([])).updated, 0, 'nothing to fetch');

  // 7. updateSymbolPrices (Prices view Update action): same window as Tools > Update prices
  calls.length = 0;
  behaviour.SOLD = () => candles(['2026-01-06', 14], ['2026-01-07', 15]);
  const up = await updateSymbolPrices('SOLD');
  eq([calls.map(c => [c.symbol, c.p1, c.p2, c.interval]), up], [[['SOLD', yearAgo > '2026-01-06' ? yearAgo : '2026-01-06', _addDaysStr(today, 1), '1d']], { closes: 2 }],
     'one symbol: from its last stored date (or today - 1 year) to tomorrow');
  eq(DB.query("SELECT Price FROM Prices WHERE Symbol='SOLD' AND Date='2026-01-06'")[0].Price, 14, 'last stored date replaced');
  calls.length = 0;
  const upNew = await updateSymbolPrices('NEWSYM').catch(e => ({ reason: e.message }));
  eq([calls[0] && calls[0].p1], [yearAgo], 'no stored prices: from today - 1 year');
})();

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
})();

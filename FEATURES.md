# Features toimplement in the future

1. Realized taxable gains and losses report (deferred from version 2.0) — derivable from the Ledger Parent chain (average cost) or computed FIFO from Transactions
2. Portfolio balance history / trend chart with YTD and 1-year change net of Transfer flows (deferred from version 2.0) — daily holdings replayed from Transactions × daily Prices + cash; show an error when a year of price data is not available
3. Option position valuation (option quotes) so written calls/puts can be included in the portfolio value



Tools provided by Yahoo Finance MCP server: https://gateway.mcpservers.org/yahoo-finance/mcp

  1. get_quote

  Real-time (or near real-time) quote data for one or more symbols.
  - Input: symbols (array of strings, required) — e.g. ["AAPL", "MSFT"]
  - Returns: price, change, OHLC, volume, market cap, 52-week range, and more
  - Used by the app for App.ensureAsset(), the Prices tab Update button and Portfolio symbol validation

  2. search

  Search for instruments and related news by name, ticker, or keyword.
  - Input: query (string, required); optional quotesCount (default 6, max 50), newsCount (default 4, max 50), lang,
  region
  - Returns: matching quotes (symbol, name, exchange, type) and related news articles
  - Not currently used anywhere in the app — could be useful for a future "add asset by name" lookup

  3. get_chart

  Historical OHLCV price data (and optionally dividend/split events) for a symbol over a date range.
  - Input: symbol (required), period1 (start date, required), period2 (end date, optional, defaults to now), interval
  (default 1d; one of 1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo — intraday intervals only support recent ranges),
  events (pipe-separated, e.g. div|split), includePrePost (bool, default false)
  - Used by Tools > Update Prices (daily closes), the Reports tab (YTD/QTD baselines) and Analyze > Asset performance

  4. quote_summary

  Detailed fundamental/financial data via Yahoo's quoteSummary modules.
  - Input: symbol (required), modules (array, optional — omitting defaults to price + summaryDetail)
  - Available modules: assetProfile, balanceSheetHistory(Quarterly), calendarEvents,
  cashflowStatementHistory(Quarterly), defaultKeyStatistics, earnings, earningsHistory, earningsTrend, financialData,
  fundOwnership, fundPerformance, fundProfile, incomeStatementHistory(Quarterly), indexTrend, industryTrend,
  insiderHolders, insiderTransactions, institutionOwnership, majorDirectHolders, majorHoldersBreakdown,
  netSharePurchaseActivity, price, quoteType, recommendationTrend, secFilings, sectorTrend, summaryProfile, topHoldings,
  upgradeDowngradeHistory
  - Note in the server's own description: "financial-statement modules now return little data — prefer financialData /
  defaultKeyStatistics"
  - Used by the app with module assetProfile for sector/industry/category enrichment on new assets

  All four report "taskSupport":"forbidden" in their execution metadata (synchronous calls only, no background task
  polling), and the server identifies itself as yahoo-finance-mcp v1.0.0.

  get_quote, quote_summary and get_chart are used by the app; search is available but unused.

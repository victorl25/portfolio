const AnalysisTab = (() => {
  let _ctr = 0;

  function openPortfolio() {
    const id = `aly-${++_ctr}`;
    App.Tabs.open(id, 'Portfolio Analysis', panel => _build(panel, id),
      { refresh: () => _refresh(id) });
  }

  async function openAccount() {
    const accountId = await _selectAccountDialog();
    if (!accountId) return;
    const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
    const accountName = acc.length ? acc[0].Name : 'Account';

    const id = `aly-${++_ctr}`;
    App.Tabs.open(id, `Portfolio Analysis — ${accountName}`, panel => _build(panel, id, accountId),
      { refresh: () => _refresh(id, accountId) });
  }

  async function _selectAccountDialog() {
    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    if (!accounts.length) { await Dialogs.alert('No accounts found. Create an account first.'); return null; }
    const opts = accounts.map(a => `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`).join('');
    return new Promise(resolve => {
      const c = Dialogs.custom(`
        <div class="dlg">
          <div class="dlg-title">Select Account</div>
          <div class="dlg-body">
            <label style="font-size:13px;color:#555;">Account</label>
            <select class="dlg-select" id="aly-acct-select" style="width:100%;margin-top:4px;">${opts}</select>
          </div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="aly-acct-cancel">Cancel</button>
            <button class="btn btn-primary" id="aly-acct-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#aly-acct-cancel').addEventListener('click', () => { Dialogs.close(); resolve(null); });
      c.querySelector('#aly-acct-ok').addEventListener('click', () => {
        // Coerce to a number — every other accountId in the app comes from a DB.query()
        // result (already a number); a <select>.value is always a string, and leaving it
        // as one is the one concrete difference from every other working account-scoped query.
        const val = Number(c.querySelector('#aly-acct-select').value);
        Dialogs.close();
        resolve(val);
      });
    });
  }

  function _build(panel, id, accountId) {
    panel.innerHTML = `<div id="${id}-wrap" style="height:100%;"></div>`;
    _render(panel, id, accountId);
  }

  function _refresh(id, accountId) {
    const panel = document.getElementById(`panel-${id}`);
    if (panel) _render(panel, id, accountId);
  }

  function _render(panel, id, accountId) {
    const wrap = panel.querySelector(`#${id}-wrap`);
    const { rows, grand, assetCount } = _loadData(accountId);

    const fmt    = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);
    const fmtPct = v => grand !== 0 ? (v / grand * 100).toFixed(1) + '%' : '—';

    const dataRows = rows.length
      ? rows.map(r => `
        <tr>
          <td class="rpt-col-name">${
            r.clickable
              ? `<a class="cell-link" data-theme="${_esc(r.themeKey)}">${_esc(r.label)}</a>`
              : _esc(r.label)
          }</td>
          <td class="rpt-col-num">${fmt(r.value)}</td>
          <td class="rpt-col-num">${fmtPct(r.value)}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="rpt-empty">No active holdings.</td></tr>`;

    let subtitle = 'By Theme';
    if (accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
      subtitle = `By Theme — ${acc.length ? acc[0].Name : 'Account'}`;
    }

    wrap.innerHTML = `
      <div class="rpt-report-layout">
        <div class="rpt-header">
          <div class="rpt-title">Portfolio Analysis</div>
          <div class="rpt-subtitle">${_esc(subtitle)}</div>
        </div>
        <table class="rpt-table">
          <thead>
            <tr>
              <th class="rpt-col-name">Theme</th>
              <th class="rpt-col-num">Value</th>
              <th class="rpt-col-num">%Portfolio</th>
            </tr>
          </thead>
          <tbody>${dataRows}</tbody>
          ${rows.length ? `
          <tfoot>
            <tr class="rpt-total-row">
              <td class="rpt-col-name">Grand Total ${assetCount} Assets</td>
              <td class="rpt-col-num">${fmt(grand)}</td>
              <td class="rpt-col-num">${fmtPct(grand)}</td>
            </tr>
          </tfoot>` : ''}
        </table>
      </div>`;

    wrap.querySelector('.rpt-table').addEventListener('click', e => {
      const link = e.target.closest('.cell-link[data-theme]');
      if (!link) return;
      PortfolioTab.open(accountId || null, link.dataset.theme);
    });
  }

  function _loadData(accountId) {
    const where  = accountId ? 'l.Active = 1 AND l.Quantity <> 0 AND l.Account_ID = ?' : 'l.Active = 1 AND l.Quantity <> 0';
    const params = accountId ? [accountId] : [];

    // Assets missing from the Assets table (e.g. a failed lookup) are grouped under "(No Theme)"
    const assets = DB.query(`
      SELECT a.Theme,
        l.Symbol,
        SUM(l.Quantity) AS Quantity,
        p.Price
      FROM Ledger l
      LEFT JOIN Assets a ON a.Symbol = l.Symbol
      LEFT JOIN v_latest_price p ON l.Symbol = p.Symbol
      WHERE ${where}
      GROUP BY l.Symbol
      HAVING SUM(l.Quantity) <> 0`, params);

    const byTheme = new Map();
    for (const a of assets) {
      const key = a.Theme || '';
      const value = (a.Quantity || 0) * (a.Price || 0);
      byTheme.set(key, (byTheme.get(key) || 0) + value);
    }

    const cashRes = accountId
      ? DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Account_ID = ? AND Active = 1', [accountId])
      : DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Active = 1');
    const cash = cashRes[0]?.TotalCash || 0;

    const rows = [...byTheme.entries()].map(([themeKey, value]) => ({
      themeKey, label: themeKey || '(No Theme)', value, clickable: true
    }));
    if (cash !== 0) rows.push({ themeKey: null, label: 'Cash', value: cash, clickable: false });

    rows.sort((a, b) => b.value - a.value);

    const grand = rows.reduce((s, r) => s + (r.value || 0), 0);
    return { rows, grand, assetCount: assets.length };
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── Analyze > Assets (trend analysis, ported from ../Stocks/trend.py) ──

  async function openAssets() {
    const input = await Dialogs.prompt(
      'Enter one or more stock symbols, separated by space and/or comma:', '', 'Analyze Assets');
    if (!input) return;
    const symbols = [...new Set(input.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return;
    _openAssetsForSymbols(symbols);
  }

  // Runs the Analyze > Assets report directly for a known symbol, skipping the
  // prompt dialog — used by the Analyze button in the Portfolio tab's Action column.
  function openAssetsFor(symbol) {
    _openAssetsForSymbols([String(symbol).toUpperCase()]);
  }

  function _openAssetsForSymbols(symbols) {
    const id = `aly-${++_ctr}`;
    const label = symbols.length <= 3
      ? `Assets: ${symbols.join(', ')}`
      : `Assets: ${symbols.slice(0, 3).join(', ')}… (${symbols.length})`;
    App.Tabs.open(id, label, panel => _buildAssets(panel, id, symbols),
      { autoRefresh: false, refresh: () => _refreshAssets(id) });
  }

  function _buildAssets(panel, id, symbols) {
    panel.innerHTML = `<div id="${id}-wrap" class="aly-assets-scroll"></div>`;
    panel._alySymbols = symbols;
    _runAssetsAnalysis(panel, id, symbols);
  }

  function _refreshAssets(id) {
    const panel = document.getElementById(`panel-${id}`);
    if (panel && panel._alySymbols) _runAssetsAnalysis(panel, id, panel._alySymbols);
  }

  async function _runAssetsAnalysis(panel, id, symbols) {
    const wrap = panel.querySelector(`#${id}-wrap`);

    const c = Dialogs.custom(`
      <div class="dlg dlg-wide">
        <div class="dlg-title">Analyzing Assets</div>
        <div class="dlg-body"><p id="${id}-aly-msg">Starting…</p></div>
      </div>`);

    // Shared S&P 500 (^GSPC) 52-week benchmark change, fetched once for the whole batch.
    let sandp = null;
    try {
      const gspcChart = await YahooFinance.getChart('^GSPC', _daysAgo(400), _todayStr(), '1d');
      sandp = _pctChangeOverYear(gspcChart?.quotes);
    } catch { /* benchmark comparison lines fall back to '—' */ }
    await _sleep(100);

    const cards = [];
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const msgEl = c.querySelector(`#${id}-aly-msg`);
      if (msgEl) msgEl.textContent = `Analyzing ${i + 1} / ${symbols.length}: ${sym}…`;
      try {
        const data = await _analyzeSymbol(sym, sandp);
        cards.push({ symbol: sym, ok: true, data });
      } catch (e) {
        cards.push({ symbol: sym, ok: false, error: e.message });
      }
    }

    Dialogs.close();
    wrap.innerHTML = cards.map(_renderCard).join('');
  }

  async function _analyzeSymbol(symbol, sandp) {
    const chart = await YahooFinance.getChart(symbol, _daysAgo(730), _todayStr(), '1d');
    await _sleep(100);
    const quotes = (chart?.quotes || []).filter(q => q.close != null);
    if (quotes.length < 210) throw new Error('Not enough historical data for 200-day moving average');

    const closes = quotes.map(q => q.close);
    const ma20  = _sma(closes, 20);
    const ma50  = _sma(closes, 50);
    const ma200 = _sma(closes, 200);
    const rsiSeries = _rsi(closes, 14);

    const diff2050  = closes.map((_, i) => (ma20[i] != null && ma50[i]  != null) ? (ma20[i] - ma50[i])  / ma50[i]  : null);
    const diff20200 = closes.map((_, i) => (ma20[i] != null && ma200[i] != null) ? (ma20[i] - ma200[i]) / ma200[i] : null);

    const last10 = arr => arr.slice(-10);
    const calc = {
      rsi:     rsiSeries[rsiSeries.length - 1] || 0,
      maNow20:  ma20[ma20.length - 1],
      maNow50:  ma50[ma50.length - 1],
      maNow200: ma200[ma200.length - 1],
      slope20:    _slope(last10(ma20)),
      slope50:    _slope(last10(ma50)),
      slope200:   _slope(last10(ma200)),
      slope2050:  _slope(last10(diff2050)),
      slope20200: _slope(last10(diff20200)),
      change: _pctChangeOverYear(quotes),
      sandp
    };

    const summary = await YahooFinance.getQuoteSummary(symbol,
      ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'assetProfile', 'fundProfile', 'fundPerformance']);
    await _sleep(100);

    const quoteType = summary?.price?.quoteType || 'EQUITY';
    return quoteType === 'ETF'
      ? _buildEtfLines(symbol, summary, calc)
      : _buildEquityLines(symbol, summary, calc);
  }

  // Compares a to b like trend.py's c()/cp() helpers: '++' (bullish/green) or '--' (bearish/red).
  function _cmp(a, b) { return a > b ? '++' : '--'; }
  function _cmpPos(a, b) { return (a > b && a > 0 && b > 0) ? '++' : '--'; }
  function _row(flag, label, value) { return { positive: flag === '++', label, value }; }
  function _num(v, def = 0) { return (typeof v === 'number' && isFinite(v)) ? v : def; }
  function _pctStr(v) { return v != null ? v.toFixed(2) + '%' : '—'; }

  function _buildEquityLines(symbol, summary, calc) {
    const price = summary?.price || {};
    const sd    = summary?.summaryDetail || {};
    const dks   = summary?.defaultKeyStatistics || {};
    const fd    = summary?.financialData || {};
    const ap    = summary?.assetProfile || {};

    const name     = price.longName || price.shortName || symbol;
    const sector   = ap.sector || '—';
    const industry = ap.industry || '—';

    const marketCap      = _num(sd.marketCap, 0) / 1e9;
    const beta           = sd.beta ?? dks.beta;
    const shortRatio     = _num(dks.shortRatio, 0);
    const short          = _num(dks.sharesShort, 0);
    const floatShares    = _num(dks.floatShares, 0);
    const pfloat         = floatShares ? 100 * short / floatShares : 0;
    const ptbook         = _num(dks.priceToBook, 0);
    const earningsGrowth = _num(fd.earningsGrowth, 0) * 100;
    const dividendYield  = _num(sd.dividendYield, 0) * 100;
    const debt2equity    = _num(fd.debtToEquity, 0);
    const quickRatio     = _num(fd.quickRatio, 0);
    const freecash       = _num(fd.freeCashflow, 0) / 1e9;
    const profitMargin   = _num(fd.profitMargins, 0) * 100;
    const frwdpe         = _num(sd.forwardPE ?? dks.forwardPE, 0);
    const trailpe        = _num(sd.trailingPE, 0);
    const meanrec        = fd.recommendationMean ?? -1;
    const reckey         = fd.recommendationKey || 'undef';
    const nanalysts      = _num(fd.numberOfAnalystOpinions, 0);
    const high52         = _num(sd.fiftyTwoWeekHigh, 0);
    const price0         = _num(fd.currentPrice ?? price.regularMarketPrice, 0);

    const { rsi, maNow20, maNow50, maNow200, slope20, slope50, slope200, slope2050, slope20200, change, sandp } = calc;

    const rows = [
      _row(_cmp(marketCap, 10), 'Market cap', `${marketCap.toFixed(3)}B, beta: ${beta ?? 'undef'}`),
      _row(_cmp(2, shortRatio), 'Short ratio', shortRatio.toFixed(2)),
      _row(_cmp(5, pfloat), '%float', pfloat.toFixed(2)),
      _row(_cmp(10, ptbook), 'Price to book', ptbook.toFixed(2)),
      _row(_cmp(earningsGrowth, 10), 'Earnings growth', earningsGrowth.toFixed(2) + '%'),
      _row(_cmp(dividendYield, 0), 'Div yield', dividendYield.toFixed(2) + '%'),
      _row(_cmpPos(75, debt2equity), 'Debt/equity', debt2equity.toFixed(1) + '%'),
      _row(_cmp(quickRatio, 1), 'Quick ratio', quickRatio.toFixed(2)),
      _row(_cmp(marketCap ? freecash / marketCap : 0, 0.01), 'Free cash flow',
        `${freecash.toFixed(3)}B (${marketCap ? (freecash / marketCap * 100).toFixed(2) : '0.00'}%)`),
      _row(_cmp(profitMargin, 10), 'Profit margin', profitMargin.toFixed(2) + '%'),
      _row(_cmp(trailpe, frwdpe), 'Forward PE', `${frwdpe.toFixed(2)}, trailing PE: ${trailpe.toFixed(2)}`),
      _row(_cmpPos(2.5, meanrec), 'Analysts', `${meanrec.toFixed(2)} ${reckey} (${nanalysts})`),
      _row(_cmp(sandp != null ? change / sandp : 0, 1), '52w price change',
        `${_pctStr(change)} vs ${_pctStr(sandp)} for S&P500`),
      _row(_cmp(70, rsi), 'RSI', rsi.toFixed(0)),
      _row(_cmp(slope20, 0), '20_day_MA 10d slope', slope20.toFixed(4)),
      _row(_cmp(slope50, 0), '50_day_MA 10d slope', slope50.toFixed(4)),
      _row(_cmp(slope200, 0), '200_day_MA 10d slope', slope200.toFixed(4)),
      _row(_cmp(slope2050, 0), '20-50 MA diff 10d slope', slope2050.toFixed(4)),
      _row(_cmp(slope20200, 0), '20-200 MA diff 10d slope', slope20200.toFixed(4)),
      _row(_cmp(price0, maNow20), '20_day_MA', `${maNow20.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow20 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(price0, maNow50), '50_day_MA', `${maNow50.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow50 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(price0, maNow200), '200_day_MA', `${maNow200.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow200 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(high52 ? price0 / high52 : 0, 0.95), '52w high', `${high52.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / high52 * 100 - 100).toFixed(2)}%)`)
    ];

    return { title: `${symbol} — ${name}`, subtitle: `${sector}, ${industry}`, rows };
  }

  function _buildEtfLines(symbol, summary, calc) {
    const price = summary?.price || {};
    const sd    = summary?.summaryDetail || {};
    const dks   = summary?.defaultKeyStatistics || {};
    const fp    = summary?.fundProfile || {};
    const fperf = summary?.fundPerformance || {};

    const name     = price.longName || price.shortName || symbol;
    const category = dks.category || fp.categoryName || '—';

    const netAssets     = _num(dks.totalAssets ?? sd.totalAssets, 0) / 1e9;
    const beta          = dks.beta3Year;
    const expenseRatio  = _num(fp?.feesExpensesInvestment?.annualReportExpenseRatio, 0) * 100;
    const dividendYield = _num(sd.yield ?? dks.yield, 0) * 100;
    const ytdReturn     = _num(dks.ytdReturn, 0) * 100;
    const m3Return      = _num(fperf?.trailingReturns?.threeMonth, 0) * 100;
    const return5y      = _num(dks.fiveYearAverageReturn, 0) * 100;
    const epsttm        = _num(dks.epsTrailingTwelveMonths, 0);
    const trailpe       = _num(sd.trailingPE, 0);
    const high52        = _num(sd.fiftyTwoWeekHigh, 0);
    const price0        = _num(sd.navPrice ?? price.regularMarketPrice, 0);

    const { rsi, maNow20, maNow50, maNow200, slope20, slope50, slope200, slope2050, slope20200, change, sandp } = calc;

    const rows = [
      _row(_cmp(netAssets, 1), 'Net assets', `${netAssets.toFixed(3)}B, beta (3y): ${beta ?? 'undef'}`),
      _row(_cmp(0.75, expenseRatio), 'Expense ratio', expenseRatio.toFixed(2) + '%'),
      _row(_cmp(dividendYield, 0), 'Dividend yield', dividendYield.toFixed(2) + '%'),
      _row(_cmp(ytdReturn, m3Return), 'YTD return', `${ytdReturn.toFixed(2)}%, 3m return: ${m3Return.toFixed(2)}%`),
      _row(_cmp(return5y, 10), '5y avg return', return5y.toFixed(2) + '%'),
      _row(_cmp(epsttm, 1), 'EPS TTM', `${epsttm.toFixed(2)}, trailing PE: ${trailpe.toFixed(2)}`),
      _row(_cmp(sandp != null ? change / sandp : 0, 1), '52w change', `${_pctStr(change)} vs ${_pctStr(sandp)} for S&P500`),
      _row(_cmp(70, rsi), 'RSI', rsi.toFixed(0)),
      _row(_cmp(slope20, 0), '20_day_MA 10d slope', slope20.toFixed(4)),
      _row(_cmp(slope50, 0), '50_day_MA 10d slope', slope50.toFixed(4)),
      _row(_cmp(slope200, 0), '200_day_MA 10d slope', slope200.toFixed(4)),
      _row(_cmp(slope2050, 0), '20-50 MA diff 10d slope', slope2050.toFixed(4)),
      _row(_cmp(slope20200, 0), '20-200 MA diff 10d slope', slope20200.toFixed(4)),
      _row(_cmp(price0, maNow20), '20_day_MA', `${maNow20.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow20 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(price0, maNow50), '50_day_MA', `${maNow50.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow50 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(price0, maNow200), '200_day_MA', `${maNow200.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / maNow200 * 100 - 100).toFixed(2)}%)`),
      _row(_cmp(high52 ? price0 / high52 : 0, 0.95), '52w high', `${high52.toFixed(2)} vs ${price0.toFixed(2)} (${(price0 / high52 * 100 - 100).toFixed(2)}%)`)
    ];

    return { title: `${symbol} — ${name}`, subtitle: category, rows };
  }

  function _renderCard(card) {
    if (!card.ok) {
      return `
        <div class="aly-card rpt-report-layout">
          <div class="rpt-header"><div class="rpt-title">${_esc(card.symbol)}</div></div>
          <div class="rpt-empty">Processing error: ${_esc(card.error)}</div>
        </div>`;
    }
    const d = card.data;
    const rowsHtml = d.rows.map(r => `
      <tr>
        <td class="rpt-col-name">${_esc(r.label)}</td>
        <td class="rpt-col-num" style="color:${r.positive ? '#27ae60' : '#c0392b'};font-weight:600;">
          ${r.positive ? '▲' : '▼'} ${_esc(r.value)}
        </td>
      </tr>`).join('');

    return `
      <div class="aly-card rpt-report-layout">
        <div class="rpt-header">
          <div class="rpt-title">${_esc(d.title)}</div>
          <div class="rpt-subtitle">${_esc(d.subtitle)}</div>
        </div>
        <table class="rpt-table aly-indicators">
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  }

  // ── Shared math/data helpers ──────────────────────────────────────────

  function _sma(values, window) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= window) sum -= values[i - window];
      if (i >= window - 1) out[i] = sum / window;
    }
    return out;
  }

  // RSI via Wilder's smoothing (matches pandas .ewm(alpha=1/period, adjust=False)).
  function _rsi(closes, period) {
    const n = closes.length;
    const gain = new Array(n).fill(0);
    const loss = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) gain[i] = delta; else loss[i] = -delta;
    }
    const alpha = 1 / period;
    const avgGain = new Array(n).fill(0);
    const avgLoss = new Array(n).fill(0);
    avgGain[0] = gain[0];
    avgLoss[0] = loss[0];
    for (let i = 1; i < n; i++) {
      avgGain[i] = (1 - alpha) * avgGain[i - 1] + alpha * gain[i];
      avgLoss[i] = (1 - alpha) * avgLoss[i - 1] + alpha * loss[i];
    }
    return closes.map((_, i) => {
      const rs = avgLoss[i] === 0 ? Infinity : avgGain[i] / avgLoss[i];
      return 100 - 100 / (1 + rs);
    });
  }

  // Linear regression slope of values against their index (matches scipy.stats.linregress slope).
  function _slope(values) {
    const y = values.filter(v => v != null && !isNaN(v));
    const n = y.length;
    if (n < 2) return 0;
    const x = Array.from({ length: n }, (_, i) => i);
    const sumX  = x.reduce((s, v) => s + v, 0);
    const sumY  = y.reduce((s, v) => s + v, 0);
    const sumXY = x.reduce((s, xi, i) => s + xi * y[i], 0);
    const sumX2 = x.reduce((s, xi) => s + xi * xi, 0);
    const denom = n * sumX2 - sumX * sumX;
    return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  }

  // % change from ~365 days before the last quote to the last quote.
  function _pctChangeOverYear(quotes) {
    if (!quotes || !quotes.length) return null;
    const last = quotes[quotes.length - 1];
    const targetTime = new Date(last.date).getTime() - 365 * 24 * 3600 * 1000;
    let best = quotes[0];
    for (const q of quotes) {
      if (new Date(q.date).getTime() <= targetTime) best = q; else break;
    }
    if (!best || !best.close) return null;
    return (last.close / best.close - 1) * 100;
  }

  function _todayStr() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function _daysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { openPortfolio, openAccount, openAssets, openAssetsFor };
})();

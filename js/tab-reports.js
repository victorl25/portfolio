const ReportsTab = (() => {
  let _ctr = 0;

  function open() {
    const id = `rpt-${++_ctr}`;
    App.Tabs.open(id, 'Performance', panel => _build(panel, id),
      { refresh: () => _computeReport(id), autoRefresh: false });
  }

  async function openAccount() {
    const accountId = await _selectAccountDialog();
    if (!accountId) return;
    const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
    const accountName = acc.length ? acc[0].Name : 'Account';

    const id = `rpt-${++_ctr}`;
    App.Tabs.open(id, `Performance — ${accountName}`, panel => _build(panel, id, accountId),
      { refresh: () => _computeReport(id, accountId), autoRefresh: false });
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
            <select class="dlg-select" id="rpt-acct-select" style="width:100%;margin-top:4px;">${opts}</select>
          </div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="rpt-acct-cancel">Cancel</button>
            <button class="btn btn-primary" id="rpt-acct-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#rpt-acct-cancel').addEventListener('click', () => { Dialogs.close(); resolve(null); });
      c.querySelector('#rpt-acct-ok').addEventListener('click', () => {
        // Coerce to a number — every other accountId in the app comes from a DB.query()
        // result (already a number); a <select>.value is always a string, and leaving it
        // as one is the one concrete difference from every other working account-scoped query.
        const val = Number(c.querySelector('#rpt-acct-select').value);
        Dialogs.close();
        resolve(val);
      });
    });
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function _build(panel, id, accountId) {
    panel.innerHTML = `
      <div class="rpt-layout">
        <div class="rpt-table-zone" id="${id}-table-wrap"></div>
        <div class="rpt-summary" id="${id}-summary"></div>
      </div>`;

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: [],
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Symbol', field: 'Symbol', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => {
              e.stopPropagation();
              TransactionsTab.open({ symbol: cell.getValue() });
            });
            return a;
          }
        },
        { title: 'Quantity', field: 'Quantity', headerSortTristate: true,
          formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price', field: 'Price', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Value', field: 'Value', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: '% Total G/L', field: 'PctTotal', headerSortTristate: true, formatter: _pctFormatter },
        { title: '% Asset G/L YTD', field: 'PctYTD', headerSortTristate: true, formatter: _pctFormatter },
        { title: '% Asset G/L QTD', field: 'PctQTD', headerSortTristate: true, formatter: _pctFormatter }
      ]
    });

    panel._rptTable = table;
    // Tabulator's constructor returns before the table has actually finished its own
    // internal build (DOM/column setup); calling replaceData() before that completes is a
    // known race that can leave the table showing no rows on first load. Deferring the
    // initial computation to the tableBuilt event guarantees Tabulator is actually ready.
    table.on('tableBuilt', () => _computeReport(id, accountId));
  }

  function _pctFormatter(cell) {
    const v = cell.getValue();
    if (v == null) return '—';
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  async function _computeReport(id, accountId) {
    const panel = document.getElementById(`panel-${id}`);
    if (!panel) return;

    let accountName = null;
    if (accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
      accountName = acc.length ? acc[0].Name : 'Account';
    }
    const reportLabel = accountName || 'Portfolio';

    const where  = accountId ? 'l.Active = 1 AND l.Quantity <> 0 AND l.Account_ID = ?' : 'l.Active = 1 AND l.Quantity <> 0';
    const params = accountId ? [accountId] : [];

    // Current positions (active Ledger entries) with their remaining cost basis
    const assets = DB.query(`
      SELECT l.Symbol, SUM(l.Quantity) AS Quantity, SUM(l.Cost_Basis) AS CostBasis, p.Price
      FROM Ledger l
      LEFT JOIN v_latest_price p ON l.Symbol = p.Symbol
      WHERE ${where}
      GROUP BY l.Symbol
      HAVING SUM(l.Quantity) <> 0
      ORDER BY l.Symbol`, params);

    if (!assets.length) {
      if (panel._rptTable) panel._rptTable.replaceData([]);
      _renderSummary(panel, id, null, null, null, reportLabel);
      return;
    }

    const { yearStart, quarterStart } = _periodStarts();

    const c = Dialogs.custom(`
      <div class="dlg dlg-wide">
        <div class="dlg-title">Computing ${_esc(reportLabel)} Performance</div>
        <div class="dlg-body">
          <p id="${id}-rpt-msg">Starting…</p>
        </div>
      </div>`);

    const rows = [];
    const failures = [];
    let startYTD = 0, curYTD = 0, startQTD = 0, curQTD = 0;
    let sumCostBasis = 0, sumValue = 0;

    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const msgEl = c.querySelector(`#${id}-rpt-msg`);
      if (msgEl) msgEl.textContent = `Processing ${i + 1} / ${assets.length}: ${a.Symbol}…`;

      const baseYTD = await _getBaseline(a.Symbol, yearStart, failures, 'YTD');
      const baseQTD = await _getBaseline(a.Symbol, quarterStart, failures, 'QTD');

      const price = a.Price || 0;
      const value = a.Quantity * price;
      const costBasis = a.CostBasis || 0;

      const pctYTD   = baseYTD ? (price - baseYTD.price) / baseYTD.price * 100 : null;
      const pctQTD   = baseQTD ? (price - baseQTD.price) / baseQTD.price * 100 : null;
      const pctTotal = costBasis ? (value - costBasis) / Math.abs(costBasis) * 100 : null;   // abs: short positions have negative basis

      if (baseYTD) { startYTD += a.Quantity * baseYTD.price; curYTD += value; }
      if (baseQTD) { startQTD += a.Quantity * baseQTD.price; curQTD += value; }
      sumCostBasis += costBasis;
      sumValue += value;

      rows.push({ Symbol: a.Symbol, Quantity: a.Quantity, Price: price, Value: value,
        PctTotal: pctTotal, PctYTD: pctYTD, PctQTD: pctQTD });
    }

    Dialogs.close();

    if (panel._rptTable) {
      // The table is built with data:[] and populated later via replaceData() once the
      // (async) YTD/QTD lookups finish — unlike every other Tabulator tab in the app, which
      // gets real data synchronously at construction. Tabulator's virtual-DOM row layout can
      // come out wrong the first time data lands on a table built empty; redraw(true) forces
      // it to recalculate from scratch so rows actually appear without needing a manual Refresh.
      await panel._rptTable.replaceData(rows);
      panel._rptTable.redraw(true);
    }

    const avgTotal = sumCostBasis ? (sumValue - sumCostBasis) / Math.abs(sumCostBasis) * 100 : null;
    const avgYTD = startYTD > 0 ? (curYTD - startYTD) / startYTD * 100 : null;
    const avgQTD = startQTD > 0 ? (curQTD - startQTD) / startQTD * 100 : null;
    _renderSummary(panel, id, avgTotal, avgYTD, avgQTD, reportLabel);

    if (failures.length) {
      await _showResultDialog(
        `Performance computed for ${assets.length} asset(s). ${failures.length} historical price lookup(s) failed.`,
        failures, `${reportLabel} Performance`);
    }
  }

  // Looks up the Symbol's closing price on the first market day on/after periodStart.
  // Checks the daily Prices first (within a short window); falls back to
  // Yahoo Finance's get_chart and records the result for future reuse.
  async function _getBaseline(symbol, periodStart, failures, label) {
    const windowEnd = _addDays(periodStart, 9);
    const cached = DB.query(
      'SELECT Date, Price FROM Prices WHERE Symbol=? AND Valid=1 AND Date>=? AND Date<? ORDER BY Date ASC LIMIT 1',
      [symbol, periodStart, windowEnd]);
    if (cached.length) return { price: cached[0].Price };

    try {
      const chart = await YahooFinance.getChart(symbol, periodStart, windowEnd, '1d');
      await new Promise(r => setTimeout(r, 100));
      const quotes = (chart && chart.quotes) || [];
      const first = quotes.find(q => q.close != null);
      if (!first) {
        failures.push({ symbol: `${symbol} (${label})`, reason: 'no trading data in period' });
        return null;
      }
      const price = Math.round(first.close * 100) / 100;
      _upsertPrice(symbol, _isoToDate(first.date), price, 'USD');
      return { price };
    } catch (e) {
      await new Promise(r => setTimeout(r, 100));
      failures.push({ symbol: `${symbol} (${label})`, reason: e.message });
      return null;
    }
  }

  function _renderSummary(panel, id, avgTotal, avgYTD, avgQTD, reportLabel) {
    const el = panel.querySelector(`#${id}-summary`);
    if (!el) return;
    const fmt = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    const color = v => v == null ? '' : (v < 0 ? 'color:#c0392b;' : v > 0 ? 'color:#27ae60;' : '');
    el.innerHTML = `
      <span class="label">Avg ${_esc(reportLabel || 'Portfolio')} Performance:</span>
      <span>Total <b style="${color(avgTotal)}">${fmt(avgTotal)}</b>, YTD <b style="${color(avgYTD)}">${fmt(avgYTD)}</b>, QTD <b style="${color(avgQTD)}">${fmt(avgQTD)}</b></span>`;
  }

  function _periodStarts() {
    const now = new Date();
    const year = now.getFullYear();
    const yearStart = `${year}-01-01`;
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3; // 0, 3, 6, 9
    const quarterStart = `${year}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
    return { yearStart, quarterStart };
  }

  function _addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const p = n => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  return { open, openAccount };
})();

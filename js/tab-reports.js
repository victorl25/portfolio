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
        { title: 'Last Acquired', field: 'LastAcquired', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            cell.getElement().title = '';
            if (!v) return '—';
            if (!cell.getRow().getData().LastAcquiredBefore) return v;
            cell.getElement().title = 'Only known from a holdings snapshot or split: acquired on or before this date';
            return `before ${v}`;
          } },
        { title: '% Total G/L', field: 'PctTotal', headerSortTristate: true, formatter: _pctFormatter },
        { title: '% Asset G/L YTD', field: 'PctYTD', headerSortTristate: true, formatter: cell => _periodFormatter(cell, 'YTD') },
        { title: '% 50 Day G/L', field: 'Pct50D', headerSortTristate: true, formatter: cell => _periodFormatter(cell, '50D') }
      ]
    });

    panel._rptTable = table;
    // Tabulator's constructor returns before the table has actually finished its own
    // internal build (DOM/column setup); calling replaceData() before that completes is a
    // known race that can leave the table showing no rows on first load. Deferring the
    // initial computation to the tableBuilt event guarantees Tabulator is actually ready.
    table.on('tableBuilt', () => _computeReport(id, accountId));
  }

  // YTD / 50-day cell: tooltip with the baseline close used, or why the cell is empty
  function _periodFormatter(cell, period) {
    const base = cell.getRow().getData()['Base' + period];
    let note = '';
    if (base && base.late) note = period === 'YTD' ? ' (first stored close in the period)' : ` (only ${base.days} trading days stored)`;
    cell.getElement().title = base
      ? `Baseline: close $${base.price.toFixed(2)} on ${base.date}${note}`
      : (period === 'YTD' ? 'No stored closing price this year' : 'Fewer than 2 stored closing prices') + ' — run Tools > Update prices';
    return _pctFormatter(cell);
  }

  function _pctFormatter(cell) {
    const v = cell.getValue();
    if (v == null) return '—';
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  // Renders the report from stored data only (daily closes in Prices; no Yahoo Finance calls).
  async function _computeReport(id, accountId) {
    const panel = document.getElementById(`panel-${id}`);
    if (!panel) return;
    const r = computeReport(accountId);
    if (panel._rptTable) {
      await panel._rptTable.replaceData(r.rows);
      panel._rptTable.redraw(true);   // defensive; the tableBuilt deferral in _build is what prevents an empty first render
    }
    _renderSummary(panel, id, r.avgTotal, r.avgYTD, r.avg50D, r.label, r.missing);
  }

  // Report rows and value-weighted averages for all accounts (accountId null) or one account.
  // Baselines: YTD — the first stored close on or after Jan 1 (an asset whose stored closes start later
  // in the year, i.e. issued during it, uses its first available close); 50-day — the stored close
  // 50 trading days before the latest one (or the earliest stored close when fewer are available).
  function computeReport(accountId, today) {
    let label = 'Portfolio';
    if (accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
      label = acc.length ? acc[0].Name : 'Account';
    }
    const where  = accountId ? 'l.Active = 1 AND l.Quantity <> 0 AND l.Account_ID = ?' : 'l.Active = 1 AND l.Quantity <> 0';
    const params = accountId ? [accountId] : [];

    // Current positions (active Ledger entries) with their remaining cost basis and latest stored close
    const assets = DB.query(`
      SELECT l.Symbol, SUM(l.Quantity) AS Quantity, SUM(l.Cost_Basis) AS CostBasis, p.Price
      FROM Ledger l
      LEFT JOIN v_latest_price p ON l.Symbol = p.Symbol
      WHERE ${where}
      GROUP BY l.Symbol
      HAVING SUM(l.Quantity) <> 0
      ORDER BY l.Symbol`, params);

    const { yearStart } = _periodStarts(today);
    const lastAcquired = _lastAcquired(accountId);
    const rows = [], missing = [];
    let startYTD = 0, curYTD = 0, start50D = 0, cur50D = 0;
    let sumCostBasis = 0, sumValue = 0;

    for (const a of assets) {
      const baseYTD = baselinePrice(a.Symbol, yearStart);
      const base50D = trailingBaseline(a.Symbol, TRAILING_DAYS);
      if (!baseYTD) missing.push(a.Symbol);

      const price = a.Price || 0;
      const value = a.Quantity * price;
      const costBasis = a.CostBasis || 0;

      const pctYTD   = baseYTD ? (price - baseYTD.price) / baseYTD.price * 100 : null;
      const pct50D   = base50D ? (price - base50D.price) / base50D.price * 100 : null;
      const pctTotal = costBasis ? (value - costBasis) / Math.abs(costBasis) * 100 : null;   // abs: short positions have negative basis

      if (baseYTD) { startYTD += a.Quantity * baseYTD.price; curYTD += value; }
      if (base50D) { start50D += a.Quantity * base50D.price; cur50D += value; }
      sumCostBasis += costBasis;
      sumValue += value;

      rows.push({ Symbol: a.Symbol, Quantity: a.Quantity, Price: price, Value: value,
        LastAcquired: lastAcquired.get(a.Symbol)?.date || null,
        LastAcquiredBefore: !!lastAcquired.get(a.Symbol)?.before,
        PctTotal: pctTotal, PctYTD: pctYTD, Pct50D: pct50D, BaseYTD: baseYTD, Base50D: base50D });
    }

    return {
      label, rows, missing, yearStart,
      avgTotal: sumCostBasis ? (sumValue - sumCostBasis) / Math.abs(sumCostBasis) * 100 : null,
      avgYTD: startYTD > 0 ? (curYTD - startYTD) / startYTD * 100 : null,
      avg50D: start50D > 0 ? (cur50D - start50D) / start50D * 100 : null,
    };
  }

  const TRAILING_DAYS = 50;

  // Stored close TRAILING_DAYS trading days before the latest stored close: { price, date, days, late } or null.
  // days = trading days covered; late = true when fewer closes are stored (the earliest one is used).
  // At least two stored closes are needed for a change.
  function trailingBaseline(symbol, days) {
    const closes = DB.query('SELECT Date, Price FROM Prices WHERE Symbol=? AND Valid=1 ORDER BY Date DESC LIMIT ?',
      [symbol, days + 1]);
    if (closes.length < 2) return null;
    const base = closes[closes.length - 1];
    return { price: base.Price, date: base.Date, days: closes.length - 1, late: closes.length < days + 1 };
  }

  // Most recent date each symbol was acquired, from the valid transactions of all accounts or of one
  // account: Map<Symbol, { date: 'YYYY-MM-DD', before: boolean }>.
  // - acquisitions: buys, reinvestments, RSU vests and distributed shares (Quantity > 0) — their latest date
  // - otherwise, other Record transactions with a non-zero quantity (holdings snapshots, splits) only show the
  //   position was held by then: their latest date, flagged `before` (displayed "before YYYY-MM-DD")
  function _lastAcquired(accountId) {
    const acc = accountId ? 'AND Account_ID = ?' : '';
    const params = accountId ? [accountId] : [];
    const out = new Map();
    for (const r of DB.query(`
      SELECT Symbol, MAX(Date) AS LastDate FROM Transactions
      WHERE Valid = 1 AND Quantity <> 0 AND Type = 'Record' AND Effect NOT IN ('RSU', 'Distribution') ${acc}
      GROUP BY Symbol`, params)) out.set(r.Symbol, { date: r.LastDate, before: true });
    for (const r of DB.query(`
      SELECT Symbol, MAX(Date) AS LastDate FROM Transactions
      WHERE Valid = 1 AND Quantity > 0 AND Effect IN ('Trade', 'Reinvestment', 'RSU', 'Distribution') ${acc}
      GROUP BY Symbol`, params)) out.set(r.Symbol, { date: r.LastDate, before: false });
    return out;
  }

  // First stored closing price on or after periodStart: { price, date, late } or null.
  // late = true when that close is after the first market days of the period (the asset's
  // stored prices start later, e.g. it was issued during the period).
  function baselinePrice(symbol, periodStart) {
    const r = DB.query(
      'SELECT Date, Price FROM Prices WHERE Symbol=? AND Valid=1 AND Date>=? ORDER BY Date ASC LIMIT 1',
      [symbol, periodStart])[0];
    if (!r) return null;
    return { price: r.Price, date: r.Date, late: r.Date >= _addDays(periodStart, 9) };
  }

  function _renderSummary(panel, id, avgTotal, avgYTD, avg50D, reportLabel, missing) {
    const el = panel.querySelector(`#${id}-summary`);
    if (!el) return;
    const fmt = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    const color = v => v == null ? '' : (v < 0 ? 'color:#c0392b;' : v > 0 ? 'color:#27ae60;' : '');
    el.innerHTML = `
      <span class="label">Avg ${_esc(reportLabel || 'Portfolio')} Performance:</span>
      <span>Total <b style="${color(avgTotal)}">${fmt(avgTotal)}</b>, YTD <b style="${color(avgYTD)}">${fmt(avgYTD)}</b>, 50 Day <b style="${color(avg50D)}">${fmt(avg50D)}</b></span>` +
      (missing && missing.length
        ? `<span class="rpt-note" title="${_esc(missing.join(', '))}">${missing.length} asset(s) without stored prices this year — run Tools &gt; Update prices</span>`
        : '');
  }

  function _periodStarts(today) {
    const now = today ? new Date(today + 'T12:00:00') : new Date();
    const year = now.getFullYear();
    return { yearStart: `${year}-01-01` };
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

  return { open, openAccount, computeReport, baselinePrice, trailingBaseline };
})();

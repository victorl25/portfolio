// DividendsTab — Reports > Dividends: year-to-date dividends per symbol with their yield on the
// asset's current value. Plain-HTML report, same layout as Reports > Portfolio by theme, with a
// checkbox per contributing account above the table to include/exclude that account.
const DividendsTab = (() => {
  let _ctr = 0;

  function open() {
    const id = `dvd-${++_ctr}`;
    App.Tabs.open(id, 'Dividends', panel => _build(panel, id), { refresh: () => _render(id) });
  }

  function _build(panel, id) {
    panel.innerHTML = `<div id="${id}-wrap" style="height:100%;"></div>`;
    panel._dvdUnchecked = new Set();   // account ids excluded by the user (kept across refreshes)
    _render(id);
  }

  function _period(today) {
    const end = today || _todayStr();
    return { yearStart: `${end.slice(0, 4)}-01-01`, end };
  }

  // Accounts with valid year-to-date dividend transactions: [{ Account_ID, Name, Account }]
  function contributingAccounts(today) {
    const { yearStart, end } = _period(today);
    return DB.query(`
      SELECT DISTINCT a.Account_ID, a.Name, a.Account
      FROM Transactions t JOIN Accounts a ON a.Account_ID = t.Account_ID
      WHERE t.Valid = 1 AND t.Category = 'Dividend' AND t.Date >= ? AND t.Date <= ?
      ORDER BY a.Name, a.Account_ID`, [yearStart, end]);
  }

  // Year-to-date dividends (valid transactions of Category Dividend, summed per symbol) and their
  // yield = dividends / current value of the holding (quantity × latest stored close).
  // excludeIds (optional array of Account_IDs, the unchecked accounts) removes those accounts' dividends
  // and holdings; empty/omitted = all accounts. The total yield is value-weighted, i.e.
  // Σ dividends / Σ value over the assets that have a value.
  function computeDividends(today, excludeIds) {
    const { yearStart, end } = _period(today);
    const ids = (excludeIds || []).map(Number);
    const inList = ids.length ? `AND Account_ID NOT IN (${ids.map(() => '?').join(',')})` : '';
    const rows = DB.query(`
      SELECT COALESCE(t.Symbol, '') AS Symbol, SUM(t.Amount) AS Dividend,
        h.Quantity * p.Price AS Value
      FROM (SELECT * FROM Transactions WHERE Valid = 1 AND Category = 'Dividend' AND Date >= ? AND Date <= ? ${inList}) t
      LEFT JOIN (SELECT Symbol, SUM(Quantity) AS Quantity FROM Ledger
                 WHERE Active = 1 AND Quantity <> 0 ${inList} GROUP BY Symbol) h ON h.Symbol = t.Symbol
      LEFT JOIN v_latest_price p ON p.Symbol = t.Symbol
      GROUP BY COALESCE(t.Symbol, '')
      HAVING ROUND(SUM(t.Amount), 2) <> 0
      ORDER BY SUM(t.Amount) DESC, Symbol`, [yearStart, end, ...ids, ...ids]);

    let total = 0, heldDividend = 0, heldValue = 0;
    for (const r of rows) {
      r.Value = r.Value > 0 ? r.Value : null;               // sold out / unpriced / cash-like: no yield
      r.Yield = r.Value ? r.Dividend / r.Value * 100 : null;
      total += r.Dividend;
      if (r.Value) { heldDividend += r.Dividend; heldValue += r.Value; }
    }
    return {
      yearStart, end, rows, count: rows.length, total,
      avgYield: heldValue > 0 ? heldDividend / heldValue * 100 : null,   // value-weighted average of the yields
    };
  }

  function _render(id) {
    const panel = document.getElementById(`panel-${id}`);
    const wrap = panel && panel.querySelector(`#${id}-wrap`);
    if (!wrap) return;
    const { yearStart, end } = _period();
    const accounts = contributingAccounts();
    const day = s => new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const checks = accounts.map(a => `
      <label class="rpt-filter"><input type="checkbox" value="${a.Account_ID}"${panel._dvdUnchecked.has(a.Account_ID) ? '' : ' checked'}>
        ${_esc(a.Name)}${a.Account ? ` <span class="rpt-filter-sub">(${_esc(a.Account)})</span>` : ''}</label>`).join('');

    wrap.innerHTML = `
      <div class="rpt-report-layout">
        <div class="rpt-header">
          <div class="rpt-title">Dividends</div>
          <div class="rpt-subtitle">Year to date — ${_esc(day(yearStart))} to ${_esc(day(end))}</div>
        </div>
        ${accounts.length ? `<div class="rpt-filters" id="${id}-accounts"><span class="rpt-filters-label">Accounts:</span>${checks}</div>` : ''}
        <div id="${id}-table"></div>
      </div>`;

    const boxes = wrap.querySelectorAll(`#${id}-accounts input[type=checkbox]`);
    boxes.forEach(cb => cb.addEventListener('change', () => {
      const accId = Number(cb.value);
      if (cb.checked) panel._dvdUnchecked.delete(accId); else panel._dvdUnchecked.add(accId);
      _renderTable(panel, id, accounts);
    }));
    _renderTable(panel, id, accounts);
  }

  // Recalculates and redraws the table for the checked accounts
  function _renderTable(panel, id, accounts) {
    const el = panel.querySelector(`#${id}-table`);
    if (!el) return;
    const selected = accounts.map(a => a.Account_ID).filter(accId => !panel._dvdUnchecked.has(accId));
    const d = computeDividends(undefined, [...panel._dvdUnchecked]);

    const fmt = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);
    const pct = v => v == null ? '—' : v.toFixed(2) + '%';
    const empty = !accounts.length ? 'No dividends received this year.'
                : !selected.length ? 'No accounts selected.' : 'No dividends received this year in the selected accounts.';

    const dataRows = d.rows.length
      ? d.rows.map(r => `
        <tr>
          <td class="rpt-col-name">${r.Symbol
            ? `<a class="cell-link" data-symbol="${_esc(r.Symbol)}">${_esc(r.Symbol)}</a>`
            : '(no symbol)'}</td>
          <td class="rpt-col-num">${fmt(r.Dividend)}</td>
          <td class="rpt-col-num" title="${r.Value ? `Current value ${fmt(r.Value)}` : 'Not currently held (or no stored price)'}">${pct(r.Yield)}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="rpt-empty">${empty}</td></tr>`;

    el.innerHTML = `
      <table class="rpt-table">
        <thead>
          <tr>
            <th class="rpt-col-name">Symbol</th>
            <th class="rpt-col-num">Dividend</th>
            <th class="rpt-col-num">Yield</th>
          </tr>
        </thead>
        <tbody>${dataRows}</tbody>
        ${d.rows.length ? `
        <tfoot>
          <tr class="rpt-total-row">
            <td class="rpt-col-name">Grand Total ${d.count} Asset${d.count === 1 ? '' : 's'}</td>
            <td class="rpt-col-num">${fmt(d.total)}</td>
            <td class="rpt-col-num" title="Value-weighted average yield of the assets currently held">${pct(d.avgYield)}</td>
          </tr>
        </tfoot>` : ''}
      </table>`;

    el.querySelector('.rpt-table').addEventListener('click', e => {
      const link = e.target.closest('.cell-link[data-symbol]');
      if (link) TransactionsTab.open({ symbol: link.dataset.symbol });
    });
  }

  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, computeDividends, contributingAccounts };
})();

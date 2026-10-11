// DividendsTab — Reports > Dividends: year-to-date dividends per symbol with their yield on the average
// cost basis held before the payouts. Plain-HTML report, same layout as Reports > Investments by theme, with a
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

  // Year-to-date dividend payouts (valid transactions of Category Dividend) with the cost basis of the
  // holding before each payout: the latest Ledger record (active or inactive) of the payout's account +
  // symbol dated at least a day before the payout. Records with quantity 0 are skipped: when the asset was
  // sold after the ex-dividend date but before the payout, the state before the sale is used.
  // excludeIds: Account_IDs to leave out (unchecked accounts).
  function payouts(today, excludeIds) {
    const { yearStart, end } = _period(today);
    const ids = (excludeIds || []).map(Number);
    const inList = ids.length ? `AND t.Account_ID NOT IN (${ids.map(() => '?').join(',')})` : '';
    return DB.query(`
      SELECT t.Transaction_ID, t.Account_ID, COALESCE(t.Symbol, '') AS Symbol, t.Date, t.Amount,
        (SELECT l.Cost_Basis FROM Ledger l
         WHERE l.Account_ID = t.Account_ID AND l.Symbol = t.Symbol AND l.Date < t.Date AND l.Quantity <> 0
         ORDER BY l.Date DESC, l.Holding_ID DESC LIMIT 1) AS CostBasis
      FROM Transactions t
      WHERE t.Valid = 1 AND t.Category = 'Dividend' AND t.Date >= ? AND t.Date <= ? ${inList}
      ORDER BY t.Date, t.Transaction_ID`, [yearStart, end, ...ids]);
  }

  // Year-to-date dividends summed per symbol, with Yield = Σ dividends / average cost basis × 100.
  // The average cost basis is the mean of the cost bases before the symbol's payouts (prior ledger
  // records, see payouts()); when the symbol pays in several accounts the per-account averages are
  // added up, so the average reflects the whole holding. Payouts with no prior ledger record (or a
  // cost basis ≤ 0) don't contribute to the average; dividends of accounts without any cost basis
  // (e.g. cash-like funds) count in the Dividend sum but not in the yield.
  // The grand total yield applies the same formula to all assets: Σ dividends / Σ average cost basis.
  function computeDividends(today, excludeIds) {
    const { yearStart, end } = _period(today);
    const bySymbol = new Map();   // symbol → { Dividend, Payouts, accounts: Map<accountId, { div, costs[] }> }
    let total = 0;
    for (const p of payouts(today, excludeIds)) {
      const r = bySymbol.get(p.Symbol) || { Symbol: p.Symbol, Dividend: 0, Payouts: 0, accounts: new Map() };
      const acc = r.accounts.get(p.Account_ID) || { div: 0, costs: [] };
      acc.div += p.Amount;
      if (p.CostBasis > 0) acc.costs.push(p.CostBasis);
      r.accounts.set(p.Account_ID, acc);
      r.Dividend += p.Amount;
      r.Payouts++;
      bySymbol.set(p.Symbol, r);
      total += p.Amount;
    }

    let yieldDivAll = 0, avgCostAll = 0;
    const rows = [];
    for (const r of bySymbol.values()) {
      if (Math.round(r.Dividend * 100) === 0) continue;
      let yieldDiv = 0, avgCost = 0, withBasis = 0;
      for (const acc of r.accounts.values()) {
        if (!acc.costs.length) continue;
        yieldDiv += acc.div;
        avgCost += acc.costs.reduce((x, c) => x + c, 0) / acc.costs.length;
        withBasis += acc.costs.length;
      }
      rows.push({ Symbol: r.Symbol, Dividend: r.Dividend, Payouts: r.Payouts, WithBasis: withBasis,
                  AvgCost: avgCost > 0 ? avgCost : null, Yield: avgCost > 0 ? yieldDiv / avgCost * 100 : null });
      if (avgCost > 0) { yieldDivAll += yieldDiv; avgCostAll += avgCost; }
    }
    rows.sort((x, y) => y.Dividend - x.Dividend || x.Symbol.localeCompare(y.Symbol));
    return {
      yearStart, end, rows, count: rows.length, total,
      avgYield: avgCostAll > 0 ? yieldDivAll / avgCostAll * 100 : null,   // Σ dividends / Σ average cost basis
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
          <td class="rpt-col-num" title="${_esc(_yieldTip(r))}">${pct(r.Yield)}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="rpt-empty">${empty}</td></tr>`;

    el.innerHTML = `
      <table class="rpt-table">
        <thead>
          <tr>
            <th class="rpt-col-name">Symbol</th>
            <th class="rpt-col-num">Dividend</th>
            <th class="rpt-col-num" title="Approximate: dividends ÷ average cost basis before the payouts">~Yield</th>
          </tr>
        </thead>
        <tbody>${dataRows}</tbody>
        ${d.rows.length ? `
        <tfoot>
          <tr class="rpt-total-row">
            <td class="rpt-col-name">Grand Total ${d.count} Asset${d.count === 1 ? '' : 's'}</td>
            <td class="rpt-col-num">${fmt(d.total)}</td>
            <td class="rpt-col-num" title="Total dividends ÷ total average cost basis of the assets with a cost basis">${pct(d.avgYield)}</td>
          </tr>
        </tfoot>` : ''}
      </table>`;

    el.querySelector('.rpt-table').addEventListener('click', e => {
      const link = e.target.closest('.cell-link[data-symbol]');
      if (link) TransactionsTab.open({ symbol: link.dataset.symbol });
    });
  }

  function _yieldTip(r) {
    if (!r.AvgCost) return 'No ledger record before the payouts (no cost basis): yield not available';
    const fmt = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
    return `Dividends ÷ average cost basis ${fmt(r.AvgCost)} (cost basis before ${r.WithBasis} payout${r.WithBasis === 1 ? '' : 's'})` +
      (r.WithBasis < r.Payouts ? `; ${r.Payouts - r.WithBasis} payout(s) without a prior ledger record` : '');
  }

  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, computeDividends, contributingAccounts, payouts };
})();

// GainsTab — Reports > Gains/Losses: realized short- and long-term gains/losses per asset for the
// current year: holding periods from the transaction history (lots matched last-in first-out), amounts at
// the average cost of the Ledger/Options record before each sale. Plain-HTML report, same
// layout as Reports > Dividends, with a checkbox per contributing account above the table.
const GainsTab = (() => {
  let _ctr = 0;
  const EPS = 1e-9;

  function open() {
    const id = `gns-${++_ctr}`;
    App.Tabs.open(id, 'Gains/Losses', panel => _build(panel, id), { refresh: () => _render(id) });
  }

  function _build(panel, id) {
    panel.innerHTML = `<div id="${id}-wrap" style="height:100%;"></div>`;
    panel._gnsUnchecked = new Set();   // account ids excluded by the user (kept across refreshes)
    _render(id);
  }

  function _period(today) {
    const end = today || _todayStr();
    return { yearStart: `${end.slice(0, 4)}-01-01`, end };
  }

  // Long term when the asset was held 1 year or more: the sale is on or after the acquisition date + 1 year.
  function isLongTerm(acquired, sold) {
    let [y, m, d] = acquired.split('-');
    if (m === '02' && d === '29') { m = '03'; d = '01'; }   // Feb 29 + 1 year
    return sold >= `${Number(y) + 1}-${m}-${d}`;
  }

  // Position before each transaction: the parent of the transaction's latest Ledger/Options entry.
  // Map Transaction_ID -> { qty, cost } (null when the entry has no parent: no earlier position).
  // Transactions without any entry are missing from the map.
  function _parentStates() {
    const map = new Map();
    for (const [table, idCol] of [['Ledger', 'Holding_ID'], ['Options', 'Option_ID']]) {
      const rows = DB.query(`
        SELECT b.Transaction_ID AS Tid, c.Quantity AS Qty, c.Cost_Basis AS Cost
        FROM ${table} b LEFT JOIN ${table} c ON c.${idCol} = b.Parent_ID
        WHERE b.${idCol} IN (SELECT MAX(${idCol}) FROM ${table} WHERE Transaction_ID IS NOT NULL GROUP BY Transaction_ID)`);
      for (const r of rows) map.set(r.Tid, r.Qty == null ? null : { qty: r.Qty, cost: r.Cost || 0 });
    }
    return map;
  }

  // Realized gains of every account + symbol, from all valid transactions processed in date order.
  // Holding periods: lots matched last in, first out. Lots: buys/reinvestments, RSU vests, distributions,
  // each dated on its transaction; a holdings snapshot replaces the lots with one lot dated on the snapshot;
  // a split rescales the lots' quantities (dates kept). Selling more than is held opens a short lot (e.g.
  // writing an option) that a later buy closes, last in first out.
  // Amounts: a sale (or a buy closing a short position) realizes its proceeds (the Amount, net of fees,
  // shared out by quantity) − the average cost of the position before it: the parent of the Ledger/Options
  // entry the transaction created (sale A → entry B → parent C: C.Cost_Basis / C.Quantity per unit). Without
  // a ledger entry the lots' own cost is used (buys: −Amount incl. fees, RSU: Quantity × Price, distributions and
  // splits: their Amount).
  // Option lots still open at expiration expire worthless on the expiration date (cost: the active Options entry).
  // Returns realization events: [{ Account_ID, Symbol, Date, Gain, Long, Basis }] plus the sales that
  // could not be matched to any holding (no cost basis).
  function realizations(today, excludeIds) {
    const { end } = _period(today);
    const ids = (excludeIds || []).map(Number);
    const notIn = ids.length ? `AND Account_ID NOT IN (${ids.map(() => '?').join(',')})` : '';
    const txns = DB.query(`
      SELECT Transaction_ID, Account_ID, Date, Effect, Symbol, Quantity, Price, Amount
      FROM Transactions
      WHERE Valid = 1 AND Symbol IS NOT NULL AND Symbol <> '' AND Date <= ?
        AND Effect IN ('Trade', 'Reinvestment', 'RSU', 'Distribution', 'Split', 'Snapshot') ${notIn}
      ORDER BY Account_ID, Symbol, Date, Transaction_ID`, [end, ...ids]);
    const parents = _parentStates();

    const events = [], unmatched = [];
    let i = 0;
    while (i < txns.length) {
      const accountId = txns[i].Account_ID, symbol = txns[i].Symbol;
      const isOpt = Engine.isOption(symbol);
      const mult = isOpt ? Engine.OPTION_MULTIPLIER : 1;
      const firstDate = txns[i].Date;   // holding period of ledger quantities the lots don't explain
      let longs = [], shorts = [];       // lots { date, qty, amt }: amt = cost (longs) or proceeds (shorts)
      const realize = (date, gain, acquired, basis) =>
        events.push({ Account_ID: accountId, Symbol: symbol, Date: date, Gain: gain, Long: isLongTerm(acquired, date), Basis: basis });
      const held = lots => lots.reduce((s, l) => s + l.qty, 0);

      // Closes `qty` units of the position: lots consumed last in, first out for the holding periods.
      // `value` is the transaction's amount for all its `txQty` units; the closed part's cost (long) or
      // premium (short) is `avg` per unit when the parent ledger record is known, else the lots' own amount.
      const close = (lots, qty, txQty, value, date, longSide, avg) => {
        let left = qty;
        while (left > EPS) {
          const lot = lots[lots.length - 1];
          const take = lot ? Math.min(lot.qty, left) : left;
          const lotAmt = lot ? lot.amt * take / lot.qty : 0;
          const posAmt = avg != null ? avg * take : lotAmt;
          const txAmt = value * take / txQty;
          // long position sold: proceeds − cost; short position bought back: premium − cost of the buy
          realize(date, longSide ? txAmt - posAmt : posAmt - txAmt, lot ? lot.date : firstDate, longSide ? posAmt : txAmt);
          left -= take;
          if (!lot) break;
          lot.amt -= lotAmt; lot.qty -= take;
          if (lot.qty <= EPS) lots.pop();
        }
      };

      // A trade closing (part of) the position held in `closing` lots; the rest opens `opening` lots
      const trade = (t, qty, value, closing, opening, longSide) => {
        const parent = parents.get(t.Transaction_ID);
        let closeQty, avg = null;
        if (parent === undefined) closeQty = Math.min(qty, held(closing));        // no ledger entry: lots only
        else {
          const pq = parent ? (longSide ? parent.qty : -parent.qty) : 0;           // quantity on the closing side
          closeQty = pq > EPS ? Math.min(qty, pq) : 0;
          if (closeQty > EPS) avg = parent.cost / parent.qty;
        }
        if (closeQty > EPS) close(closing, closeQty, qty, value, t.Date, longSide, avg);
        const left = qty - closeQty;
        if (left > EPS) {
          closing.length = 0;                                                     // position crossed zero
          opening.push({ date: t.Date, qty: left, amt: value * left / qty });
          if (longSide && !isOpt) unmatched.push({ Account_ID: accountId, Symbol: symbol, Date: t.Date, Quantity: left });
        }
      };

      for (; i < txns.length && txns[i].Account_ID === accountId && txns[i].Symbol === symbol; i++) {
        const t = txns[i];
        const q = t.Quantity || 0, amount = t.Amount || 0;
        if (!q) continue;
        switch (t.Effect) {
          case 'Trade':
          case 'Reinvestment':
            if (q > 0) trade(t, q, -amount, shorts, longs, false);   // buy: cost paid, incl. fees
            else       trade(t, -q, amount, longs, shorts, true);    // sale: proceeds, net of fees
            break;
          case 'RSU':
            if (q > 0) longs.push({ date: t.Date, qty: q, amt: q * (t.Price || 0) });
            break;
          case 'Distribution':                                        // cost: the transaction's Amount
            if (q > 0) longs.push({ date: t.Date, qty: q, amt: amount });
            break;
          case 'Split': {                                             // q and Amount replace quantity and cost; dates kept
            const h = held(longs);
            if (h > EPS && q > 0) longs.forEach(l => { l.qty *= q / h; l.amt = amount * l.qty / q; });
            else if (q > 0) longs = [{ date: t.Date, qty: q, amt: amount }];
            break;
          }
          case 'Snapshot': {                                          // recorded state replaces the lots
            const cost = q * (t.Price || 0) * mult;
            longs = q > 0 ? [{ date: t.Date, qty: q, amt: cost }] : [];
            shorts = q < 0 ? [{ date: t.Date, qty: -q, amt: -cost }] : [];
            break;
          }
        }
      }

      // Options still open at expiration expire worthless: the cost (long) is lost, the premium (short)
      // kept — at the active Options entry's average cost when there is one
      if (isOpt) {
        const exp = Engine.parseOption(symbol)?.expiration;
        if (exp && exp <= end) {
          const entry = Engine.activeEntry('Options', accountId, symbol);
          const avg = entry && entry.Quantity ? (entry.Cost_Basis || 0) / entry.Quantity : null;
          for (const l of longs)  { const c = avg != null ? avg * l.qty : l.amt; realize(exp, -c, l.date, c); }
          for (const s of shorts) realize(exp, avg != null ? avg * s.qty : s.amt, s.date, 0);
        }
      }
    }
    return { events, unmatched };
  }

  // Accounts with realized gains or losses this year: [{ Account_ID, Name, Account }]
  function contributingAccounts(today) {
    const { yearStart, end } = _period(today);
    const accIds = new Set(realizations(today).events
      .filter(e => e.Date >= yearStart && e.Date <= end && Math.abs(e.Gain) > 0.005).map(e => e.Account_ID));
    if (!accIds.size) return [];
    return DB.query(`SELECT Account_ID, Name, Account FROM Accounts WHERE Account_ID IN (${[...accIds].map(() => '?').join(',')})
                     ORDER BY Name, Account_ID`, [...accIds]);
  }

  // Short- and long-term realized gains per symbol for the current year (Jan 1 – today), excluding the
  // given accounts. Rows sorted by total gain, largest first.
  function computeGains(today, excludeIds) {
    const { yearStart, end } = _period(today);
    const { events, unmatched } = realizations(today, excludeIds);
    const bySymbol = new Map();
    for (const e of events) {
      if (e.Date < yearStart || e.Date > end) continue;
      const r = bySymbol.get(e.Symbol) || { Symbol: e.Symbol, ShortTerm: 0, LongTerm: 0 };
      if (e.Long) r.LongTerm += e.Gain; else r.ShortTerm += e.Gain;
      bySymbol.set(e.Symbol, r);
    }
    const rows = [...bySymbol.values()]
      .map(r => ({ ...r, ShortTerm: _round2(r.ShortTerm), LongTerm: _round2(r.LongTerm) }))
      .filter(r => r.ShortTerm !== 0 || r.LongTerm !== 0)
      .sort((x, y) => (y.ShortTerm + y.LongTerm) - (x.ShortTerm + x.LongTerm) || x.Symbol.localeCompare(y.Symbol));
    return {
      yearStart, end, rows, count: rows.length,
      shortTerm: _round2(rows.reduce((s, r) => s + r.ShortTerm, 0)),
      longTerm: _round2(rows.reduce((s, r) => s + r.LongTerm, 0)),
      unmatched: unmatched.filter(u => u.Date >= yearStart && u.Date <= end),
    };
  }

  const _round2 = v => Math.round((v + Number.EPSILON) * 100) / 100 || 0;

  function _render(id) {
    const panel = document.getElementById(`panel-${id}`);
    const wrap = panel && panel.querySelector(`#${id}-wrap`);
    if (!wrap) return;
    const { yearStart, end } = _period();
    const accounts = contributingAccounts();
    const day = s => new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const checks = accounts.map(a => `
      <label class="rpt-filter"><input type="checkbox" value="${a.Account_ID}"${panel._gnsUnchecked.has(a.Account_ID) ? '' : ' checked'}>
        ${_esc(a.Name)}${a.Account ? ` <span class="rpt-filter-sub">(${_esc(a.Account)})</span>` : ''}</label>`).join('');

    wrap.innerHTML = `
      <div class="rpt-report-layout">
        <div class="rpt-header">
          <div class="rpt-title">Realized Gains/Losses</div>
          <div class="rpt-subtitle">Year to date — ${_esc(day(yearStart))} to ${_esc(day(end))}</div>
        </div>
        ${accounts.length ? `<div class="rpt-filters" id="${id}-accounts"><span class="rpt-filters-label">Accounts:</span>${checks}</div>` : ''}
        <div id="${id}-table"></div>
      </div>`;

    wrap.querySelectorAll(`#${id}-accounts input[type=checkbox]`).forEach(cb => cb.addEventListener('change', () => {
      const accId = Number(cb.value);
      if (cb.checked) panel._gnsUnchecked.delete(accId); else panel._gnsUnchecked.add(accId);
      _renderTable(panel, id, accounts);
    }));
    _renderTable(panel, id, accounts);
  }

  // Recalculates and redraws the table without the unchecked accounts
  function _renderTable(panel, id, accounts) {
    const el = panel.querySelector(`#${id}-table`);
    if (!el) return;
    const selected = accounts.filter(a => !panel._gnsUnchecked.has(a.Account_ID));
    const g = computeGains(undefined, [...panel._gnsUnchecked]);

    const fmt = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);
    const cell = v => `<td class="rpt-col-num${v < 0 ? ' rpt-neg' : ''}">${v ? fmt(v) : '—'}</td>`;
    const empty = !accounts.length ? 'No realized gains or losses this year.'
                : !selected.length ? 'No accounts selected.' : 'No realized gains or losses this year in the selected accounts.';

    const dataRows = g.rows.length
      ? g.rows.map(r => `
        <tr>
          <td class="rpt-col-name"><a class="cell-link" data-symbol="${_esc(r.Symbol)}">${_esc(r.Symbol)}</a></td>
          ${cell(r.ShortTerm)}${cell(r.LongTerm)}
        </tr>`).join('')
      : `<tr><td colspan="3" class="rpt-empty">${empty}</td></tr>`;

    const warn = g.unmatched.length
      ? `<p class="rpt-warning" title="${_esc(g.unmatched.map(u => `${u.Date} ${u.Symbol} ${u.Quantity}`).join('\n'))}">
           ${g.unmatched.length} sale(s) of ${_esc([...new Set(g.unmatched.map(u => u.Symbol))].join(', '))} have no earlier
           holdings in the transaction history (no cost basis) and are not included — import the earlier holdings or transactions.</p>`
      : '';

    el.innerHTML = `
      <table class="rpt-table">
        <thead>
          <tr>
            <th class="rpt-col-name">Asset</th>
            <th class="rpt-col-num" title="Held less than 1 year">Short Term</th>
            <th class="rpt-col-num" title="Held 1 year or more">Long Term</th>
          </tr>
        </thead>
        <tbody>${dataRows}</tbody>
        ${g.rows.length ? `
        <tfoot>
          <tr class="rpt-total-row">
            <td class="rpt-col-name">Grand Total ${g.count} Asset${g.count === 1 ? '' : 's'}</td>
            ${cell(g.shortTerm)}${cell(g.longTerm)}
          </tr>
        </tfoot>` : ''}
      </table>${warn}`;

    el.querySelector('.rpt-table').addEventListener('click', e => {
      const link = e.target.closest('.cell-link[data-symbol]');
      if (link) TransactionsTab.open({ symbol: link.dataset.symbol });
    });
  }

  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, computeGains, contributingAccounts, realizations, isLongTerm };
})();

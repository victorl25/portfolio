// LedgerTab — View > Ledger: active Ledger entries with quantity ≠ 0 (one per account + symbol)
// with manual editing, deletion (deactivation) and a rebuild of the selected account + symbol (VERSION_2.md item 3).
// openFiltered() opens extra Ledger tabs limited to an asset Theme and/or a set of accounts
// (Reports > Investments by theme).
const LedgerTab = (() => {
  const TAB_ID = 'led';
  let _ctr = 0;

  function open() {
    App.Tabs.open(TAB_ID, 'Ledger', panel => _build(panel, TAB_ID), { refresh: () => _refresh(TAB_ID) });
  }

  // filter: { theme, accountIds } — theme: the Assets.Theme ('' = no theme, also symbols missing from
  // Assets; undefined/null = any); accountIds: array of Account_IDs (null = all accounts)
  function openFiltered(filter = {}) {
    const id = `ldf-${++_ctr}`;
    const f = { theme: filter.theme ?? null, accountIds: filter.accountIds ? filter.accountIds.map(Number) : null };
    let label = 'Ledger';
    if (f.theme !== null) label += ` — ${f.theme || '(No Theme)'}`;
    if (f.accountIds) {
      const names = f.accountIds.length ? DB.query(
        `SELECT Name FROM Accounts WHERE Account_ID IN (${f.accountIds.map(() => '?').join(',')}) ORDER BY Name`, f.accountIds).map(a => a.Name) : [];
      label += ` (${names.length <= 2 ? names.join(', ') : `${names.length} accounts`})`;
    }
    App.Tabs.open(id, label, panel => _build(panel, id, f), { refresh: () => _refresh(id, f) });
  }

  function fld(id, name) { return document.getElementById(`ft-${id}-${name}`); }

  function _build(panel, id, filter) {
    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    const accOpts  = accounts.map(a => `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`).join('');

    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Account</label>
                <select class="form-control" id="ft-${id}-account" disabled><option value="">— select —</option>${accOpts}</select>
              </div>
              <div class="form-field"><label>Symbol</label><input class="form-control form-readonly" id="ft-${id}-symbol" readonly></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Quantity</label><input class="form-control" id="ft-${id}-qty" type="number" step="any"></div>
              <div class="form-field">
                <label>Cost Basis</label>
                <div class="amt-cur">
                  <input class="form-control" id="ft-${id}-cost" type="number" step="0.01">
                  <input class="form-control" id="ft-${id}-currency" maxlength="3" value="USD">
                </div>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="${id}-btn-new">New</button>
              <button class="btn btn-secondary" id="${id}-btn-delete" disabled title="Delete (deactivate) the selected ledger entry">Delete</button>
              <button class="btn btn-secondary" id="${id}-btn-rebuild" disabled title="Rebuild the ledger of the selected account + symbol from its transactions">Rebuild</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="${id}-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    let _selected = null;
    let _isNew    = false;
    const btn = name => panel.querySelector(`#${id}-btn-${name}`);

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: _loadData(filter),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Account', field: 'Name', headerFilter: true, headerSortTristate: true },
        { title: 'Symbol', field: 'Symbol', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => {
              e.stopPropagation();
              TransactionsTab.open({ symbol: cell.getValue(), accountId: cell.getRow().getData().Account_ID });
            });
            return a;
          }
        },
        { title: 'Date', field: 'Date', headerFilter: true, headerSortTristate: true },
        { title: 'Quantity', field: 'Quantity', headerSortTristate: true, formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price', field: 'AvgPrice', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Cost Basis', field: 'Cost_Basis', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Value', field: 'Value', headerSortTristate: true, formatter: _fmtValue,
          tooltip: (e, cell) => { const d = cell.getRow().getData(); return d.LastPrice != null ? `Latest price ${d.LastPrice} (${d.PriceDate})` : 'No stored price'; } },
        { title: 'Gain / Loss', field: 'GainLoss', headerSortTristate: true, formatter: _fmtGainLoss },
        { title: '% Gain/Loss', field: 'GainLossPct', headerSortTristate: true, formatter: _fmtPct }
      ]
    });

    table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selected = rows[0].getData();
      _isNew = false;
      _populate(_selected);
    });

    panel.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Delete' && _selected && !_isNew) _delete();
    });

    btn('new').addEventListener('click', () => {
      _isNew = true;
      _selected = null;
      table.deselectRow();
      fld(id, 'account').disabled = false;
      fld(id, 'account').value = '';
      const sym = fld(id, 'symbol');
      sym.readOnly = false; sym.classList.remove('form-readonly'); sym.value = '';
      fld(id, 'qty').value = '';
      fld(id, 'cost').value = '';
      fld(id, 'currency').value = 'USD';
      btn('delete').disabled = true;
      btn('rebuild').disabled = true;
      btn('accept').disabled = false;
    });
    btn('accept').addEventListener('click', _accept);
    btn('delete').addEventListener('click', _delete);
    btn('rebuild').addEventListener('click', _rebuild);
    ['account', 'symbol', 'qty', 'cost', 'currency'].forEach(f =>
      fld(id, f).addEventListener('input', () => { btn('accept').disabled = false; }));

    function _populate(row) {
      fld(id, 'account').value = String(row.Account_ID);
      fld(id, 'account').disabled = true;
      const sym = fld(id, 'symbol');
      sym.value = row.Symbol; sym.readOnly = true; sym.classList.add('form-readonly');
      fld(id, 'qty').value = row.Quantity;
      fld(id, 'cost').value = row.Cost_Basis;
      fld(id, 'currency').value = row.Currency || 'USD';
      btn('delete').disabled = false;
      btn('rebuild').disabled = false;
      btn('accept').disabled = true;
    }

    // A manual edit supersedes the entry: Parent_ID set, Transaction_ID empty
    async function _accept() {
      const accountId = Number(fld(id, 'account').value);
      const symbol    = Engine.normalizeSymbol(fld(id, 'symbol').value);
      const qty       = parseFloat(fld(id, 'qty').value);
      const cost      = parseFloat(fld(id, 'cost').value);
      const currency  = fld(id, 'currency').value.trim() || 'USD';
      if (!accountId || !symbol || isNaN(qty) || isNaN(cost)) {
        await Dialogs.alert('Account, Symbol, Quantity, and Cost Basis are required.');
        return;
      }
      if (Engine.isOption(symbol)) { await Dialogs.alert('Option positions are edited in View > Options.'); return; }
      const prev = Engine.activeEntry('Ledger', accountId, symbol);
      if (_isNew && prev && !(await Dialogs.confirm(`${symbol} already has a ledger entry in this account. Replace it?`))) return;
      await DB.transaction(() => Engine.supersede('Ledger', accountId, symbol, prev, qty, Math.round(cost * 100) / 100, null, currency));
      if (_isNew) await App.ensureAsset(symbol);
      _isNew = false;
      btn('accept').disabled = true;
      App.onDataChanged();
    }

    // Delete = deactivate the entry (Active=0); its Timestamp records when it was deleted
    async function _delete() {
      if (!_selected) return;
      const ok = await Dialogs.confirm(
        `Delete the ledger entry ${_selected.Symbol} (${_fmtNum(_selected.Quantity)}) of ${_selected.Name}?`, 'Delete Ledger Entry');
      if (!ok) return;
      DB.run('UPDATE Ledger SET Active=0, Timestamp=? WHERE Holding_ID=?', [_nowTs(), _selected.Holding_ID]);
      _selected = null;
      btn('delete').disabled = true;
      btn('rebuild').disabled = true;
      App.onDataChanged();
    }

    // Rebuilds the ledger of the selected account + symbol only (Engine.rebuildPair)
    async function _rebuild() {
      if (!_selected) return;
      const { Account_ID: accountId, Symbol: symbol, Name: name } = _selected;
      const ok = await Dialogs.confirm(
        `Rebuild the ledger of ${symbol} in ${name} by replaying its valid transactions? ` +
        `This discards any manual edits of this ${symbol} ledger entry.`, 'Rebuild Ledger');
      if (!ok) return;
      try {
        const r = await DB.transaction(() => Engine.rebuildPair(accountId, symbol));
        await Dialogs.alert(r && r.transactions
          ? `Rebuilt ${symbol} in ${name} from ${r.transactions} transaction(s): quantity ${_fmtNum(r.qty)}, cost basis ${r.cost.toFixed(2)}.`
          : `${symbol} has no valid transactions in ${name}; its ledger entry was deleted.`, 'Rebuild Ledger');
      } catch (e) {
        await Dialogs.alert(`Rebuild failed, no changes were made: ${e.message}`);
      }
      App.onDataChanged();
    }

    panel._ledTable = table;
  }

  // Active entries with quantity ≠ 0, optionally limited to a Theme and/or accounts (see openFiltered).
  // Value = Quantity × the latest stored price (v_latest_price), Gain/Loss = Value − Cost_Basis,
  // % Gain/Loss = Gain/Loss / |Cost_Basis| × 100 (abs: shorts have a negative basis; NULL for basis 0);
  // all NULL when the symbol has no stored price.
  function _loadData(filter) {
    const params = [];
    let themeJoin = '', accFilter = '';
    if (filter && filter.theme != null) {
      themeJoin = 'LEFT JOIN Assets s ON s.Symbol = l.Symbol';
      if (filter.theme === '') accFilter += " AND (s.Theme IS NULL OR s.Theme = '')";
      else { accFilter += ' AND s.Theme = ?'; params.push(filter.theme); }
    }
    if (filter && filter.accountIds) {
      if (!filter.accountIds.length) return [];
      accFilter += ` AND l.Account_ID IN (${filter.accountIds.map(() => '?').join(',')})`;
      params.push(...filter.accountIds);
    }
    return DB.query(`
      SELECT l.Holding_ID, l.Account_ID, a.Name, l.Symbol, l.Date, l.Quantity, l.Cost_Basis, l.Currency,
        CASE WHEN l.Quantity <> 0 THEN l.Cost_Basis / l.Quantity END AS AvgPrice,
        p.Price AS LastPrice, p.Date AS PriceDate,
        ROUND(l.Quantity * p.Price, 2) AS Value,
        ROUND(l.Quantity * p.Price - l.Cost_Basis, 2) AS GainLoss,
        CASE WHEN l.Cost_Basis <> 0 THEN (l.Quantity * p.Price - l.Cost_Basis) / ABS(l.Cost_Basis) * 100 END AS GainLossPct
      FROM Ledger l
      JOIN Accounts a ON a.Account_ID = l.Account_ID
      LEFT JOIN v_latest_price p ON p.Symbol = l.Symbol
      ${themeJoin}
      WHERE l.Active = 1 AND l.Quantity <> 0 ${accFilter}
      ORDER BY a.Name, l.Symbol`, params);
  }

  function _refresh(tabId, filter) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._ledTable) panel._ledTable.replaceData(_loadData(filter));
  }

  function _fmtValue(cell) {
    const v = cell.getValue();
    return v == null ? '—' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Signed and colored like the Portfolio tab's Gain / Loss column; — without a stored price
  function _fmtGainLoss(cell) {
    const v = cell.getValue();
    if (v == null) return '—';
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' +
      Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtPct(cell) {
    const v = cell.getValue();
    if (v == null) return '—';
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, openFiltered, loadData: _loadData };
})();

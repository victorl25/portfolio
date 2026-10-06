// LedgerTab — View > Ledger: active Ledger entries with quantity ≠ 0 (one per account + symbol)
// with manual editing, deactivation and an account rebuild (VERSION_2.md item 3).
const LedgerTab = (() => {
  const TAB_ID = 'led';

  function open() {
    App.Tabs.open(TAB_ID, 'Ledger', panel => _build(panel, TAB_ID), { refresh: () => _refresh(TAB_ID) });
  }

  function fld(id, name) { return document.getElementById(`ft-${id}-${name}`); }

  function _build(panel, id) {
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
              <button class="btn btn-secondary" id="${id}-btn-deactivate" disabled>Deactivate</button>
              <button class="btn btn-secondary" id="${id}-btn-rebuild" disabled title="Rebuild the account's ledger from its transactions">Rebuild</button>
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
      data: _loadData(),
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
        { title: 'Quantity', field: 'Quantity', headerSortTristate: true, formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price', field: 'AvgPrice', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Cost Basis', field: 'Cost_Basis', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } }
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
      if (e.key === 'Delete' && _selected && !_isNew) _deactivate();
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
      btn('deactivate').disabled = true;
      btn('rebuild').disabled = true;
      btn('accept').disabled = false;
    });
    btn('accept').addEventListener('click', _accept);
    btn('deactivate').addEventListener('click', _deactivate);
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
      btn('deactivate').disabled = false;
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

    async function _deactivate() {
      if (!_selected) return;
      const ok = await Dialogs.confirm(
        `Deactivate the ledger entry ${_selected.Symbol} (${_fmtNum(_selected.Quantity)}) of ${_selected.Name}?`);
      if (!ok) return;
      DB.run('UPDATE Ledger SET Active=0 WHERE Holding_ID=?', [_selected.Holding_ID]);
      _selected = null;
      btn('deactivate').disabled = true;
      App.onDataChanged();
    }

    async function _rebuild() {
      if (!_selected) return;
      const ok = await Dialogs.confirm(
        `Rebuild the ledger and options of ${_selected.Name} by replaying its valid transactions? ` +
        'This discards any manual edits of the account\'s ledger and option entries.', 'Rebuild Ledger');
      if (!ok) return;
      try {
        const counts = await DB.transaction(() => Engine.rebuildAccount(_selected.Account_ID));
        await Dialogs.alert(`Rebuilt ${counts.ledger} ledger and ${counts.options} option entr${counts.options === 1 ? 'y' : 'ies'}.`, 'Rebuild Ledger');
      } catch (e) {
        await Dialogs.alert(`Rebuild failed, no changes were made: ${e.message}`);
      }
      App.onDataChanged();
    }

    panel._ledTable = table;
  }

  function _loadData() {
    return DB.query(`
      SELECT l.Holding_ID, l.Account_ID, a.Name, l.Symbol, l.Quantity, l.Cost_Basis, l.Currency,
        CASE WHEN l.Quantity <> 0 THEN l.Cost_Basis / l.Quantity END AS AvgPrice
      FROM Ledger l
      JOIN Accounts a ON a.Account_ID = l.Account_ID
      WHERE l.Active = 1 AND l.Quantity <> 0
      ORDER BY a.Name, l.Symbol`);
  }

  function _refresh(tabId) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._ledTable) panel._ledTable.replaceData(_loadData());
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

// OptionsTab — View > Options: active, non-expired option positions with quantity ≠ 0,
// with manual editing and deactivation (VERSION_2.md item 4). Options are tracked, not valued.
const OptionsTab = (() => {
  const TAB_ID = 'opt';

  function open() {
    App.Tabs.open(TAB_ID, 'Options', panel => _build(panel, TAB_ID), { refresh: () => _refresh(TAB_ID) });
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
              <div class="form-field"><label>Symbol</label>
                <input class="form-control form-readonly" id="ft-${id}-symbol" readonly placeholder="e.g. NVDA20270115C360"></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Quantity</label>
                <input class="form-control" id="ft-${id}-qty" type="number" step="1" placeholder="contracts, negative = written"></div>
              <div class="form-field">
                <label>Cost Basis</label>
                <div class="amt-cur">
                  <input class="form-control" id="ft-${id}-cost" type="number" step="0.01" placeholder="premium paid +, received −">
                  <input class="form-control" id="ft-${id}-currency" maxlength="3" value="USD">
                </div>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="${id}-btn-new">New</button>
              <button class="btn btn-secondary" id="${id}-btn-deactivate" disabled>Deactivate</button>
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
        { title: 'Asset', field: 'Asset', headerFilter: true, headerSortTristate: true },
        { title: 'Expiration Date', field: 'Expiration_Date', headerFilter: true, headerSortTristate: true },
        { title: 'Strike', field: 'Strike', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Quantity', field: 'Quantity', headerSortTristate: true }
      ]
    });

    table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selected = rows[0].getData();
      _isNew = false;
      fld(id, 'account').value = String(_selected.Account_ID);
      fld(id, 'account').disabled = true;
      const sym = fld(id, 'symbol');
      sym.value = _selected.Symbol; sym.readOnly = true; sym.classList.add('form-readonly');
      fld(id, 'qty').value = _selected.Quantity;
      fld(id, 'cost').value = _selected.Cost_Basis;
      fld(id, 'currency').value = _selected.Currency || 'USD';
      btn('deactivate').disabled = false;
      btn('accept').disabled = true;
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
      btn('accept').disabled = false;
    });
    btn('accept').addEventListener('click', _accept);
    btn('deactivate').addEventListener('click', _deactivate);
    ['account', 'symbol', 'qty', 'cost', 'currency'].forEach(f =>
      fld(id, f).addEventListener('input', () => { btn('accept').disabled = false; }));

    async function _accept() {
      const accountId = Number(fld(id, 'account').value);
      const symbol    = Engine.normalizeOption(fld(id, 'symbol').value);
      const qty       = parseInt(fld(id, 'qty').value, 10);
      const cost      = parseFloat(fld(id, 'cost').value);
      if (!accountId || isNaN(qty) || isNaN(cost)) { await Dialogs.alert('Account, Symbol, Quantity, and Cost Basis are required.'); return; }
      if (!symbol) { await Dialogs.alert('Enter the option symbol as <Ticker><YYYY><MM><DD><C|P><Strike>, e.g. NVDA20270115C360.'); return; }
      const prev = Engine.activeEntry('Options', accountId, symbol);
      if (_isNew && prev && !(await Dialogs.confirm(`${symbol} already has an option entry in this account. Replace it?`))) return;
      await DB.transaction(() => Engine.supersede('Options', accountId, symbol, prev, qty, Math.round(cost * 100) / 100,
                                                  null, fld(id, 'currency').value.trim() || 'USD'));
      _isNew = false;
      btn('accept').disabled = true;
      App.onDataChanged();
    }

    async function _deactivate() {
      if (!_selected) return;
      if (!(await Dialogs.confirm(`Deactivate the option entry ${_selected.Symbol} of ${_selected.Name}?`))) return;
      DB.run('UPDATE Options SET Active=0 WHERE Option_ID=?', [_selected.Option_ID]);
      _selected = null;
      btn('deactivate').disabled = true;
      App.onDataChanged();
    }

    panel._optTable = table;
  }

  function _loadData() {
    return DB.query(`
      SELECT o.*, a.Name
      FROM Options o
      JOIN Accounts a ON a.Account_ID = o.Account_ID
      WHERE o.Active = 1 AND o.Quantity <> 0 AND o.Expiration_Date >= ?
      ORDER BY o.Expiration_Date, o.Asset, o.Symbol`, [_todayStr()]);
  }

  function _refresh(tabId) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._optTable) panel._optTable.replaceData(_loadData());
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

const TransactionsTab = (() => {
  let _ctr = 0;

  function open(filter) {
    filter = filter || {};
    const id = `txn-${++_ctr}`;
    let label = 'Transactions';
    if (filter.symbol) {
      label = filter.symbol;
    } else if (filter.accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [filter.accountId]);
      if (acc.length) label = acc[0].Name;
    }
    App.Tabs.open(id, label, panel => _build(panel, id, filter), { closeable: true, refresh: () => _refresh(id, filter) });
  }

  function fld(id, name) { return document.getElementById(`ft-${id}-${name}`); }

  // Convert datetime-local input value (YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS) to stored format
  function _toStoredTs(v) {
    if (!v) return _nowTs();
    const s = v.replace('T', ' ');
    return s.length === 16 ? s + ':00' : s;
  }

  function _build(panel, id, filter) {
    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    const accOpts  = accounts.map(a => `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`).join('');

    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Account</label><input class="form-control form-readonly" id="ft-${id}-account" readonly></div>
              <div class="form-field"><label>Name</label>
                <select class="form-control" id="ft-${id}-name"><option value="">— select —</option>${accOpts}</select>
              </div>
              <div class="form-field"><label>Timestamp</label><input class="form-control" id="ft-${id}-date" type="datetime-local"></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Symbol</label><input class="form-control" id="ft-${id}-symbol"></div>
              <div class="form-field"><label>Quantity</label><input class="form-control" id="ft-${id}-qty" type="number" step="any"></div>
              <div class="form-field">
                <label>Price</label>
                <div class="amt-cur">
                  <input class="form-control" id="ft-${id}-price" type="number" step="0.01" min="0">
                  <input class="form-control" id="ft-${id}-currency" maxlength="3" value="USD">
                </div>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="${id}-btn-new">New</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="${id}-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    let _selected = null;
    let _isNew    = false;

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: _loadData(filter),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      initialSort: [{ column: 'Timestamp', dir: 'asc' }],
      columns: [
        { title: 'Name',      field: 'Name',      headerFilter: true, headerSortTristate: true },
        { title: 'Type',      field: 'TxType',    headerFilter: true, headerSortTristate: true },
        { title: 'Timestamp', field: 'Timestamp', headerFilter: true, headerSortTristate: true },
        { title: 'Symbol',    field: 'Symbol',    headerFilter: true, headerSortTristate: true },
        { title: 'Quantity',  field: 'Quantity',  headerSortTristate: true,
          formatter: cell => _fmtNum(Math.abs(cell.getValue())) },
        { title: 'Price', field: 'Price', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Value', field: 'Value', headerSortTristate: true,
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
      if (e.key === 'Delete' && _selected && !_isNew) _delete(_selected);
    });

    fld(id, 'name').addEventListener('change', () => {
      const accId = fld(id, 'name').value;
      const acc = accounts.find(a => String(a.Account_ID) === String(accId));
      fld(id, 'account').value = acc ? acc.Account : '';
      _dirty();
    });

    panel.querySelector(`#${id}-btn-new`).addEventListener('click', () => {
      _isNew = true;
      _selected = null;
      table.deselectRow();
      _clearForm();
    });

    panel.querySelector(`#${id}-btn-accept`).addEventListener('click', () => _accept(_isNew, _selected));

    ['symbol','qty','price','currency','date'].forEach(f =>
      fld(id, f).addEventListener('input', _dirty)
    );

    function _dirty() { panel.querySelector(`#${id}-btn-accept`).disabled = false; }

    function _populate(row) {
      fld(id, 'account').value  = row.Account    || '';
      fld(id, 'name').value     = row.Account_ID != null ? String(row.Account_ID) : '';
      // Convert stored 'YYYY-MM-DD HH:MM:SS' to datetime-local format 'YYYY-MM-DDTHH:MM:SS'
      fld(id, 'date').value     = (row.Timestamp || '').replace(' ', 'T');
      fld(id, 'symbol').value   = row.Symbol     || '';
      fld(id, 'qty').value      = row.Quantity   != null ? row.Quantity : '';
      fld(id, 'price').value    = row.Price      != null ? row.Price    : '';
      fld(id, 'currency').value = row.Currency   || 'USD';
      panel.querySelector(`#${id}-btn-accept`).disabled = true;
    }

    function _clearForm() {
      fld(id, 'account').value  = '';
      fld(id, 'name').value     = '';
      fld(id, 'date').value     = _nowTs().replace(' ', 'T');
      fld(id, 'symbol').value   = filter.symbol || '';
      fld(id, 'qty').value      = '';
      fld(id, 'price').value    = '';
      fld(id, 'currency').value = 'USD';
      panel.querySelector(`#${id}-btn-accept`).disabled = false;
    }

    async function _accept(isNew, selectedRow) {
      const accountId = fld(id, 'name').value;
      const symbol    = fld(id, 'symbol').value.trim().toUpperCase();
      const qty       = parseFloat(fld(id, 'qty').value);
      const price     = parseFloat(fld(id, 'price').value);
      const currency  = fld(id, 'currency').value.trim() || 'USD';
      const ts        = _toStoredTs(fld(id, 'date').value);

      if (!accountId || !symbol || isNaN(qty) || isNaN(price)) {
        await Dialogs.alert('Account, Symbol, Quantity, and Price are required.');
        return;
      }

      if (isNew) {
        await App.ensureAsset(symbol);
        const existing = DB.query('SELECT COUNT(*) AS cnt FROM Prices WHERE Symbol=?', [symbol]);
        if (!existing[0].cnt) {
          DB.run('INSERT INTO Prices (Timestamp, Symbol, Price, Currency, Valid) VALUES (?,?,?,?,1)',
            [ts, symbol, Math.round(price * 100) / 100, currency]);
        }
        const hash = _txHash(accountId, symbol, qty, price);
        DB.run(`INSERT OR IGNORE INTO Ledger
          (Transaction_Hash, Timestamp, Account_ID, Symbol, Quantity, Price, Currency, Valid)
          VALUES (?,?,?,?,?,?,?,1)`,
          [hash, ts, accountId, symbol, qty, price, currency]);
        DB.run('UPDATE Accounts SET Last_Updated=? WHERE Account_ID=?', [ts, accountId]);
      } else {
        DB.run('UPDATE Ledger SET Timestamp=?, Account_ID=?, Symbol=?, Quantity=?, Price=?, Currency=? WHERE Transaction_Hash=?',
          [ts, accountId, symbol, qty, price, currency, selectedRow.Transaction_Hash]);
      }
      panel.querySelector(`#${id}-btn-accept`).disabled = true;
      _isNew = false;
      _refresh(id, filter);
      App.onDataChanged();
    }

    async function _delete(row) {
      const ok = await Dialogs.confirm(`Invalidate this transaction (${row.Symbol}, ${row.Quantity} @ ${row.Price})?`);
      if (!ok) return;
      DB.run('UPDATE Ledger SET Valid=0 WHERE Transaction_Hash=?', [row.Transaction_Hash]);
      _selected = null;
      _refresh(id, filter);
      App.onDataChanged();
    }

    panel._txTable = table;
    panel._txFilter = filter;
  }

  function _loadData(filter) {
    let where = 'l.Valid = 1';
    const params = [];
    if (filter.accountId) { where += ' AND l.Account_ID = ?'; params.push(filter.accountId); }
    if (filter.symbol)    { where += ' AND l.Symbol = ?';     params.push(filter.symbol); }
    return DB.query(`
      SELECT l.Transaction_Hash, a.Account_ID, a.Account, a.Name,
        CASE WHEN l.Quantity > 0 THEN 'Buy' ELSE 'Sale' END AS TxType,
        l.Timestamp, l.Symbol, l.Quantity, l.Price,
        l.Quantity * l.Price AS Value, l.Currency
      FROM Ledger l
      JOIN Accounts a ON l.Account_ID = a.Account_ID
      WHERE ${where}
      ORDER BY l.Timestamp ASC`, params);
  }

  function _refresh(tabId, filter) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._txTable) panel._txTable.replaceData(_loadData(filter));
  }

  function _txHash(accountId, symbol, qty, price) {
    const key = `${accountId}|${symbol}|${qty}|${price}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) { h = (Math.imul(31, h) + key.charCodeAt(i)) | 0; }
    return key + '_' + Math.abs(h).toString(36);
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

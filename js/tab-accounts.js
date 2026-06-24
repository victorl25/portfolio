const AccountsTab = (() => {
  const TAB_ID = 'acc';
  let _table = null;
  let _selectedRow = null;
  let _isNew = false;

  function open() {
    App.Tabs.open(TAB_ID, 'Accounts', panel => _build(panel), { refresh: _refresh });
  }

  function _build(panel) {
    if (_table) { _table.destroy(); _table = null; }
    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="acc-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Account</label><input class="form-control" id="acc-f-account"></div>
              <div class="form-field"><label>Name</label><input class="form-control" id="acc-f-name"></div>
            </div>
            <div class="form-col">
              <div class="form-field">
                <label>Cash</label>
                <div class="amt-cur">
                  <input class="form-control" id="acc-f-cash" type="number" step="0.01">
                  <input class="form-control" id="acc-f-currency" maxlength="3">
                </div>
              </div>
              <div class="form-field"><label>Active</label>
                <select class="form-control" id="acc-f-active">
                  <option value="1">Yes</option><option value="0">No</option>
                </select>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="acc-btn-new">New</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="acc-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    _table = new Tabulator('#acc-table-wrap', {
      data: _loadData(),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Account', field: 'Account', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => { e.stopPropagation(); PortfolioTab.open(cell.getRow().getData().Account_ID); });
            return a;
          }
        },
        { title: 'Name', field: 'Name', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => { e.stopPropagation(); PortfolioTab.open(cell.getRow().getData().Account_ID); });
            return a;
          }
        },
        { title: 'Balance', field: 'Balance', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Cash', field: 'Cash', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Last Updated', field: 'Last_Updated', headerSortTristate: true }
      ]
    });

    _table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selectedRow = rows[0].getData();
      _isNew = false;
      _populateForm(_selectedRow);
    });

    panel.addEventListener('keydown', e => {
      if (e.key === 'Delete' && _selectedRow && !_isNew) _deleteSelected();
    });

    panel.querySelector('#acc-btn-new').addEventListener('click', () => {
      _isNew = true;
      _selectedRow = null;
      _table.deselectRow();
      _clearForm();
      _enableAccept();
    });

    panel.querySelector('#acc-btn-accept').addEventListener('click', _accept);

    ['acc-f-account','acc-f-name','acc-f-cash','acc-f-currency','acc-f-active'].forEach(id => {
      document.getElementById(id).addEventListener('input', _enableAccept);
    });
  }

  function _loadData() {
    return DB.query(`
      SELECT a.Account_ID, a.Account, a.Name, a.Cash, a.Last_Updated, a.Currency, a.Active,
        ROUND(COALESCE(inv.AssetsValue, 0) + COALESCE(a.Cash, 0), 2) AS Balance
      FROM Accounts a
      LEFT JOIN (
        SELECT l.Account_ID,
          SUM(l.Quantity * COALESCE(p.Price, 0)) AS AssetsValue
        FROM Ledger l
        LEFT JOIN (
          SELECT Symbol, Price FROM Prices
          WHERE Valid = 1
          GROUP BY Symbol
          HAVING Timestamp = MAX(Timestamp)
        ) p ON l.Symbol = p.Symbol
        WHERE l.Valid = 1
        GROUP BY l.Account_ID
      ) inv ON a.Account_ID = inv.Account_ID
      WHERE a.Active = 1
      ORDER BY a.Name`);
  }

  function _populateForm(row) {
    document.getElementById('acc-f-account').value  = row.Account   || '';
    document.getElementById('acc-f-name').value     = row.Name      || '';
    document.getElementById('acc-f-cash').value     = row.Cash      != null ? row.Cash : '';
    document.getElementById('acc-f-currency').value = row.Currency  || 'USD';
    document.getElementById('acc-f-active').value   = row.Active    != null ? row.Active : 1;
    document.getElementById('acc-btn-accept').disabled = true;
  }

  function _clearForm() {
    ['acc-f-account','acc-f-name','acc-f-cash'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('acc-f-currency').value = 'USD';
    document.getElementById('acc-f-active').value = '1';
    document.getElementById('acc-btn-accept').disabled = false;
  }

  function _enableAccept() {
    document.getElementById('acc-btn-accept').disabled = false;
  }

  async function _accept() {
    const account  = document.getElementById('acc-f-account').value.trim();
    const name     = document.getElementById('acc-f-name').value.trim();
    const cash     = parseFloat(document.getElementById('acc-f-cash').value) || 0;
    const currency = document.getElementById('acc-f-currency').value.trim() || 'USD';
    const active   = parseInt(document.getElementById('acc-f-active').value);

    if (!account || !name) { await Dialogs.alert('Account and Name are required.'); return; }

    if (_isNew) {
      DB.run('INSERT INTO Accounts (Account, Name, Cash, Currency, Active) VALUES (?,?,?,?,?)',
        [account, name, cash, currency, active]);
    } else {
      DB.run('UPDATE Accounts SET Account=?, Name=?, Cash=?, Currency=?, Active=? WHERE Account_ID=?',
        [account, name, cash, currency, active, _selectedRow.Account_ID]);
    }
    document.getElementById('acc-btn-accept').disabled = true;
    _isNew = false;
    _refresh();
    App.onDataChanged();
  }

  async function _deleteSelected() {
    const refs = DB.query('SELECT COUNT(*) AS cnt FROM Ledger WHERE Account_ID=? AND Valid=1',
      [_selectedRow.Account_ID]);
    if (refs[0].cnt > 0) {
      await Dialogs.alert(`Cannot delete: this account has ${refs[0].cnt} transaction(s).`);
      return;
    }
    const ok = await Dialogs.confirm(`Deactivate account "${_selectedRow.Name}"?`);
    if (!ok) return;
    DB.run('UPDATE Accounts SET Active=0 WHERE Account_ID=?', [_selectedRow.Account_ID]);
    _selectedRow = null;
    _clearForm();
    document.getElementById('acc-btn-accept').disabled = true;
    _refresh();
    App.onDataChanged();
  }

  function _refresh() {
    if (_table) _table.replaceData(_loadData());
  }

  return { open, refresh: _refresh };
})();

// TransactionsTab — View > Transactions: valid rows of the Transactions table, optionally
// pre-filtered by account and/or symbol. Edits and deletes follow VERSION_2.md (Transactions table).
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
    App.Tabs.open(id, label, panel => _build(panel, id, filter), { refresh: () => _refresh(id, filter) });
  }

  function fld(id, name) { return document.getElementById(`ft-${id}-${name}`); }

  function _build(panel, id, filter) {
    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    const accOpts  = accounts.map(a => `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`).join('');
    // all stored effects: the rule effects except Ignore, plus Snapshot (holdings recorded by Import holdings)
    const effOpts  = [...Engine.EFFECTS.filter(e => e !== 'Ignore'), 'Snapshot'].map(e => `<option>${e}</option>`).join('');
    const catOpts  = Engine.CATEGORIES.map(c => `<option>${c}</option>`).join('');

    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Account</label>
                <select class="form-control" id="ft-${id}-account"><option value="">— select —</option>${accOpts}</select>
              </div>
              <div class="form-field"><label>Date</label><input class="form-control" id="ft-${id}-date" type="date"></div>
              <div class="form-field">
                <label>Effect / Category</label>
                <div class="sel-pair">
                  <select class="form-control" id="ft-${id}-effect">${effOpts}</select>
                  <select class="form-control" id="ft-${id}-category">${catOpts}</select>
                </div>
              </div>
              <div class="form-field"><label>Description</label><input class="form-control" id="ft-${id}-desc"></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Symbol</label><input class="form-control" id="ft-${id}-symbol"></div>
              <div class="form-field"><label>Quantity</label><input class="form-control" id="ft-${id}-qty" type="number" step="any"></div>
              <div class="form-field">
                <label>Price</label>
                <div class="amt-cur">
                  <input class="form-control" id="ft-${id}-price" type="number" step="any">
                  <input class="form-control" id="ft-${id}-currency" maxlength="3" value="USD">
                </div>
              </div>
              <div class="form-field"><label>Amount</label>
                <input class="form-control" id="ft-${id}-amount" type="number" step="0.01" placeholder="blank = −Quantity × Price"></div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="${id}-btn-new">New</button>
              <button class="btn btn-secondary" id="${id}-btn-delete" disabled>Delete</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="${id}-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    let _selected = null;
    let _isNew    = false;
    const btn = name => panel.querySelector(`#${id}-btn-${name}`);
    const money = { formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } };

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: _loadData(filter),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Date',        field: 'Date',        headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Account',     field: 'Name',        headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Type',        field: 'Type',        headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Category',    field: 'Category',    headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Symbol',      field: 'Symbol',      headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Quantity',    field: 'Quantity',    headerSortTristate: true, widthGrow: 1, formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price',       field: 'Price',       headerSortTristate: true, widthGrow: 1, ...money },
        { title: 'Amount',      field: 'Amount',      headerSortTristate: true, widthGrow: 1, ...money },
        { title: 'Description', field: 'Description', headerFilter: true, headerSortTristate: true, widthGrow: 3 }
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
      fld(id, 'account').value  = filter.accountId ? String(filter.accountId) : '';
      fld(id, 'date').value     = _todayStr();
      fld(id, 'effect').value   = 'Trade';
      fld(id, 'category').value = 'Asset';
      fld(id, 'desc').value     = '';
      fld(id, 'symbol').value   = filter.symbol || '';
      ['qty', 'price', 'amount'].forEach(f => { fld(id, f).value = ''; });
      fld(id, 'currency').value = 'USD';
      btn('delete').disabled = true;
      btn('accept').disabled = false;
    });
    btn('accept').addEventListener('click', _accept);
    btn('delete').addEventListener('click', _delete);
    ['account', 'date', 'effect', 'category', 'desc', 'symbol', 'qty', 'price', 'currency', 'amount'].forEach(f =>
      fld(id, f).addEventListener('input', () => { btn('accept').disabled = false; }));

    function _populate(row) {
      fld(id, 'account').value  = String(row.Account_ID);
      fld(id, 'date').value     = row.Date || '';
      fld(id, 'effect').value   = row.Effect;
      fld(id, 'category').value = row.Category;
      fld(id, 'desc').value     = row.Description || '';
      fld(id, 'symbol').value   = row.Symbol || '';
      fld(id, 'qty').value      = row.Quantity ?? '';
      fld(id, 'price').value    = row.Price ?? '';
      fld(id, 'amount').value   = row.Amount ?? '';
      fld(id, 'currency').value = row.Currency || 'USD';
      btn('delete').disabled = false;
      btn('accept').disabled = true;
    }

    function _readForm() {
      const num = f => { const v = fld(id, f).value.trim(); return v === '' ? null : parseFloat(v); };
      const symbol = Engine.normalizeSymbol(fld(id, 'symbol').value) || null;
      const effect = fld(id, 'effect').value;
      let category = fld(id, 'category').value;
      if (category === 'Asset') category = symbol && Engine.isOption(symbol) ? 'Option' : 'Equity';
      const quantity = num('qty') ?? 0;
      const price = num('price');
      const amount = Engine.resolveAmount({ amount: num('amount'), quantity, price, effect, symbol });
      return {
        Account_ID: Number(fld(id, 'account').value) || null, Date: fld(id, 'date').value, Effect: effect,
        Type: Engine.EFFECT_TYPE[effect], Category: category, Symbol: symbol, Quantity: quantity, Price: price,
        Amount: amount, Currency: fld(id, 'currency').value.trim() || 'USD', Description: fld(id, 'desc').value.trim()
      };
    }

    async function _accept() {
      const t = _readForm();
      if (!t.Account_ID || !/^\d{4}-\d{2}-\d{2}$/.test(t.Date)) { await Dialogs.alert('Account and Date are required.'); return; }
      const needsSymbol = ['Trade', 'Reinvestment', 'Distribution', 'Split', 'RSU'].includes(t.Effect);
      if (needsSymbol && !t.Symbol) { await Dialogs.alert(`A Symbol is required for ${t.Effect} transactions.`); return; }
      if (t.Effect === 'RSU' && t.Price == null) {
        // Cost basis = quantity × the closing price on the vesting date
        t.Price = Engine.priceOn(t.Symbol, t.Date);
        if (t.Price == null) {
          await Dialogs.alert(`No ${t.Symbol} closing price is stored for ${t.Date}. Enter the price (Tools > Update prices only covers the last year).`);
          return;
        }
      }

      // Editing: `before` is the transaction as it was (the selected row); when the edit changes a position and the
      // transaction is not the latest one applied to the ledger, the user chooses what to do first
      const before = _isNew ? null : { ..._selected };
      let rebuild = false;
      if (before) {
        let impact;
        try { ({ impact } = Engine.editImpact(before, t)); }
        catch (e) { await Dialogs.alert(`Could not save the transaction: ${(e && e.message) || String(e)}`); return; }
        if (impact === 'earlier' || impact === 'unlinked') {
          const choice = await _ledgerChoice(before, impact);
          if (choice === 'cancel') return;
          rebuild = choice === 'rebuild';
        }
      }
      try {
        if (_isNew) await DB.transaction(() => Engine.record(t));
        else await DB.transaction(() => Engine.editTransaction(before, t, { rebuild }));
      } catch (e) {
        await Dialogs.alert(`Could not save the transaction: ${(e && e.message) || String(e)}`);
        return;
      }
      if ((t.Type === 'Trade' || t.Type === 'Record') && t.Symbol && !Engine.isOption(t.Symbol)) await App.ensureAsset(t.Symbol);
      _isNew = false;
      btn('accept').disabled = true;
      App.onDataChanged();
    }

    // Asks what to do with the ledger when the edited or deleted transaction is not the latest one applied to it:
    // resolves 'update' (save/delete the transaction only), 'rebuild' (and rebuild the asset's ledger) or 'cancel'
    function _ledgerChoice(txn, impact, action = 'edit') {
      const what = `${txn.Symbol || 'the asset'} in ${txn.Name || 'this account'}`;
      const why = impact === 'earlier'
        ? `This transaction is not the last one applied to the ledger of ${what}: later transactions were applied after it.`
        : `This transaction is not applied to the current ledger of ${what}.`;
      const verb = action === 'delete' ? 'Delete' : 'Update';
      const onlyText = `${verb} the transaction only (the ledger is not changed)`;
      const rebuildText = impact === 'earlier'
        ? `${verb} the transaction and rebuild the ledger of the asset, starting from the ledger record of this transaction`
        : `${verb} the transaction and rebuild the ledger of the asset from all of its transactions`;
      return new Promise(resolve => {
        const c = Dialogs.custom(`
          <div class="dlg dlg-wide">
            <div class="dlg-title">${action === 'delete' ? 'Delete' : 'Edit'} Transaction</div>
            <div class="dlg-body">
              <p>${_esc(why)}</p>
              <label class="dlg-choice"><input type="radio" name="txn-ledger-choice" value="update" checked>
                ${_esc(onlyText)}</label>
              <label class="dlg-choice"><input type="radio" name="txn-ledger-choice" value="rebuild"> ${_esc(rebuildText)}</label>
            </div>
            <div class="dlg-footer">
              <button class="btn btn-secondary" id="txn-choice-cancel">Cancel</button>
              <button class="btn btn-primary" id="txn-choice-ok">OK</button>
            </div>
          </div>`);
        c.querySelector('#txn-choice-cancel').addEventListener('click', () => { Dialogs.close(); resolve('cancel'); });
        c.querySelector('#txn-choice-ok').addEventListener('click', () => {
          const v = c.querySelector('input[name="txn-ledger-choice"]:checked').value;
          Dialogs.close();
          resolve(v);
        });
      });
    }

    async function _delete() {
      if (!_selected) return;
      const what = `${_selected.Date} ${_selected.Symbol || ''} ${_selected.Description || ''}`.trim();
      const row = DB.query('SELECT * FROM Transactions WHERE Transaction_ID=?', [_selected.Transaction_ID])[0];
      const { impact } = Engine.deleteImpact(row);
      let rebuild = false;
      if (impact === 'earlier') {
        // not the last transaction applied to the ledger: same choice as for edits
        const choice = await _ledgerChoice(_selected, impact, 'delete');
        if (choice === 'cancel') return;
        rebuild = choice === 'rebuild';
      } else {
        const msg = impact === 'latest'
          ? `Delete the transaction "${what}"? It is the last transaction applied to the ledger of ${_selected.Symbol}, ` +
            'so the current ledger entry goes back to its state before this transaction.'
          : impact === 'unlinked'
            ? `Delete the transaction "${what}"? It is not applied to the current ledger of ${_selected.Symbol}, so the ledger is not changed.`
            : `Delete the transaction "${what}"?`;
        if (!(await Dialogs.confirm(msg, 'Delete Transaction'))) return;
      }
      await DB.transaction(() => Engine.deleteTransaction(row, { rebuild }));
      _selected = null;
      btn('delete').disabled = true;
      App.onDataChanged();
    }

    panel._txTable = table;
  }

  function _loadData(filter) {
    let where = 't.Valid = 1';
    const params = [];
    if (filter.accountId) { where += ' AND t.Account_ID = ?'; params.push(filter.accountId); }
    if (filter.symbol)    { where += ' AND t.Symbol = ?';     params.push(filter.symbol); }
    return DB.query(`
      SELECT t.*, a.Name
      FROM Transactions t
      JOIN Accounts a ON t.Account_ID = a.Account_ID
      WHERE ${where}
      ORDER BY t.Date, t.Transaction_ID`, params);
  }

  function _refresh(tabId, filter) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._txTable) panel._txTable.replaceData(_loadData(filter));
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

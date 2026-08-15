const PricesTab = (() => {
  const TAB_ID = 'prc';
  let _table = null;
  let _selectedRow = null;

  function open() {
    App.Tabs.open(TAB_ID, 'Prices', panel => _build(panel), { refresh: _refresh });
  }

  function _build(panel) {
    if (_table) { _table.destroy(); _table = null; }
    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="prc-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Symbol</label><input class="form-control form-readonly" id="prc-f-symbol" readonly></div>
              <div class="form-field"><label>Description</label><input class="form-control form-readonly" id="prc-f-desc" readonly></div>
            </div>
            <div class="form-col">
              <div class="form-field">
                <label>Price</label>
                <div class="amt-cur">
                  <input class="form-control" id="prc-f-price" type="number" step="0.01" min="0">
                  <input class="form-control form-readonly" id="prc-f-currency" readonly value="USD">
                </div>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="prc-btn-update" disabled>Update</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="prc-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    _table = new Tabulator('#prc-table-wrap', {
      data: _loadData(),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Symbol', field: 'Symbol', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => { e.stopPropagation(); TransactionsTab.open({ symbol: cell.getValue() }); });
            return a;
          }
        },
        { title: 'Description', field: 'Description', headerFilter: true, headerSortTristate: true },
        { title: 'Price', field: 'Price', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Timestamp', field: 'Timestamp', headerSortTristate: true }
      ]
    });

    _table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selectedRow = rows[0].getData();
      document.getElementById('prc-f-symbol').value   = _selectedRow.Symbol      || '';
      document.getElementById('prc-f-desc').value     = _selectedRow.Description || '';
      document.getElementById('prc-f-price').value    = _selectedRow.Price       != null ? _selectedRow.Price : '';
      document.getElementById('prc-f-currency').value = _selectedRow.Currency    || 'USD';
      document.getElementById('prc-btn-update').disabled = false;
      document.getElementById('prc-btn-accept').disabled = true;
    });

    document.getElementById('prc-f-price').addEventListener('input', () => {
      document.getElementById('prc-btn-accept').disabled = false;
    });

    document.getElementById('prc-btn-update').addEventListener('click', _update);
    document.getElementById('prc-btn-accept').addEventListener('click', _accept);
  }

  function _loadData() {
    return DB.query(`
      SELECT p.Symbol, a.Description, p.Price, p.Timestamp, p.Currency
      FROM Prices p
      JOIN Assets a ON p.Symbol = a.Symbol
      WHERE p.Valid = 1
      GROUP BY p.Symbol
      HAVING p.Timestamp = MAX(p.Timestamp)
      ORDER BY p.Symbol`);
  }

  async function _update() {
    if (!_selectedRow) return;
    const btn = document.getElementById('prc-btn-update');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const quote = await YahooFinance.getQuote(_selectedRow.Symbol);
      const price = quote.regularMarketPrice ?? quote.regularMarketPreviousClose;
      if (price != null && !isNaN(price)) {
        document.getElementById('prc-f-price').value = Math.round(price * 100) / 100;
        document.getElementById('prc-btn-accept').disabled = false;
      } else {
        await Dialogs.alert('Price not available for this symbol.');
      }
    } catch (e) {
      await Dialogs.alert(`Failed to retrieve price: ${e.message}`);
    }
    btn.textContent = 'Update';
    btn.disabled = false;
  }

  async function _accept() {
    if (!_selectedRow) return;
    const price = parseFloat(document.getElementById('prc-f-price').value);
    if (isNaN(price) || price < 0) { await Dialogs.alert('Enter a valid price.'); return; }
    DB.run('INSERT INTO Prices (Timestamp, Symbol, Price, Currency, Valid) VALUES (?,?,?,?,1)',
      [_nowTs(), _selectedRow.Symbol, Math.round(price * 100) / 100, _selectedRow.Currency || 'USD']);
    document.getElementById('prc-btn-accept').disabled = true;
    _refresh();
    App.onDataChanged();
  }

  function _refresh() {
    if (_table) _table.replaceData(_loadData());
  }

  return { open, refresh: _refresh };
})();

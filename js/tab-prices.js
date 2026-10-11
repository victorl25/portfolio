const PricesTab = (() => {
  const TAB_ID = 'prc';
  let _table = null;
  let _selectedRow = null;

  function open() {
    App.Tabs.open(TAB_ID, 'Prices', panel => _build(panel), { refresh: _refresh, onClose: () => { _table = null; _selectedRow = null; } });
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
        { title: 'Date', field: 'Date', headerSortTristate: true },
        // Update: stores the symbol's daily closes like Tools > Update prices (updateSymbolPrices in app.js)
        { title: 'Action', field: 'Symbol', width: 90, hozAlign: 'center', headerSort: false,
          formatter: () => `<button class="act-btn analyze-btn">Update</button>`,
          cellClick: (e, cell) => {
            if (!e.target.classList.contains('act-btn')) return;
            _updateRow(cell.getRow().getData().Symbol, e.target);
          }
        }
      ]
    });

    _table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selectedRow = rows[0].getData();
      document.getElementById('prc-f-symbol').value   = _selectedRow.Symbol      || '';
      document.getElementById('prc-f-desc').value     = _selectedRow.Description || '';
      document.getElementById('prc-f-price').value    = _selectedRow.Price       != null ? _selectedRow.Price : '';
      document.getElementById('prc-f-currency').value = _selectedRow.Currency    || 'USD';
      document.getElementById('prc-btn-accept').disabled = true;
    });

    document.getElementById('prc-f-price').addEventListener('input', () => {
      document.getElementById('prc-btn-accept').disabled = false;
    });

    document.getElementById('prc-btn-accept').addEventListener('click', _accept);
  }

  // Every active asset with its description and latest price (Price/Date empty when no price is stored),
  // plus symbols that have prices but no Assets row — an outer join of Assets and the latest prices
  function _loadData() {
    return DB.query(`
      SELECT a.Symbol, a.Description, lp.Price, lp.Date, p.Currency
      FROM Assets a
      LEFT JOIN v_latest_price lp ON lp.Symbol = a.Symbol
      LEFT JOIN Prices p ON p.Symbol = lp.Symbol AND p.Date = lp.Date
      WHERE a.Active = 1
      UNION ALL
      SELECT lp.Symbol, NULL, lp.Price, lp.Date, p.Currency
      FROM v_latest_price lp
      JOIN Prices p ON p.Symbol = lp.Symbol AND p.Date = lp.Date
      WHERE NOT EXISTS (SELECT 1 FROM Assets a WHERE a.Symbol = lp.Symbol)
      ORDER BY 1`);
  }

  // Action column Update: fetches and stores the symbol's daily closes (same logic as Tools > Update prices)
  async function _updateRow(symbol, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '…';
    let r;
    try {
      r = await updateSymbolPrices(symbol, attempt => { button.textContent = `retry ${attempt}`; });
    } catch (e) {
      r = { reason: e.message };
    }
    button.disabled = false;
    button.textContent = 'Update';
    if (r.limited) {
      await Dialogs.alert(`The Yahoo Finance server kept returning "Too Many Requests" for ${symbol} (${PRICE_MAX_ATTEMPTS} attempts). Try again later.`, 'Update Price');
    } else if (r.reason) {
      await Dialogs.alert(`Failed to update ${symbol}: ${r.reason}`, 'Update Price');
    } else {
      _refresh();
      App.onDataChanged();
    }
  }

  async function _accept() {
    if (!_selectedRow) return;
    const price = parseFloat(document.getElementById('prc-f-price').value);
    if (isNaN(price) || price < 0) { await Dialogs.alert('Enter a valid price.'); return; }
    _upsertPrice(_selectedRow.Symbol, _todayStr(), price, _selectedRow.Currency || 'USD');
    document.getElementById('prc-btn-accept').disabled = true;
    _refresh();
    App.onDataChanged();
  }

  function _refresh() {
    if (_table) _table.replaceData(_loadData());
  }

  return { open, refresh: _refresh, loadData: _loadData };
})();

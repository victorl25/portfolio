const AssetsTab = (() => {
  const TAB_ID = 'ast';
  let _table = null;
  let _selectedRow = null;
  let _isNew = false;

  function open() {
    App.Tabs.open(TAB_ID, 'Assets', panel => _build(panel),
      { refresh: _refresh, onClose: () => { _table = null; _selectedRow = null; _isNew = false; } });
  }

  function _build(panel) {
    if (_table) { _table.destroy(); _table = null; }
    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="ast-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Symbol</label><input class="form-control form-readonly" id="ast-f-symbol" readonly></div>
              <div class="form-field"><label>Description</label><input class="form-control" id="ast-f-desc"></div>
              <div class="form-field"><label>Note</label><input class="form-control" id="ast-f-notes" placeholder="latest note; a changed note is added to the history"></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Type</label>
                <select class="form-control" id="ast-f-type">
                  <option value="">—</option>
                  <option value="Stock">Stock</option>
                  <option value="ETF">ETF</option>
                  <option value="MF">Mutual Fund</option>
                </select>
              </div>
              <div class="form-field"><label>Category</label><input class="form-control" id="ast-f-cat"></div>
              <div class="form-field"><label>Theme</label>
                <div class="ac-wrap">
                  <input class="form-control" id="ast-f-theme" autocomplete="off">
                  <div class="ac-list" id="ast-f-theme-ac"></div>
                </div>
              </div>
            </div>
            <div class="form-col-btns">
              <button class="btn btn-secondary" id="ast-btn-new">New</button>
              <div class="btn-spacer"></div>
              <button class="btn btn-primary" id="ast-btn-accept" disabled>Accept</button>
            </div>
          </div>
        </div>
      </div>`;

    _table = new Tabulator('#ast-table-wrap', {
      data: _loadData(),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Symbol', field: 'Symbol', widthGrow: 1, headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => { e.stopPropagation(); TransactionsTab.open({ symbol: cell.getValue() }); });
            return a;
          }
        },
        { title: 'Quantity', field: 'Quantity', widthGrow: 1, headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            return v != null ? (+v).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
          }
        },
        { title: 'Description', field: 'Description', widthGrow: 2, headerFilter: true, headerSortTristate: true },
        { title: 'Type',        field: 'Type',        widthGrow: 1, headerFilter: true, headerSortTristate: true },
        { title: 'Theme',       field: 'Theme',       widthGrow: 2, headerFilter: true, headerSortTristate: true },
        { title: 'Category',    field: 'Category',    widthGrow: 2, headerFilter: true, headerSortTristate: true },
        { title: 'Notes',       field: 'Notes',       widthGrow: 2, headerFilter: true, headerSortTristate: true },
        { title: 'Action', field: 'NoteCount', width: 80, hozAlign: 'center', headerSort: false,
          formatter: cell => cell.getValue() > 0 ? `<button class="act-btn analyze-btn">Notes</button>` : '',
          cellClick: (e, cell) => {
            if (!e.target.classList.contains('act-btn')) return;
            _showNotes(cell.getRow().getData().Symbol);
          }
        }
      ]
    });

    _attachThemeAutocomplete(
      panel.querySelector('#ast-f-theme'),
      panel.querySelector('#ast-f-theme-ac'));

    _table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selectedRow = rows[0].getData();
      _isNew = false;
      _populateForm(_selectedRow);
    });

    panel.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Delete' && _selectedRow && !_isNew) _deleteSelected();
    });

    panel.querySelector('#ast-btn-new').addEventListener('click', () => {
      _isNew = true;
      _selectedRow = null;
      _table.deselectRow();
      _clearForm(false);
      document.getElementById('ast-f-symbol').readOnly = false;
      document.getElementById('ast-f-symbol').classList.remove('form-readonly');
    });

    panel.querySelector('#ast-btn-accept').addEventListener('click', _accept);

    ['ast-f-symbol','ast-f-desc','ast-f-type','ast-f-cat','ast-f-theme','ast-f-notes'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        document.getElementById('ast-btn-accept').disabled = false;
      });
    });
  }

  function _loadData() {
    return DB.query(`
      SELECT a.Symbol, a.Description, a.Type, a.Category, a.Theme, a.Active,
        h.Quantity,
        (SELECT n.Note FROM Notes n WHERE n.Symbol = a.Symbol ORDER BY n.Timestamp DESC, n.Note_ID DESC LIMIT 1) AS Notes,
        (SELECT COUNT(*) FROM Notes n WHERE n.Symbol = a.Symbol) AS NoteCount
      FROM Assets a
      JOIN v_holdings h ON a.Symbol = h.Symbol   -- held assets only (v_holdings excludes quantity 0)
      WHERE a.Active = 1 AND h.Quantity <> 0
      ORDER BY a.Symbol`);
  }

  // Popup with all notes of an asset in chronological order
  async function _showNotes(symbol) {
    const notes = DB.query('SELECT Timestamp, Note FROM Notes WHERE Symbol=? ORDER BY Timestamp, Note_ID', [symbol]);
    const items = notes.map(n =>
      `<div class="note-item"><div class="note-ts">${_esc(n.Timestamp)}</div><div>${_esc(n.Note)}</div></div>`).join('');
    await Dialogs.alertHtml(`<div class="note-list">${items || '<p>No notes.</p>'}</div>`, `${symbol} Notes`);
  }

  function _attachThemeAutocomplete(inputEl, listEl) {
    inputEl.addEventListener('input', () => {
      const q = inputEl.value.trim();
      if (!q) { listEl.innerHTML = ''; return; }
      const matches = DB.query(
        `SELECT DISTINCT Theme FROM Assets WHERE Theme LIKE ? AND Theme IS NOT NULL AND Theme <> '' ORDER BY Theme LIMIT 10`,
        [`${q}%`]
      );
      listEl.innerHTML = matches.map(m =>
        `<div class="ac-item" data-name="${_esc(m.Theme)}">${_esc(m.Theme)}</div>`
      ).join('');
    });
    listEl.addEventListener('mousedown', e => {
      const item = e.target.closest('.ac-item');
      if (!item) return;
      inputEl.value = item.dataset.name;
      listEl.innerHTML = '';
      document.getElementById('ast-btn-accept').disabled = false;
    });
    inputEl.addEventListener('blur', () => setTimeout(() => { listEl.innerHTML = ''; }, 150));
    _addAcKeyboard(inputEl, listEl);
  }

  function _addAcKeyboard(inputEl, listEl) {
    let idx = -1;
    inputEl.addEventListener('input', () => { idx = -1; });
    inputEl.addEventListener('keydown', e => {
      const items = listEl.querySelectorAll('.ac-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(idx + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle('ac-active', i === idx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        items.forEach((it, i) => it.classList.toggle('ac-active', i === idx));
      } else if (e.key === 'Enter' && idx >= 0) {
        e.preventDefault();
        inputEl.value = items[idx].dataset.name;
        listEl.innerHTML = '';
        idx = -1;
        document.getElementById('ast-btn-accept').disabled = false;
      } else if (e.key === 'Escape') {
        listEl.innerHTML = '';
        idx = -1;
      }
    });
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function _populateForm(row) {
    document.getElementById('ast-f-symbol').value = row.Symbol      || '';
    document.getElementById('ast-f-desc').value   = row.Description || '';
    document.getElementById('ast-f-type').value   = row.Type        || '';
    document.getElementById('ast-f-cat').value    = row.Category    || '';
    document.getElementById('ast-f-theme').value  = row.Theme       || '';
    document.getElementById('ast-f-notes').value  = row.Notes       || '';
    document.getElementById('ast-btn-accept').disabled = true;
    document.getElementById('ast-f-symbol').readOnly = true;
    document.getElementById('ast-f-symbol').classList.add('form-readonly');
  }

  function _clearForm(readonly = true) {
    ['ast-f-symbol','ast-f-desc','ast-f-cat','ast-f-theme','ast-f-notes'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('ast-f-type').value = '';
    document.getElementById('ast-btn-accept').disabled = false;
    if (readonly) {
      document.getElementById('ast-f-symbol').readOnly = true;
      document.getElementById('ast-f-symbol').classList.add('form-readonly');
    }
  }

  async function _accept() {
    const symbol = document.getElementById('ast-f-symbol').value.trim().toUpperCase();
    const desc   = document.getElementById('ast-f-desc').value.trim();
    const type   = document.getElementById('ast-f-type').value;
    const cat    = document.getElementById('ast-f-cat').value.trim();
    const theme  = document.getElementById('ast-f-theme').value.trim();
    const notes  = document.getElementById('ast-f-notes').value.trim();

    if (!symbol) { await Dialogs.alert('Symbol is required.'); return; }

    if (_isNew) {
      DB.run('INSERT OR IGNORE INTO Assets (Symbol, Description, Type, Category, Theme, Active) VALUES (?,?,?,?,?,1)',
        [symbol, desc, type, cat, theme]);
    } else {
      DB.run('UPDATE Assets SET Description=?, Type=?, Category=?, Theme=? WHERE Symbol=?',
        [desc, type, cat, theme, _selectedRow.Symbol]);
    }
    // A new or changed note is added to the note history
    const latest = _isNew ? '' : (_selectedRow.Notes || '');
    if (notes && notes !== latest) {
      DB.run('INSERT INTO Notes (Symbol, Timestamp, Note) VALUES (?,?,?)', [symbol, _nowTs(), notes]);
    }
    // Keep the form bound to the saved asset so a further Accept updates it (and its note) again
    _selectedRow = { ...(_selectedRow || {}), Symbol: _isNew ? symbol : _selectedRow.Symbol, Notes: notes || latest };
    document.getElementById('ast-btn-accept').disabled = true;
    _isNew = false;
    _refresh();
    App.onDataChanged();
  }

  async function _deleteSelected() {
    const prices = DB.query('SELECT COUNT(*) AS cnt FROM Prices WHERE Symbol=? AND Valid=1', [_selectedRow.Symbol]);
    const txns   = DB.query('SELECT COUNT(*) AS cnt FROM Transactions WHERE Symbol=? AND Valid=1', [_selectedRow.Symbol]);
    const ledger = DB.query('SELECT COUNT(*) AS cnt FROM Ledger WHERE Symbol=? AND Active=1', [_selectedRow.Symbol]);
    if (prices[0].cnt > 0 || txns[0].cnt > 0 || ledger[0].cnt > 0) {
      await Dialogs.alert(`Cannot delete: "${_selectedRow.Symbol}" has ${txns[0].cnt} transaction(s), ` +
        `${ledger[0].cnt} ledger entr${ledger[0].cnt === 1 ? 'y' : 'ies'} and ${prices[0].cnt} price record(s).`);
      return;
    }
    const ok = await Dialogs.confirm(`Deactivate asset "${_selectedRow.Symbol}"?`);
    if (!ok) return;
    DB.run('UPDATE Assets SET Active=0 WHERE Symbol=?', [_selectedRow.Symbol]);
    _selectedRow = null;
    _clearForm();
    _refresh();
    App.onDataChanged();
  }

  function _refresh() {
    if (_table) _table.replaceData(_loadData());
  }

  return { open, refresh: _refresh };
})();

// RulesTab — View > Rules: import rules that interpret the Action column of imported
// transactions (VERSION_2.md item 9). Changes apply to subsequent imports only.
const RulesTab = (() => {
  const TAB_ID = 'rul';

  function open() {
    App.Tabs.open(TAB_ID, 'Rules', panel => _build(panel, TAB_ID), { refresh: () => _refresh(TAB_ID) });
  }

  function fld(id, name) { return document.getElementById(`ft-${id}-${name}`); }

  function _build(panel, id) {
    const catOpts = Engine.CATEGORIES.map(c => `<option>${c}</option>`).join('');
    const effOpts = Engine.EFFECTS.map(e => `<option>${e}</option>`).join('');

    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone">
          <div class="form-body">
            <div class="form-col">
              <div class="form-field"><label>Pattern</label>
                <input class="form-control" id="ft-${id}-pattern" style="font-family:monospace;" placeholder="regular expression matched against the Action, e.g. ^(YOU BOUGHT)"></div>
              <div class="form-field"><label>Description</label><input class="form-control" id="ft-${id}-desc"></div>
              <div class="form-field"><label>Matching</label>
                <div class="form-checks">
                  <label><input type="checkbox" id="ft-${id}-case" checked> Case Sensitive</label>
                  <label><input type="checkbox" id="ft-${id}-symreq" checked> Symbol Required</label>
                </div>
              </div>
              <div class="form-err" id="${id}-err"></div>
            </div>
            <div class="form-col">
              <div class="form-field"><label>Order</label><input class="form-control" id="ft-${id}-order" type="number" step="1"></div>
              <div class="form-field"><label>Category</label><select class="form-control" id="ft-${id}-category">${catOpts}</select></div>
              <div class="form-field"><label>Effect</label><select class="form-control" id="ft-${id}-effect">${effOpts}</select></div>
              <div class="form-field"><label>Sign</label>
                <select class="form-control" id="ft-${id}-sign">
                  <option value="">none</option><option value="1">+1</option><option value="-1">-1</option>
                </select>
              </div>
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
    const yesNo = cell => cell.getValue() ? 'yes' : 'no';

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: _loadData(),
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Order',           field: 'Rule_Order',      headerSortTristate: true, widthGrow: 1 },
        { title: 'Pattern',         field: 'Pattern',         headerFilter: true, headerSortTristate: true, widthGrow: 3,
          formatter: cell => `<code>${_esc(cell.getValue())}</code>` },
        { title: 'Case Sensitive',  field: 'Case_Sensitive',  headerSortTristate: true, widthGrow: 1, formatter: yesNo },
        { title: 'Symbol Required', field: 'Symbol_Required', headerSortTristate: true, widthGrow: 1, formatter: yesNo },
        { title: 'Category',        field: 'Category',        headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Effect',          field: 'Effect',          headerFilter: true, headerSortTristate: true, widthGrow: 1 },
        { title: 'Sign',            field: 'Sign',            headerSortTristate: true, widthGrow: 1,
          formatter: cell => cell.getValue() == null ? '' : (cell.getValue() > 0 ? '+1' : '-1') },
        { title: 'Description',     field: 'Description',     headerFilter: true, headerSortTristate: true, widthGrow: 4 }
      ]
    });

    table.on('rowSelectionChanged', (data, rows) => {
      if (!rows.length) return;
      _selected = rows[0].getData();
      _isNew = false;
      fld(id, 'pattern').value  = _selected.Pattern;
      fld(id, 'desc').value     = _selected.Description || '';
      fld(id, 'case').checked   = !!_selected.Case_Sensitive;
      fld(id, 'symreq').checked = !!_selected.Symbol_Required;
      fld(id, 'order').value    = _selected.Rule_Order;
      fld(id, 'category').value = _selected.Category || 'Other';
      fld(id, 'effect').value   = _selected.Effect;
      fld(id, 'sign').value     = _selected.Sign == null ? '' : String(_selected.Sign);
      panel.querySelector(`#${id}-err`).textContent = '';
      btn('delete').disabled = false;
      btn('accept').disabled = true;
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
      const maxOrder = DB.query('SELECT COALESCE(MAX(Rule_Order), 0) AS m FROM Rules WHERE Active=1')[0].m;
      fld(id, 'pattern').value  = '';
      fld(id, 'desc').value     = '';
      fld(id, 'case').checked   = true;
      fld(id, 'symreq').checked = true;
      fld(id, 'order').value    = maxOrder + 10;
      fld(id, 'category').value = 'Other';
      fld(id, 'effect').value   = 'Cash';
      fld(id, 'sign').value     = '';
      panel.querySelector(`#${id}-err`).textContent = '';
      btn('delete').disabled = true;
      btn('accept').disabled = false;
    });
    btn('accept').addEventListener('click', _accept);
    btn('delete').addEventListener('click', _delete);
    ['pattern', 'desc', 'case', 'symreq', 'order', 'category', 'effect', 'sign'].forEach(f => {
      fld(id, f).addEventListener('input', () => { btn('accept').disabled = false; });
      fld(id, f).addEventListener('change', () => { btn('accept').disabled = false; });
    });

    async function _accept() {
      const err = panel.querySelector(`#${id}-err`);
      const pattern = fld(id, 'pattern').value.trim();
      const caseSensitive = fld(id, 'case').checked ? 1 : 0;
      const order = parseInt(fld(id, 'order').value, 10);
      if (!pattern) { err.textContent = 'Pattern is required.'; return; }
      try { new RegExp(pattern, caseSensitive ? '' : 'i'); }
      catch (e) { err.textContent = `Invalid regular expression: ${e.message}`; return; }
      if (isNaN(order)) { err.textContent = 'Order must be a number.'; return; }
      err.textContent = '';
      const sign = fld(id, 'sign').value === '' ? null : Number(fld(id, 'sign').value);
      const vals = [order, pattern, caseSensitive, fld(id, 'symreq').checked ? 1 : 0, fld(id, 'category').value,
                    fld(id, 'effect').value, sign, fld(id, 'desc').value.trim()];
      if (_isNew) {
        DB.run(`INSERT INTO Rules (Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect, Sign, Description, Active)
                VALUES (?,?,?,?,?,?,?,?,1)`, vals);
      } else {
        DB.run(`UPDATE Rules SET Rule_Order=?, Pattern=?, Case_Sensitive=?, Symbol_Required=?, Category=?, Effect=?, Sign=?,
                Description=? WHERE Rule_ID=?`, [...vals, _selected.Rule_ID]);
      }
      _isNew = false;
      btn('accept').disabled = true;
      App.onDataChanged();
    }

    async function _delete() {
      if (!_selected) return;
      if (!(await Dialogs.confirm(`Delete the rule ${_selected.Pattern}?`, 'Delete Rule'))) return;
      DB.run('UPDATE Rules SET Active=0 WHERE Rule_ID=?', [_selected.Rule_ID]);
      _selected = null;
      btn('delete').disabled = true;
      App.onDataChanged();
    }

    panel._rulTable = table;
  }

  function _loadData() {
    return DB.query('SELECT * FROM Rules WHERE Active = 1 ORDER BY Rule_Order, Rule_ID');
  }

  function _refresh(tabId) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel && panel._rulTable) panel._rulTable.replaceData(_loadData());
  }

  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

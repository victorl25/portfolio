const QueryTab = (() => {
  let _ctr = 0;

  function open() {
    const id = `qry-${++_ctr}`;
    App.Tabs.open(id, 'Query', panel => _build(panel, id));
  }

  function _build(panel, id) {
    panel.innerHTML = `
      <div class="qry-layout">
        <div class="qry-sql-zone">
          <div class="qry-toolbar">
            <span class="qry-label">SQL</span>
            <button class="btn btn-primary qry-run-btn" id="${id}-run">Run</button>
          </div>
          <textarea class="qry-textarea" id="${id}-sql" placeholder="SELECT * FROM Accounts;"></textarea>
        </div>
        <div class="qry-table-zone" id="${id}-results"></div>
      </div>`;

    const btn    = panel.querySelector(`#${id}-run`);
    const ta     = panel.querySelector(`#${id}-sql`);
    const zone   = panel.querySelector(`#${id}-results`);
    let table    = null;

    function run() {
      const sql = ta.value.trim();
      if (!sql) return;
      if (table) { table.destroy(); table = null; }
      zone.innerHTML = '';
      let rows;
      try { rows = DB.query(sql); }
      catch (e) {
        zone.innerHTML = `<div class="qry-message qry-error">${e.message}</div>`;
        return;
      }
      if (!rows.length) {
        zone.innerHTML = `<div class="qry-message">Query executed. No rows returned.</div>`;
        return;
      }
      const el = document.createElement('div');
      el.style.height = '100%';
      zone.appendChild(el);
      table = new Tabulator(el, {
        data: rows,
        autoColumns: true,
        layout: 'fitData',
        height: '100%'
      });
    }

    btn.addEventListener('click', run);
    ta.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') run(); });
  }

  return { open };
})();

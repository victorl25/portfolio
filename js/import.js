const Import = (() => {
  const FIELDS = ['Account', 'Name', 'Date', 'Symbol', 'Description', 'Quantity', 'Price', 'CostBasis', 'Currency'];
  const FIELD_LABELS = { CostBasis: 'Cost Basis' };

  async function run() {
    let fileHandle;
    try {
      [fileHandle] = await window.showOpenFilePicker({
        id: 'portfolio-import',
        startIn: App._lastImportHandle || undefined,
        types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }]
      });
    } catch (e) { return; }

    App._lastImportHandle = fileHandle;
    const file = await fileHandle.getFile();
    const text = await file.text();
    const { headers, rows } = _parseCsv(text);
    if (!headers.length) { await Dialogs.alert('Could not parse CSV headers.'); return; }

    const saved = DB.query('SELECT Source, Target, Pattern FROM Mappings');
    const savedMap = {};
    saved.forEach(r => { savedMap[r.Source] = { target: r.Target, pattern: r.Pattern }; });

    const mapping = await _showMappingDialog(headers, savedMap);
    if (!mapping) return;

    // Save mappings back to DB
    FIELDS.forEach(f => {
      const m = mapping[f];
      DB.run(`INSERT INTO Mappings (Source, Target, Pattern) VALUES (?,?,?)
              ON CONFLICT(Source) DO UPDATE SET Target=excluded.Target, Pattern=excluded.Pattern`,
        [f, m ? m.col : null, m ? m.pattern : null]);
    });

    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    let resolvedAccountId = null;

    const hasAccountCol = mapping.Account?.col || mapping.Name?.col;

    if (!hasAccountCol) {
      resolvedAccountId = await _pickAccount(accounts);
      if (!resolvedAccountId) return;
    }

    // Pre-pass: find unique symbols from the CSV that are not yet in the Assets table.
    // We enrich them upfront so the main loop's ensureAsset() calls are instant no-ops.
    const _resolveField = (row, field) => {
      const m = mapping[field];
      if (!m || !m.col) return '';
      let v = row[m.col] != null ? String(row[m.col]) : '';
      v = v.replace(/[$,%+]/g, '').trim();
      if (m.pattern) {
        try { const rx = new RegExp(m.pattern), mx = v.match(rx); if (mx) v = mx[1] ?? mx[0]; } catch {}
      }
      return v;
    };

    const newSymbolsMap = new Map(); // symbol → first description seen
    for (const row of rows) {
      const sym = _resolveField(row, 'Symbol').toUpperCase();
      if (sym && !newSymbolsMap.has(sym) &&
          !DB.query('SELECT Symbol FROM Assets WHERE Symbol=?', [sym]).length) {
        newSymbolsMap.set(sym, _resolveField(row, 'Description'));
      }
    }

    if (newSymbolsMap.size) {
      const newSymbols = [...newSymbolsMap.entries()];
      const c = Dialogs.custom(`
        <div class="dlg dlg-wide">
          <div class="dlg-title">Updating Assets</div>
          <div class="dlg-body">
            <p id="ast-upd-msg">Starting…</p>
            <div style="font-size:12px;color:#888;" id="ast-upd-detail"></div>
          </div>
        </div>`);

      let astOk = 0;
      const astFailures = [];
      for (let i = 0; i < newSymbols.length; i++) {
        const [sym, desc] = newSymbols[i];
        c.querySelector('#ast-upd-msg').textContent = `Updating ${i + 1} / ${newSymbols.length}: ${sym}…`;
        const result = await App.ensureAsset(sym, desc);
        if (result && result.ok === false) astFailures.push({ symbol: sym, reason: result.reason });
        else astOk++;
        await new Promise(r => setTimeout(r, 500));
      }
      Dialogs.close();

      const summary = `Assets updated: ${astOk} succeeded, ${astFailures.length} failed.`;
      if (astFailures.length) {
        const items = astFailures
          .map(f => `<li><b>${_esc(f.symbol)}</b>: ${_esc(f.reason)}</li>`)
          .join('');
        await Dialogs.alertHtml(
          `<p>${_esc(summary)}</p>
           <ul style="margin:8px 0 0;padding-left:18px;font-size:12px;max-height:200px;overflow-y:auto;">${items}</ul>`,
          'Update Assets');
      }
    }

    let imported = 0, skipped = 0;
    const cashDeltas = {};   // accountId → net cash change (negative = spent, positive = received)
    for (const row of rows) {
      try {
        const val = (field) => {
          const m = mapping[field];
          if (!m || !m.col) return null;
          let v = row[m.col] != null ? String(row[m.col]) : '';
          v = v.replace(/[$,%+]/g, '').trim();
          if (m.pattern) {
            try {
              const rx = new RegExp(m.pattern);
              const mx = v.match(rx);
              if (mx) v = mx[1] != null ? mx[1] : mx[0];
            } catch {}
          }
          return v || null;
        };

        const symbol = (val('Symbol') || '').toUpperCase();
        if (!symbol) { skipped++; continue; }

        const qty = parseFloat(val('Quantity'));
        let price = parseFloat(val('Price'));
        if (isNaN(price)) {
          const cb = parseFloat(val('CostBasis'));
          if (!isNaN(cb) && qty !== 0) price = cb / Math.abs(qty);
        }
        if (isNaN(qty) || isNaN(price)) { skipped++; continue; }

        const currency = val('Currency') || 'USD';
        const ts       = _toTimestamp(val('Date'));
        const desc     = val('Description') || '';

        let accountId = resolvedAccountId;
        if (!accountId && hasAccountCol) {
          const accVal  = val('Account');
          const nameVal = val('Name');
          const found   = accounts.find(a =>
            (accVal  && (a.Account === accVal  || a.Account.includes(accVal)))  ||
            (nameVal && (a.Name   === nameVal  || a.Name.includes(nameVal)))
          );
          if (!found) { skipped++; continue; }
          accountId = found.Account_ID;
        }

        await App.ensureAsset(symbol, desc);

        const existPrices = DB.query('SELECT COUNT(*) AS cnt FROM Prices WHERE Symbol=?', [symbol]);
        if (!existPrices[0].cnt) {
          DB.run('INSERT INTO Prices (Timestamp, Symbol, Price, Currency, Valid) VALUES (?,?,?,?,1)',
            [ts, symbol, Math.round(price * 100) / 100, currency]);
        }

        const hash = _txHash(accountId, symbol, qty, price);
        const before = DB.query('SELECT Transaction_Hash FROM Ledger WHERE Transaction_Hash=?', [hash]);
        if (before.length) { skipped++; continue; }

        DB.run(`INSERT INTO Ledger (Transaction_Hash, Timestamp, Account_ID, Symbol, Quantity, Price, Currency, Valid)
                VALUES (?,?,?,?,?,?,?,1)`,
          [hash, ts, accountId, symbol, qty, price, currency]);
        imported++;
        cashDeltas[accountId] = (cashDeltas[accountId] || 0) - qty * price;
      } catch (e) {
        console.warn('Import row error:', e);
        skipped++;
      }
    }

    const now = _nowTs();
    for (const [accId, delta] of Object.entries(cashDeltas)) {
      DB.run('UPDATE Accounts SET Cash = ROUND(Cash + ?, 2), Last_Updated = ? WHERE Account_ID = ?',
        [delta, now, accId]);
    }

    App.onDataChanged();
    await Dialogs.alert(`Import complete: ${imported} transaction(s) added, ${skipped} skipped.`);
  }

  function _parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { headers: [], rows: [] };
    const headers = _splitCsvLine(lines[0]);
    const rows = lines.slice(1).map(l => {
      const vals = _splitCsvLine(l);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] != null ? vals[i] : ''; });
      return obj;
    });
    return { headers, rows };
  }

  function _splitCsvLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  }

  async function _showMappingDialog(headers, savedMap) {
    return new Promise(resolve => {
      const noneOpt = '<option value="">— none —</option>';
      const colOpts = headers.map(h => `<option value="${_esc(h)}">${_esc(h)}</option>`).join('');

      const rows = FIELDS.map(f => {
        const s   = savedMap[f] || {};
        const col = (s.target && headers.includes(s.target)) ? s.target : '';
        const pat = s.pattern || '';
        const sel = headers.map(h => `<option value="${_esc(h)}"${h === col ? ' selected' : ''}>${_esc(h)}</option>`).join('');
        const label = FIELD_LABELS[f] || f;
        return `<div class="csv-map-field">${_esc(label)}</div>
                <select class="csv-map-src" id="cm-${f}">${noneOpt}${sel}</select>
                <input  class="csv-map-pattern" id="cp-${f}" placeholder="regex…" value="${_esc(pat)}">
                <div></div>`;
      }).join('');

      const c = Dialogs.custom(`
        <div class="dlg dlg-xl">
          <div class="dlg-title">CSV Column Mapping</div>
          <div class="dlg-body">
            <div class="csv-map-grid">
              <div class="csv-map-hdr">Field</div>
              <div class="csv-map-hdr">CSV Column</div>
              <div class="csv-map-hdr">Extract Pattern <span class="csv-map-hint">(optional regex)</span></div>
              <div></div>
              ${rows}
            </div>
            <div class="csv-map-err" id="cm-err"></div>
          </div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="cm-cancel">Cancel</button>
            <button class="btn btn-primary"   id="cm-import">Import</button>
          </div>
        </div>`);

      c.querySelector('#cm-cancel').addEventListener('click', () => { Dialogs.close(); resolve(null); });
      c.querySelector('#cm-import').addEventListener('click', () => {
        const dateCol = c.querySelector('#cm-Date').value;
        const qtyCol  = c.querySelector('#cm-Quantity').value;
        const prcCol  = c.querySelector('#cm-Price').value;
        const cbCol   = c.querySelector('#cm-CostBasis').value;
        const symCol  = c.querySelector('#cm-Symbol').value;
        if (!symCol || !qtyCol || (!prcCol && !cbCol)) {
          c.querySelector('#cm-err').textContent = 'Symbol, Quantity, and either Price or Cost Basis columns are required.';
          return;
        }
        const result = {};
        FIELDS.forEach(f => {
          const col = c.querySelector(`#cm-${f}`).value;
          const pat = c.querySelector(`#cp-${f}`).value.trim();
          result[f] = col ? { col, pattern: pat || null } : null;
        });
        Dialogs.close();
        resolve(result);
      });
    });
  }

  async function _pickAccount(accounts) {
    return new Promise(resolve => {
      const opts = accounts.map(a =>
        `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`
      ).join('');
      const c = Dialogs.custom(`
        <div class="dlg dlg-wide">
          <div class="dlg-title">Select Account</div>
          <div class="dlg-body">
            <p>No account column is mapped. Select the account for all imported transactions.</p>
            <select class="dlg-select" id="pa-sel">${opts}</select>
          </div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="pa-cancel">Cancel</button>
            <button class="btn btn-primary"   id="pa-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#pa-cancel').addEventListener('click', () => { Dialogs.close(); resolve(null); });
      c.querySelector('#pa-ok').addEventListener('click', () => {
        const v = c.querySelector('#pa-sel').value;
        Dialogs.close();
        resolve(v || null);
      });
    });
  }

  function _toTimestamp(val) {
    if (!val) return _nowTs();
    val = val.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(val)) return val;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val + ' 00:00:00';
    // Try browser Date parsing as fallback (handles MM/DD/YYYY, etc.)
    const d = new Date(val);
    if (!isNaN(d)) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    return _nowTs();
  }

  function _txHash(accountId, symbol, qty, price) {
    const key = `${accountId}|${symbol}|${qty}|${price}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) { h = (Math.imul(31, h) + key.charCodeAt(i)) | 0; }
    return key + '_' + Math.abs(h).toString(36);
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { run };
})();

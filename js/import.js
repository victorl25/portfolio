// Import global — File > Import holdings… (positions snapshot) and File > Import transactions…
const Import = (() => {
  const HOLDINGS_FIELDS    = ['Account', 'Name', 'Date', 'Symbol', 'Description', 'Quantity', 'Price', 'CostBasis', 'CurrentValue', 'Currency'];
  const TRANSACTION_FIELDS = ['Account', 'Name', 'Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Amount', 'Currency'];
  const NUMERIC_FIELDS     = ['Quantity', 'Price', 'CostBasis', 'CurrentValue', 'Amount'];
  const FIELD_LABELS       = { CostBasis: 'Cost Basis', CurrentValue: 'Current Value' };
  // Positions rows that represent the account's cash rather than a holding (case sensitive)
  const CASH_SYMBOLS       = [/^SPAXX(\*+)/, /^USD(\*+)/, /^Cash/];

  // ── File > Import holdings… ──────────────────────────────────────────────
  async function runHoldings() {
    const csv = await _openCsv();
    if (!csv) return;
    const mapping = await _mapColumns(csv, HOLDINGS_FIELDS, 'Import Holdings', m =>
      (!m.Symbol || !m.Quantity || (!m.Price && !m.CostBasis))
        ? 'Symbol, Quantity, and either Price or Cost Basis columns are required.' : null);
    if (!mapping) return;

    const rows = _prepareRows(csv, mapping, false);
    const resolver = await _accountResolver(mapping, 'Select the account for the imported positions.');
    if (!resolver) return;

    // One transaction date per file: from the Date column if mapped, otherwise entered by the user
    let date = mapping.Date ? rows.map(r => _parseDate(_text(r, mapping, 'Date'))).find(Boolean) : null;
    if (!date) {
      const v = await Dialogs.prompt('Date of the holdings snapshot (YYYY-MM-DD):', _todayStr(), 'Import Holdings');
      if (!v) return;
      date = _parseDate(v);
      if (!date) { await Dialogs.alert(`"${v}" is not a valid date.`); return; }
    }

    const { perAccount, skipped, unknownAccount, cashRowsWithoutValue } = collectSnapshot(rows, mapping, resolver);
    if (!perAccount.size) { await Dialogs.alert('No positions found in the file.'); return; }

    const results = [];
    try {
      await DB.transaction(() => {
        for (const [accountId, a] of perAccount) {
          const res = Engine.applySnapshot(accountId, date, a.holdings, a.cash);
          results.push({ accountId, ...res, cash: a.cash });
        }
      });
    } catch (e) {
      await Dialogs.alert(`Import failed, no changes were made: ${e.message}`);
      return;
    }

    const assetFailures = await _enrichAssets(
      [...perAccount.values()].flatMap(a => a.holdings).filter(h => !Engine.isOption(h.symbol)));
    App.onDataChanged();

    const names = _accountNames();
    const lines = results.map(r =>
      `<li><b>${_esc(names[r.accountId])}</b>: ${r.records} position(s) set, ${r.deactivated} position(s) not in the file deactivated, ` +
      (r.cash != null ? `cash set to ${_esc(Fmt.currency(r.cash))}` : 'cash unchanged (no cash rows)') + '</li>').join('');
    let html = `<p>Positions snapshot as of <b>${_esc(date)}</b> imported.</p><ul style="padding-left:18px;font-size:13px;">${lines}</ul>`;
    if (skipped)              html += `<p>${skipped} row(s) without a symbol or quantity were skipped.</p>`;
    if (unknownAccount)       html += `<p>${unknownAccount} row(s) were skipped because their account was not found.</p>`;
    if (cashRowsWithoutValue) html += `<p>${cashRowsWithoutValue} cash row(s) had no Current Value, Quantity or Cost Basis value and were ignored.</p>`;
    html += _failureList('Asset lookups failed', assetFailures.map(f => `<b>${_esc(f.symbol)}</b>: ${_esc(f.reason)}`));
    await Dialogs.alertHtml(html, 'Import Holdings');
    await _offerPriceUpdate();
  }

  // Splits holdings rows into per-account positions and cash totals. Cash rows (CASH_SYMBOLS) are valued
  // by their Current Value, falling back to Quantity (money market shares are $1) and then Cost Basis.
  function collectSnapshot(rows, mapping, resolver) {
    const perAccount = new Map();   // accountId → { holdings: [], cash: null }
    let skipped = 0, unknownAccount = 0, cashRowsWithoutValue = 0;
    for (const r of rows) {
      const accountId = resolver(r);
      if (!accountId) { unknownAccount++; continue; }
      if (!perAccount.has(accountId)) perAccount.set(accountId, { holdings: [], cash: null });
      const acc = perAccount.get(accountId);
      const rawSymbol = _text(r, mapping, 'Symbol');
      const qty  = _num(r, mapping, 'Quantity');
      const cost = _num(r, mapping, 'CostBasis');
      if (CASH_SYMBOLS.some(rx => rx.test(rawSymbol))) {
        const v = _num(r, mapping, 'CurrentValue') ?? qty ?? cost;
        if (v == null) { cashRowsWithoutValue++; continue; }
        acc.cash = (acc.cash || 0) + v;
        continue;
      }
      const symbol = Engine.normalizeSymbol(rawSymbol);
      if (!symbol || qty == null || qty === 0) { skipped++; continue; }
      const price = _num(r, mapping, 'Price');
      const mult = Engine.isOption(symbol) ? Engine.OPTION_MULTIPLIER : 1;
      const costBasis = cost != null ? cost : (price != null ? qty * price * mult : 0);
      acc.holdings.push({ symbol, quantity: qty, costBasis, currency: _text(r, mapping, 'Currency') || 'USD',
                          description: _text(r, mapping, 'Description') });
    }
    return { perAccount, skipped, unknownAccount, cashRowsWithoutValue };
  }

  // ── File > Import transactions… ─────────────────────────────────────────
  async function runTransactions() {
    const csv = await _openCsv();
    if (!csv) return;
    const mapping = await _mapColumns(csv, TRANSACTION_FIELDS, 'Import Transactions', m =>
      (!m.Date || !m.Action || !m.Symbol || !m.Quantity || (!m.Amount && !m.Price))
        ? 'Date, Action, Symbol, Quantity, and either Amount or Price columns are required.' : null);
    if (!mapping) return;

    const rows = _prepareRows(csv, mapping, true);
    if (!rows.length) { await Dialogs.alert('No transaction rows with a valid date were found in the file.'); return; }
    const resolver = await _accountResolver(mapping, 'Select the account for the imported transactions.');
    if (!resolver) return;

    let result;
    try {
      result = await DB.transaction(() => processTransactions(rows, mapping, resolver));
    } catch (e) {
      await Dialogs.alert(`Import failed, no changes were made: ${e.message}`);
      return;
    }
    const { stats, unrecognized, predating, newAssets } = result;

    const assetFailures = await _enrichAssets([...newAssets].map(([symbol, description]) => ({ symbol, description })));
    App.onDataChanged();

    const names = _accountNames();
    let html = `<table class="imp-summary">
        <tr><td>Imported</td><td>${stats.imported}</td></tr>
        <tr><td>Ignored because of the import rules</td><td>${stats.ignored}</td></tr>
        <tr><td>Skipped as duplicates (matching Hash)</td><td>${stats.duplicates}</td></tr>
        <tr><td>Unrecognized (no matching rule)</td><td>${unrecognized.length}</td></tr>
        ${stats.unknownAccount ? `<tr><td>Skipped (account not found)</td><td>${stats.unknownAccount}</td></tr>` : ''}
      </table>`;
    html += _failureList('Unrecognized rows (add rules in View > Rules, then re-import the file)', unrecognized.map(u =>
      `${_esc(u.date)} · ${_esc(u.action)} · ${_esc(u.symbol || '—')} · qty ${_esc(u.qty)} · amount ${_esc(u.amount ?? '—')}`));
    html += _failureList('Transactions dated before existing transactions of the same account + symbol (the ledger may need to be rebuilt)',
      predating.map(p => `${_esc(p.date)} · ${_esc(names[p.accountId])} · ${_esc(p.symbol)} (latest existing ${_esc(p.prevDate)})`));
    html += _failureList('Asset lookups failed', assetFailures.map(f => `<b>${_esc(f.symbol)}</b>: ${_esc(f.reason)}`));
    await Dialogs.alertHtml(html, 'Import Transactions');
    if (stats.imported) await _offerPriceUpdate();
  }

  // Classifies, de-duplicates and records the prepared transaction rows (caller wraps in DB.transaction).
  function processTransactions(rows, mapping, resolver) {
    // State before the import: duplicates are detected only against previously recorded transactions
    const knownHashes = new Set(DB.query('SELECT Hash FROM Transactions').map(r => r.Hash));
    const latestDate = new Map(DB.query(`SELECT Account_ID, Symbol, MAX(Date) AS D FROM Transactions
        WHERE Valid=1 AND Type IN ('Trade','Record') AND Symbol IS NOT NULL GROUP BY Account_ID, Symbol`)
      .map(r => [`${r.Account_ID}|${r.Symbol}`, r.D]));
    const rules = Engine.loadRules();
    const stats = { imported: 0, ignored: 0, duplicates: 0, unknownAccount: 0 };
    const unrecognized = [], predating = [];
    const newAssets = new Map();   // equity symbol → description

    for (const r of rows) {
      const date      = _parseDate(_text(r, mapping, 'Date'));
      const action    = _text(r, mapping, 'Action');
      const rawSymbol = _text(r, mapping, 'Symbol');
      const symbol    = Engine.normalizeSymbol(rawSymbol);
      let   qty       = _num(r, mapping, 'Quantity') ?? 0;
      const price     = _num(r, mapping, 'Price');
      const fileAmt   = _num(r, mapping, 'Amount');

      const c = Engine.classify(action, symbol, rules);
      if (c.status === 'ignored') { stats.ignored++; continue; }
      if (c.status === 'unrecognized') {
        unrecognized.push({ date, action, symbol: rawSymbol, qty, amount: fileAmt });
        continue;
      }
      const accountId = resolver(r);
      if (!accountId) { stats.unknownAccount++; continue; }

      // Some brokers report sale quantities as positive numbers: the cash direction decides
      if ((c.effect === 'Trade' || c.effect === 'Reinvestment') && fileAmt && qty &&
          Math.sign(qty) === Math.sign(fileAmt)) qty = -qty;

      const amount = Engine.resolveAmount({ amount: fileAmt, quantity: qty, price, effect: c.effect, sign: c.sign, symbol });
      const h = Engine.hash(accountId, date, symbol || null, qty, price, amount);
      if (knownHashes.has(h)) { stats.duplicates++; continue; }

      const affectsPosition = (c.type === 'Trade' || c.type === 'Record') && symbol;
      const prevDate = affectsPosition ? latestDate.get(`${accountId}|${symbol}`) : null;
      if (prevDate && date < prevDate) predating.push({ date, symbol, prevDate, accountId });

      Engine.record({
        Account_ID: accountId, Date: date, Effect: c.effect, Category: c.category, Symbol: symbol || null,
        Quantity: qty, Price: price, Amount: amount, Currency: _text(r, mapping, 'Currency') || 'USD',
        Description: action, Hash: h
      });
      stats.imported++;
      if (affectsPosition && !Engine.isOption(symbol) && !newAssets.has(symbol))
        newAssets.set(symbol, _text(r, mapping, 'Description'));
    }
    return { stats, unrecognized, predating, newAssets };
  }

  // ── CSV parsing and row preparation ─────────────────────────────────────
  async function _openCsv() {
    let fileHandle;
    try {
      [fileHandle] = await window.showOpenFilePicker({
        id: 'portfolio-import',
        startIn: App._lastImportHandle || undefined,
        types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }]
      });
    } catch { return null; }
    App._lastImportHandle = fileHandle;
    const text = await (await fileHandle.getFile()).text();
    const csv = parseCsv(text);
    if (!csv.headers.length) { await Dialogs.alert('Could not parse CSV headers.'); return null; }
    return csv;
  }

  // Empty rows before the header are discarded; returns { headers, rows: [string[]], headerHash }.
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return { headers: [], rows: [], headerHash: '' };
    const headers = _splitCsvLine(lines[i]).map(h => h.replace(/^﻿/, '').trim());
    while (headers.length && !headers[headers.length - 1]) headers.pop();   // trailing comma in the header row
    const rows = [];
    for (const line of lines.slice(i + 1)) {
      if (!line.trim()) continue;
      const vals = _splitCsvLine(line);
      // a trailing comma adds an empty extra cell — not a different column count
      while (vals.length > headers.length && vals[vals.length - 1] === '') vals.pop();
      rows.push(vals);
    }
    return { headers, rows, headerHash: headerHash(headers) };
  }

  function headerHash(headers) {
    const key = headers.map(h => h.trim()).join('\u001f');
    let h1 = 0, h2 = 5381;
    for (let i = 0; i < key.length; i++) {
      h1 = (Math.imul(31, h1) + key.charCodeAt(i)) | 0;
      h2 = (Math.imul(33, h2) ^ key.charCodeAt(i)) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + key.length.toString(36);
  }

  // Drops trailing rows (column count differs from the header, or — for transaction files —
  // the Date does not parse), then sorts transaction rows chronologically, earliest first.
  function _prepareRows(csv, mapping, chronological) {
    const n = csv.headers.length;
    const ok = vals => vals.length === n && (!chronological || _parseDate(_cell(vals, csv, mapping.Date)));
    const rows = csv.rows.slice();
    while (rows.length && !ok(rows[rows.length - 1])) rows.pop();
    const valid = rows.filter(ok);
    if (!chronological) return valid.map(v => ({ vals: v, csv }));
    const dated = valid.map((v, i) => ({ vals: v, csv, i, d: _parseDate(_cell(v, csv, mapping.Date)) }));
    // Same-date rows keep file order, reversed when the file is sorted newest first
    const newestFirst = dated.length > 1 && dated[0].d > dated[dated.length - 1].d;
    dated.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (newestFirst ? b.i - a.i : a.i - b.i));
    return dated;
  }

  function _splitCsvLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  }

  function _cell(vals, csv, m) {
    if (!m || !m.col) return '';
    const idx = csv.headers.indexOf(m.col);
    let v = idx >= 0 && vals[idx] != null ? String(vals[idx]).trim() : '';
    if (m.pattern) {
      try { const mx = v.match(new RegExp(m.pattern)); if (mx) v = mx[1] != null ? mx[1] : mx[0]; } catch {}
    }
    return v;
  }

  const _text = (row, mapping, field) => _cell(row.vals, row.csv, mapping[field]);

  // Parses "$1,234.56", "-$76635.00", "(12.50)", "+2.35%" → number; null when empty or not numeric
  function _num(row, mapping, field) {
    let s = _text(row, mapping, field);
    if (!s || s === '--') return null;
    let neg = false;
    const paren = s.match(/^\((.*)\)$/);
    if (paren) { neg = true; s = paren[1]; }
    s = s.replace(/[$,%+\s]/g, '');
    const v = parseFloat(s);
    if (!isFinite(v)) return null;
    return neg ? -v : v;
  }

  // 'YYYY-MM-DD', 'MM/DD/YYYY' (first date in the cell, e.g. "09/23/2026 as of 09/22/2026"), or anything Date parses
  function _parseDate(v) {
    if (!v) return null;
    const p = n => String(n).padStart(2, '0');
    let m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${p(m[1])}-${p(m[2])}`;
    const d = new Date(v);
    return isNaN(d) ? null : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ── Column mapping (stored per Header_Hash) ─────────────────────────────
  async function _mapColumns(csv, fields, title, validate) {
    const saved = {};
    DB.query('SELECT Source, Target, Pattern FROM Mappings WHERE Header_Hash=?', [csv.headerHash])
      .forEach(r => { saved[r.Source] = { target: r.Target, pattern: r.Pattern }; });

    const mapping = await _showMappingDialog(csv.headers, fields, saved, title, validate);
    if (!mapping) return null;
    fields.forEach(f => {
      const m = mapping[f];
      DB.run(`INSERT INTO Mappings (Header_Hash, Source, Target, Pattern) VALUES (?,?,?,?)
              ON CONFLICT(Header_Hash, Source) DO UPDATE SET Target=excluded.Target, Pattern=excluded.Pattern`,
        [csv.headerHash, f, m ? m.col : null, m ? m.pattern : null]);
    });
    return mapping;
  }

  // First use of a file layout: pre-select a column whose name matches the field ("Price ($)" ↔ Price)
  function _guessColumn(field, headers) {
    const norm = s => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z]/g, '');
    const label = norm(FIELD_LABELS[field] || field);
    return headers.find(h => norm(h) === label) || '';
  }

  function _showMappingDialog(headers, fields, saved, title, validate) {
    return new Promise(resolve => {
      const noneOpt = '<option value="">— none —</option>';
      const rows = fields.map(f => {
        // Saved mapping for this file layout; a field never saved for it (e.g. one added in a later
        // version) is matched by column name like a new layout
        const s   = saved[f] || {};
        const col = f in saved ? ((s.target && headers.includes(s.target)) ? s.target : '') : _guessColumn(f, headers);
        const sel = headers.map(h => `<option value="${_esc(h)}"${h === col ? ' selected' : ''}>${_esc(h)}</option>`).join('');
        return `<div class="csv-map-field">${_esc(FIELD_LABELS[f] || f)}</div>
                <select class="csv-map-src" id="cm-${f}">${noneOpt}${sel}</select>
                <input  class="csv-map-pattern" id="cp-${f}" placeholder="regex…" value="${_esc(s.pattern || '')}">
                <div></div>`;
      }).join('');

      const c = Dialogs.custom(`
        <div class="dlg dlg-xl">
          <div class="dlg-title">${_esc(title)} — CSV Column Mapping</div>
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
        const result = {};
        fields.forEach(f => {
          const col = c.querySelector(`#cm-${f}`).value;
          const pat = c.querySelector(`#cp-${f}`).value.trim();
          result[f] = col ? { col, pattern: pat || null } : null;
        });
        const err = validate(result);
        if (err) { c.querySelector('#cm-err').textContent = err; return; }
        Dialogs.close();
        resolve(result);
      });
    });
  }

  // ── Accounts ────────────────────────────────────────────────────────────
  // Returns row → accountId: from the Account/Name columns when mapped, otherwise one picked account.
  async function _accountResolver(mapping, prompt) {
    const accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    if (!accounts.length) { await Dialogs.alert('No accounts found. Create an account in View > Accounts first.'); return null; }
    if (mapping.Account || mapping.Name) {
      return row => {
        const accVal  = _text(row, mapping, 'Account');
        const nameVal = _text(row, mapping, 'Name');
        const found = accounts.find(a =>
          (accVal  && (a.Account === accVal || a.Account.includes(accVal))) ||
          (nameVal && (a.Name === nameVal   || a.Name.includes(nameVal))));
        return found ? found.Account_ID : null;
      };
    }
    const id = await _pickAccount(accounts, prompt);
    return id ? () => id : null;
  }

  function _pickAccount(accounts, prompt) {
    return new Promise(resolve => {
      const opts = accounts.map(a => `<option value="${a.Account_ID}">${_esc(a.Name)} (${_esc(a.Account)})</option>`).join('');
      const c = Dialogs.custom(`
        <div class="dlg dlg-wide">
          <div class="dlg-title">Select Account</div>
          <div class="dlg-body">
            <p>No account column is mapped. ${_esc(prompt)}</p>
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
        resolve(v ? Number(v) : null);
      });
    });
  }

  function _accountNames() {
    const names = {};
    DB.query('SELECT Account_ID, Name FROM Accounts').forEach(a => { names[a.Account_ID] = a.Name; });
    return names;
  }

  // ── Assets (created after the transactions and ledger entries) ──────────
  async function _enrichAssets(items) {
    const seen = new Set();
    const todo = items.filter(it => {
      if (seen.has(it.symbol)) return false;
      seen.add(it.symbol);
      return !DB.query('SELECT 1 FROM Assets WHERE Symbol=?', [it.symbol]).length;
    });
    const failures = [];
    if (!todo.length) return failures;
    const c = Dialogs.custom(`
      <div class="dlg dlg-wide">
        <div class="dlg-title">Updating Assets</div>
        <div class="dlg-body">
          <p id="ast-upd-msg">Starting…</p>
          <div style="font-size:12px;color:#888;" id="ast-upd-detail"></div>
        </div>
      </div>`);
    for (let i = 0; i < todo.length; i++) {
      c.querySelector('#ast-upd-msg').textContent = `Updating ${i + 1} / ${todo.length}: ${todo[i].symbol}…`;
      const result = await App.ensureAsset(todo[i].symbol, todo[i].description);
      if (result && result.ok === false) failures.push({ symbol: todo[i].symbol, reason: result.reason });
      await new Promise(r => setTimeout(r, 500));
    }
    Dialogs.close();
    return failures;
  }

  async function _offerPriceUpdate() {
    if (await Dialogs.confirm('Update prices for the portfolio assets now?', 'Update Prices')) await cmdUpdatePrices();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function _failureList(title, items) {
    if (!items.length) return '';
    return `<p style="margin-top:12px;"><b>${_esc(title)}:</b></p>
      <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;max-height:180px;overflow-y:auto;">
        ${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  }

  function _todayStr() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { runHoldings, runTransactions, parseCsv, headerHash,
           prepareRows: _prepareRows, collectSnapshot, processTransactions };   // non-UI steps exposed for testing
})();

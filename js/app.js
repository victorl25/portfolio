const APP_VERSION = '1.0';

// ── State ─────────────────────────────────────────────────────────────────
let _lastFileHandle = null;
let _lastPrefix     = 'portfolio';
let _dbFilename     = '';

// ── MCP logging ───────────────────────────────────────────────────────────
let _mcpLog       = [];
let _mcpLogHandle = null;

async function _initMcpLog() {
  _mcpLog = [];
  try {
    const root    = await navigator.storage.getDirectory();
    const logsDir = await root.getDirectoryHandle('logs', { create: true });
    _mcpLogHandle = await logsDir.getFileHandle('mcp.log', { create: true });
    const w = await _mcpLogHandle.createWritable({ keepExistingData: false });
    await w.write(`MCP Log  ${new Date().toISOString()}\n${'─'.repeat(60)}\n`);
    await w.close();
  } catch {
    _mcpLogHandle = null;
  }
}

async function _logMcpResponse(tool, args, response) {
  const ts    = new Date().toISOString().slice(11, 23);
  const entry = `[${ts}] ${tool}(${JSON.stringify(args)})\n${JSON.stringify(response, null, 2)}`;
  _mcpLog.push(entry);
  if (!_mcpLogHandle) return;
  try {
    const existing = await _mcpLogHandle.getFile();
    const w        = await _mcpLogHandle.createWritable({ keepExistingData: true });
    await w.seek(existing.size);
    await w.write('\n' + entry + '\n');
    await w.close();
  } catch {}
}

function cmdDownloadMcpLog() {
  if (!_mcpLog.length) { Dialogs.alert('No MCP calls logged this session.'); return; }
  const header  = `MCP Log  ${new Date().toISOString()}\n${'─'.repeat(60)}\n`;
  const content = header + _mcpLog.join('\n\n') + '\n';
  const blob    = new Blob([content], { type: 'text/plain' });
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(blob);
  a.download    = 'mcp.log';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Formatting helpers ────────────────────────────────────────────────────
const Fmt = {
  currency: v => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  number:   v => (v || 0).toLocaleString('en-US'),
  date:     v => v || ''
};

// ── Tab management ────────────────────────────────────────────────────────
const App = {
  _tabs:    [],
  _activeId: null,
  _lastImportHandle: null,

  Tabs: {
    open(id, label, buildFn, opts = {}) {
      const existing = App._tabs.find(t => t.id === id);
      if (existing) { App.Tabs.activate(id); return; }

      const panel = document.createElement('div');
      panel.className = 'tab-panel';
      panel.id = `panel-${id}`;
      document.getElementById('tab-content').appendChild(panel);
      buildFn(panel);

      const btn = document.createElement('div');
      btn.className = 'tab-btn';
      btn.dataset.tabId = id;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      btn.appendChild(lbl);

      if (opts.closeable) {
        const x = document.createElement('span');
        x.className = 'tab-close';
        x.textContent = '×';
        x.dataset.closeTab = id;
        x.addEventListener('click', e => { e.stopPropagation(); App.Tabs.close(id); });
        btn.appendChild(x);
      }

      btn.addEventListener('click', () => App.Tabs.activate(id));
      document.getElementById('tab-bar').appendChild(btn);

      App._tabs.push({ id, panel, btn, refresh: opts.refresh || null });
      App.Tabs.activate(id);
    },

    close(id) {
      const idx = App._tabs.findIndex(t => t.id === id);
      if (idx === -1) return;
      const t = App._tabs[idx];
      t.btn.remove();
      t.panel.remove();
      App._tabs.splice(idx, 1);
      if (App._activeId === id) {
        const next = App._tabs[Math.min(idx, App._tabs.length - 1)];
        if (next) App.Tabs.activate(next.id); else App._activeId = null;
      }
    },

    closeAll() {
      [...App._tabs].forEach(t => {
        t.btn.remove();
        t.panel.remove();
      });
      App._tabs = [];
      App._activeId = null;
    },

    activate(id) {
      App._tabs.forEach(t => {
        const active = t.id === id;
        t.btn.classList.toggle('active', active);
        t.panel.classList.toggle('active', active);
      });
      App._activeId = id;
    },

    refreshCurrent() {
      const t = App._tabs.find(t => t.id === App._activeId);
      if (t && t.refresh) t.refresh();
    },

    refreshAll() {
      App._tabs.forEach(t => { if (t.refresh) t.refresh(); });
    }
  },

  onDataChanged() {
    App.Tabs.refreshAll();
  },

  async ensureAsset(symbol, description) {
    const existing = DB.query('SELECT Symbol FROM Assets WHERE Symbol=?', [symbol]);
    if (existing.length) return null;   // already exists — caller can ignore
    DB.run('INSERT OR IGNORE INTO Assets (Symbol, Description, Active) VALUES (?,?,1)', [symbol, description || '']);
    try {
      const quote = await YahooFinance.getQuote(symbol);
      if (!quote) return { ok: false, reason: 'No data returned' };
      const desc = quote.longName || quote.shortName || description || symbol;
      let type = 'Stock';
      if (quote.quoteType === 'ETF')        type = 'ETF';
      else if (quote.quoteType === 'MUTUALFUND') type = 'MF';

      let category = '';
      try {
        const summary = await YahooFinance.getQuoteSummary(symbol, 'assetProfile');
        const profile = summary?.assetProfile || summary?.quoteSummary?.result?.[0]?.assetProfile;
        if (profile) {
          if (type === 'Stock') {
            category = [profile.sector, profile.industry].filter(Boolean).join(', ');
          } else if (type === 'ETF') {
            category = profile.category || '';
          }
        }
      } catch {}

      DB.run('UPDATE Assets SET Description=?, Type=?, Category=? WHERE Symbol=?',
        [desc, type, category, symbol]);
      return { ok: true };
    } catch (e) {
      console.warn('Yahoo Finance lookup failed for', symbol, e.message);
      return { ok: false, reason: e.message };
    }
  }
};

// ── Yahoo Finance MCP client ──────────────────────────────────────────────
const YahooFinance = (() => {
  const ENDPOINT = 'https://gateway.mcpservers.org/yahoo-finance/mcp';
  let _sessionId = null;
  let _reqId = 0;
  let _initialized = false;

  async function _post(body, isNotification = false) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (_sessionId) headers['Mcp-Session-Id'] = _sessionId;
    const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`MCP error ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) _sessionId = sid;
    if (isNotification) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) return _readSse(res, body.id);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async function _readSse(res, targetId) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.id === targetId) {
            if (msg.error) throw new Error(msg.error.message);
            return msg.result;
          }
        } catch (e) { if (!e.message.includes('JSON')) throw e; }
      }
    }
    throw new Error('SSE ended without result');
  }

  async function _init() {
    if (_initialized) return;
    try {
      const id = ++_reqId;
      await _post({ jsonrpc: '2.0', id, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'Portfolio', version: APP_VERSION }
      }});
      await _post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
      _initialized = true;
    } catch {}
  }

  async function _call(toolName, args) {
    await _init();
    const id = ++_reqId;
    const result = await _post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } });
    const text = result?.content?.find(c => c.type === 'text')?.text;
    let parsed;
    if (!text) {
      parsed = result;
    } else {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    _logMcpResponse(toolName, args, parsed);
    return parsed;
  }

  async function getQuote(symbol) {
    const result = await _call('get_quote', { symbols: [symbol] });
    if (Array.isArray(result)) return result[0];
    if (result && typeof result === 'object' && result[symbol]) return result[symbol];
    return result;
  }

  async function getQuoteSummary(symbol, module) {
    return _call('quote_summary', { symbol, modules: Array.isArray(module) ? module : [module] });
  }

  return { getQuote, getQuoteSummary };
})();

// ── IndexedDB handle persistence ──────────────────────────────────────────
function _idbGet(key) {
  return new Promise(resolve => {
    const req = indexedDB.open('PortfolioApp', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('handles', 'readonly');
      const r  = tx.objectStore('handles').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

function _idbSet(key, value) {
  return new Promise(resolve => {
    const req = indexedDB.open('PortfolioApp', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

// ── Status bar ────────────────────────────────────────────────────────────
function _renderStatus() {
  const n   = DB.getChangeCount();
  const sfx = n > 0 ? ` (+${n})` : '';
  document.getElementById('db-status').textContent =
    `v${APP_VERSION}${_dbFilename ? ' ' + _dbFilename : ''}${sfx}`;
}

// ── File operations ───────────────────────────────────────────────────────
async function cmdNew() {
  if (DB.getChangeCount() > 0) {
    const ok = await Dialogs.confirm('Unsaved changes will be lost. Continue?');
    if (!ok) return;
  }
  DB.createNew();
  _dbFilename = '';
  _lastPrefix = 'portfolio';
  _renderStatus();
  _resetTabs();
}

async function cmdOpen() {
  let fh;
  try {
    [fh] = await window.showOpenFilePicker({
      id: 'portfolio-db',
      startIn: _lastFileHandle || undefined,
      types: [{ description: 'SQLite database', accept: { 'application/octet-stream': ['.db'] } }]
    });
  } catch { return; }
  const file  = await fh.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  DB.loadFromBytes(bytes);
  _lastFileHandle = fh;
  _dbFilename     = file.name;
  _lastPrefix     = _extractPrefix(file.name);
  await _idbSet('dbFile', fh);
  DB.resetChangeCount();
  _renderStatus();
  _resetTabs();
}

async function cmdSave() {
  if (!DB.isLoaded()) { await Dialogs.alert('No database to save.'); return; }
  const prefix = await Dialogs.prompt('File prefix:', _lastPrefix, 'Save Database');
  if (!prefix) return;
  const ts  = _timestamp();
  const name = `${prefix}_${ts}.db`;
  let fh;
  try {
    fh = await window.showSaveFilePicker({
      id: 'portfolio-db',
      startIn: _lastFileHandle || undefined,
      suggestedName: name,
      types: [{ description: 'SQLite database', accept: { 'application/octet-stream': ['.db'] } }]
    });
  } catch { return; }
  const bytes    = DB.exportBytes();
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
  _lastFileHandle = fh;
  _dbFilename     = (await fh.getFile()).name;
  _lastPrefix     = prefix;
  await _idbSet('dbFile', fh);
  DB.resetChangeCount();
  _renderStatus();
}

async function cmdExport() {
  if (!DB.isLoaded()) { await Dialogs.alert('No database loaded.'); return; }

  const rows = DB.query(`
    SELECT l.Symbol,
      SUM(l.Quantity) AS Quantity,
      SUM(l.Quantity) * COALESCE(p.Price, 0) AS Value,
      a.Description, a.Type, a.Category, a.Notes
    FROM Ledger l
    LEFT JOIN (
      SELECT Symbol, Price FROM Prices
      WHERE Valid = 1
      GROUP BY Symbol
      HAVING Timestamp = MAX(Timestamp)
    ) p ON l.Symbol = p.Symbol
    LEFT JOIN Assets a ON l.Symbol = a.Symbol
    WHERE l.Valid = 1
    GROUP BY l.Symbol
    HAVING SUM(l.Quantity) > 0
    ORDER BY l.Symbol`);

  if (!rows.length) { await Dialogs.alert('No holdings to export.'); return; }

  const total = rows.reduce((s, r) => s + (r.Value || 0), 0);

  const _csvCell = v => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['Symbol', 'Quantity', 'Value', '%Portfolio', 'Description', 'Type', 'Category', 'Notes'];
  const lines  = [header.join(',')];
  for (const r of rows) {
    const pct = total > 0 ? ((r.Value || 0) / total * 100).toFixed(2) : '0.00';
    lines.push([
      _csvCell(r.Symbol),
      _csvCell(r.Quantity != null ? +r.Quantity : ''),
      _csvCell(r.Value    != null ? (+r.Value).toFixed(2) : '0.00'),
      _csvCell(pct),
      _csvCell(r.Description),
      _csvCell(r.Type),
      _csvCell(r.Category),
      _csvCell(r.Notes)
    ].join(','));
  }
  const csv = lines.join('\r\n') + '\r\n';

  const d = new Date(), p = n => String(n).padStart(2, '0');
  const suggestedName = `portfolio_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}.csv`;

  try {
    const fh = await window.showSaveFilePicker({
      id: 'portfolio-export',
      startIn: _lastFileHandle || undefined,
      suggestedName,
      types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }]
    });
    const writable = await fh.createWritable();
    await writable.write(csv);
    await writable.close();
  } catch { return; }
}

async function cmdUpdatePrices() {
  const assets = DB.query(`
    SELECT l.Symbol, a.Type
    FROM Ledger l
    JOIN Assets a ON l.Symbol = a.Symbol
    WHERE l.Valid = 1
    GROUP BY l.Symbol
    HAVING SUM(l.Quantity) > 0`);

  if (!assets.length) { await Dialogs.alert('No assets with positive holdings.'); return; }

  const c = Dialogs.custom(`
    <div class="dlg dlg-wide">
      <div class="dlg-title">Updating Prices</div>
      <div class="dlg-body">
        <p id="upd-msg">Starting…</p>
        <div style="font-size:12px;color:#888;" id="upd-detail"></div>
      </div>
    </div>`);

  let updated = 0;
  const failures = [];

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    c.querySelector('#upd-msg').textContent = `Updating ${i + 1} / ${assets.length}: ${a.Symbol}…`;
    try {
      const quote = await YahooFinance.getQuote(a.Symbol);
      let price;
      price = quote.regularMarketPrice ?? quote.regularMarketPreviousClose;
      if (price != null && !isNaN(price)) {
        DB.run('INSERT INTO Prices (Timestamp, Symbol, Type, Price, Currency, Valid) VALUES (?,?,?,?,?,1)',
          [_nowTs(), a.Symbol, a.Type, Math.round(price * 100) / 100, 'USD']);
        updated++;
      } else {
        failures.push({ symbol: a.Symbol, reason: 'price unavailable in response' });
      }
    } catch (e) {
      failures.push({ symbol: a.Symbol, reason: e.message });
    }
    await new Promise(r => setTimeout(r, 100));
  }

  Dialogs.close();
  App.onDataChanged();
  await _showResultDialog(
    `Prices updated: ${updated} succeeded, ${failures.length} failed.`,
    failures, 'Update Prices');
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Shows a summary alert. If failures array is non-empty, renders a scrollable
// failure list below the summary line using Dialogs.alertHtml.
async function _showResultDialog(summary, failures, title) {
  if (!failures.length) { await Dialogs.alert(summary, title); return; }
  const items = failures
    .map(f => `<li><b>${_esc(f.symbol)}</b>: ${_esc(f.reason)}</li>`)
    .join('');
  await Dialogs.alertHtml(
    `<p>${_esc(summary)}</p>
     <ul style="margin:8px 0 0;padding-left:18px;font-size:12px;max-height:200px;overflow-y:auto;">${items}</ul>`,
    title || 'Notice');
}

function _resetTabs() {
  App.Tabs.closeAll();
  PortfolioTab.open();
}

function _extractPrefix(filename) {
  return filename.replace(/_\d{12}\.db$/i, '').replace(/\.db$/i, '') || 'portfolio';
}

function _timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

function _nowTs() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Menu wiring ───────────────────────────────────────────────────────────
function _initMenus() {
  // Toggle dropdowns
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.dropdown-item')) return;
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
      e.stopPropagation();
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
  });

  const cmd = id => document.getElementById(id);

  cmd('cmd-new').addEventListener('click', () => { _closeMenus(); cmdNew(); });
  cmd('cmd-open').addEventListener('click', () => { _closeMenus(); cmdOpen(); });
  cmd('cmd-import').addEventListener('click', () => { _closeMenus(); Import.run(); });
  cmd('cmd-export').addEventListener('click', () => { _closeMenus(); cmdExport(); });
  cmd('cmd-save').addEventListener('click', () => { _closeMenus(); cmdSave(); });

  cmd('cmd-view-portfolio').addEventListener('click', () => { _closeMenus(); PortfolioTab.open(); });
  cmd('cmd-view-accounts').addEventListener('click', () => { _closeMenus(); AccountsTab.open(); });
  cmd('cmd-view-assets').addEventListener('click', () => { _closeMenus(); AssetsTab.open(); });
  cmd('cmd-view-prices').addEventListener('click', () => { _closeMenus(); PricesTab.open(); });
  cmd('cmd-view-transactions').addEventListener('click', () => { _closeMenus(); TransactionsTab.open(); });

  cmd('cmd-analyze-portfolio').addEventListener('click', () => { _closeMenus(); _stubTab('Analyze: Portfolio'); });
  cmd('cmd-analyze-accounts').addEventListener('click', () => { _closeMenus(); _stubTab('Analyze: Accounts'); });
  cmd('cmd-analyze-assets').addEventListener('click', () => { _closeMenus(); _stubTab('Analyze: Assets'); });

  cmd('cmd-update-prices').addEventListener('click', () => { _closeMenus(); cmdUpdatePrices(); });
  cmd('cmd-query-db').addEventListener('click', () => { _closeMenus(); QueryTab.open(); });
  cmd('cmd-mcp-log').addEventListener('click', () => { _closeMenus(); cmdDownloadMcpLog(); });

  document.getElementById('tab-refresh').addEventListener('click', () => App.Tabs.refreshCurrent());
}

function _closeMenus() {
  document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
}

let _stubCtr = 0;
function _stubTab(label) {
  const id = `stub-${++_stubCtr}`;
  App.Tabs.open(id, label, panel => {
    panel.innerHTML = `<div style="padding:40px;color:#999;font-size:15px;">Coming soon</div>`;
  }, { closeable: true });
}

// ── Startup ───────────────────────────────────────────────────────────────
async function _startup() {
  // Initialise MCP log (clears/creates logs/mcp.log in OPFS for this launch)
  await _initMcpLog();

  // Register change listener for status bar
  DB.setChangeListener(_renderStatus);

  // Wire menus
  _initMenus();

  // Window close protection
  window.addEventListener('beforeunload', e => {
    if (DB.getChangeCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // Parse URL params
  const params    = new URLSearchParams(window.location.search);
  const dataDir   = params.get('dataDir');
  const dbFile    = params.get('db');
  const _dataDirUrl = dataDir ? `file:///${dataDir}` : null;

  // Load last file handle from IndexedDB
  _lastFileHandle = await _idbGet('dbFile');

  let loaded = false;

  if (dataDir && dbFile) {
    const url = `${_dataDirUrl}/${dbFile}`;
    try {
      const res   = await fetch(url);
      const buf   = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      DB.loadFromBytes(bytes);
      _dbFilename = dbFile;
      _lastPrefix = _extractPrefix(dbFile);
      loaded = true;

      // Bootstrap file handle if we don't have one
      if (!_lastFileHandle) {
        try {
          const [fh] = await window.showOpenFilePicker({ id: 'portfolio-db', startIn: undefined });
          _lastFileHandle = fh;
          await _idbSet('dbFile', fh);
        } catch {}
      }
    } catch (e) {
      console.warn('Failed to load DB from URL:', e.message);
    }
  }

  if (!loaded) {
    DB.createNew();
    _dbFilename = '';
  }

  DB.resetChangeCount();
  _renderStatus();
  _resetTabs();
}

initSqlJs({ locateFile: f => `lib/${f}` }).then(SqlLib => {
  window.SQL = SqlLib;
  _startup();
}).catch(e => {
  document.getElementById('db-status').textContent = 'Failed to load sql.js: ' + e.message;
});

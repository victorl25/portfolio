const APP_VERSION = '2.0';

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

      // All views are closeable
      const x = document.createElement('span');
      x.className = 'tab-close';
      x.textContent = '×';
      x.dataset.closeTab = id;
      x.addEventListener('click', e => { e.stopPropagation(); App.Tabs.close(id); });
      btn.appendChild(x);

      btn.addEventListener('click', () => App.Tabs.activate(id));
      document.getElementById('tab-bar').appendChild(btn);

      App._tabs.push({ id, panel, btn, refresh: opts.refresh || null, autoRefresh: opts.autoRefresh !== false,
                       onClose: opts.onClose || null });
      App.Tabs.activate(id);
      App.Tabs._renderEmpty();
    },

    close(id) {
      const idx = App._tabs.findIndex(t => t.id === id);
      if (idx === -1) return;
      const t = App._tabs[idx];
      t.btn.remove();
      t.panel.remove();
      App._tabs.splice(idx, 1);
      if (t.onClose) t.onClose();
      if (App._activeId === id) {
        const next = App._tabs[Math.min(idx, App._tabs.length - 1)];
        if (next) App.Tabs.activate(next.id); else App._activeId = null;
      }
      App.Tabs._renderEmpty();
    },

    closeAll() {
      [...App._tabs].forEach(t => {
        t.btn.remove();
        t.panel.remove();
        if (t.onClose) t.onClose();
      });
      App._tabs = [];
      App._activeId = null;
      App.Tabs._renderEmpty();
    },

    // Placeholder shown in the content area when no view is open
    _renderEmpty() {
      let el = document.getElementById('tab-empty');
      if (App._tabs.length) { if (el) el.remove(); return; }
      if (el) return;
      el = document.createElement('div');
      el.id = 'tab-empty';
      el.textContent = 'No open views. Use the View menu to open one.';
      document.getElementById('tab-content').appendChild(el);
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
      App._tabs.forEach(t => { if (t.refresh && t.autoRefresh) t.refresh(); });
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

  async function getChart(symbol, period1, period2, interval = '1d') {
    return _call('get_chart', { symbol, period1, period2, interval });
  }

  return { getQuote, getQuoteSummary, getChart };
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
  try {
    DB.loadFromBytes(bytes);
  } catch (e) {
    // Unsupported schema version or not a database: keep the current database open
    await Dialogs.alertHtml(`<p>${_esc(e.message)}</p>`, `Cannot open ${file.name}`);
    return;
  }
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
    SELECT h.Symbol, h.Quantity,
      h.Quantity * COALESCE(p.Price, 0) AS Value,
      a.Description, a.Type, a.Category,
      (SELECT n.Note FROM Notes n WHERE n.Symbol = h.Symbol ORDER BY n.Timestamp DESC, n.Note_ID DESC LIMIT 1) AS Notes
    FROM v_holdings h
    LEFT JOIN v_latest_price p ON h.Symbol = p.Symbol
    LEFT JOIN Assets a ON h.Symbol = a.Symbol
    WHERE h.Quantity > 0
    ORDER BY h.Symbol`);

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

  try {
    const fh = await window.showSaveFilePicker({
      id: 'portfolio-export',
      startIn: _lastFileHandle || undefined,
      suggestedName: `portfolio_${_todayStr()}.csv`,
      types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }]
    });
    const writable = await fh.createWritable();
    await writable.write(csv);
    await writable.close();
  } catch { return; }
}

// Fetches daily closing prices for all held assets (active Ledger entries with quantity ≠ 0),
// from today − 1 year or from the last stored price date, whichever is later. The last stored
// date is fetched again so an intraday price recorded earlier is replaced by the final close.
async function cmdUpdatePrices() {
  const assets = DB.query('SELECT Symbol FROM v_holdings ORDER BY Symbol');

  if (!assets.length) { await Dialogs.alert('No assets with holdings.'); return; }

  const c = Dialogs.custom(`
    <div class="dlg dlg-wide">
      <div class="dlg-title">Updating Prices</div>
      <div class="dlg-body">
        <p id="upd-msg">Starting…</p>
        <div style="font-size:12px;color:#888;" id="upd-detail"></div>
      </div>
    </div>`);

  let updated = 0, closes = 0;
  const failures = [];
  const DELAY_MS = 100;
  const RATE_LIMIT_WAIT_MS = 1000;
  const MAX_ATTEMPTS = 15;
  const isRateLimited = v => /too many requests|\b429\b/i.test(String(v ?? ''));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const yearAgo  = _addDaysStr(_todayStr(), -365);
  const tomorrow = _addDaysStr(_todayStr(), 1);
  let abortedOn = null;

  for (let i = 0; i < assets.length && !abortedOn; i++) {
    const a = assets[i];
    c.querySelector('#upd-msg').textContent = `Updating ${i + 1} / ${assets.length}: ${a.Symbol}…`;
    c.querySelector('#upd-detail').textContent = '';
    const last  = DB.query('SELECT MAX(Date) AS D FROM Prices WHERE Symbol=? AND Valid=1', [a.Symbol])[0]?.D;
    const start = last && last > yearAgo ? last : yearAgo;

    for (let attempt = 1; ; attempt++) {
      let chart, error;
      try { chart = await YahooFinance.getChart(a.Symbol, start, tomorrow, '1d'); }
      catch (e) { error = e; }

      const limited = error ? isRateLimited(error.message) : typeof chart === 'string' && isRateLimited(chart);
      if (limited) {
        if (attempt >= MAX_ATTEMPTS) { abortedOn = a.Symbol; break; }
        c.querySelector('#upd-detail').textContent =
          `Too Many Requests — waiting 1 s, retrying ${a.Symbol} (attempt ${attempt + 1} of ${MAX_ATTEMPTS})…`;
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }

      if (error) {
        failures.push({ symbol: a.Symbol, reason: error.message });
      } else if (typeof chart === 'string') {
        failures.push({ symbol: a.Symbol, reason: chart.slice(0, 200) });
      } else {
        const quotes = (chart?.quotes || []).filter(q => q.close != null && q.date);
        if (quotes.length) {
          for (const q of quotes) _upsertPrice(a.Symbol, _isoToDate(q.date), q.close);
          closes += quotes.length;
          updated++;
        } else {
          failures.push({ symbol: a.Symbol, reason: 'no price data in response' });
        }
      }
      break;
    }
    if (!abortedOn) await sleep(DELAY_MS);
  }

  Dialogs.close();
  App.onDataChanged();

  if (abortedOn) {
    const remaining = assets.length - updated - failures.length;
    failures.push({ symbol: abortedOn, reason: `Too Many Requests on all ${MAX_ATTEMPTS} attempts — update stopped` });
    await _showResultDialog(
      `Price update terminated: the Yahoo Finance server kept returning "Too Many Requests" for ${abortedOn}. ` +
      `${updated} symbol(s) were updated before stopping; ${remaining} symbol(s) were not updated. Try again later.`,
      failures, 'Update Prices');
    return;
  }

  await _showResultDialog(
    `Prices updated: ${updated} symbol(s) succeeded (${closes} daily closes), ${failures.length} failed.`,
    failures, 'Update Prices');
}

// Inserts or replaces the daily price of a symbol (Prices is unique per Symbol + Date).
function _upsertPrice(symbol, date, price, currency) {
  DB.run(`INSERT INTO Prices (Date, Symbol, Price, Currency, Valid) VALUES (?,?,?,?,1)
          ON CONFLICT(Symbol, Date) DO UPDATE SET Price=excluded.Price, Currency=excluded.Currency, Valid=1`,
    [date, symbol, Math.round(price * 100) / 100, currency || 'USD']);
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

function _todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function _addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const p = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// Trading date (YYYY-MM-DD) of a get_chart daily candle. Candles are stamped either at
// midnight UTC or at the US market open (13:30/14:30 UTC); the UTC calendar date is the
// trading date in both cases, whereas a local-time conversion could shift it a day back.
function _isoToDate(iso) {
  const s = typeof iso === 'string' ? iso : new Date(iso).toISOString();
  return s.slice(0, 10);
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
  cmd('cmd-import-holdings').addEventListener('click', () => { _closeMenus(); Import.runHoldings(); });
  cmd('cmd-import-transactions').addEventListener('click', () => { _closeMenus(); Import.runTransactions(); });
  cmd('cmd-export').addEventListener('click', () => { _closeMenus(); cmdExport(); });
  cmd('cmd-save').addEventListener('click', () => { _closeMenus(); cmdSave(); });

  cmd('cmd-view-portfolio').addEventListener('click', () => { _closeMenus(); PortfolioTab.open(); });
  cmd('cmd-view-accounts').addEventListener('click', () => { _closeMenus(); AccountsTab.open(); });
  cmd('cmd-view-assets').addEventListener('click', () => { _closeMenus(); AssetsTab.open(); });
  cmd('cmd-view-prices').addEventListener('click', () => { _closeMenus(); PricesTab.open(); });
  cmd('cmd-view-transactions').addEventListener('click', () => { _closeMenus(); TransactionsTab.open(); });
  cmd('cmd-view-ledger').addEventListener('click', () => { _closeMenus(); LedgerTab.open(); });
  cmd('cmd-view-options').addEventListener('click', () => { _closeMenus(); OptionsTab.open(); });
  cmd('cmd-view-rules').addEventListener('click', () => { _closeMenus(); RulesTab.open(); });

  // Analyze: performance (ReportsTab: holdings with Total / YTD / 50-day G/L; AnalysisTab: one asset's trend report)
  cmd('cmd-analyze-portfolio-performance').addEventListener('click', () => { _closeMenus(); ReportsTab.open(); });
  cmd('cmd-analyze-account-performance').addEventListener('click', () => { _closeMenus(); ReportsTab.openAccount(); });
  cmd('cmd-analyze-asset-performance').addEventListener('click', () => { _closeMenus(); AnalysisTab.openAsset(); });

  // Reports: value by Theme (AnalysisTab)
  cmd('cmd-report-portfolio-theme').addEventListener('click', () => { _closeMenus(); AnalysisTab.openPortfolio(); });
  cmd('cmd-report-account-theme').addEventListener('click', () => { _closeMenus(); AnalysisTab.openAccount(); });
  cmd('cmd-report-dividends').addEventListener('click', () => { _closeMenus(); DividendsTab.open(); });

  cmd('cmd-update-prices').addEventListener('click', () => { _closeMenus(); cmdUpdatePrices(); });
  cmd('cmd-query-db').addEventListener('click', () => { _closeMenus(); QueryTab.open(); });
  cmd('cmd-mcp-log').addEventListener('click', () => { _closeMenus(); cmdDownloadMcpLog(); });

  document.getElementById('tab-refresh').addEventListener('click', () => App.Tabs.refreshCurrent());
}

function _closeMenus() {
  document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
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
  let refusal = null;   // message shown after startup when the auto-loaded file is refused

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
      if (e instanceof DB.VersionError) {
        refusal = { title: `Cannot open ${dbFile}`,
                    html: `<p>${_esc(e.message)}</p><p>A new empty database has been created instead.</p>` };
      }
    }
  }

  if (!loaded) {
    DB.createNew();
    _dbFilename = '';
  }

  DB.resetChangeCount();
  _renderStatus();
  _resetTabs();
  if (refusal) await Dialogs.alertHtml(refusal.html, refusal.title);
}

initSqlJs({ locateFile: f => `lib/${f}` }).then(SqlLib => {
  window.SQL = SqlLib;
  _startup();
}).catch(e => {
  document.getElementById('db-status').textContent = 'Failed to load sql.js: ' + e.message;
});

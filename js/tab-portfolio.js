const PortfolioTab = (() => {
  let _ctr = 0;
  let _hldCtr = 0;

  const MONEY = { formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } };

  function open(accountId, theme) {
    const id = `prt-${++_ctr}`;
    const hasTheme = theme !== undefined && theme !== null;
    let label = 'Portfolio';
    if (accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
      label = acc.length ? acc[0].Name : label;
      if (hasTheme) label += ` — ${theme || '(No Theme)'}`;
    } else if (hasTheme) {
      label = theme || '(No Theme)';
    }
    App.Tabs.open(id, label, panel => _build(panel, id, accountId, theme),
      { refresh: () => _refresh(id, accountId, theme) });
  }

  function _build(panel, id, accountId, theme) {
    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone" style="flex-direction:column;">
          <div id="${id}-total" style="font-size:16px;font-weight:700;color:#222;padding:6px 16px 4px;border-bottom:1px solid #e0e0e0;"></div>
          <div class="form-body" style="align-items:top;flex:1;">
            <div style="flex:1;display:flex;flex-direction:column;gap:6px;padding:6px 0;">
              <label style="font-size:12px;color:#666;font-weight:500;">Enter transaction (e.g. "+100 AAPL $150", "buy 50 MSFT $300 2026-09-30", "sell all AAPL $220", "-2 NVDA20270115C360 $3.20")</label>
              <input class="form-control" id="${id}-txinput" placeholder="+100 AAPL $150.00 [YYYY-MM-DD]" style="font-size:14px;">
            </div>
          </div>
        </div>
      </div>`;

    const { rows: initRows, total: initTotal } = _loadData(accountId, theme);
    _renderTotal(panel, id, initTotal, initRows.length);

    const table = new Tabulator(`#${id}-table-wrap`, {
      data: initRows,
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Symbol', field: 'Symbol', headerFilter: true, headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => { e.stopPropagation(); openHoldings(cell.getValue(), accountId); });
            return a;
          }
        },
        { title: 'Quantity', field: 'Quantity',  headerSortTristate: true,
          formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price', field: 'Price', headerSortTristate: true, ...MONEY },
        { title: 'Value', field: 'Value', headerSortTristate: true, ...MONEY },
        { title: 'Gain / Loss', field: 'GainLoss', headerSortTristate: true, formatter: _fmtGainLoss },
        { title: '% Gain/Loss', field: 'GainLossPct', headerSortTristate: true, formatter: _fmtPct },
        { title: '% Portfolio', field: 'Percent', headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            return v != null ? v.toFixed(2) + '%' : '';
          }
        },
        { title: 'Action', field: 'Symbol', width: 90, hozAlign: 'center', headerSort: false,
          formatter: () => `<button class="act-btn analyze-btn">Analyze</button>`,
          cellClick: (e, cell) => {
            if (!e.target.classList.contains('act-btn')) return;
            AnalysisTab.openAssetFor(cell.getRow().getData().Symbol);
          }
        }
      ]
    });

    panel._prtTable = table;
    panel._prtAccountId = accountId;

    const input = panel.querySelector(`#${id}-txinput`);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') _handleInput(input.value.trim(), id, accountId);
    });
  }

  // Current positions from the active Ledger entries (quantity 0 excluded), valued at the latest price.
  function _loadData(accountId, theme) {
    let where = 'l.Active = 1 AND l.Quantity <> 0';
    const params = [];
    if (accountId) { where += ' AND l.Account_ID = ?'; params.push(accountId); }

    const isThemeFiltered = theme !== undefined && theme !== null;
    let themeJoin = '';
    if (isThemeFiltered) {
      themeJoin = 'LEFT JOIN Assets ta ON ta.Symbol = l.Symbol';
      if (theme === '') {
        where += " AND (ta.Theme IS NULL OR ta.Theme = '')";
      } else {
        where += ' AND ta.Theme = ?';
        params.push(theme);
      }
    }

    const rows = DB.query(`
      SELECT l.Symbol,
        SUM(l.Quantity) AS Quantity,
        SUM(l.Cost_Basis) AS CostBasis,
        p.Price,
        SUM(l.Quantity) * COALESCE(p.Price, 0) AS Value
      FROM Ledger l
      ${themeJoin}
      LEFT JOIN v_latest_price p ON l.Symbol = p.Symbol
      WHERE ${where}
      GROUP BY l.Symbol
      HAVING SUM(l.Quantity) <> 0`, params);

    const assetsTotal = rows.reduce((s, r) => s + (r.Value || 0), 0);

    // Cash has no Theme of its own — folding the account's/portfolio's full cash balance into
    // the denominator here would understate %Portfolio for every row once the view is narrowed
    // to a single Theme (rows only ever sum to that Theme's assets). Only include cash for the
    // unfiltered view, where "total" genuinely means everything in scope (assets + cash).
    let cash = 0;
    if (!isThemeFiltered) {
      const cashRes = accountId
        ? DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Account_ID = ? AND Active = 1', [accountId])
        : DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Active = 1');
      cash = cashRes[0]?.TotalCash || 0;
    }
    const total = assetsTotal + cash;

    rows.forEach(r => {
      r.Percent      = total > 0 ? (r.Value || 0) / total * 100 : 0;
      r.GainLoss     = (r.Value || 0) - (r.CostBasis || 0);
      r.GainLossPct  = r.CostBasis ? r.GainLoss / Math.abs(r.CostBasis) * 100 : null;   // abs: shorts have negative basis
    });
    return { rows, total };
  }

  // ── Holdings drill-down: one row per account for a symbol ───────────────
  function openHoldings(symbol, accountId) {
    const id = `hld-${++_hldCtr}`;
    App.Tabs.open(id, `${symbol} holdings`, panel => _buildHoldings(panel, id, symbol, accountId),
      { refresh: () => _refreshHoldings(id, symbol, accountId) });
  }

  function _buildHoldings(panel, id, symbol, accountId) {
    panel.innerHTML = `
      <div class="rpt-layout">
        <div class="rpt-table-zone" id="${id}-table-wrap"></div>
        <div class="rpt-summary" id="${id}-summary"></div>
      </div>`;
    const rows = _loadHoldings(symbol, accountId);
    panel._hldTable = new Tabulator(`#${id}-table-wrap`, {
      data: rows,
      layout: 'fitColumns',
      selectableRows: 1,
      height: '100%',
      columns: [
        { title: 'Account', field: 'Name', headerSortTristate: true,
          formatter: cell => {
            const a = document.createElement('a');
            a.className = 'cell-link';
            a.textContent = cell.getValue();
            a.addEventListener('click', e => {
              e.stopPropagation();
              TransactionsTab.open({ symbol, accountId: cell.getRow().getData().Account_ID });
            });
            return a;
          }
        },
        { title: 'Quantity', field: 'Quantity', headerSortTristate: true, formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Avg Cost', field: 'AvgCost', headerSortTristate: true, ...MONEY },
        { title: 'Cost Basis', field: 'Cost_Basis', headerSortTristate: true, ...MONEY },
        { title: 'Price', field: 'Price', headerSortTristate: true, ...MONEY },
        { title: 'Value', field: 'Value', headerSortTristate: true, ...MONEY },
        { title: 'Gain / Loss', field: 'GainLoss', headerSortTristate: true, formatter: _fmtGainLoss },
        { title: '% Gain/Loss', field: 'GainLossPct', headerSortTristate: true, formatter: _fmtPct }
      ]
    });
    _renderHoldingsSummary(panel, id, symbol, rows);
  }

  function _loadHoldings(symbol, accountId) {
    const params = [symbol];
    let where = 'l.Active = 1 AND l.Quantity <> 0 AND l.Symbol = ?';
    if (accountId) { where += ' AND l.Account_ID = ?'; params.push(accountId); }
    const rows = DB.query(`
      SELECT l.Account_ID, a.Name, l.Quantity, l.Cost_Basis, p.Price,
        l.Quantity * COALESCE(p.Price, 0) AS Value
      FROM Ledger l
      JOIN Accounts a ON a.Account_ID = l.Account_ID
      LEFT JOIN v_latest_price p ON p.Symbol = l.Symbol
      WHERE ${where}
      ORDER BY a.Name`, params);
    rows.forEach(r => {
      r.AvgCost     = r.Quantity ? r.Cost_Basis / r.Quantity : null;
      r.GainLoss    = (r.Value || 0) - (r.Cost_Basis || 0);
      r.GainLossPct = r.Cost_Basis ? r.GainLoss / Math.abs(r.Cost_Basis) * 100 : null;
    });
    return rows;
  }

  function _renderHoldingsSummary(panel, id, symbol, rows) {
    const el = panel.querySelector(`#${id}-summary`);
    if (!el) return;
    const qty  = rows.reduce((s, r) => s + r.Quantity, 0);
    const cost = rows.reduce((s, r) => s + r.Cost_Basis, 0);
    const val  = rows.reduce((s, r) => s + (r.Value || 0), 0);
    el.innerHTML = `<span class="label">${_esc(symbol)}:</span>
      <span>Quantity <b>${_fmtNum(qty)}</b></span>
      <span>Avg Cost <b>${qty ? Fmt.currency(cost / qty) : '—'}</b></span>
      <span>Value <b>${Fmt.currency(val)}</b></span>
      <span>Gain / Loss <b style="color:${val - cost < 0 ? '#c0392b' : '#27ae60'}">${Fmt.currency(val - cost)}</b></span>`;
  }

  function _refreshHoldings(tabId, symbol, accountId) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (!panel || !panel._hldTable) return;
    const rows = _loadHoldings(symbol, accountId);
    panel._hldTable.replaceData(rows);
    _renderHoldingsSummary(panel, tabId, symbol, rows);
  }

  // ── Transaction entry ───────────────────────────────────────────────────
  async function _handleInput(text, id, accountId) {
    if (!text) return;
    const parsed = parseEntry(text);
    if (!parsed) {
      await Dialogs.alert('Could not parse entry. Try "+100 AAPL $150", "buy 100 AAPL $150 2026-09-30", ' +
        '"sell all MSFT $291.5", or "-2 NVDA20270115C360 $3.20".');
      return;
    }
    const isOption = Engine.isOption(parsed.symbol);

    if (parsed.all) {
      let qSql = 'SELECT COALESCE(SUM(Quantity), 0) AS total FROM Ledger WHERE Active=1 AND Symbol=?';
      const qParams = [parsed.symbol];
      if (accountId) { qSql += ' AND Account_ID=?'; qParams.push(accountId); }
      const table = isOption ? 'Options' : 'Ledger';
      const res = DB.query(qSql.replace('FROM Ledger', `FROM ${table}`), qParams);
      const ownedQty = Math.abs(res[0]?.total || 0);
      if (!ownedQty) { await Dialogs.alert(`No ${parsed.symbol} holdings found.`); return; }
      parsed.quantity = parsed.sell ? -ownedQty : ownedQty;
    }

    // Validate the symbol: option symbols by format, unknown equities via Yahoo Finance
    if (!isOption && !DB.query('SELECT Symbol FROM Assets WHERE Symbol=?', [parsed.symbol]).length) {
      let quote = null;
      try {
        quote = await YahooFinance.getQuote(parsed.symbol);
      } catch (e) {
        await Dialogs.alert(`"${parsed.symbol}" is not a valid ticker symbol (${e.message}). Please correct the transaction.`);
        return;
      }
      if (!quote || (quote.regularMarketPrice == null && quote.regularMarketPreviousClose == null)) {
        await Dialogs.alert(`"${parsed.symbol}" does not appear to be a valid ticker symbol. Please correct the transaction.`);
        return;
      }
    }

    const sellQty = Math.abs(parsed.quantity || 0);
    let accounts;
    if (parsed.quantity < 0 && !isOption) {
      // Equity sales: only accounts that hold enough shares
      const accFilter = accountId ? 'AND a.Account_ID = ?' : '';
      const params    = accountId ? [parsed.symbol, accountId, sellQty] : [parsed.symbol, sellQty];
      accounts = DB.query(`
        SELECT a.Account_ID, a.Account, a.Name, COALESCE(SUM(l.Quantity), 0) AS Holdings
        FROM Accounts a
        LEFT JOIN Ledger l ON l.Account_ID = a.Account_ID AND l.Symbol = ? AND l.Active = 1
        WHERE a.Active = 1 ${accFilter}
        GROUP BY a.Account_ID
        HAVING COALESCE(SUM(l.Quantity), 0) >= ?
        ORDER BY a.Name`, params);
      if (!accounts.length) {
        await Dialogs.alert(
          accountId
            ? `Insufficient holdings of ${parsed.symbol} in this account to sell ${sellQty} share(s).`
            : `No account holds enough ${parsed.symbol} to sell ${sellQty} share(s).`);
        return;
      }
    } else {
      accounts = DB.query('SELECT Account_ID, Account, Name FROM Accounts WHERE Active=1 ORDER BY Name');
    }

    if (!accounts.length) { await Dialogs.alert('No accounts found. Create an account first.'); return; }

    const accOpts = accounts.map(a =>
      `<option value="${a.Account_ID}"${accountId && String(a.Account_ID) === String(accountId) ? ' selected' : ''}>${_esc(a.Name)} (${_esc(a.Account)})</option>`
    ).join('');

    return new Promise(resolve => {
      const c = Dialogs.custom(`
        <div class="dlg dlg-wide">
          <div class="dlg-title">Confirm Transaction</div>
          <div class="dlg-body">
            <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 12px;align-items:center;">
              <label style="font-size:13px;color:#555;text-align:right;">Account</label>
              <select class="dlg-select" id="ptx-account">${accOpts}</select>
              <label style="font-size:13px;color:#555;text-align:right;">Date</label>
              <input class="dlg-input" id="ptx-date" type="date" value="${_esc(parsed.date || _todayStr())}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Symbol</label>
              <input class="dlg-input" id="ptx-symbol" value="${_esc(parsed.symbol)}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Quantity</label>
              <input class="dlg-input" id="ptx-qty" type="number" step="any" value="${parsed.quantity}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Price</label>
              <input class="dlg-input" id="ptx-price" type="number" step="any" value="${parsed.price}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Currency</label>
              <input class="dlg-input" id="ptx-currency" value="USD" maxlength="3" style="margin-top:0;">
            </div>
          </div>
          <div style="color:#c0392b;font-size:12px;padding:0 20px 8px;min-height:16px;" id="ptx-err"></div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="ptx-cancel">Cancel</button>
            <button class="btn btn-primary"   id="ptx-ok">OK</button>
          </div>
        </div>`);

      c.querySelector('#ptx-cancel').addEventListener('click', () => { Dialogs.close(); resolve(); });
      c.querySelector('#ptx-ok').addEventListener('click', async () => {
        const selAccountId = Number(c.querySelector('#ptx-account').value);
        const date     = c.querySelector('#ptx-date').value;
        const symbol   = Engine.normalizeSymbol(c.querySelector('#ptx-symbol').value);
        const qty      = parseFloat(c.querySelector('#ptx-qty').value);
        const price    = parseFloat(c.querySelector('#ptx-price').value);
        const currency = c.querySelector('#ptx-currency').value.trim() || 'USD';

        if (!selAccountId || !symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(qty) || !qty || isNaN(price)) {
          c.querySelector('#ptx-err').textContent = 'All fields are required.';
          return;
        }
        Dialogs.close();

        const opt = Engine.isOption(symbol);
        try {
          await DB.transaction(() => Engine.record({
            Account_ID: selAccountId, Date: date, Effect: 'Trade', Category: opt ? 'Option' : 'Equity',
            Symbol: symbol, Quantity: qty, Price: price, Currency: currency, Description: `Manual entry: ${text}`,
            Amount: Engine.resolveAmount({ amount: null, quantity: qty, price, effect: 'Trade', symbol })
          }));
        } catch (e) {
          await Dialogs.alert(`Could not record the transaction: ${e.message}`);
          resolve();
          return;
        }
        if (!opt) await App.ensureAsset(symbol);

        const el = document.getElementById(`${id}-txinput`);
        if (el) el.value = '';
        App.onDataChanged();
        resolve();
      });
    });
  }

  // "+100 AAPL $150 [YYYY-MM-DD]", "-2 NVDA20270115C360 $3.20",
  // "buy|bought|sell|sold [all|N] [shares of] SYMBOL $PRICE [YYYY-MM-DD]"
  function parseEntry(text) {
    const SYM = '([A-Za-z][A-Za-z0-9.]*)', PRICE = '\\$\\s*(\\d+(?:\\.\\d+)?|\\.\\d+)', DATE = '(?:\\s+(\\d{4}-\\d{2}-\\d{2}))?';
    let m = text.match(new RegExp(`^([+-]?\\d+(?:\\.\\d+)?)\\s+${SYM}\\s+${PRICE}${DATE}$`));
    if (m) return { quantity: parseFloat(m[1]), symbol: Engine.normalizeSymbol(m[2]), price: parseFloat(m[3]), date: m[4] || null };

    m = text.match(new RegExp(`^(buy|bought|sell|sold)\\s+(all|\\d+(?:\\.\\d+)?)\\s+(?:shares?\\s+of\\s+)?${SYM}\\s+${PRICE}${DATE}$`, 'i'));
    if (m) {
      const isSell = /^(sell|sold)$/i.test(m[1]);
      const base = { symbol: Engine.normalizeSymbol(m[3]), price: parseFloat(m[4]), date: m[5] || null };
      if (m[2].toLowerCase() === 'all') return { ...base, quantity: null, all: true, sell: isSell };
      const qty = parseFloat(m[2]);
      return { ...base, quantity: isSell ? -qty : qty };
    }
    return null;
  }

  function _renderTotal(panel, tabId, total, assetCount) {
    const el = panel.querySelector(`#${tabId}-total`);
    if (el) el.textContent = 'Total Value: $' +
      (total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
      ` (${assetCount || 0})`;
  }

  function _refresh(tabId, accountId, theme) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (!panel) return;
    const { rows, total } = _loadData(accountId, theme);
    if (panel._prtTable) panel._prtTable.replaceData(rows);
    _renderTotal(panel, tabId, total, rows.length);
  }

  function _fmtGainLoss(cell) {
    const v = cell.getValue();
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' +
      Math.abs(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtPct(cell) {
    const v = cell.getValue();
    if (v == null) return '—';
    cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open, openHoldings, parseEntry };
})();

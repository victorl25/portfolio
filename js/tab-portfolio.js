const PortfolioTab = (() => {
  let _ctr = 0;

  function open(accountId) {
    const id = `prt-${++_ctr}`;
    let label = 'Portfolio';
    if (accountId) {
      const acc = DB.query('SELECT Name FROM Accounts WHERE Account_ID=?', [accountId]);
      if (acc.length) label = acc[0].Name;
    }
    App.Tabs.open(id, label, panel => _build(panel, id, accountId),
      { closeable: !!accountId, refresh: () => _refresh(id, accountId) });
  }

  function _build(panel, id, accountId) {
    panel.innerHTML = `
      <div class="tab-layout">
        <div class="table-zone" id="${id}-table-wrap"></div>
        <div class="form-zone" style="flex-direction:column;">
          <div id="${id}-total" style="font-size:16px;font-weight:700;color:#222;padding:6px 16px 4px;border-bottom:1px solid #e0e0e0;"></div>
          <div class="form-body" style="align-items:top;flex:1;">
            <div style="flex:1;display:flex;flex-direction:column;gap:6px;padding:6px 0;">
              <label style="font-size:12px;color:#666;font-weight:500;">Enter transaction (e.g. "+100 AAPL @ 150", "buy 50 MSFT at 300", "sell all AAPL @ 220")</label>
              <input class="form-control" id="${id}-txinput" placeholder="+100 AAPL @ 150.00" style="font-size:14px;">
            </div>
          </div>
        </div>
      </div>`;

    const { rows: initRows, total: initTotal } = _loadData(accountId);
    _renderTotal(panel, id, initTotal);

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
            a.addEventListener('click', e => {
              e.stopPropagation();
              const filter = { symbol: cell.getValue() };
              if (accountId) filter.accountId = accountId;
              TransactionsTab.open(filter);
            });
            return a;
          }
        },
        { title: 'Quantity', field: 'Quantity',  headerSortTristate: true,
          formatter: cell => _fmtNum(cell.getValue()) },
        { title: 'Price', field: 'Price', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Value', field: 'Value', headerSortTristate: true,
          formatter: 'money', formatterParams: { decimal: '.', thousand: ',', symbol: '$', precision: 2 } },
        { title: 'Gain / Loss', field: 'GainLoss', headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
            return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' +
              Math.abs(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          }
        },
        { title: '% Gain/Loss', field: 'GainLossPct', headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            if (v == null) return '—';
            cell.getElement().style.color = v < 0 ? '#c0392b' : v > 0 ? '#27ae60' : '';
            return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
          }
        },
        { title: '% Portfolio', field: 'Percent', headerSortTristate: true,
          formatter: cell => {
            const v = cell.getValue();
            return v != null ? v.toFixed(2) + '%' : '';
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

  function _loadData(accountId) {
    let where = 'l.Valid = 1';
    const params = [];
    if (accountId) { where += ' AND l.Account_ID = ?'; params.push(accountId); }

    const rows = DB.query(`
      SELECT l.Symbol,
        SUM(l.Quantity) AS Quantity,
        p.Price,
        SUM(l.Quantity) * COALESCE(p.Price, 0) AS Value,
        SUM(l.Quantity) * COALESCE(p.Price, 0) - SUM(l.Quantity * l.Price) AS GainLoss,
        SUM(l.Quantity * l.Price) AS CostBasis
      FROM Ledger l
      LEFT JOIN (
        SELECT Symbol, Price FROM Prices
        WHERE Valid = 1
        GROUP BY Symbol
        HAVING Timestamp = MAX(Timestamp)
      ) p ON l.Symbol = p.Symbol
      WHERE ${where}
      GROUP BY l.Symbol
      HAVING SUM(l.Quantity) > 0`, params);

    const assetsTotal = rows.reduce((s, r) => s + (r.Value || 0), 0);

    const cashRes = accountId
      ? DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Account_ID = ? AND Active = 1', [accountId])
      : DB.query('SELECT COALESCE(SUM(Cash), 0) AS TotalCash FROM Accounts WHERE Active = 1');
    const cash  = cashRes[0]?.TotalCash || 0;
    const total = assetsTotal + cash;

    rows.forEach(r => {
      r.Percent      = total > 0 ? (r.Value || 0) / total * 100 : 0;
      r.GainLossPct  = r.CostBasis ? r.GainLoss / r.CostBasis * 100 : null;
    });
    return { rows, total };
  }

  async function _handleInput(text, id, accountId) {
    if (!text) return;
    const parsed = _parseEntry(text);
    if (!parsed) { await Dialogs.alert('Could not parse entry. Try "+100 AAPL @ 150", "buy 100 AAPL at 150", or "sell all MSFT @ 291.5".'); return; }

    if (parsed.all) {
      let qSql = 'SELECT COALESCE(SUM(Quantity), 0) AS total FROM Ledger WHERE Valid=1 AND Symbol=?';
      const qParams = [parsed.symbol];
      if (accountId) { qSql += ' AND Account_ID=?'; qParams.push(accountId); }
      const res = DB.query(qSql, qParams);
      const ownedQty = res[0]?.total || 0;
      parsed.quantity = parsed.sell ? -ownedQty : ownedQty;
    }

    // Validate symbol via Yahoo Finance if not already in the Assets table
    const knownAsset = DB.query('SELECT Symbol FROM Assets WHERE Symbol=?', [parsed.symbol]);
    if (!knownAsset.length) {
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

    const isSell  = parsed.quantity < 0;
    const sellQty = Math.abs(parsed.quantity || 0);

    let accounts;
    if (isSell) {
      const accFilter = accountId ? 'AND a.Account_ID = ?' : '';
      const params    = accountId
        ? [parsed.symbol, accountId, sellQty]
        : [parsed.symbol, sellQty];
      accounts = DB.query(`
        SELECT a.Account_ID, a.Account, a.Name,
          COALESCE(SUM(l.Quantity), 0) AS Holdings
        FROM Accounts a
        LEFT JOIN Ledger l ON l.Account_ID = a.Account_ID AND l.Symbol = ? AND l.Valid = 1
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
              <label style="font-size:13px;color:#555;text-align:right;">Symbol</label>
              <input class="dlg-input" id="ptx-symbol" value="${_esc(parsed.symbol)}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Quantity</label>
              <input class="dlg-input" id="ptx-qty" type="number" step="any" value="${parsed.quantity}" style="margin-top:0;">
              <label style="font-size:13px;color:#555;text-align:right;">Price</label>
              <input class="dlg-input" id="ptx-price" type="number" step="0.01" value="${parsed.price}" style="margin-top:0;">
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
        const selAccountId = c.querySelector('#ptx-account').value;
        const symbol   = c.querySelector('#ptx-symbol').value.trim().toUpperCase();
        const qty      = parseFloat(c.querySelector('#ptx-qty').value);
        const price    = parseFloat(c.querySelector('#ptx-price').value);
        const currency = c.querySelector('#ptx-currency').value.trim() || 'USD';

        if (!selAccountId || !symbol || isNaN(qty) || isNaN(price)) {
          c.querySelector('#ptx-err').textContent = 'All fields are required.';
          return;
        }

        Dialogs.close();
        const ts = _nowTs();

        await App.ensureAsset(symbol);

        const existingPrices = DB.query('SELECT COUNT(*) AS cnt FROM Prices WHERE Symbol=?', [symbol]);
        if (!existingPrices[0].cnt) {
          DB.run('INSERT INTO Prices (Timestamp, Symbol, Price, Currency, Valid) VALUES (?,?,?,?,1)',
            [ts, symbol, Math.round(price * 100) / 100, currency]);
        }

        const hash = _txHash(selAccountId, symbol, qty, price);
        DB.run(`INSERT OR IGNORE INTO Ledger
          (Transaction_Hash, Timestamp, Account_ID, Symbol, Quantity, Price, Currency, Valid)
          VALUES (?,?,?,?,?,?,?,1)`,
          [hash, ts, selAccountId, symbol, qty, price, currency]);

        DB.run('UPDATE Accounts SET Cash = Cash - ?, Last_Updated = ? WHERE Account_ID = ?',
          [qty * price, ts, selAccountId]);

        const el = document.getElementById(`${id}-txinput`);
        if (el) el.value = '';
        _refresh(id, accountId);
        App.onDataChanged(selAccountId);
        resolve();
      });
    });
  }

  function _parseEntry(text) {
    // "+100 AAPL @ 150" or "-100 AAPL @ 150"
    let m = text.match(/^([+-]?\d+(?:\.\d+)?)\s+([A-Za-z.]+)\s*@\s*([\d.]+)$/);
    if (m) return { quantity: parseFloat(m[1]), symbol: m[2].toUpperCase(), price: parseFloat(m[3]) };

    // "buy/bought/sell/sold [all|N] [shares of] SYMBOL [at|@] PRICE"
    m = text.match(/^(buy|bought|sell|sold)\s+(all|\d+(?:\.\d+)?)\s+(?:shares?\s+of\s+)?([A-Za-z.]+)\s+(?:at|@)\s+([\d.]+)/i);
    if (m) {
      const isSell = /^sell$|^sold$/i.test(m[1]);
      if (m[2].toLowerCase() === 'all') {
        return { quantity: null, all: true, sell: isSell, symbol: m[3].toUpperCase(), price: parseFloat(m[4]) };
      }
      const qty = parseFloat(m[2]);
      return { quantity: isSell ? -qty : qty, symbol: m[3].toUpperCase(), price: parseFloat(m[4]) };
    }
    return null;
  }

  function _txHash(accountId, symbol, qty, price) {
    const key = `${accountId}|${symbol}|${qty}|${price}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) { h = (Math.imul(31, h) + key.charCodeAt(i)) | 0; }
    return key + '_' + Math.abs(h).toString(36);
  }

  function _renderTotal(panel, tabId, total) {
    const el = panel.querySelector(`#${tabId}-total`);
    if (el) el.textContent = 'Total Value: $' +
      (total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _refresh(tabId, accountId) {
    const panel = document.getElementById(`panel-${tabId}`);
    if (!panel) return;
    const { rows, total } = _loadData(accountId);
    if (panel._prtTable) panel._prtTable.replaceData(rows);
    _renderTotal(panel, tabId, total);
  }

  function _fmtNum(v) {
    return v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  }

  function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { open };
})();

// Engine — applies transactions to the Ledger, Options and account cash balances
// (see VERSION_2.md). Pure data logic, no UI. Callers wrap writes in DB.transaction().
const Engine = (() => {
  // Transaction Type for each Effect ('Ignore' rows are never stored)
  const EFFECT_TYPE = {
    Trade: 'Trade', Reinvestment: 'Trade', Cash: 'Cash', Other: 'Other',
    Distribution: 'Record', Split: 'Record', Merger: 'Other', Snapshot: 'Record', RSU: 'Record'
  };
  const EFFECTS    = ['Ignore', 'Trade', 'Cash', 'Other', 'Distribution', 'Split', 'Merger', 'Reinvestment', 'RSU'];
  const CATEGORIES = ['Asset', 'Equity', 'Option', 'Dividend', 'Fee', 'Interest', 'Margin', 'Tax', 'Transfer', 'Other'];
  const NON_CASH_EFFECTS = ['Distribution', 'Split', 'Merger', 'Snapshot', 'RSU'];
  const RSU_PRICE_LOOKBACK_DAYS = 7;   // vesting on a weekend/holiday uses the last close before it
  const OPTION_MULTIPLIER = 100;
  const EPS = 1e-9;

  const _round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const _roundQ = v => { const r = Math.round(v * 1e8) / 1e8; return Math.abs(r) < EPS ? 0 : r; };

  // ── Option symbols ──────────────────────────────────────────────────────
  // Canonical form: <Ticker><YYYY><MM><DD><C|P><Strike>, e.g. NVDA20260101C300 / NVDA20260101C182.5
  const _RX_CANON  = /^([A-Z][A-Z.]*)(\d{4})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/;
  const _RX_YYMMDD = /^([A-Z][A-Z.]*)(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/;          // Fidelity: -GLD260821C515
  const _RX_OCC    = /^([A-Z][A-Z.]*)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;                // OCC: NVDA270115C00360000
  // Alternative (Schwab) format: NVDA 01/15/2027 360.00 C — also 1/5/2027, 01/15/27 and $360.00
  const _RX_SCHWAB = /^([A-Z][A-Z.]*)\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+\$?(\d+(?:\.\d+)?)\s+([CP])$/;

  const _fmtStrike = s => String(parseFloat(s));

  // Returns the canonical option symbol, or null if sym is not an option symbol.
  function normalizeOption(sym) {
    const s = String(sym || '').trim().toUpperCase().replace(/^-\s*/, '');
    let m;
    if ((m = s.match(_RX_CANON)))  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${_fmtStrike(m[6])}`;
    if ((m = s.match(_RX_OCC)))    return `${m[1]}20${m[2]}${m[3]}${m[4]}${m[5]}${_fmtStrike(parseInt(m[6], 10) / 1000)}`;
    if ((m = s.match(_RX_YYMMDD))) return `${m[1]}20${m[2]}${m[3]}${m[4]}${m[5]}${_fmtStrike(m[6])}`;
    if ((m = s.match(_RX_SCHWAB))) {
      const pad = n => n.padStart(2, '0');
      const year = m[4].length === 2 ? '20' + m[4] : m[4];
      return `${m[1]}${year}${pad(m[2])}${pad(m[3])}${m[6]}${_fmtStrike(m[5])}`;
    }
    return null;
  }

  function isOption(sym) { return normalizeOption(sym) !== null; }

  // { asset, expiration: 'YYYY-MM-DD', right: 'C'|'P', strike } for a canonical option symbol
  function parseOption(sym) {
    const m = String(sym || '').match(_RX_CANON);
    if (!m) return null;
    return { asset: m[1], expiration: `${m[2]}-${m[3]}-${m[4]}`, right: m[5], strike: parseFloat(m[6]) };
  }

  // Canonical symbol for storage: option symbols normalized, equities trimmed and uppercased.
  function normalizeSymbol(sym) {
    const s = String(sym || '').trim();
    if (!s) return '';
    return normalizeOption(s) || s.toUpperCase();
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  function loadRules() {
    const rules = [];
    for (const r of DB.query('SELECT * FROM Rules WHERE Active = 1 ORDER BY Rule_Order, Rule_ID')) {
      try { rules.push({ ...r, rx: new RegExp(r.Pattern, r.Case_Sensitive ? '' : 'i') }); }
      catch (e) { console.warn(`Rule ${r.Rule_ID} skipped, invalid pattern:`, e.message); }
    }
    return rules;
  }

  // Classifies one imported row by its Action. Returns
  // { status: 'import'|'ignored'|'unrecognized', effect, type, category, sign, rule }.
  function classify(action, symbol, rules) {
    const act = String(action || '').trim();
    for (const r of rules) {
      if (r.Symbol_Required && !symbol) continue;
      if (!r.rx.test(act)) continue;
      if (r.Effect === 'Ignore') return { status: 'ignored', rule: r };
      let category = r.Category || 'Other';
      if (category === 'Asset') category = isOption(symbol) ? 'Option' : 'Equity';
      return { status: 'import', effect: r.Effect, type: EFFECT_TYPE[r.Effect] || 'Other',
               category, sign: r.Sign, rule: r };
    }
    return { status: 'unrecognized' };
  }

  // Cash impact of a transaction: the file's Amount when available, otherwise
  // -Quantity × Price (× 100 for options). Non-cash effects are always 0.
  function resolveAmount({ amount, quantity, price, effect, sign, symbol }) {
    if (NON_CASH_EFFECTS.includes(effect)) return 0;
    let a;
    if (amount != null && isFinite(amount)) a = amount;
    else if (effect !== 'Other' && isFinite(quantity) && isFinite(price))
      a = -quantity * price * (isOption(symbol) ? OPTION_MULTIPLIER : 1);
    else a = 0;
    if (sign) a = Math.sign(sign) * Math.abs(a);
    return _round2(a) || 0;
  }

  function hash(accountId, date, symbol, quantity, price, amount) {
    const key = [accountId, date, symbol || '', quantity ?? '', price ?? '', amount ?? ''].join('|');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
    return key + '_' + Math.abs(h).toString(36);
  }

  // ── Position arithmetic (VERSION_2.md, Ledger table) ─────────────────────
  // Returns the new { qty, cost } of a position after applying txn to (q, C).
  function nextPosition(q, C, txn) {
    const dq = txn.Quantity || 0;
    switch (txn.Effect) {
      case 'Trade':
      case 'Reinvestment': {
        const paid = -(txn.Amount || 0);                       // purchase cost incl. fees (negative for proceeds)
        if (Math.abs(q) < EPS || Math.sign(q) === Math.sign(dq)) {
          return { qty: _roundQ(q + dq), cost: _round2(C + paid) };   // open or add to a position
        }
        const newQ = _roundQ(q + dq);
        if (Math.abs(dq) <= Math.abs(q) + EPS) {                 // reduce: average cost, proportionally
          return { qty: newQ, cost: newQ === 0 ? 0 : _round2(C * newQ / q) };
        }
        // Crossing zero: the closing part removes the whole basis; the opening part starts
        // a new basis at the transaction's price (its pro-rata share of the Amount).
        const openFraction = Math.abs(newQ) / Math.abs(dq);
        const mult = isOption(txn.Symbol) ? OPTION_MULTIPLIER : 1;
        const opening = txn.Amount ? paid * openFraction : newQ * (txn.Price || 0) * mult;
        return { qty: newQ, cost: _round2(opening) };
      }
      case 'Distribution': return { qty: _roundQ(q + dq), cost: C };
      // Vested RSU shares: cost basis = quantity × the stock's closing price on the vesting date (stored as Price)
      case 'RSU':          return { qty: _roundQ(q + dq), cost: _round2(C + dq * (txn.Price || 0)) };
      case 'Split':        return { qty: _roundQ(dq), cost: C };
      case 'Snapshot': {   // Price is per unit; an option contract covers 100 units
        const mult = isOption(txn.Symbol) ? OPTION_MULTIPLIER : 1;
        return { qty: _roundQ(dq), cost: _round2(dq * (txn.Price || 0) * mult) };
      }
      default:             return { qty: q, cost: C };
    }
  }

  // Closing price of a symbol on a date (or the last close within RSU_PRICE_LOOKBACK_DAYS before it), or null
  function priceOn(symbol, date) {
    if (!symbol || !date) return null;
    const [y, m, d] = date.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, d - RSU_PRICE_LOOKBACK_DAYS)).toISOString().slice(0, 10);
    const r = DB.query('SELECT Price FROM Prices WHERE Symbol=? AND Valid=1 AND Date<=? AND Date>=? ORDER BY Date DESC LIMIT 1',
      [symbol, date, from])[0];
    return r ? r.Price : null;
  }

  const _affectsCash     = t => t.Type === 'Cash' || t.Type === 'Trade';
  const _affectsPosition = t => (t.Type === 'Trade' || t.Type === 'Record') && !!t.Symbol;
  const _table   = sym => isOption(sym) ? 'Options' : 'Ledger';
  const _idCol   = table => table === 'Options' ? 'Option_ID' : 'Holding_ID';

  function activeEntry(table, accountId, symbol) {
    return DB.query(`SELECT * FROM ${table} WHERE Account_ID=? AND Symbol=? AND Active=1`, [accountId, symbol])[0] || null;
  }

  function _entry(table, id) {
    return id == null ? null : DB.query(`SELECT * FROM ${table} WHERE ${_idCol(table)}=?`, [id])[0] || null;
  }

  // Marks `prev` (if any) inactive and inserts the new active entry linked to it.
  function supersede(table, accountId, symbol, prev, qty, cost, transactionId, currency) {
    if (prev) DB.run(`UPDATE ${table} SET Active=0 WHERE ${_idCol(table)}=?`, [prev[_idCol(table)]]);
    const ts = _nowTs();
    const cur = currency || prev?.Currency || 'USD';
    if (table === 'Options') {
      const o = parseOption(symbol);
      if (!o) throw new Error(`Invalid option symbol ${symbol}`);
      DB.run(`INSERT INTO Options (Parent_ID, Transaction_ID, Timestamp, Account_ID, Symbol, Asset, Expiration_Date, Strike,
              Quantity, Cost_Basis, Currency, Active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [prev ? prev.Option_ID : null, transactionId ?? null, ts, accountId, symbol, o.asset, o.expiration, o.strike,
         Math.round(qty), cost, cur]);
    } else {
      DB.run(`INSERT INTO Ledger (Parent_ID, Transaction_ID, Timestamp, Account_ID, Symbol, Quantity, Cost_Basis, Currency, Active)
              VALUES (?,?,?,?,?,?,?,?,1)`,
        [prev ? prev.Holding_ID : null, transactionId ?? null, ts, accountId, symbol, qty, cost, cur]);
    }
    return DB.query('SELECT last_insert_rowid() AS id')[0].id;
  }

  function adjustCash(accountId, delta) {
    if (!delta) return;
    DB.run('UPDATE Accounts SET Cash = ROUND(COALESCE(Cash, 0) + ?, 2), Last_Updated = ? WHERE Account_ID = ?',
      [delta, _nowTs(), accountId]);
  }

  // Applies a stored transaction's position effect on top of the pair's active entry
  // (or on top of `base` when given). Returns the new entry id or null.
  function _applyPosition(txn, base) {
    if (!_affectsPosition(txn)) return null;
    const table = _table(txn.Symbol);
    const prev  = activeEntry(table, txn.Account_ID, txn.Symbol);
    const from  = base !== undefined ? base : prev;
    const { qty, cost } = nextPosition(from ? from.Quantity : 0, from ? from.Cost_Basis : 0, txn);
    return supersede(table, txn.Account_ID, txn.Symbol, prev, qty, cost, txn.Transaction_ID, txn.Currency);
  }

  // ── Transactions ────────────────────────────────────────────────────────
  // Inserts a transaction (fields as in the Transactions table, Type derived from Effect)
  // and returns the stored row.
  function insertTransaction(t) {
    const type = t.Type || EFFECT_TYPE[t.Effect] || 'Other';
    const amount = t.Amount ?? 0;
    DB.run(`INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Price, Amount,
            Currency, Description, Hash, Timestamp, Valid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [t.Account_ID, t.Date, type, t.Category || 'Other', t.Effect, t.Symbol || null, t.Quantity ?? 0, t.Price ?? null,
       amount, t.Currency || 'USD', t.Description || '',
       t.Hash || hash(t.Account_ID, t.Date, t.Symbol, t.Quantity, t.Price, amount), _nowTs()]);
    const id = DB.query('SELECT last_insert_rowid() AS id')[0].id;
    return DB.query('SELECT * FROM Transactions WHERE Transaction_ID=?', [id])[0];
  }

  // Applies a stored transaction: Ledger/Options update and cash change.
  function applyTransaction(txn) {
    const entryId = _applyPosition(txn);
    if (_affectsCash(txn)) adjustCash(txn.Account_ID, txn.Amount);
    else if (entryId) DB.run('UPDATE Accounts SET Last_Updated=? WHERE Account_ID=?', [_nowTs(), txn.Account_ID]);
    return entryId;
  }

  // Inserts and applies a transaction in one step (imports, manual entry).
  function record(t) {
    const txn = insertTransaction(t);
    applyTransaction(txn);
    return txn;
  }

  // Edits a stored transaction (VERSION_2.md, Transactions table):
  // - if the active entry of the pair references it: rebuild the entry from its Parent + edited txn
  // - otherwise apply the edited transaction in full (warning returned)
  // - cash changes by the Amount delta.
  // `changes` holds the edited Transactions columns. Returns { warning }.
  function editTransaction(old, changes) {
    const e = { ...old, ...changes };
    e.Symbol = normalizeSymbol(e.Symbol) || null;
    e.Type = EFFECT_TYPE[e.Effect] || e.Type;
    e.Hash = hash(e.Account_ID, e.Date, e.Symbol, e.Quantity, e.Price, e.Amount);
    DB.run(`UPDATE Transactions SET Account_ID=?, Date=?, Type=?, Category=?, Effect=?, Symbol=?, Quantity=?, Price=?,
            Amount=?, Currency=?, Description=?, Hash=? WHERE Transaction_ID=?`,
      [e.Account_ID, e.Date, e.Type, e.Category, e.Effect, e.Symbol, e.Quantity, e.Price, e.Amount, e.Currency,
       e.Description, e.Hash, old.Transaction_ID]);

    // Cash: apply the delta (moving to another account reverses the old amount there)
    const oldCash = _affectsCash(old) ? (old.Amount || 0) : 0;
    const newCash = _affectsCash(e) ? (e.Amount || 0) : 0;
    if (String(old.Account_ID) === String(e.Account_ID)) adjustCash(e.Account_ID, _round2(newCash - oldCash));
    else { adjustCash(old.Account_ID, -oldCash); adjustCash(e.Account_ID, newCash); }

    let warning = false;
    const positionChanged = ['Account_ID', 'Symbol', 'Quantity', 'Price', 'Amount', 'Effect', 'Date']
      .some(k => String(old[k] ?? '') !== String(e[k] ?? ''));
    if (positionChanged && (_affectsPosition(old) || _affectsPosition(e))) {
      const samePair = String(old.Account_ID) === String(e.Account_ID) && old.Symbol === e.Symbol;
      const latest = old.Symbol ? activeEntry(_table(old.Symbol), old.Account_ID, old.Symbol) : null;
      if (samePair && latest && latest.Transaction_ID === old.Transaction_ID) {
        const table  = _table(e.Symbol);
        const parent = _entry(table, latest.Parent_ID);
        if (_affectsPosition(e)) _applyPosition(e, parent);
        else supersede(table, e.Account_ID, e.Symbol, latest, parent ? parent.Quantity : 0,
                       parent ? parent.Cost_Basis : 0, e.Transaction_ID, e.Currency);
      } else {
        warning = _affectsPosition(old);
        _applyPosition(e);
      }
    }
    return { warning };
  }

  // True if any Ledger or Options entry (active or inactive) references the transaction.
  function isReferenced(transactionId) {
    return DB.query(`SELECT (SELECT COUNT(*) FROM Ledger  WHERE Transaction_ID=?) +
                            (SELECT COUNT(*) FROM Options WHERE Transaction_ID=?) AS n`,
      [transactionId, transactionId])[0].n > 0;
  }

  // Invalidates a transaction and reverses its Amount on the cash balance.
  // Ledger/Options entries are not changed (the caller warns when isReferenced()).
  function deleteTransaction(txn) {
    DB.run('UPDATE Transactions SET Valid=0 WHERE Transaction_ID=?', [txn.Transaction_ID]);
    if (_affectsCash(txn)) adjustCash(txn.Account_ID, -(txn.Amount || 0));
  }

  // Rebuilds all Ledger and Options entries of an account by replaying its valid
  // transactions in chronological order. Manual edits are discarded.
  function rebuildAccount(accountId) {
    const txns = DB.query(`SELECT * FROM Transactions WHERE Account_ID=? AND Valid=1 AND Type IN ('Trade','Record')
                           AND Symbol IS NOT NULL AND Symbol <> '' ORDER BY Date, Transaction_ID`, [accountId]);
    const positions = new Map();   // symbol → { qty, cost, lastTxn, currency }
    for (const t of txns) {
      const p = positions.get(t.Symbol) || { qty: 0, cost: 0 };
      const n = nextPosition(p.qty, p.cost, t);
      positions.set(t.Symbol, { qty: n.qty, cost: n.cost, lastTxn: t.Transaction_ID, currency: t.Currency });
    }
    const counts = { ledger: 0, options: 0 };
    for (const table of ['Ledger', 'Options']) {
      const active = DB.query(`SELECT * FROM ${table} WHERE Account_ID=? AND Active=1`, [accountId]);
      const activeBySymbol = new Map(active.map(r => [r.Symbol, r]));
      const symbols = new Set([...active.map(r => r.Symbol),
                               ...[...positions.keys()].filter(s => _table(s) === table)]);
      for (const sym of symbols) {
        const prev = activeBySymbol.get(sym) || null;
        const p = positions.get(sym);
        if (!p) { DB.run(`UPDATE ${table} SET Active=0 WHERE ${_idCol(table)}=?`, [prev[_idCol(table)]]); continue; }
        if (!prev && p.qty === 0) continue;      // closed position that was already deactivated
        supersede(table, accountId, sym, prev, p.qty, p.cost, p.lastTxn, p.currency);
        counts[table === 'Ledger' ? 'ledger' : 'options']++;
      }
    }
    return counts;
  }

  // Import Holdings: the snapshot replaces the account's holdings and cash.
  // holdings: [{ symbol, quantity, costBasis, currency, description }]; cashTotal: number|null.
  function applySnapshot(accountId, date, holdings, cashTotal) {
    const inFile = new Set();
    let records = 0;
    for (const h of holdings) {
      const symbol = normalizeSymbol(h.symbol);
      if (!symbol || !isFinite(h.quantity)) continue;
      inFile.add(symbol);
      // Unit price: cost basis / units; an option contract covers 100 units. Kept exact so the cost is restored.
      const units = h.quantity * (isOption(symbol) ? OPTION_MULTIPLIER : 1);
      const price = units && isFinite(h.costBasis) ? h.costBasis / units : 0;
      record({
        Account_ID: accountId, Date: date, Effect: 'Snapshot', Category: isOption(symbol) ? 'Option' : 'Equity',
        Symbol: symbol, Quantity: h.quantity, Price: price, Amount: 0, Currency: h.currency || 'USD',
        Description: h.description ? `Account snapshot: ${h.description}` : 'Account snapshot'
      });
      records++;
    }
    let deactivated = 0;
    for (const table of ['Ledger', 'Options']) {
      for (const r of DB.query(`SELECT * FROM ${table} WHERE Account_ID=? AND Active=1`, [accountId])) {
        if (inFile.has(r.Symbol)) continue;
        DB.run(`UPDATE ${table} SET Active=0 WHERE ${_idCol(table)}=?`, [r[_idCol(table)]]);
        deactivated++;
      }
    }
    if (cashTotal != null) {
      const current = DB.query('SELECT COALESCE(Cash, 0) AS Cash FROM Accounts WHERE Account_ID=?', [accountId])[0]?.Cash || 0;
      record({ Account_ID: accountId, Date: date, Effect: 'Cash', Category: 'Other', Symbol: null, Quantity: 0,
               Price: null, Amount: _round2(cashTotal - current), Description: 'Opening cash balance' });
    }
    DB.run('UPDATE Accounts SET Last_Updated=? WHERE Account_ID=?', [_nowTs(), accountId]);
    return { records, deactivated };
  }

  return {
    EFFECT_TYPE, EFFECTS, CATEGORIES, OPTION_MULTIPLIER, RSU_PRICE_LOOKBACK_DAYS, priceOn,
    normalizeOption, normalizeSymbol, isOption, parseOption,
    loadRules, classify, resolveAmount, hash, nextPosition,
    activeEntry, supersede, adjustCash,
    insertTransaction, applyTransaction, record, editTransaction, isReferenced, deleteTransaction,
    rebuildAccount, applySnapshot
  };
})();

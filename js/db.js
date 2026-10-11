const DB = (() => {
  let _db = null;
  let _changeCount = 0;
  let _changeListener = null;
  let _txDepth = 0;

  function _notify() { if (_changeListener) _changeListener(); }

  // Thrown by loadFromBytes() when a file's schema version is not supported.
  // The currently loaded database is left untouched.
  class VersionError extends Error {
    constructor(message, version) {
      super(message);
      this.name = 'VersionError';
      this.version = version;
    }
  }

  // Compares dotted version strings numerically per part ('2.10' > '2.9').
  function _compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // Reads Info.Schema_Version; returns null for files without the Info table
  // (databases created before version 2.0) or with an unreadable version.
  function _readVersion(db) {
    try {
      const res = db.exec('SELECT Schema_Version FROM Info LIMIT 1');
      const v = res.length && res[0].values.length ? res[0].values[0][0] : null;
      return v && /^\d+(\.\d+)*$/.test(String(v)) ? String(v) : null;
    } catch { return null; }
  }

  function _checkVersion(db) {
    const v = _readVersion(db);
    if (!v || _compareVersions(v, SCHEMA_MIN_VERSION) < 0) {
      throw new VersionError(
        `This database was created by an earlier version of Portfolio (schema ${v || '1.x'}) ` +
        `and cannot be opened by this version, which requires schema ${SCHEMA_MIN_VERSION} or later.`, v);
    }
    if (_compareVersions(v, SCHEMA_VERSION) > 0) {
      throw new VersionError(
        `This database was created by a newer version of Portfolio (schema ${v}) ` +
        `and cannot be opened by this version, which supports schema ${SCHEMA_VERSION}.`, v);
    }
    // Upgrade step by step from the file's version to SCHEMA_VERSION
    let cur = v;
    while (_compareVersions(cur, SCHEMA_VERSION) < 0) {
      const step = UPGRADES[cur];
      if (!step) throw new VersionError(`No upgrade path from schema ${cur} to ${SCHEMA_VERSION}.`, v);
      cur = step(db);
      db.run('UPDATE Info SET Schema_Version = ?', [cur]);
    }
    return cur !== v ? v : null;   // the original version when the file was upgraded
  }

  const _hasColumn = (db, table, col) =>
    (db.exec(`PRAGMA table_info(${table})`)[0]?.values || []).some(r => r[1] === col);

  // Upgrade steps between 2.x schema versions, keyed by the source version; each returns the new version.
  const UPGRADES = {
    // 2.1: Ledger.Date — the date of the transaction that produced the entry (its reference transaction).
    // Entries without a (still existing) reference transaction, i.e. manual edits, get the date of their Timestamp.
    '2.0': db => {
      if (!_hasColumn(db, 'Ledger', 'Date')) db.run('ALTER TABLE Ledger ADD COLUMN Date TEXT');
      db.run(`UPDATE Ledger SET Date = (SELECT t.Date FROM Transactions t WHERE t.Transaction_ID = Ledger.Transaction_ID)
              WHERE Transaction_ID IS NOT NULL`);
      db.run('UPDATE Ledger SET Date = substr(Timestamp, 1, 10) WHERE Date IS NULL');
      return '2.1';
    },
    // 2.2: no schema change. Split/Distribution transactions keep the file's Amount as their cost basis
    // (Engine.nextPosition); the seeded rule descriptions that still describe the old handling are updated.
    '2.1': db => {
      const desc = [
        ["new shares distributed (e.g. spinoff); Amount is 0, quantity is added, cost basis is kept from the parent entry (0 for a new entry)",
         "new shares distributed (e.g. spinoff); quantity and Amount are added to the quantity and cost basis, no cash effect"],
        ["reverse split; the transaction quantity replaces the held quantity, cost basis is kept",
         "reverse split; the transaction quantity and Amount replace the held quantity and cost basis, no cash effect"],
      ];
      for (const [from, to] of desc) db.run('UPDATE Rules SET Description = ? WHERE Description = ?', [to, from]);
      return '2.2';
    },
    // 2.3: Balance table — cash balance history per account. Filled by replaying, per account in chronological
    // order (Date, Transaction_ID), every valid transaction that changes cash (Type Cash or Trade, Amount ≠ 0),
    // starting from 0. When the result differs from Accounts.Cash (manual cash edits in the Accounts view,
    // cash set before any transaction), a final record without a transaction (dated today) brings the
    // balance to Accounts.Cash, so the active record always equals the account's cash.
    '2.2': db => {
      db.run(SCHEMA_SQL);   // creates the Balance table (all statements are IF NOT EXISTS)
      db.run('DELETE FROM Balance');   // rebuilt from scratch
      const rows = sql => { const r = db.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
      const now = typeof _nowTs === 'function' ? _nowTs() : new Date().toISOString().slice(0, 19).replace('T', ' ');
      const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
      const txns = rows(`SELECT Transaction_ID, Account_ID, Date, Amount, Currency, Timestamp FROM Transactions
                         WHERE Valid = 1 AND Type IN ('Cash', 'Trade') AND COALESCE(Amount, 0) <> 0
                         ORDER BY Account_ID, Date, Transaction_ID`);
      const byAccount = new Map();
      for (const t of txns) (byAccount.get(t.Account_ID) || byAccount.set(t.Account_ID, []).get(t.Account_ID)).push(t);
      const insert = (parentId, txnId, date, ts, accountId, cash, currency) => {
        if (parentId != null) db.run('UPDATE Balance SET Active = 0 WHERE Balance_ID = ?', [parentId]);
        db.run(`INSERT INTO Balance (Parent_ID, Transaction_ID, Date, Timestamp, Account_ID, Cash, Currency, Active)
                VALUES (?,?,?,?,?,?,?,1)`, [parentId, txnId, date, ts || now, accountId, cash, currency || 'USD']);
        return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      };
      for (const acc of rows('SELECT Account_ID, COALESCE(Cash, 0) AS Cash, Currency FROM Accounts ORDER BY Account_ID')) {
        let parent = null, cash = 0;
        for (const t of byAccount.get(acc.Account_ID) || []) {
          cash = round2(cash + t.Amount);
          parent = insert(parent, t.Transaction_ID, t.Date, t.Timestamp, acc.Account_ID, cash, t.Currency || acc.Currency);
        }
        if (parent == null ? acc.Cash !== 0 : round2(acc.Cash) !== cash)
          insert(parent, null, now.slice(0, 10), now, acc.Account_ID, round2(acc.Cash), acc.Currency);
      }
      return '2.3';
    },
  };

  function createNew() {
    const db = new SQL.Database();
    db.run(SCHEMA_SQL);
    db.run('INSERT INTO Info (Schema_Version) VALUES (?)', [SCHEMA_VERSION]);
    RULES_SEED.forEach(r => db.run(
      `INSERT INTO Rules (Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect, Sign, Description, Active)
       VALUES (?,?,?,?,?,?,?,?,1)`, r));
    if (_db) _db.close();
    _db = db;
    _txDepth = 0;
    _changeCount = 0;
    _notify();
  }

  // Throws VersionError (and keeps the current database) if the file's schema is not supported.
  // Older 2.x files are upgraded in memory; returns { upgradedFrom } (null when no upgrade was needed).
  // An upgraded database counts as changed, so it is saved in the current schema.
  function loadFromBytes(bytes) {
    const db = new SQL.Database(bytes);
    let upgradedFrom;
    try {
      upgradedFrom = _checkVersion(db);
      db.run(SCHEMA_SQL);
    } catch (e) {
      db.close();
      throw e;
    }
    if (_db) _db.close();
    _db = db;
    _txDepth = 0;
    _changeCount = upgradedFrom ? 1 : 0;
    _notify();
    return { upgradedFrom };
  }

  function exportBytes() {
    return _db ? _db.export() : null;
  }

  // sql.js throws plain strings for some errors (e.g. "Wrong API use : tried to bind a value of an
  // unknown type (undefined)."): rethrow them as Errors so callers can show e.message.
  function _asError(e) { return e instanceof Error ? e : new Error(String(e)); }

  function query(sql, params) {
    if (!_db) throw new Error('No database loaded');
    let results;
    try { results = _db.exec(sql, params || []); } catch (e) { throw _asError(e); }
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
  }

  function run(sql, params) {
    if (!_db) throw new Error('No database loaded');
    try { _db.run(sql, params || []); } catch (e) { throw _asError(e); }
    _changeCount++;
    _notify();
  }

  // Runs fn (sync or async) atomically: all writes are committed together, or rolled
  // back if fn throws. Nested calls join the outermost transaction.
  async function transaction(fn) {
    if (!_db) throw new Error('No database loaded');
    if (_txDepth > 0) {
      _txDepth++;
      try { return await fn(); } finally { _txDepth--; }
    }
    const countBefore = _changeCount;
    _db.run('BEGIN');
    _txDepth = 1;
    try {
      const result = await fn();
      _db.run('COMMIT');
      return result;
    } catch (e) {
      _db.run('ROLLBACK');
      _changeCount = countBefore;
      _notify();
      throw e;
    } finally {
      _txDepth = 0;
    }
  }

  function setChangeListener(fn) { _changeListener = fn; }
  function getChangeCount() { return _changeCount; }
  function resetChangeCount() { _changeCount = 0; }
  function isLoaded() { return _db !== null; }

  return { createNew, loadFromBytes, exportBytes, query, run, transaction, VersionError,
           setChangeListener, getChangeCount, resetChangeCount, isLoaded };
})();

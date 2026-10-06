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
    // Upgrade steps between 2.x schema versions go here, keyed by the source version.
  }

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
  function loadFromBytes(bytes) {
    const db = new SQL.Database(bytes);
    try {
      _checkVersion(db);
      db.run(SCHEMA_SQL);
    } catch (e) {
      db.close();
      throw e;
    }
    if (_db) _db.close();
    _db = db;
    _txDepth = 0;
    _changeCount = 0;
    _notify();
  }

  function exportBytes() {
    return _db ? _db.export() : null;
  }

  function query(sql, params) {
    if (!_db) throw new Error('No database loaded');
    const results = _db.exec(sql, params || []);
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
    _db.run(sql, params || []);
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

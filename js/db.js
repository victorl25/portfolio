const DB = (() => {
  let _db = null;
  let _changeCount = 0;
  let _changeListener = null;

  function _notify() { if (_changeListener) _changeListener(); }

  function _migrate(db) {
    // Rename Date → Timestamp in Prices and Ledger for existing databases.
    // Silently ignored if columns are already renamed or tables don't exist yet.
    [
      'ALTER TABLE Prices RENAME COLUMN Date TO Timestamp',
      'ALTER TABLE Ledger RENAME COLUMN Date TO Timestamp',
      'ALTER TABLE Assets ADD COLUMN Notes TEXT',
      'ALTER TABLE Assets ADD COLUMN Theme TEXT',
      'ALTER TABLE Prices DROP COLUMN Type',
    ].forEach(sql => { try { db.run(sql); } catch {} });
  }

  function createNew() {
    if (_db) _db.close();
    _db = new SQL.Database();
    _db.run(SCHEMA_SQL);
    _changeCount = 0;
    _notify();
  }

  function loadFromBytes(bytes) {
    if (_db) _db.close();
    _db = new SQL.Database(bytes);
    _migrate(_db);
    _db.run(SCHEMA_SQL);
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

  function setChangeListener(fn) { _changeListener = fn; }
  function getChangeCount() { return _changeCount; }
  function resetChangeCount() { _changeCount = 0; }
  function isLoaded() { return _db !== null; }

  return { createNew, loadFromBytes, exportBytes, query, run, setChangeListener, getChangeCount, resetChangeCount, isLoaded };
})();

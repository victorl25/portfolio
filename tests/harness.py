# Test harness: runs the app's real js files in QuickJS, with a minimal sql.js stand-in
# (SQL.Database) backed by Python's sqlite3 — the same SQL engine sql.js compiles to WASM.
#
# Usage (from the repo root):
#   python tests/harness.py [pre:stub.js ...] [js/app-file.js ...] test_file.js [...]
#   - pre:<file>  stubs evaluated before the app scripts (path relative to tests/)
#   - js/<file>, lib/<file>  app scripts / libraries loaded after js/schema.js, js/db.js and js/engine.js, in the given order
#   - <file>      test scripts (path relative to tests/), run last; pending promise jobs are drained
#
# Requires the `quickjs` package: python -m pip install --target tests/.pylib quickjs
import json, os, sqlite3, sys

TESTS = os.path.dirname(os.path.abspath(__file__))
ROOT  = os.path.dirname(TESTS)
sys.path.insert(0, os.path.join(TESTS, '.pylib'))
try:
    import quickjs
except ImportError:
    sys.exit('quickjs is not installed: python -m pip install --target tests/.pylib quickjs')

_dbs = {}
_next = [0]

def _new_db():
    _next[0] += 1
    _dbs[_next[0]] = sqlite3.connect(':memory:', isolation_level=None)
    return _next[0]

def _exec(h, sql, params_json):
    c = _dbs[h]
    params = json.loads(params_json)
    try:
        if not params and sql.strip().count(';') > 1:      # multi-statement DDL (SCHEMA_SQL)
            c.executescript(sql)
            return json.dumps({'ok': []})
        cur = c.execute(sql, params)
        if cur.description is None:
            return json.dumps({'ok': []})
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        return json.dumps({'ok': [{'columns': cols, 'values': [list(r) for r in rows]}] if rows else []})
    except Exception as e:
        return json.dumps({'err': str(e)})

def _clone(h):
    # export(): a copy of the database, handed back to the constructor like sql.js bytes
    _next[0] += 1
    dst = sqlite3.connect(':memory:', isolation_level=None)
    _dbs[h].backup(dst)
    _dbs[_next[0]] = dst
    return _next[0]

def _open_file(path):
    # bytes of a .db file on disk (e.g. a v1 database), loaded into memory
    _next[0] += 1
    src = sqlite3.connect(path)
    dst = sqlite3.connect(':memory:', isolation_level=None)
    src.backup(dst)
    src.close()
    _dbs[_next[0]] = dst
    return _next[0]

def _close(h):
    _dbs.pop(h).close()
    return 0

def _read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()

def _exists(path):
    return os.path.exists(path)

def _list_dir(path):
    return json.dumps(sorted(os.listdir(path)) if os.path.isdir(path) else [])

ctx = quickjs.Context()
ctx.add_callable('__newDb', _new_db)
ctx.add_callable('__exec', _exec)
ctx.add_callable('__close', _close)
ctx.add_callable('__clone', _clone)
ctx.add_callable('__openFile', _open_file)
ctx.add_callable('__print', lambda s: print(s) or 0)
ctx.add_callable('__readFile', _read)
ctx.add_callable('__exists', _exists)
ctx.add_callable('__listDir', _list_dir)

ctx.eval('globalThis.__ROOT = ' + json.dumps(ROOT.replace('\\', '/')) + ';')
ctx.eval(r'''
globalThis.console = { log: (...a) => __print(a.map(String).join(' ')), warn: (...a) => __print('WARN ' + a.map(String).join(' ')) };
globalThis.SQL = { Database: class {
  // "bytes" are { __db: handle } objects from export() or __dbFile(path)
  constructor(bytes) { this.h = bytes ? __clone(bytes.__db) : __newDb(); }
  exec(sql, params) { const r = JSON.parse(__exec(this.h, sql, JSON.stringify(params || []))); if (r.err) throw new Error(r.err); return r.ok; }
  run(sql, params) { this.exec(sql, params); return this; }
  export() { return { __db: __clone(this.h) }; }
  close() { __close(this.h); }
}};
globalThis.__dbFile = path => ({ __db: __openFile(path) });
globalThis._nowTs = () => '2026-10-05 12:00:00';
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
globalThis.initSqlJs = () => ({ then: () => ({ catch: () => {} }) });   // app.js bootstraps sql.js at load time
let __fails = 0, __passes = 0, __skips = 0;
globalThis.ok = (cond, msg) => { if (cond) __passes++; else { __fails++; __print('FAIL ' + msg); } };
globalThis.eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
globalThis.skip = msg => { __skips++; __print('SKIP ' + msg); };
globalThis.__result = () => `${__passes} passed, ${__fails} failed` + (__skips ? `, ${__skips} skipped` : '');
''')

args = sys.argv[1:]
for pre in [a[4:] for a in args if a.startswith('pre:')]:
    ctx.eval(_read(os.path.join(TESTS, pre)))

for f in ['js/schema.js', 'js/db.js', 'js/engine.js'] + [a for a in args if a.startswith(('js/', 'lib/'))]:
    ctx.eval(_read(os.path.join(ROOT, f)))

for t in [a for a in args if not a.startswith(('js/', 'lib/', 'pre:'))]:
    ctx.eval(_read(os.path.join(TESTS, t)))
    while ctx.execute_pending_job():    # run async tests to completion
        pass

res = ctx.eval('__result()')
print(res)
sys.exit(0 if ' 0 failed' in res else 1)

# Static checks: every js/*.js file parses (QuickJS, not executed) and every SQL statement
# passed to DB.query / DB.run compiles against the v2 schema (EXPLAIN with dummy parameters).
# Usage (from the repo root): python tests/check_static.py
import glob, io, os, re, sqlite3, sys

TESTS = os.path.dirname(os.path.abspath(__file__))
ROOT  = os.path.dirname(TESTS)
sys.path.insert(0, os.path.join(TESTS, '.pylib'))
try:
    import quickjs
except ImportError:
    sys.exit('quickjs is not installed: python -m pip install --target tests/.pylib quickjs')

JS = sorted(glob.glob(os.path.join(ROOT, 'js', '*.js')))
fails = 0

ctx = quickjs.Context()
for f in JS:
    try:
        ctx.eval('(function(){\n' + io.open(f, encoding='utf-8').read() + '\n})')   # parse only
    except Exception as e:
        print('PARSE FAIL', os.path.basename(f), e); fails += 1

schema = re.search(r'const SCHEMA_SQL = `(.*?)`;', io.open(os.path.join(ROOT, 'js', 'schema.js'), encoding='utf-8').read(), re.S).group(1)
db = sqlite3.connect(':memory:')
db.executescript(schema)

# Interpolated SQL fragments replaced by neutral text; ${table}/${_idCol(table)} are tried for both tables
SUBS = {'${where}': '1=1', '${themeJoin}': '', '${accFilter}': '', '${acc}': '', '${inList}': 'AND Account_ID NOT IN (?)'}
TABLES = [('Ledger', 'Holding_ID'), ('Options', 'Option_ID')]
count = 0
for f in JS:
    src = io.open(f, encoding='utf-8').read()
    for m in re.finditer(r"DB\.(?:query|run)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')", src):
        sql = m.group(1)[1:-1]
        for k, v in SUBS.items():
            sql = sql.replace(k, v)
        # conditional fragments like ${accountId ? 'AND Account_ID = ?' : ''} -> the non-empty branch
        sql = re.sub(r"\$\{[^{}?]*\?\s*'([^']*)'\s*:\s*''\}", lambda g: g.group(1), sql)
        if sql.strip().upper() in ('BEGIN', 'COMMIT', 'ROLLBACK'):
            continue
        variants = [sql.replace('${table}', t).replace('${_idCol(table)}', i) for t, i in TABLES] if '${table}' in sql else [sql]
        for v in variants:
            if '${' in v:
                print('SKIP (unhandled interpolation)', os.path.basename(f), v.strip()[:60]); continue
            try:
                db.execute('EXPLAIN ' + v, [None] * v.count('?'))
                count += 1
            except Exception as e:
                line = src[:m.start()].count('\n') + 1
                print(f'SQL FAIL {os.path.basename(f)}:{line}: {e}\n   {v.strip()[:160]}'); fails += 1

print(f'{len(JS)} files parsed, {count} SQL statements compiled, {fails} failed')
sys.exit(1 if fails else 0)

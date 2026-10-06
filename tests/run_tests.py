# Runs all tests. Usage (from the repo root): python tests/run_tests.py
import os, subprocess, sys

TESTS = os.path.dirname(os.path.abspath(__file__))
APP_SCRIPTS = ['js/dialogs.js', 'js/import.js', 'js/tab-portfolio.js', 'js/tab-accounts.js', 'js/tab-assets.js',
               'js/tab-prices.js', 'js/tab-transactions.js', 'js/tab-ledger.js', 'js/tab-options.js', 'js/tab-rules.js',
               'js/tab-query.js', 'js/tab-reports.js', 'js/tab-analysis.js', 'js/app.js']   # index.html order

SUITES = [
    ('static checks',  ['check_static.py']),
    ('db',             ['harness.py', 'test_db.js']),
    ('engine',         ['harness.py', 'test_engine.js']),
    ('import',         ['harness.py', 'js/import.js', 'test_import.js']),
    ('update prices',  ['harness.py', 'pre:stubs_ui.js', 'js/app.js', 'test_prices.js']),
    ('script load',    ['harness.py', *APP_SCRIPTS, 'test_load.js']),
]

failed = []
for name, args in SUITES:
    r = subprocess.run([sys.executable, os.path.join(TESTS, args[0]), *args[1:]], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    print(f'-- {name}: ' + (out.splitlines()[-1] if out else ''))
    for line in out.splitlines()[:-1]:
        print('   ' + line)
    if r.returncode:
        failed.append(name)

print('\nALL PASSED' if not failed else f'\nFAILED: {", ".join(failed)}')
sys.exit(1 if failed else 0)

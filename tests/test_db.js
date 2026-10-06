// DB layer: new database contents, schema version check, transactions (js/db.js, js/schema.js)
DB.createNew();
eq(DB.query('SELECT Schema_Version AS v FROM Info').map(r => r.v), [SCHEMA_VERSION], 'new database has one Info row');
eq(SCHEMA_VERSION, '2.0', 'schema version');
eq(DB.query('SELECT COUNT(*) AS n FROM Rules WHERE Active=1')[0].n, RULES_SEED.length, 'rules seeded');
eq(RULES_SEED.length, 21, '21 seeded rules');
eq(DB.query('SELECT Rule_Order FROM Rules WHERE Symbol_Required=0 ORDER BY Rule_Order').map(r => r.Rule_Order),
   [10, 140, 150, 170, 180], 'Symbol_Required off only for journal, interest, deposit, withdrawal rules');
ok(DB.query('SELECT Pattern, Case_Sensitive FROM Rules').every(r => { try { new RegExp(r.Pattern, r.Case_Sensitive ? '' : 'i'); return true; } catch { return false; } }),
   'all seeded patterns compile');
const r45 = new RegExp(DB.query('SELECT Pattern FROM Rules WHERE Rule_Order=45')[0].Pattern);
ok(r45.test('REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)') && !r45.test('REINVESTMENT MICROSOFT CORP (MSFT) (Margin)'),
   'rule 45 matches money-market reinvestments only');
eq(DB.getChangeCount(), 0, 'new database has no unsaved changes');

const cols = t => DB.query(`PRAGMA table_info(${t})`).map(c => c.name);
ok(!cols('Assets').includes('Notes'), 'Assets has no Notes column');
eq(cols('Prices')[0], 'Date', 'Prices keyed by Date');

// Constraints and views
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('X1','A')");
DB.run("INSERT INTO Prices (Date, Symbol, Price) VALUES ('2026-10-01','AAPL',250),('2026-10-02','AAPL',255),('2026-10-03','AAPL',999)");
DB.run("UPDATE Prices SET Valid=0 WHERE Date='2026-10-03'");
eq(DB.query("SELECT Price FROM v_latest_price WHERE Symbol='AAPL'")[0].Price, 255, 'v_latest_price skips invalid prices');
let threw = false; try { DB.run("INSERT INTO Prices (Date, Symbol, Price) VALUES ('2026-10-01','AAPL',1)"); } catch { threw = true; }
ok(threw, 'one price per symbol and date');
DB.run("INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES ('t',1,'AAPL',10,2000),('t',1,'MSFT',0,0)");
threw = false; try { DB.run("INSERT INTO Ledger (Timestamp, Account_ID, Symbol, Quantity, Cost_Basis) VALUES ('t',1,'AAPL',5,1)"); } catch { threw = true; }
ok(threw, 'one active Ledger entry per account + symbol');
eq(DB.query('SELECT Symbol, Quantity FROM v_holdings'), [{ Symbol: 'AAPL', Quantity: 10 }], 'v_holdings excludes quantity 0');
DB.run("INSERT INTO Mappings (Header_Hash, Source, Target) VALUES ('h1','Price','Price ($)'),('h2','Price','Price')");
threw = false; try { DB.run("INSERT INTO Mappings (Header_Hash, Source, Target) VALUES ('h1','Price','x')"); } catch { threw = true; }
ok(threw, 'one mapping per Header_Hash + Source');

// Save / reload round trip
const bytes = DB.exportBytes();
DB.loadFromBytes(bytes);
eq([DB.query('SELECT COUNT(*) AS n FROM Accounts')[0].n, DB.getChangeCount()], [1, 0], 'a v2 file reloads');

// Version check: the current database is kept when a file is refused
const marker = () => DB.query('SELECT COUNT(*) AS n FROM Accounts')[0].n;
const refuse = (mutate, label, rx) => {
  const db = new SQL.Database(bytes); mutate(db);
  let err = null; try { DB.loadFromBytes(db.export()); } catch (e) { err = e; }
  ok(err && err.name === 'VersionError' && rx.test(err.message), `${label}: ${err && err.message}`);
  eq(marker(), 1, `${label}: current database kept`);
};
refuse(db => db.run('DROP TABLE Info'), 'database without Info (pre-2.0) refused', /earlier version/);
refuse(db => db.run("UPDATE Info SET Schema_Version='1.9'"), 'schema 1.9 refused', /earlier version/);
refuse(db => db.run("UPDATE Info SET Schema_Version='2.10'"), 'schema 2.10 refused as newer (numeric comparison)', /newer version/);
refuse(db => db.run("UPDATE Info SET Schema_Version='abc'"), 'unreadable version refused', /earlier version/);

// Real database files in data/ (not in the repo): pre-2.0 files must be refused, 2.0 files must open
const dbFiles = JSON.parse(__listDir(__ROOT + '/data')).filter(f => /\.db$/i.test(f));
if (!dbFiles.length) skip('no .db files in data/: real file version checks not run');
for (const f of dbFiles) {
  const probe = new SQL.Database(__dbFile(`${__ROOT}/data/${f}`));
  const hasInfo = probe.exec("SELECT name FROM sqlite_master WHERE name='Info'").length > 0;
  probe.close();
  let err = null; try { DB.loadFromBytes(__dbFile(`${__ROOT}/data/${f}`)); } catch (e) { err = e; }
  if (hasInfo) ok(!err, `${f} (v2) opens${err ? ': ' + err.message : ''}`);
  else { ok(err && err.name === 'VersionError', `${f} (pre-2.0) refused`); eq(marker(), 1, `current database kept after refusing ${f}`); }
  DB.loadFromBytes(bytes);   // back to the test database
}

// Transactions: commit, rollback (nested and async), change count restored
(async () => {
  const n0 = marker(), c0 = DB.getChangeCount();
  let msg = null;
  try {
    await DB.transaction(async () => {
      DB.run("INSERT INTO Accounts (Account, Name) VALUES ('X2','B')");
      await Promise.resolve();
      await DB.transaction(() => DB.run("INSERT INTO Accounts (Account, Name) VALUES ('X3','C')"));
      throw new Error('boom');
    });
  } catch (e) { msg = e.message; }
  eq([msg, marker(), DB.getChangeCount()], ['boom', n0, c0], 'rollback undoes nested and async writes');
  const r = await DB.transaction(() => { DB.run("INSERT INTO Accounts (Account, Name) VALUES ('X4','D')"); return 42; });
  eq([r, marker()], [42, n0 + 1], 'commit returns the result');
})();

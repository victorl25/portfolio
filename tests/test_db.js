// DB layer: new database contents, schema version check, transactions (js/db.js, js/schema.js)
DB.createNew();
eq(DB.query('SELECT Schema_Version AS v FROM Info').map(r => r.v), [SCHEMA_VERSION], 'new database has one Info row');
eq([SCHEMA_VERSION, SCHEMA_MIN_VERSION], ['2.3', '2.0'], 'schema version 2.3, files from 2.0 accepted');
eq(DB.query('SELECT COUNT(*) AS n FROM Rules WHERE Active=1')[0].n, RULES_SEED.length, 'rules seeded');
eq(RULES_SEED.length, 29, '29 seeded rules (from the latest database, incl. RSU rule 25)');
eq(DB.query('SELECT Rule_Order FROM Rules WHERE Symbol_Required=0 ORDER BY Rule_Order').map(r => r.Rule_Order),
   [10, 140, 150, 170, 180, 200, 210, 220, 230, 240, 250, 260], 'Symbol_Required off for journal, interest, deposit, withdrawal and the rules 200-260');
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
  if (hasInfo) {
    ok(!err, `${f} (v2) opens${err ? ': ' + err.message : ''}`);
    if (!err) {
      eq(DB.query('SELECT Schema_Version AS v FROM Info')[0].v, SCHEMA_VERSION, `${f} is at schema ${SCHEMA_VERSION} after opening`);
      eq(DB.query('SELECT COUNT(*) AS n FROM Ledger WHERE Date IS NULL')[0].n, 0, `${f}: every Ledger entry has a Date`);
      // active entries only: editing an earlier transaction with "update the transaction only" leaves the
      // inactive entry that references it unchanged (by design)
      eq(DB.query(`SELECT COUNT(*) AS n FROM Ledger l JOIN Transactions t ON t.Transaction_ID = l.Transaction_ID
                   WHERE l.Active = 1 AND l.Date <> t.Date`)[0].n, 0, `${f}: active Ledger dates match their reference transactions`);
    }
  }
  else { ok(err && err.name === 'VersionError', `${f} (pre-2.0) refused`); eq(marker(), 1, `current database kept after refusing ${f}`); }
  DB.loadFromBytes(bytes);   // back to the test database
}

// sql.js throws plain strings for some errors; DB.run / DB.query rethrow them as Errors with a message
let bindErr = null; try { DB.run('UPDATE Accounts SET Name=? WHERE Account_ID=1', [undefined]); } catch (e) { bindErr = e; }
ok(bindErr instanceof Error && /tried to bind a value of an unknown type/.test(bindErr.message), 'DB.run: string error -> Error: ' + (bindErr && bindErr.message));
bindErr = null; try { DB.query('SELECT ? AS v', [undefined]); } catch (e) { bindErr = e; }
ok(bindErr instanceof Error && !!bindErr.message, 'DB.query: string error -> Error');

// Upgrade 2.0 -> 2.1 (-> 2.3): Ledger.Date filled from the reference transactions (active and inactive entries)
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name) VALUES ('U1','Upgrade')");
const rec = (date, qty, amount) => Engine.record({ Account_ID: 1, Date: date, Effect: 'Trade', Category: 'Equity',
                                                 Symbol: 'AAPL', Quantity: qty, Price: 10, Amount: amount });
rec('2026-01-15', 100, -1000); rec('2026-03-20', -40, 480);
Engine.supersede('Ledger', 1, 'AAPL', Engine.activeEntry('Ledger', 1, 'AAPL'), 60, 600, null);   // manual edit
eq(DB.query('SELECT Date, Active, Transaction_ID IS NULL AS manual FROM Ledger ORDER BY Holding_ID'),
   [{ Date: '2026-01-15', Active: 0, manual: 0 }, { Date: '2026-03-20', Active: 0, manual: 0 }, { Date: _nowTs().slice(0, 10), Active: 1, manual: 1 }],
   'new entries are dated by their reference transaction (manual edit: today)');
const v20 = new SQL.Database(DB.exportBytes());
v20.run('DROP INDEX idx_ledger_date'); v20.run('ALTER TABLE Ledger DROP COLUMN Date');
v20.run("UPDATE Ledger SET Timestamp = '2026-05-05 10:00:00' WHERE Transaction_ID IS NULL");
v20.run("UPDATE Info SET Schema_Version = '2.0'");
const up = DB.loadFromBytes(v20.export());
eq([up.upgradedFrom, DB.query('SELECT Schema_Version AS v FROM Info')[0].v, DB.getChangeCount()], ['2.0', '2.3', 1],
   'a 2.0 file is upgraded to 2.3 (via 2.1, 2.2) on load and counts as changed');
eq(DB.query('SELECT Date FROM Ledger ORDER BY Holding_ID').map(r => r.Date), ['2026-01-15', '2026-03-20', '2026-05-05'],
   'upgrade fills Date from the reference transaction for all entries (incl. inactive); manual edits from their Timestamp');
ok(DB.query("SELECT name FROM sqlite_master WHERE name = 'idx_ledger_date'").length === 1, 'Ledger.Date index created');
const again = DB.loadFromBytes(DB.exportBytes());
eq([again.upgradedFrom, DB.getChangeCount()], [null, 0], 'a 2.3 file opens without an upgrade');

// Upgrade 2.1 -> 2.2: old seeded Split/Distribution rule descriptions updated, edited ones kept
const v21 = new SQL.Database(DB.exportBytes());
v21.run("UPDATE Info SET Schema_Version = '2.1'");
v21.run("UPDATE Rules SET Description = 'new shares distributed (e.g. spinoff); Amount is 0, quantity is added, cost basis is kept from the parent entry (0 for a new entry)' WHERE Rule_Order = 60");
v21.run("UPDATE Rules SET Description = 'my split rule' WHERE Rule_Order = 80");
const up21 = DB.loadFromBytes(v21.export());
eq([up21.upgradedFrom, DB.query('SELECT Schema_Version AS v FROM Info')[0].v, DB.getChangeCount()], ['2.1', '2.3', 1],
   'a 2.1 file is upgraded to 2.3 on load and counts as changed');
eq(DB.query('SELECT Description FROM Rules WHERE Rule_Order IN (60, 80) ORDER BY Rule_Order').map(r => r.Description),
   [RULES_SEED.find(r => r[0] === 60)[7], 'my split rule'], 'old seeded description updated, edited description kept');

// Upgrade 2.2 -> 2.3: Balance table filled by replaying the cash transactions per account in date order
DB.createNew();
DB.run("INSERT INTO Accounts (Account, Name, Cash) VALUES ('B1','Replay',0),('B2','Manual',0),('B3','No txns',0),('B4','Zero',0)");
const bt = (acc, date, type, amount, valid = 1) => DB.run(
  `INSERT INTO Transactions (Account_ID, Date, Type, Category, Effect, Symbol, Quantity, Amount, Currency, Timestamp, Valid)
   VALUES (?,?,?,'Other',?,NULL,0,?,'USD','2026-01-01 09:00:00',?)`, [acc, date, type, type === 'Record' ? 'Distribution' : type, amount, valid]);
bt(1, '2026-03-01', 'Trade', -400);       // inserted first, dated later
bt(1, '2026-01-10', 'Cash', 1000);
bt(1, '2026-02-01', 'Record', 5000);      // record: no cash effect
bt(1, '2026-02-15', 'Cash', 0);           // amount 0: no change
bt(1, '2026-02-20', 'Cash', 77, 0);       // deleted
bt(1, '2026-04-01', 'Other', 50);         // Other: no cash effect
bt(2, '2026-01-05', 'Cash', 200);
DB.run('UPDATE Accounts SET Cash = 600 WHERE Account_ID = 1');   // = replayed total
DB.run('UPDATE Accounts SET Cash = 250 WHERE Account_ID = 2');   // manual edit on top of the transactions
DB.run('UPDATE Accounts SET Cash = 30 WHERE Account_ID = 3');
const v22 = new SQL.Database(DB.exportBytes());
v22.run('DROP TABLE Balance'); v22.run("UPDATE Info SET Schema_Version = '2.2'");
const up22 = DB.loadFromBytes(v22.export());
eq([up22.upgradedFrom, DB.query('SELECT Schema_Version AS v FROM Info')[0].v, DB.getChangeCount()], ['2.2', '2.3', 1],
   'a 2.2 file is upgraded to 2.3 on load and counts as changed');
const bal = acc => DB.query('SELECT Balance_ID, Parent_ID, Transaction_ID, Date, Cash, Active FROM Balance WHERE Account_ID = ? ORDER BY Balance_ID', [acc]);
const b1 = bal(1);
eq(b1.map(r => [r.Date, r.Cash, r.Active]), [['2026-01-10', 1000, 0], ['2026-03-01', 600, 1]],
   'cash transactions replayed by date (Cash/Trade only, Amount <> 0, valid), last record active');
eq([b1[0].Parent_ID, b1[1].Parent_ID, b1.every(r => r.Transaction_ID != null)], [null, b1[0].Balance_ID, true],
   'records chained by Parent_ID and linked to their transactions');
const today = _nowTs().slice(0, 10);
eq(bal(2).map(r => [r.Date, r.Cash, r.Active, r.Transaction_ID]), [['2026-01-05', 200, 0, bal(2)[0].Transaction_ID], [today, 250, 1, null]],
   'Accounts.Cash differs from the replay: final adjustment record (no transaction, today)');
eq([bal(3).map(r => [r.Cash, r.Transaction_ID]), bal(4).length], [[[30, null]], 0], 'cash without transactions: one record; zero cash: none');
eq(DB.query('SELECT COUNT(*) AS n FROM Accounts a JOIN Balance b ON b.Account_ID = a.Account_ID AND b.Active = 1 WHERE b.Cash <> a.Cash')[0].n, 0,
   'active Balance record = Accounts.Cash for every account');
DB.loadFromBytes(bytes);   // back to the earlier test database

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

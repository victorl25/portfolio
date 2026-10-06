// Database schema version written to Info.Schema_Version. Files with an older
// (pre-2.0) or newer schema are refused by DB.loadFromBytes().
const SCHEMA_VERSION = '2.0';
const SCHEMA_MIN_VERSION = '2.0';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS Info (
    Schema_Version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS Accounts (
    Account_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
    Account      TEXT    NOT NULL,
    Name         TEXT    NOT NULL,
    Cash         REAL    DEFAULT 0,
    Last_Updated TEXT,
    Currency     TEXT    DEFAULT 'USD',
    Active       INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS Assets (
    Symbol      TEXT PRIMARY KEY,
    Description TEXT,
    Type        TEXT,
    Category    TEXT,
    Theme       TEXT,
    Active      INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS Notes (
    Note_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
    Symbol    TEXT NOT NULL,
    Timestamp TEXT NOT NULL,
    Note      TEXT,
    FOREIGN KEY (Symbol) REFERENCES Assets(Symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_symbol ON Notes(Symbol);
  CREATE TABLE IF NOT EXISTS Prices (
    Date     TEXT    NOT NULL,
    Symbol   TEXT    NOT NULL,
    Price    REAL    NOT NULL,
    Currency TEXT    DEFAULT 'USD',
    Valid    INTEGER DEFAULT 1,
    UNIQUE (Symbol, Date),
    FOREIGN KEY (Symbol) REFERENCES Assets(Symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_prices_date ON Prices(Date);
  CREATE TABLE IF NOT EXISTS Transactions (
    Transaction_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Account_ID     INTEGER NOT NULL,
    Date           TEXT    NOT NULL,
    Type           TEXT    NOT NULL,
    Category       TEXT    NOT NULL,
    Effect         TEXT    NOT NULL,
    Symbol         TEXT,
    Quantity       REAL    DEFAULT 0,
    Price          REAL,
    Amount         REAL    DEFAULT 0,
    Currency       TEXT    DEFAULT 'USD',
    Description    TEXT,
    Hash           TEXT,
    Timestamp      TEXT    NOT NULL,
    Valid          INTEGER DEFAULT 1,
    FOREIGN KEY (Account_ID) REFERENCES Accounts(Account_ID)
  );
  CREATE INDEX IF NOT EXISTS idx_txn_account   ON Transactions(Account_ID);
  CREATE INDEX IF NOT EXISTS idx_txn_date      ON Transactions(Date);
  CREATE INDEX IF NOT EXISTS idx_txn_hash      ON Transactions(Hash);
  CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON Transactions(Timestamp);
  CREATE TABLE IF NOT EXISTS Ledger (
    Holding_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
    Parent_ID      INTEGER,
    Transaction_ID INTEGER,
    Timestamp      TEXT    NOT NULL,
    Account_ID     INTEGER NOT NULL,
    Symbol         TEXT    NOT NULL,
    Quantity       REAL    NOT NULL,
    Cost_Basis     REAL    NOT NULL,
    Currency       TEXT    DEFAULT 'USD',
    Active         INTEGER DEFAULT 1,
    FOREIGN KEY (Parent_ID)      REFERENCES Ledger(Holding_ID),
    FOREIGN KEY (Transaction_ID) REFERENCES Transactions(Transaction_ID),
    FOREIGN KEY (Account_ID)     REFERENCES Accounts(Account_ID)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_active ON Ledger(Account_ID, Symbol) WHERE Active = 1;
  CREATE INDEX IF NOT EXISTS idx_ledger_timestamp   ON Ledger(Timestamp);
  CREATE INDEX IF NOT EXISTS idx_ledger_account_id  ON Ledger(Account_ID);
  CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON Ledger(Transaction_ID);
  CREATE TABLE IF NOT EXISTS Options (
    Option_ID       INTEGER PRIMARY KEY AUTOINCREMENT,
    Parent_ID       INTEGER,
    Transaction_ID  INTEGER,
    Timestamp       TEXT    NOT NULL,
    Account_ID      INTEGER NOT NULL,
    Symbol          TEXT    NOT NULL,
    Asset           TEXT    NOT NULL,
    Expiration_Date TEXT    NOT NULL,
    Strike          REAL    NOT NULL,
    Quantity        INTEGER NOT NULL,
    Cost_Basis      REAL    NOT NULL,
    Currency        TEXT    DEFAULT 'USD',
    Active          INTEGER DEFAULT 1,
    FOREIGN KEY (Parent_ID)      REFERENCES Options(Option_ID),
    FOREIGN KEY (Transaction_ID) REFERENCES Transactions(Transaction_ID),
    FOREIGN KEY (Account_ID)     REFERENCES Accounts(Account_ID)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_options_active ON Options(Account_ID, Symbol) WHERE Active = 1;
  CREATE INDEX IF NOT EXISTS idx_options_account     ON Options(Account_ID);
  CREATE INDEX IF NOT EXISTS idx_options_transaction ON Options(Transaction_ID);
  CREATE INDEX IF NOT EXISTS idx_options_expiration  ON Options(Expiration_Date);
  CREATE TABLE IF NOT EXISTS Mappings (
    Mapping_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
    Header_Hash TEXT NOT NULL,
    Source      TEXT NOT NULL,
    Target      TEXT,
    Pattern     TEXT,
    UNIQUE (Header_Hash, Source)
  );
  CREATE TABLE IF NOT EXISTS Rules (
    Rule_ID         INTEGER PRIMARY KEY AUTOINCREMENT,
    Rule_Order      INTEGER NOT NULL,
    Pattern         TEXT    NOT NULL,
    Case_Sensitive  INTEGER DEFAULT 1,
    Symbol_Required INTEGER DEFAULT 1,
    Category        TEXT,
    Effect          TEXT    NOT NULL,
    Sign            INTEGER,
    Description     TEXT,
    Active          INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_rules_order ON Rules(Rule_Order);

  -- Latest valid price per symbol
  CREATE VIEW IF NOT EXISTS v_latest_price AS
    SELECT p.Symbol, p.Price, p.Date
    FROM Prices p
    JOIN (SELECT Symbol, MAX(Date) AS Date FROM Prices WHERE Valid = 1 GROUP BY Symbol) m
      ON m.Symbol = p.Symbol AND m.Date = p.Date
    WHERE p.Valid = 1;

  -- Current holdings per symbol across all accounts (active Ledger entries, zero quantities excluded)
  CREATE VIEW IF NOT EXISTS v_holdings AS
    SELECT Symbol, SUM(Quantity) AS Quantity, SUM(Cost_Basis) AS Cost_Basis
    FROM Ledger
    WHERE Active = 1 AND Quantity <> 0
    GROUP BY Symbol;
`;

// Import rules inserted into a new database (see VERSION_2.md, Rules table).
// [Rule_Order, Pattern, Case_Sensitive, Symbol_Required, Category, Effect, Sign, Description]
const RULES_SEED = [
  [10,  '^(JOURNALED)',                                    1, 0, 'Other',    'Ignore',       null, 'journaling transactions'],
  [20,  '^(DIVIDEND)',                                     1, 1, 'Dividend', 'Cash',         null, 'cash dividend'],
  [30,  '^(YOU BOUGHT)',                                   1, 1, 'Asset',    'Trade',        null, 'equity/option purchase'],
  [40,  '^(YOU SOLD)',                                     1, 1, 'Asset',    'Trade',        null, 'equity/option sale'],
  [45,  '^(REINVESTMENT).*\\((SPAXX|FDRXX|FZFXX|SWVXX)\\)', 1, 1, 'Other',    'Other',        null, 'reinvestment into a cash-like money market fund, recorded only'],
  [50,  '^(REINVESTMENT)',                                 1, 1, 'Asset',    'Reinvestment', null, 'reinvestment transactions'],
  [60,  '^(DISTRIBUTION)',                                 1, 1, 'Asset',    'Distribution', null, 'new shares distributed (e.g. spinoff); Amount is 0, quantity is added, cost basis is kept from the parent entry (0 for a new entry)'],
  [70,  '^(EXPIRED)',                                      1, 1, 'Other',    'Other',        null, 'expired options, the expiration date already provides the necessary info'],
  [80,  '^(REVERSE SPLIT)',                                1, 1, 'Asset',    'Split',        null, 'reverse split; the transaction quantity replaces the held quantity, cost basis is kept'],
  [90,  '^(MERGER)',                                       1, 1, 'Asset',    'Merger',       null, 'merger, a new asset symbol is likely but the cost basis could be tricky'],
  [100, '^(Buy)',                                          1, 1, 'Asset',    'Trade',        null, 'equity/option purchase'],
  [110, '^(Sell)',                                         1, 1, 'Asset',    'Trade',        null, 'equity/option sale'],
  [112, '^(ASSIGNED)',                                     1, 1, 'Asset',    'Other',        null, 'option assignment, recorded only; the resulting share sale is reported separately (e.g. YOU SOLD)'],
  [114, '^(EXERCISED)',                                    1, 1, 'Asset',    'Other',        null, 'option exercise, recorded only; the resulting share purchase is reported separately (e.g. YOU BOUGHT)'],
  [120, '^(.+)(Dividend)',                                 1, 1, 'Dividend', 'Cash',         null, 'cash dividend'],
  [130, '^(ADR Mgmt Fee)',                                 1, 1, 'Fee',      'Cash',         null, 'ADR management fee'],
  [140, '^(Margin Interest)',                              1, 0, 'Margin',   'Cash',         null, 'margin interest'],
  [150, '^(Credit Interest)',                              1, 0, 'Interest', 'Cash',         null, 'cash interest'],
  [160, '^(FOREIGN TAX)',                                  1, 1, 'Tax',      'Cash',         -1,   'foreign tax withheld from dividends'],
  [170, '^(Deposit)',                                      0, 0, 'Transfer', 'Cash',         1,    'cash deposit into the account'],
  [180, '^(Withdrawal)',                                   0, 0, 'Transfer', 'Cash',         -1,   'cash withdrawal from the account'],
];

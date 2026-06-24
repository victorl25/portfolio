const SCHEMA_SQL = `
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
    Notes       TEXT,
    Active      INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS Prices (
    Timestamp TEXT    NOT NULL,
    Symbol    TEXT    NOT NULL,
    Type      TEXT,
    Price     REAL    NOT NULL,
    Currency  TEXT    DEFAULT 'USD',
    Valid     INTEGER DEFAULT 1,
    FOREIGN KEY (Symbol) REFERENCES Assets(Symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_prices_timestamp ON Prices(Timestamp);
  CREATE INDEX IF NOT EXISTS idx_prices_symbol    ON Prices(Symbol);
  CREATE TABLE IF NOT EXISTS Ledger (
    Transaction_Hash TEXT PRIMARY KEY,
    Timestamp        TEXT    NOT NULL,
    Account_ID       INTEGER NOT NULL,
    Symbol           TEXT    NOT NULL,
    Quantity         REAL    NOT NULL,
    Price            REAL    NOT NULL,
    Currency         TEXT    DEFAULT 'USD',
    Valid            INTEGER DEFAULT 1,
    FOREIGN KEY (Account_ID) REFERENCES Accounts(Account_ID),
    FOREIGN KEY (Symbol)     REFERENCES Assets(Symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_timestamp  ON Ledger(Timestamp);
  CREATE INDEX IF NOT EXISTS idx_ledger_account_id ON Ledger(Account_ID);
  CREATE INDEX IF NOT EXISTS idx_ledger_symbol     ON Ledger(Symbol);
  CREATE TABLE IF NOT EXISTS Mappings (
    Mapping_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Source     TEXT NOT NULL UNIQUE,
    Target     TEXT,
    Pattern    TEXT
  );
`;

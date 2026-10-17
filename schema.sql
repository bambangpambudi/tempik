CREATE TABLE IF NOT EXISTS inboxes (
  address TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  inbox_address TEXT,
  from_address TEXT,
  subject TEXT,
  body TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(inbox_address) REFERENCES inboxes(address)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_inboxes (
  session_id TEXT,
  inbox_address TEXT,
  PRIMARY KEY(session_id, inbox_address)
);

CREATE TABLE IF NOT EXISTS telegram_inboxes (
  chat_id TEXT,
  inbox_address TEXT,
  PRIMARY KEY(chat_id, inbox_address)
);

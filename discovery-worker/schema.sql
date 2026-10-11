CREATE TABLE IF NOT EXISTS seen (
  issue_id   INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT,
  amount     TEXT,
  created_at TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  notified   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_seen_first_seen ON seen(first_seen);

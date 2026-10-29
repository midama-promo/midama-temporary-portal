PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('admin','client')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  primary_artist TEXT NOT NULL,
  release_type TEXT NOT NULL DEFAULT 'Single',
  release_date TEXT,
  genre TEXT,
  explicit INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Approved','Denied','Delivered','Corrections required')),
  admin_notes TEXT NOT NULL DEFAULT '',
  royalty_amount REAL NOT NULL DEFAULT 0,
  artwork_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist_credits TEXT NOT NULL DEFAULT '',
  audio_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','In progress','Resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_releases_user ON releases(user_id);
CREATE INDEX IF NOT EXISTS idx_tracks_release ON tracks(release_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);

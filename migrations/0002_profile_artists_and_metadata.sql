-- Additive migration only. Existing rows and objects are preserved.
ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN surname TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN primary_artist_name TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN presave_url TEXT;
ALTER TABLE releases ADD COLUMN rights_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE releases ADD COLUMN featured_artists TEXT NOT NULL DEFAULT '[]';
ALTER TABLE releases ADD COLUMN spotify_profiles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE releases ADD COLUMN apple_profiles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tracks ADD COLUMN composers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tracks ADD COLUMN featured_artists TEXT NOT NULL DEFAULT '[]';
ALTER TABLE otp_codes ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE otp_codes ADD COLUMN surname TEXT NOT NULL DEFAULT '';
ALTER TABLE otp_codes ADD COLUMN primary_artist_name TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_name TEXT NOT NULL,
  spotify_url TEXT,
  apple_music_url TEXT,
  spotify_creation_requested INTEGER NOT NULL DEFAULT 0,
  apple_creation_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, artist_name)
);
CREATE INDEX IF NOT EXISTS idx_artists_user ON artists(user_id);
CREATE TABLE IF NOT EXISTS release_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON release_drafts(user_id);
CREATE TABLE IF NOT EXISTS admin_access_audit (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  client_user_id TEXT NOT NULL REFERENCES users(id),
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE releases ADD COLUMN spotify_creation_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE releases ADD COLUMN apple_creation_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN spotify_profile_url TEXT;
ALTER TABLE tracks ADD COLUMN apple_music_profile_url TEXT;
ALTER TABLE tracks ADD COLUMN spotify_creation_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN apple_creation_requested INTEGER NOT NULL DEFAULT 0;

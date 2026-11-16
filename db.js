const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'watch-night.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plex_titles (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, year INTEGER,
    summary TEXT, poster TEXT, rating TEXT, genres TEXT NOT NULL DEFAULT '[]',
    section_id TEXT
  );
  CREATE TABLE IF NOT EXISTS shortlist (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
    title TEXT NOT NULL, type TEXT NOT NULL, year INTEGER, poster TEXT,
    UNIQUE(source, source_id)
  );
  CREATE TABLE IF NOT EXISTS ballots (
    voter TEXT PRIMARY KEY COLLATE NOCASE, ranks TEXT NOT NULL,
    approvals TEXT NOT NULL, vetoes TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`);

module.exports = db;

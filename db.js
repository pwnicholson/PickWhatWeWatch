const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const legacyDataDir = path.join(__dirname, 'data');
const dataDir = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PickWhatWeWatch')
  : legacyDataDir;
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'watch-night.sqlite');
const legacyDbPath = path.join(legacyDataDir, 'watch-night.sqlite');
if (path.resolve(dbPath) !== path.resolve(legacyDbPath) &&
    !fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  for (const suffix of ['-shm', '-wal', '-journal']) {
    const destination = `${dbPath}${suffix}`;
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
  }
  for (const suffix of ['-wal', '-journal', '']) {
    const source = `${legacyDbPath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const destination = `${dbPath}${suffix}`;
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(destination).mode | 0o600);
  }
  console.log(`Migrated SQLite data to ${dbPath}`);
}

for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
  if (!fs.existsSync(filePath)) continue;
  const mode = fs.statSync(filePath).mode;
  if ((mode & 0o222) === 0) {
    try {
      fs.chmodSync(filePath, mode | 0o600);
    } catch (error) {
      throw new Error(`SQLite file is read-only and could not be made writable: ${filePath}`, { cause: error });
    }
  }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plex_titles (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, year INTEGER,
    summary TEXT, poster TEXT, rating TEXT, audience_rating REAL, duration_mins INTEGER,
    genres TEXT NOT NULL DEFAULT '[]',
    section_id TEXT, cast_top2 TEXT NOT NULL DEFAULT '[]', director TEXT
  );
  CREATE TABLE IF NOT EXISTS shortlist (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
    title TEXT NOT NULL, type TEXT NOT NULL, year INTEGER, poster TEXT,
    genres TEXT NOT NULL DEFAULT '[]', cast_top2 TEXT NOT NULL DEFAULT '[]',
    director TEXT, summary TEXT, content_rating TEXT,
    metacritic_score TEXT, imdb_rating TEXT, rt_score TEXT,
    imdb_id TEXT, imdb_top250_rank INTEGER, providers TEXT NOT NULL DEFAULT '[]',
    runtime_mins INTEGER, tmdb_vote_average REAL, tmdb_vote_count INTEGER,
    UNIQUE(source, source_id)
  );
  CREATE TABLE IF NOT EXISTS ballots (
    voter TEXT PRIMARY KEY COLLATE NOCASE, ranks TEXT NOT NULL,
    approvals TEXT NOT NULL, vetoes TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS round1_votes (
    voter_name TEXT NOT NULL COLLATE NOCASE, item_id TEXT NOT NULL,
    vote INTEGER NOT NULL CHECK (vote IN (0, 1)), updated_at TEXT NOT NULL,
    UNIQUE (voter_name, item_id)
  );
`);

function addMissingColumns(table, columns) {
  const existing = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

addMissingColumns('plex_titles', {
  labels: "TEXT NOT NULL DEFAULT '[]'",
  cast_top2: "TEXT NOT NULL DEFAULT '[]'",
  director: 'TEXT',
  audience_rating: 'REAL',
  duration_mins: 'INTEGER'
});
addMissingColumns('shortlist', {
  genres: "TEXT NOT NULL DEFAULT '[]'",
  cast_top2: "TEXT NOT NULL DEFAULT '[]'",
  director: 'TEXT',
  summary: 'TEXT',
  content_rating: 'TEXT',
  metacritic_score: 'TEXT',
  imdb_rating: 'TEXT',
  rt_score: 'TEXT',
  imdb_id: 'TEXT',
  imdb_top250_rank: 'INTEGER',
  providers: "TEXT NOT NULL DEFAULT '[]'",
  runtime_mins: 'INTEGER',
  tmdb_vote_average: 'REAL',
  tmdb_vote_count: 'INTEGER'
});

module.exports = db;

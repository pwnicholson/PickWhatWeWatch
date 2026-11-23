const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const legacyDataDir = path.join(__dirname, 'data');
const dataDir = process.env.DATA_DIR || legacyDataDir;
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'watch-night.sqlite');
const oldWindowsDataDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'PickWhatWeWatch'
);
const legacyDbPaths = [
  ...(process.platform === 'win32' ? [path.join(oldWindowsDataDir, 'watch-night.sqlite')] : []),
  path.join(legacyDataDir, 'watch-night.sqlite')
];
const legacyDbPath = legacyDbPaths.find(candidate =>
  path.resolve(dbPath) !== path.resolve(candidate) && !fs.existsSync(dbPath) && fs.existsSync(candidate));
if (legacyDbPath) {
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
const hasSettingsTable = Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
).get());
const twoRoundPoolMigrated = hasSettingsTable &&
  db.prepare("SELECT value FROM settings WHERE key='two_round_pool_migrated'").get()?.value === 'true';
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
  CREATE TABLE IF NOT EXISTS two_round_pool (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
    title TEXT NOT NULL, type TEXT NOT NULL, year INTEGER, poster TEXT,
    genres TEXT NOT NULL DEFAULT '[]', cast_top2 TEXT NOT NULL DEFAULT '[]',
    director TEXT, summary TEXT, content_rating TEXT,
    metacritic_score TEXT, imdb_rating TEXT, rt_score TEXT,
    imdb_id TEXT, imdb_top250_rank INTEGER, providers TEXT NOT NULL DEFAULT '[]',
    runtime_mins INTEGER, tmdb_vote_average REAL, tmdb_vote_count INTEGER,
    is_finalist INTEGER NOT NULL DEFAULT 0 CHECK (is_finalist IN (0, 1)),
    UNIQUE(source, source_id)
  );
  CREATE TABLE IF NOT EXISTS saved_shortlists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_shortlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_shortlist_id TEXT NOT NULL REFERENCES saved_shortlists(id) ON DELETE CASCADE,
    source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
    year INTEGER, poster TEXT, genres TEXT NOT NULL DEFAULT '[]', cast_top2 TEXT NOT NULL DEFAULT '[]',
    director TEXT, summary TEXT, content_rating TEXT, metacritic_score TEXT, imdb_rating TEXT,
    rt_score TEXT, imdb_id TEXT, imdb_top250_rank INTEGER, providers TEXT NOT NULL DEFAULT '[]',
    runtime_mins INTEGER, tmdb_vote_average REAL, tmdb_vote_count INTEGER,
    UNIQUE(saved_shortlist_id, source, source_id)
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
addMissingColumns('two_round_pool', {
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
  tmdb_vote_count: 'INTEGER',
  is_finalist: 'INTEGER NOT NULL DEFAULT 0'
});

if (!twoRoundPoolMigrated) {
  db.transaction(() => {
    const mode = db.prepare("SELECT value FROM settings WHERE key='voting_mode'").get()?.value;
    const stage = db.prepare("SELECT value FROM settings WHERE key='round_stage'").get()?.value;
    const shortlistLimit = Number(db.prepare(
      "SELECT value FROM settings WHERE key='shortlist_max_size'"
    ).get()?.value) || 20;
    const copyToPool = db.prepare(`INSERT OR IGNORE INTO two_round_pool
      (id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
        metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
        tmdb_vote_average,tmdb_vote_count,is_finalist)
      SELECT id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
        metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
        tmdb_vote_average,tmdb_vote_count,?
      FROM shortlist`);
    if (mode === 'two_round') {
      copyToPool.run(stage === 'round2' ? 1 : 0);
      db.prepare('DELETE FROM shortlist').run();
    } else {
      const count = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
      if (count > shortlistLimit) {
        db.prepare(`INSERT OR IGNORE INTO two_round_pool
          (id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
            metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
            tmdb_vote_average,tmdb_vote_count,is_finalist)
          SELECT id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
            metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
            tmdb_vote_average,tmdb_vote_count,0
          FROM shortlist ORDER BY rowid LIMIT -1 OFFSET ?`).run(shortlistLimit);
        db.prepare(`DELETE FROM shortlist WHERE id IN (
          SELECT id FROM shortlist ORDER BY rowid LIMIT -1 OFFSET ?
        )`).run(shortlistLimit);
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('two_round_pool_migrated','true')").run();
  })();
}

module.exports = db;

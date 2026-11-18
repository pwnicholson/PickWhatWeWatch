require('dotenv').config(process.env.PWW_ENV_PATH ? { path: process.env.PWW_ENV_PATH } : {});
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { createPin, getLabels, getLibraries, getSyncStats, plexServers, pollPin, syncLibraries } = require('./plex');
const { enrichShortlist } = require('./metadata');
const { isAllowedByRating, needsCertification } = require('./ratings');
const { matchesActiveFilters } = require('./public/shortlist-filters');
const tmdb = require('./tmdb');
const {
  fillGenres, fillEras, mapLimit, plexFillCandidates, sameTitle, shuffle, tmdbFillCandidates,
  qualifyPlexCandidates
} = require('./shortlist-fill');

if (!process.env.ADMIN_PIN || !process.env.SESSION_SECRET) {
  throw new Error('Set ADMIN_PIN and SESSION_SECRET in your .env file.');
}

const app = express();
const port = Number(process.env.PORT) || 3000;
const providers = tmdb.providerOptions;

app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'watch-night-admin',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
}));

function getSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

for (const [key, value] of Object.entries({
  shortlist_max_size: '20',
  max_movie_rating: 'ALL',
  include_unrated_movies: 'true',
  max_tv_rating: 'ALL',
  include_unrated_tv: 'true',
  allow_guest_additions: 'true',
  media_type_filter: 'both',
  voting_mode: 'standard',
  round_stage: 'round1',
  finalists_count: '10',
  round1_id: ''
})) {
  db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, value);
}
db.prepare("DELETE FROM settings WHERE key='voting_closed'").run();

function shortlistMaxSize() {
  const size = Number(getSetting('shortlist_max_size', '20'));
  return Number.isInteger(size) && size >= 3 && size <= 100 ? size : 20;
}

function mediaTypeAllowed(type, filter = getSetting('media_type_filter', 'both')) {
  return filter === 'both' || (filter === 'movies' && type === 'movie') || (filter === 'tv' && type === 'tv');
}

function mediaTypeWhere(filter, column = 'type') {
  if (filter === 'movies') return `${column}='movie'`;
  if (filter === 'tv') return `${column}='tv'`;
  return '1=1';
}

function activeFilterSettings(settings = config()) {
  return { ...settings, ...roundState().roundFillOptions };
}

function roundState() {
  const mode = getSetting('voting_mode', 'standard');
  const roundStage = getSetting('round_stage', 'round1');
  const finalistsCount = Number(getSetting('finalists_count', '10'));
  return {
    votingMode: mode === 'two_round' ? 'two_round' : 'standard',
    roundStage: ['draft', 'round1', 'round2'].includes(roundStage) ? roundStage : 'round1',
    finalistsCount: Number.isInteger(finalistsCount) && finalistsCount >= 3 && finalistsCount <= 25 ? finalistsCount : 10,
    roundId: getSetting('round1_id'),
    roundFillOptions: (() => {
      try { return JSON.parse(getSetting('round1_fill_options', '{}')); }
      catch { return {}; }
    })()
  };
}

function getPlexClientId() {
  let clientId = getSetting('plex_client_id');
  if (!clientId) {
    clientId = randomUUID();
    setSetting('plex_client_id', clientId);
  }
  return clientId;
}

function config() {
  let activeProviders = [];
  try { activeProviders = JSON.parse(getSetting('providers', '[]')); } catch { activeProviders = []; }
  return {
    serverUrl: getSetting('plex_url').trim().replace(/\/+$/, ''),
    plexToken: getSetting('plex_token'),
    sectionIds: getSetting('plex_sections'),
    labels: getSetting('plex_labels').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    tmdbKey: getSetting('tmdb_key'),
    omdbKey: getSetting('omdb_api_key') || process.env.OMDB_API_KEY || '',
    max_movie_rating: getSetting('max_movie_rating', 'ALL'),
    include_unrated_movies: getSetting('include_unrated_movies', 'true') === 'true',
    max_tv_rating: getSetting('max_tv_rating', 'ALL'),
    include_unrated_tv: getSetting('include_unrated_tv', 'true') === 'true',
    allow_guest_additions: getSetting('allow_guest_additions', 'true') === 'true',
    media_type_filter: getSetting('media_type_filter', 'both'),
    shortlistMaxSize: shortlistMaxSize(),
    providers: activeProviders
  };
}

function adminOnly(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'Admin PIN required.' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const listTables = new Set(['shortlist', 'two_round_pool']);
const insertShortlistRows = new Map([...listTables].map(table => [table, db.prepare(`INSERT INTO ${table}
  (id,source,source_id,title,type,year,poster,summary,content_rating,genres,cast_top2,director,metacritic_score,
    imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,tmdb_vote_average,tmdb_vote_count)
  VALUES (@id,@source,@sourceId,@title,@type,@year,@poster,@summary,@content_rating,@genres,@cast_top2,@director,
    @metacritic_score,@imdb_rating,@rt_score,@imdb_id,@imdb_top250_rank,@providers,@runtime_mins,@tmdb_vote_average,@tmdb_vote_count)`)]));

function listTable(table) {
  if (!listTables.has(table)) throw new Error('Invalid list table.');
  return table;
}

function activeListTable(state = roundState()) {
  return state.votingMode === 'two_round' ? 'two_round_pool' : 'shortlist';
}

function listCount(table) {
  return db.prepare(`SELECT count(*) AS count FROM ${listTable(table)}`).get().count;
}

function activeListCount(state = roundState()) {
  const table = activeListTable(state);
  return table === 'two_round_pool' && state.roundStage === 'round2'
    ? db.prepare('SELECT count(*) AS count FROM two_round_pool WHERE is_finalist=1').get().count
    : listCount(table);
}

function activeListMaxSize(state = roundState()) {
  if (state.votingMode !== 'two_round') return shortlistMaxSize();
  return state.roundStage === 'round2' ? state.finalistsCount : state.finalistsCount * 6;
}

function saveShortlistItem(item, details, table = 'shortlist') {
  const id = `${item.source}:${item.sourceId}`;
  insertShortlistRows.get(listTable(table)).run({
    id, source: item.source, sourceId: String(item.sourceId), title: item.title, type: item.type, year: item.year,
    ...details, poster: details.poster || item.poster || ''
  });
}

function parseFillOptions(body = {}) {
  const requestedGenres = body.genres ?? [];
  const requestedEraIds = body.eras ?? [];
  if (!Array.isArray(requestedGenres) || requestedGenres.some(name => !Object.hasOwn(fillGenres, name)) ||
      !Array.isArray(requestedEraIds)) throw new Error('Invalid genre or era selection.');
  const availableEras = new Map(fillEras().map(era => [era.id, era]));
  const eraIds = [...new Set(requestedEraIds.map(String))];
  if (eraIds.some(id => !availableEras.has(id))) throw new Error('Invalid era selection.');
  const minDuration = Number(body.minDuration ?? 0);
  const maxDuration = Number(body.maxDuration ?? 9999);
  if (![0, 30, 45, 60, 75, 90, 105, 120].includes(minDuration) ||
      ![9999, 45, 60, 90, 105, 120, 135, 150, 180].includes(maxDuration)) {
    throw new Error('Invalid runtime duration selection.');
  }
  return {
    genres: [...new Set(requestedGenres)],
    eras: eraIds.map(id => availableEras.get(id)),
    minDuration, maxDuration
  };
}

async function fillListTo(table, targetSize, settings, options) {
  table = listTable(table);
  const currentCount = listCount(table);
  const needed = targetSize - currentCount;
  if (needed <= 0) return { addedCount: 0, newTotal: currentCount };
  const plex = (await qualifyPlexCandidates(
    plexFillCandidates(settings, options.genres, options.eras, options.minDuration, options.maxDuration),
    settings.tmdbKey, options.eras
  )).filter(item => mediaTypeAllowed(item.type, settings.media_type_filter));
  const streaming = (await tmdbFillCandidates(
    settings, options.genres, options.eras, needed, options.minDuration, options.maxDuration
  )).filter(item => mediaTypeAllowed(item.type, settings.media_type_filter));
  const known = db.prepare(`SELECT source,source_id AS sourceId,title,type,year FROM ${table}`).all();
  const candidates = [];
  for (const item of [...plex, ...streaming]) {
    if (known.some(existing =>
      (existing.source === item.source && existing.sourceId === item.sourceId) || sameTitle(existing, item)
    )) continue;
    known.push(item);
    candidates.push(item);
  }
  const selected = shuffle(candidates).slice(0, needed);
  const enriched = await mapLimit(selected, 4, async item => ({
    item, details: await enrichShortlist(item, settings)
  }));
  return db.transaction(items => {
    let total = listCount(table);
    const existing = db.prepare(`SELECT source,source_id AS sourceId,title,type,year FROM ${table}`).all();
    let addedCount = 0;
    for (const { item, details } of items) {
      if (total >= targetSize) break;
      if (existing.some(row =>
        (row.source === item.source && row.sourceId === item.sourceId) || sameTitle(row, item)
      )) continue;
      saveShortlistItem(item, details, table);
      existing.push(item);
      total++;
      addedCount++;
    }
    return { addedCount, newTotal: total };
  })(enriched);
}

function shortlistTitles(table = 'shortlist', finalistsOnly = false) {
  table = listTable(table);
  const finalistFilter = table === 'two_round_pool' && finalistsOnly ? 'WHERE s.is_finalist=1' : '';
  const finalistColumn = table === 'two_round_pool' ? 's.is_finalist AS isFinalist' : '0 AS isFinalist';
  return db.prepare(`SELECT s.id,s.source,s.source_id AS sourceId,s.title,s.type,s.year,s.poster,s.summary,
    s.content_rating AS contentRating,s.genres,s.cast_top2 AS castTop2,s.director,
    s.metacritic_score AS metacriticScore,s.imdb_rating AS imdbRating,s.rt_score AS rtScore,
    s.imdb_id AS imdbId,s.imdb_top250_rank AS imdbTop250Rank,s.providers,
    COALESCE(s.runtime_mins, p.duration_mins) AS runtimeMins,
    s.tmdb_vote_average AS tmdbVoteAverage,s.tmdb_vote_count AS tmdbVoteCount,${finalistColumn}
    FROM ${table} s LEFT JOIN plex_titles p ON s.source='plex' AND p.id=s.source_id
    ${finalistFilter}
    ORDER BY s.title COLLATE NOCASE`).all().map(item => ({
    ...item, genres: JSON.parse(item.genres || '[]'), castTop2: JSON.parse(item.castTop2 || '[]'),
    providers: JSON.parse(item.providers || '[]')
  }));
}

function activeListTitles(state = roundState()) {
  const table = activeListTable(state);
  return shortlistTitles(table, table === 'two_round_pool' && state.roundStage === 'round2')
    .filter(item => mediaTypeAllowed(item.type));
}

function matchingStandardShortlist(settings) {
  return shortlistTitles('shortlist').filter(item => matchesActiveFilters(item, settings));
}

function copyShortlistItemsToPool(items) {
  const copyItem = db.prepare(`INSERT INTO two_round_pool
    (id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
      metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
      tmdb_vote_average,tmdb_vote_count,is_finalist)
    SELECT id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,content_rating,
      metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,
      tmdb_vote_average,tmdb_vote_count,0 FROM shortlist WHERE id=?`);
  let count = 0;
  for (const item of items) count += copyItem.run(item.id).changes;
  return count;
}

function normalizeTitle(title) {
  return String(title || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function jsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function plexTitleMatch(title, year, type) {
  const normalized = normalizeTitle(title);
  return db.prepare('SELECT * FROM plex_titles WHERE type=?').all(type)
    .filter(item => normalizeTitle(item.title) === normalized &&
      (!year || !item.year || Math.abs(Number(year) - Number(item.year)) <= 1))
    .sort((a, b) => {
      const distance = item => year && item.year ? Math.abs(Number(year) - Number(item.year)) : Number.MAX_SAFE_INTEGER;
      return distance(a) - distance(b);
    })[0] || null;
}

async function enrichedPreview(item, settings) {
  const details = await enrichShortlist(item, settings);
  return {
    ...item, poster: details.poster || item.poster || '', summary: details.summary || item.summary || '',
    contentRating: details.content_rating || item.contentRating || '',
    genres: jsonList(details.genres), castTop2: jsonList(details.cast_top2),
    director: details.director || '', metacriticScore: details.metacritic_score,
    imdbRating: details.imdb_rating, rtScore: details.rt_score,
    imdbId: details.imdb_id, imdbTop250Rank: details.imdb_top250_rank,
    runtimeMins: details.runtime_mins, tmdbVoteAverage: details.tmdb_vote_average,
    tmdbVoteCount: details.tmdb_vote_count, providers: jsonList(details.providers)
  };
}

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && !field) quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value.trim())) rows.push(row);
      row = []; field = '';
    } else field += character;
  }
  row.push(field.replace(/\r$/, ''));
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function parseImportEntries(body) {
  const csv = typeof body.csv === 'string' ? body.csv : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (csv) {
    const rows = csvRows(csv);
    const headers = (rows.shift() || []).map(value => value.trim().replace(/^\uFEFF/, '').toLowerCase());
    const titleIndex = headers.findIndex(value => value === 'title' || value === 'name');
    if (titleIndex < 0) throw new Error('CSV needs a Title or Name column.');
    const yearIndex = headers.indexOf('year');
    const typeIndex = headers.findIndex(value => ['mediatype', 'media type', 'type', 'title type'].includes(value));
    return rows.map(row => ({
      title: String(row[titleIndex] || '').trim(),
      year: Number(row[yearIndex]) || null,
      type: normalizeMediaType(row[typeIndex])
    })).filter(item => item.title);
  }
  return text.split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(.*?)\s+\((\d{4})\)$/);
    return { title: (match ? match[1] : line).trim(), year: match ? Number(match[2]) : null, type: null };
  }).filter(item => item.title);
}

function normalizeMediaType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (['tv', 'show', 'series', 'tv show', 'tv series', 'tv mini series', 'television', 'tvseries', 'tvminiseries'].includes(type)) return 'tv';
  if (['movie', 'movies', 'film', 'feature', 'tv movie', 'tvmovie'].includes(type)) return 'movie';
  return null;
}

async function matchImportEntry(entry, settings) {
  const types = entry.type ? [entry.type] : ['movie', 'tv'];
  for (const type of types) {
    if (!mediaTypeAllowed(type, settings.media_type_filter)) continue;
    const local = plexTitleMatch(entry.title, entry.year, type);
    if (local && isAllowedByRating(type, local.rating, settings)) {
      const item = {
        source: 'plex', sourceId: local.id, title: local.title, type, year: local.year,
        poster: local.poster || '', summary: local.summary || '', id: `plex:${local.id}`
      };
      return enrichedPreview(item, settings);
    }
  }
  const searchType = entry.type ||
    (settings.media_type_filter === 'movies' ? 'movie' : settings.media_type_filter === 'tv' ? 'tv' : null);
  const remote = await tmdb.findAvailable(entry.title, searchType, entry.year, settings);
  if (!remote || !mediaTypeAllowed(remote.type, settings.media_type_filter)) return null;
  const item = { ...remote, year: remote.year || entry.year || null };
  const preview = await enrichedPreview(item, settings);
  return isAllowedByRating(item.type, preview.contentRating, settings) ? preview : null;
}

function plexArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

async function plexJson(url, method = 'GET') {
  const response = await fetch(url, { method, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Plex returned ${response.status}.`);
  return response.json();
}

function savedItemToShortlist(row) {
  return {
    id: `${row.source}:${row.source_id}`, source: row.source, sourceId: row.source_id,
    title: row.title, type: row.type, year: row.year, poster: row.poster,
    summary: row.summary, content_rating: row.content_rating, genres: row.genres,
    cast_top2: row.cast_top2, director: row.director, metacritic_score: row.metacritic_score,
    imdb_rating: row.imdb_rating, rt_score: row.rt_score, imdb_id: row.imdb_id,
    imdb_top250_rank: row.imdb_top250_rank, providers: row.providers,
    runtime_mins: row.runtime_mins, tmdb_vote_average: row.tmdb_vote_average,
    tmdb_vote_count: row.tmdb_vote_count
  };
}

app.post('/api/admin/login', (req, res) => {
  if (String(req.body?.pin || '') !== process.env.ADMIN_PIN) {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Could not create an admin session.' });
    req.session.admin = true;
    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: 'Could not save the admin session.' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/admin/logout', adminOnly, (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: 'Could not end the admin session.' });
    res.clearCookie('watch-night-admin');
    res.json({ ok: true });
  });
});

app.get('/api/admin/session', (req, res) => res.json({ authenticated: Boolean(req.session?.admin) }));
app.get('/api/admin/settings', adminOnly, (req, res) => {
  const c = config();
  res.json({
    plexUrl: c.serverUrl, plexToken: c.plexToken, sectionIds: c.sectionIds,
    plexOAuth: getSetting('plex_oauth_connected') === 'true',
    labels: getSetting('plex_labels'), tmdbKey: c.tmdbKey, omdbKey: c.omdbKey,
    maxMovieRating: c.max_movie_rating, includeUnratedMovies: c.include_unrated_movies,
    maxTvRating: c.max_tv_rating, includeUnratedTv: c.include_unrated_tv,
    allowGuestAdditions: c.allow_guest_additions,
    mediaTypeFilter: c.media_type_filter,
    shortlistMaxSize: c.shortlistMaxSize,
    providers: c.providers, providerOptions: providers,
    ...roundState(),
    roundPoolSize: listCount('two_round_pool')
  });
});

app.get('/api/admin/shortlist', adminOnly, (req, res) => {
  const table = req.query.list === 'standard' ? 'shortlist' : activeListTable();
  res.json(shortlistTitles(table));
});

app.get('/api/two-round-pool', adminOnly, (req, res) => {
  res.json(shortlistTitles('two_round_pool'));
});

app.post('/api/plex/auth/start', adminOnly, asyncRoute(async (req, res) => {
  const clientId = getPlexClientId();
  const pin = await createPin(clientId);
  if (!pin?.id || !pin?.code) throw new Error('Plex did not return an authentication PIN.');
  req.session.plexPinId = String(pin.id);
  res.json({
    pinId: String(pin.id),
    code: String(pin.code),
    clientId,
    expiresIn: Number(pin.expiresIn) || 600
  });
}));

app.get('/api/plex/auth/poll/:pinId', adminOnly, asyncRoute(async (req, res) => {
  const pinId = String(req.params.pinId);
  if (!/^\d+$/.test(pinId) || req.session.plexPinId !== pinId) {
    return res.status(403).json({ error: 'This Plex PIN was not started in this admin session.' });
  }
  const result = await pollPin(pinId, getPlexClientId());
  if (!result.authToken) return res.json({ authorized: false });
  setSetting('plex_token', result.authToken);
  setSetting('plex_oauth_connected', 'true');
  delete req.session.plexPinId;
  res.json({ authorized: true });
}));

app.get('/api/plex/servers', adminOnly, asyncRoute(async (req, res) => {
  res.json({ servers: await plexServers(config().plexToken, getPlexClientId()) });
}));

app.get('/api/plex/libraries', adminOnly, asyncRoute(async (req, res) => {
  res.json({ libraries: await getLibraries(config()) });
}));

app.get('/api/plex/stats', adminOnly, (req, res) => {
  res.json(getSyncStats(config()));
});

app.get('/api/plex/labels', adminOnly, asyncRoute(async (req, res) => {
  const sectionIds = String(req.query.sectionIds || config().sectionIds)
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!sectionIds.length) return res.status(400).json({ error: 'Select at least one library first.' });
  res.json({ labels: await getLabels(sectionIds, config()) });
}));

app.get('/api/plex/watchlist', asyncRoute(async (req, res) => {
  const settings = config();
  if (!settings.allow_guest_additions && !req.session?.admin) {
    return res.status(403).json({ error: 'The host has locked shortlist additions for this session.' });
  }
  if (!settings.plexToken) return res.status(400).json({ error: 'Connect Plex or enter a Plex token first.' });
  const url = new URL('https://metadata.provider.plex.tv/library/sections/watchlist/all');
  url.searchParams.set('X-Plex-Token', settings.plexToken);
  const data = await plexJson(url);
  const metadata = data?.MediaContainer?.Metadata ?? data?.MediaContainer?.Directory;
  const entries = plexArray(metadata);
  const results = await mapLimit(entries, 4, async entry => {
    const rawType = String(entry.type ?? entry.media_type ?? '').toLowerCase();
    const type = ['show', 'tv', '2'].includes(rawType) ? 'tv' : ['movie', '1'].includes(rawType) ? 'movie' : null;
    const title = String(entry.title || entry.name || '').trim();
    const year = Number(entry.year) || null;
    if (!type || !title || !mediaTypeAllowed(type, settings.media_type_filter)) return null;
    const local = plexTitleMatch(title, year, type);
    if (local && isAllowedByRating(type, local.rating, settings)) {
      const item = {
        id: `plex:${local.id}`, source: 'plex', sourceId: local.id, title: local.title,
        type, year: local.year, poster: local.poster || '', summary: local.summary || ''
      };
      return { item: await enrichedPreview(item, settings) };
    }
    const remote = await tmdb.findAvailable(title, type, year, settings);
    if (!remote) return { unmatched: { title, year, type } };
    const item = await enrichedPreview({ ...remote, year: remote.year || year }, settings);
    return isAllowedByRating(type, item.contentRating, settings) ? { item } : { unmatched: { title, year, type } };
  });
  const items = [], unmatched = [], seen = new Set();
  for (const result of results.filter(Boolean)) {
    if (result.item) {
      const key = `${result.item.source}:${result.item.sourceId}`;
      if (!seen.has(key)) { seen.add(key); items.push(result.item); }
    } else unmatched.push(result.unmatched);
  }
  res.json({ items, unmatched });
}));

app.post('/api/plex/watchlist/push', adminOnly, asyncRoute(async (req, res) => {
  const settings = config();
  if (!settings.plexToken) return res.status(400).json({ error: 'Connect Plex or enter a Plex token first.' });
  const failedTitles = [];
  let addedCount = 0;
  for (const item of activeListTitles()) {
    try {
      const matchUrl = new URL('https://metadata.provider.plex.tv/library/metadata/matches');
      matchUrl.searchParams.set('type', item.type === 'tv' ? '2' : '1');
      matchUrl.searchParams.set('title', item.title);
      if (item.year) matchUrl.searchParams.set('year', String(item.year));
      matchUrl.searchParams.set('X-Plex-Token', settings.plexToken);
      const match = await plexJson(matchUrl);
      const ratingKey = plexArray(match?.MediaContainer?.Metadata)[0]?.ratingKey;
      if (!ratingKey) throw new Error('No Plex cloud match.');
      const addUrl = new URL(`https://discover.provider.plex.tv/library/metadata/${encodeURIComponent(ratingKey)}/addToWatchlist`);
      addUrl.searchParams.set('X-Plex-Token', settings.plexToken);
      const response = await fetch(addUrl, { method: 'PUT', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Plex returned ${response.status}.`);
      addedCount++;
    } catch (error) {
      failedTitles.push({ title: item.title, error: error.message });
    }
  }
  res.json({ addedCount, failedTitles });
}));

app.post('/api/plex/playlist', adminOnly, asyncRoute(async (req, res) => {
  const settings = config();
  if (!settings.serverUrl || !settings.plexToken) {
    return res.status(400).json({ ok: false, error: 'Configure a Plex server URL and token first.' });
  }
  const name = String(req.body?.name || `Movie Night - ${new Date().toISOString().slice(0, 10)}`).trim().slice(0, 100);
  if (!name) return res.status(400).json({ ok: false, error: 'Enter a playlist name.' });
  const titles = activeListTitles();
  const localTitles = titles.map(item => ({ item, local: plexTitleMatch(item.title, item.year, item.type) }))
    .filter(match => match.local);
  if (!localTitles.length) {
    return res.status(400).json({ ok: false, error: 'No titles in the current shortlist are hosted on your Plex server.' });
  }
  const skippedStreamingCount = titles.length - localTitles.length;
  const identityUrl = new URL('/identity', settings.serverUrl);
  identityUrl.searchParams.set('X-Plex-Token', settings.plexToken);
  const identity = await plexJson(identityUrl);
  const machineIdentifier = identity?.MediaContainer?.machineIdentifier || identity?.machineIdentifier;
  if (!machineIdentifier) throw new Error('Plex did not return a machineIdentifier.');
  const ratingKeys = [], seen = new Set();
  for (const { item, local } of localTitles) {
    let ratingKey = local.id;
    if (item.type === 'tv') {
      const leavesUrl = new URL(`/library/metadata/${encodeURIComponent(local.id)}/allLeaves`, settings.serverUrl);
      leavesUrl.searchParams.set('X-Plex-Token', settings.plexToken);
      const leavesData = await plexJson(leavesUrl);
      const leaves = plexArray(leavesData?.MediaContainer?.Metadata);
      const episode = leaves.find(leaf => Number(leaf.viewCount || 0) === 0) || leaves[0];
      if (!episode?.ratingKey) throw new Error(`Plex returned no episodes for "${item.title}".`);
      ratingKey = String(episode.ratingKey);
    }
    if (!seen.has(String(ratingKey))) {
      seen.add(String(ratingKey));
      ratingKeys.push(String(ratingKey));
    }
  }
  if (!ratingKeys.length) {
    return res.status(400).json({ ok: false, error: 'No titles in the current shortlist are hosted on your Plex server.' });
  }
  const uri = `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;
  const playlistUrl = new URL('/playlists', settings.serverUrl);
  for (const [key, value] of Object.entries({
    type: 'video', title: name, smart: '0', uri, 'X-Plex-Token': settings.plexToken
  })) playlistUrl.searchParams.set(key, value);
  await plexJson(playlistUrl, 'POST');
  res.json({ ok: true, addedCount: ratingKeys.length, skippedStreamingCount });
}));

app.post('/api/admin/settings', adminOnly, (req, res) => {
  const body = req.body || {};
  if (body.roundFillOptions != null &&
      (typeof body.roundFillOptions !== 'object' || Array.isArray(body.roundFillOptions))) {
    return res.status(400).json({ error: 'Invalid auto-fill settings.' });
  }
  const plexToken = String(body.plexToken || '').trim();
  const chosen = Array.isArray(body.providers) ? body.providers.map(Number) : [];
  const allowed = new Set(providers.map(([, id]) => id));
  if (chosen.some(id => !allowed.has(id))) return res.status(400).json({ error: 'Invalid streaming provider selection.' });
  const movieRatings = ['G', 'PG', 'PG-13', 'R', 'ALL'];
  const tvRatings = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'ALL'];
  const maxMovieRating = String(body.maxMovieRating ?? getSetting('max_movie_rating', 'ALL'));
  const maxTvRating = String(body.maxTvRating ?? getSetting('max_tv_rating', 'ALL'));
  const mediaTypeFilter = String(body.mediaTypeFilter ?? getSetting('media_type_filter', 'both'));
  const allowGuestAdditions = body.allowGuestAdditions == null
    ? getSetting('allow_guest_additions', 'true') === 'true'
    : body.allowGuestAdditions === true;
  const maxShortlistSize = body.shortlistMaxSize == null
    ? shortlistMaxSize()
    : Number(body.shortlistMaxSize);
  if (!Number.isInteger(maxShortlistSize) || maxShortlistSize < 3 || maxShortlistSize > 100) {
    return res.status(400).json({ error: 'Max shortlist size must be an integer from 3 to 100.' });
  }
  if (!movieRatings.includes(maxMovieRating) || !tvRatings.includes(maxTvRating)) {
    return res.status(400).json({ error: 'Invalid content rating selection.' });
  }
  if (!['both', 'movies', 'tv'].includes(mediaTypeFilter)) {
    return res.status(400).json({ error: 'Invalid media type filter.' });
  }
  if (body.allowGuestAdditions != null && typeof body.allowGuestAdditions !== 'boolean') {
    return res.status(400).json({ error: 'Guest additions setting must be boolean.' });
  }
  if ((body.includeUnratedMovies != null && typeof body.includeUnratedMovies !== 'boolean') ||
      (body.includeUnratedTv != null && typeof body.includeUnratedTv !== 'boolean')) {
    return res.status(400).json({ error: 'Unrated content settings must be boolean.' });
  }
  const includeUnratedMovies = body.includeUnratedMovies == null
    ? getSetting('include_unrated_movies', 'true') === 'true'
    : body.includeUnratedMovies === true;
  const includeUnratedTv = body.includeUnratedTv == null
    ? getSetting('include_unrated_tv', 'true') === 'true'
    : body.includeUnratedTv === true;
  if (plexToken !== getSetting('plex_token')) setSetting('plex_oauth_connected', 'false');
  for (const [key, value] of Object.entries({
    plex_url: String(body.plexUrl || '').trim(),
    plex_token: plexToken,
    plex_sections: String(body.sectionIds || '').trim(),
    plex_labels: String(body.labels || '').trim(),
    tmdb_key: String(body.tmdbKey || '').trim(),
    omdb_api_key: String(body.omdbKey || '').trim(),
    max_movie_rating: maxMovieRating,
    include_unrated_movies: includeUnratedMovies,
    max_tv_rating: maxTvRating,
    include_unrated_tv: includeUnratedTv,
    allow_guest_additions: allowGuestAdditions,
    media_type_filter: mediaTypeFilter,
    shortlist_max_size: maxShortlistSize,
    providers: JSON.stringify([...new Set(chosen)]),
    round1_fill_options: body.roundFillOptions == null
      ? getSetting('round1_fill_options', '{}')
      : JSON.stringify(body.roundFillOptions)
  })) setSetting(key, value);
  res.json({ ok: true });
});

app.post('/api/admin/sync', adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, ...await syncLibraries(config()) });
  } catch (error) {
    console.error(`Plex sync failed: ${error.stack || error.message}`);
    res.status(500).json({ ok: false, error: error.message || 'Plex sync failed.' });
  }
});

app.post('/api/admin/reset-votes', adminOnly, (req, res) => {
  const result = db.transaction(() => ({
    ballots: db.prepare('DELETE FROM ballots').run().changes,
    round1Votes: db.prepare('DELETE FROM round1_votes').run().changes
  }))();
  const state = roundState();
  if (state.votingMode === 'two_round' && state.roundStage === 'round1' && state.roundId) {
    setSetting('round1_id', randomUUID());
  }
  res.json({ ok: true, ...result });
});

app.post('/api/admin/voting-mode', adminOnly, (req, res) => {
  const mode = String(req.body?.mode || '');
  const finalistsCount = Number(req.body?.finalistsCount);
  if (!['standard', 'two_round'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid voting mode.' });
  }
  if (!Number.isInteger(finalistsCount) || finalistsCount < 3 || finalistsCount > 25) {
    return res.status(400).json({ error: 'Number of finalists must be from 3 to 25.' });
  }
  if (mode !== getSetting('voting_mode', 'standard')) {
    db.transaction(() => {
      db.prepare('DELETE FROM round1_votes').run();
      db.prepare('DELETE FROM ballots').run();
      setSetting('round1_id', '');
      setSetting('round_stage', mode === 'two_round' ? 'draft' : 'round1');
    })();
  }
  setSetting('voting_mode', mode);
  setSetting('finalists_count', finalistsCount);
  res.json(roundState());
});

app.post('/api/admin/round1/generate', adminOnly, asyncRoute(async (req, res) => {
  const finalistsCount = Number(req.body?.finalistsCount);
  if (!Number.isInteger(finalistsCount) || finalistsCount < 3 || finalistsCount > 25) {
    return res.status(400).json({ error: 'Number of finalists must be from 3 to 25.' });
  }
  let options;
  try { options = parseFillOptions(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const poolSize = finalistsCount * 6;
  const settings = config();
  const seedShortlist = req.body?.seedShortlist === true;
  const eligible = seedShortlist
    ? matchingStandardShortlist({ ...settings, ...options })
    : [];
  const seedItems = eligible.length >= poolSize ? shuffle(eligible).slice(0, poolSize) : eligible;
  const skipFill = eligible.length >= poolSize;
  let seededCount = 0;
  const roundId = randomUUID();
  const startRound = db.transaction(() => {
    db.prepare('DELETE FROM round1_votes').run();
    db.prepare('DELETE FROM ballots').run();
    db.prepare('DELETE FROM two_round_pool').run();
    if (seedShortlist) seededCount = copyShortlistItemsToPool(seedItems);
    setSetting('voting_mode', 'two_round');
    setSetting('round_stage', 'draft');
    setSetting('finalists_count', finalistsCount);
    setSetting('round1_id', roundId);
    setSetting('round1_fill_options', JSON.stringify(options));
  });
  startRound();
  const result = skipFill
    ? { newTotal: seededCount, addedCount: 0 }
    : await fillListTo('two_round_pool', poolSize, settings, options);
  if (!result.newTotal) return res.status(400).json({ error: 'Add titles to the Standard shortlist, select seed, or configure a source before generating the Round 1 pool.' });
  res.json({
    ...roundState(), poolSize: result.newTotal, addedCount: result.addedCount, seededCount
  });
}));

app.post('/api/two-round/populate-from-shortlist', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'draft') {
    return res.status(409).json({ error: 'The Round 1 pool can only be populated during draft review.' });
  }
  const poolSize = state.finalistsCount * 6;
  const eligible = matchingStandardShortlist(activeFilterSettings());
  const selected = eligible.length > poolSize ? shuffle(eligible).slice(0, poolSize) : eligible;
  const count = db.transaction(() => {
    db.prepare('DELETE FROM round1_votes').run();
    db.prepare('DELETE FROM ballots').run();
    db.prepare('DELETE FROM two_round_pool').run();
    const copiedCount = copyShortlistItemsToPool(selected);
    setSetting('round_stage', 'draft');
    setSetting('round1_id', randomUUID());
    return copiedCount;
  })();
  res.json({ ok: true, count });
});

app.post('/api/admin/round1/refill', adminOnly, asyncRoute(async (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'draft' || !state.roundId) {
    return res.status(409).json({ error: 'The Round 1 pool can only be re-filled during draft review.' });
  }
  let options;
  try { options = parseFillOptions(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const targetSize = state.finalistsCount * 6;
  const result = await fillListTo('two_round_pool', targetSize, config(), options);
  setSetting('round1_fill_options', JSON.stringify(options));
  res.json({ ...result, poolSize: result.newTotal, targetSize });
}));

app.post('/api/admin/round1/release', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'draft' || !state.roundId) {
    return res.status(409).json({ error: 'There is no Round 1 draft to release.' });
  }
  const poolSize = db.prepare(`SELECT count(*) AS count FROM two_round_pool
    WHERE ${mediaTypeWhere(config().media_type_filter)}`).get().count;
  if (poolSize < state.finalistsCount + 1) {
    return res.status(400).json({
      error: `The pool needs at least ${state.finalistsCount + 1} items before Round 1 can start.`
    });
  }
  setSetting('round_stage', 'round1');
  res.json({ ...roundState(), poolSize });
});

app.get('/api/admin/round1/progress', adminOnly, (req, res) => {
  const state = roundState();
  const filter = config().media_type_filter;
  const poolSize = db.prepare(`SELECT count(*) AS count FROM two_round_pool WHERE ${mediaTypeWhere(filter)}`).get().count;
  const voters = db.prepare(`SELECT v.voter_name AS name, count(DISTINCT v.item_id) AS completed
    FROM round1_votes v JOIN two_round_pool s ON s.id = v.item_id
    WHERE ${mediaTypeWhere(filter, 's.type')}
    GROUP BY v.voter_name COLLATE NOCASE ORDER BY v.voter_name COLLATE NOCASE`).all()
    .map(voter => ({ ...voter, done: poolSize > 0 && voter.completed >= poolSize }));
  res.json({ ...state, poolSize, voters });
});

app.post('/api/admin/round2/start', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'There is no active Round 1 pool.' });
  }
  const items = db.prepare('SELECT id,type FROM two_round_pool').all()
    .filter(item => mediaTypeAllowed(item.type));
  if (!items.length) return res.status(400).json({ error: 'The Round 1 pool is empty.' });
  const yesVotes = new Map(db.prepare(`SELECT item_id AS id, count(*) AS votes FROM round1_votes
    WHERE vote = 1 GROUP BY item_id`).all().map(row => [row.id, row.votes]));
  const groups = new Map();
  for (const item of items) {
    const votes = yesVotes.get(item.id) || 0;
    if (!groups.has(votes)) groups.set(votes, []);
    groups.get(votes).push(item);
  }
  const ordered = [...groups.keys()].sort((a, b) => b - a)
    .flatMap(votes => shuffle(groups.get(votes)));
  const finalists = ordered.slice(0, state.finalistsCount).map(item => item.id);
  const beginRound2 = db.transaction(ids => {
    db.prepare('UPDATE two_round_pool SET is_finalist=0').run();
    const markFinalist = db.prepare('UPDATE two_round_pool SET is_finalist=1 WHERE id=?');
    for (const id of ids) markFinalist.run(id);
    setSetting('round_stage', 'round2');
  });
  beginRound2(finalists);
  res.json({ roundStage: 'round2', finalistsCount: finalists.length });
});

function removeVotesForItems(itemIds) {
  const removed = new Set(itemIds);
  if (!removed.size) return;
  const deleteRound1Vote = db.prepare('DELETE FROM round1_votes WHERE item_id=?');
  for (const id of removed) deleteRound1Vote.run(id);
  const ballots = db.prepare('SELECT voter,ranks,approvals,vetoes FROM ballots').all();
  const save = db.prepare('UPDATE ballots SET ranks=?,approvals=?,vetoes=? WHERE voter=?');
  for (const ballot of ballots) {
    const previousRanks = JSON.parse(ballot.ranks);
    const previousApprovals = JSON.parse(ballot.approvals);
    const previousVetoes = JSON.parse(ballot.vetoes);
    const ranks = previousRanks.filter(id => !removed.has(id));
    const approvals = previousApprovals.filter(id => !removed.has(id));
    const vetoes = previousVetoes.filter(id => !removed.has(id));
    if (ranks.length !== previousRanks.length ||
        approvals.length !== previousApprovals.length ||
        vetoes.length !== previousVetoes.length) {
      save.run(JSON.stringify(ranks), JSON.stringify(approvals), JSON.stringify(vetoes), ballot.voter);
    }
  }
}

function removeListItem(table, id, res) {
  table = listTable(table);
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Title not found in this list.' });
  db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    removeVotesForItems([id]);
  })();
  res.json({ ok: true });
}

function clearList(table, res) {
  table = listTable(table);
  const isActiveList = activeListTable() === table;
  const ids = db.prepare(`SELECT id FROM ${table}`).all().map(row => row.id);
  db.transaction(() => {
    removeVotesForItems(ids);
    db.prepare(`DELETE FROM ${table}`).run();
    if (isActiveList) db.prepare('DELETE FROM ballots').run();
    if (table === 'two_round_pool') {
      db.prepare('DELETE FROM round1_votes').run();
      if (isActiveList) {
        setSetting('round1_id', '');
        setSetting('round_stage', 'draft');
      }
    }
  })();
  res.json({ ok: true });
}

app.delete('/api/shortlist/:id', adminOnly, (req, res) => removeListItem('shortlist', req.params.id, res));
app.delete('/api/two-round-pool/:id', adminOnly, (req, res) => removeListItem('two_round_pool', req.params.id, res));
app.delete('/api/shortlist', adminOnly, (req, res) => clearList('shortlist', res));
app.delete('/api/two-round-pool', adminOnly, (req, res) => clearList('two_round_pool', res));
app.delete('/api/admin/shortlist/:id', adminOnly, (req, res) =>
  removeListItem(activeListTable(), req.params.id, res));
app.delete('/api/admin/shortlist', adminOnly, (req, res) => clearList(activeListTable(), res));

app.get('/api/status', (req, res) => res.json({
  shortlistCount: activeListCount(),
  shortlistMaxSize: shortlistMaxSize(),
  activeListMaxSize: activeListMaxSize(),
  ...roundState()
}));

app.get('/api/session/status', (req, res) => res.json({
  shortlistCount: activeListCount(),
  ...roundState()
}));

app.get('/api/round1/pool', (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'Round 1 is not active.' });
  }
  const voter = String(req.query.voter || '').trim().slice(0, 60);
  const items = shortlistTitles('two_round_pool')
    .filter(item => mediaTypeAllowed(item.type));
  const votes = Object.fromEntries(db.prepare(`SELECT item_id AS id, vote FROM round1_votes
    WHERE voter_name = ? COLLATE NOCASE`).all(voter).map(vote => [vote.id, vote.vote]));
  res.json({ roundId: state.roundId, items, votes });
});

app.post('/api/round1/vote', (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'Round 1 is not active.' });
  }
  if (req.body?.roundId !== state.roundId) {
    return res.status(409).json({ error: 'Round 1 was reset. Refreshing your cards…' });
  }
  const voter = String(req.body?.voter || '').trim().slice(0, 60);
  const itemId = String(req.body?.itemId || '');
  const vote = req.body?.vote;
  if (!voter) return res.status(400).json({ error: 'Enter your name before voting.' });
  if (!itemId || ![0, 1].includes(vote)) return res.status(400).json({ error: 'Choose Yes or No for a title.' });
  const candidate = db.prepare('SELECT type FROM two_round_pool WHERE id = ?').get(itemId);
  if (!candidate || !mediaTypeAllowed(candidate.type)) {
    return res.status(400).json({ error: 'That title is no longer in the Round 1 pool.' });
  }
  db.prepare(`INSERT INTO round1_votes (voter_name,item_id,vote,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(voter_name,item_id) DO UPDATE SET vote=excluded.vote,updated_at=excluded.updated_at`)
    .run(voter, itemId, vote, new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/config/status', (req, res) => {
  const c = config();
  res.json({
    plexConfigured: Boolean(c.serverUrl && c.plexToken),
    tmdbConfigured: Boolean(c.tmdbKey),
    omdbConfigured: Boolean(c.omdbKey),
    allowGuestAdditions: c.allow_guest_additions
  });
});

app.get('/api/search', asyncRoute(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json([]);
  const needle = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const settings = config();
  const plex = db.prepare(`SELECT id, title, type, year, poster, summary, rating
    FROM plex_titles WHERE title LIKE ? ESCAPE '\\' ORDER BY title`).all(needle)
    .filter(item => mediaTypeAllowed(item.type, settings.media_type_filter) &&
      isAllowedByRating(item.type, item.rating, settings))
    .slice(0, 30)
    .map(({ rating, ...item }) => ({ ...item, source: 'plex', sourceId: item.id }));
  const remote = (await tmdb.search(query, settings))
    .filter(item => mediaTypeAllowed(item.type, settings.media_type_filter));
  const ratedRemote = await Promise.all(remote.map(async item => {
    if (!needsCertification(item.type, settings)) return item;
    const match = String(item.sourceId).match(/^(movie|tv):(\d+)$/);
    if (!match) throw new Error('TMDB returned an invalid title ID.');
    const rating = await tmdb.certification(match[1], match[2], settings.tmdbKey);
    return isAllowedByRating(item.type, rating, settings) ? item : null;
  }));
  const normalizeTitle = title => String(title || '').normalize('NFKD')
    .replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const duplicatesPlex = item => {
    const title = normalizeTitle(item.title);
    const year = item.year == null ? null : Number(item.year);
    if (!title || year == null || !Number.isFinite(year)) return false;
    return plex.some(match => {
      const plexYear = match.year == null ? null : Number(match.year);
      return match.type === item.type && normalizeTitle(match.title) === title &&
        plexYear != null && Number.isFinite(plexYear) && Math.abs(plexYear - year) <= 1;
    });
  };
  res.json([...plex, ...ratedRemote.filter(item => item && !duplicatesPlex(item))]);
}));

app.get('/api/title', asyncRoute(async (req, res) => {
  const source = String(req.query.source || '');
  const id = String(req.query.id || '');
  if (source === 'plex') {
    const item = db.prepare('SELECT * FROM plex_titles WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Plex title not found.' });
    return res.json({ ...item, source, sourceId: item.id, genres: JSON.parse(item.genres || '[]') });
  }
  if (source === 'tmdb') {
    const match = id.match(/^(movie|tv):(\d+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid TMDB title ID.' });
    if (!config().tmdbKey) return res.status(400).json({ error: 'TMDB is not configured by the admin.' });
    return res.json(await tmdb.details(match[1], match[2], config()));
  }
  res.status(400).json({ error: 'Unknown title source.' });
}));

app.get('/api/plex-image', asyncRoute(async (req, res) => {
  const imagePath = String(req.query.path || '');
  if (!/^\/library\/metadata\/[\w-]+\/thumb\/[\w.-]+$/.test(imagePath)) {
    return res.status(400).json({ error: 'Invalid Plex image path.' });
  }
  const c = config();
  if (!c.serverUrl || !c.plexToken) return res.status(503).json({ error: 'Plex is not configured.' });
  const url = new URL(imagePath, c.serverUrl);
  url.searchParams.set('X-Plex-Token', c.plexToken);
  const response = await fetch(url);
  if (!response.ok) return res.status(response.status).end();
  res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await response.arrayBuffer()));
}));

app.post('/api/shortlist/fill', adminOnly, asyncRoute(async (req, res) => {
  const state = roundState();
  if (state.votingMode === 'two_round' && state.roundStage !== 'draft') {
    return res.status(409).json({ error: 'The Two-Round pool can only be auto-filled during draft review.' });
  }
  const settings = config();
  let options;
  try { options = parseFillOptions(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const table = activeListTable(state);
  const targetSize = state.votingMode === 'two_round' ? state.finalistsCount * 6 : settings.shortlistMaxSize;
  const currentCount = listCount(table);
  const result = await fillListTo(table, targetSize, settings, options);
  if (state.votingMode === 'two_round' && !state.roundId) setSetting('round1_id', randomUUID());
  res.json({
    ...result,
    ...(result.addedCount ? {} : {
      message: currentCount >= targetSize ? 'The active list is already full.' : 'No matching titles found.'
    })
  });
}));

app.get('/api/saved-shortlists', adminOnly, (req, res) => {
  res.json(db.prepare(`SELECT s.id,s.name,s.created_at AS createdAt,count(i.id) AS itemCount
    FROM saved_shortlists s LEFT JOIN saved_shortlist_items i ON i.saved_shortlist_id=s.id
    GROUP BY s.id ORDER BY s.created_at DESC`).all());
});

app.post('/api/saved-shortlists', adminOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Enter a name for this saved shortlist.' });
  const state = roundState();
  const columns = `source,source_id,title,type,year,poster,genres,cast_top2,director,summary,
    content_rating,metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,
    runtime_mins,tmdb_vote_average,tmdb_vote_count`;
  const rows = state.votingMode === 'two_round'
    ? state.roundStage === 'round2'
      ? db.prepare(`SELECT ${columns} FROM two_round_pool WHERE is_finalist=1 ORDER BY title COLLATE NOCASE`).all()
      : []
    : db.prepare(`SELECT ${columns} FROM shortlist ORDER BY title COLLATE NOCASE`).all();
  if (!rows.length) return res.status(400).json({ error: 'There are no titles in the current list to save.' });
  const id = randomUUID();
  db.transaction(items => {
    db.prepare('INSERT INTO saved_shortlists (id,name,created_at) VALUES (?,?,?)')
      .run(id, name, new Date().toISOString());
    const insert = db.prepare(`INSERT INTO saved_shortlist_items
      (saved_shortlist_id,source,source_id,title,type,year,poster,genres,cast_top2,director,summary,
        content_rating,metacritic_score,imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,
        runtime_mins,tmdb_vote_average,tmdb_vote_count)
      VALUES (@savedId,@source,@source_id,@title,@type,@year,@poster,@genres,@cast_top2,@director,@summary,
        @content_rating,@metacritic_score,@imdb_rating,@rt_score,@imdb_id,@imdb_top250_rank,@providers,
        @runtime_mins,@tmdb_vote_average,@tmdb_vote_count)`);
    for (const item of items) insert.run({ ...item, savedId: id });
  })(rows);
  res.status(201).json({ id, name, itemCount: rows.length });
});

app.patch('/api/saved-shortlists/:id', adminOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Enter a name for this saved shortlist.' });
  const result = db.prepare('UPDATE saved_shortlists SET name=? WHERE id=?').run(name, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Saved shortlist not found.' });
  res.json({ ok: true, name });
});

app.delete('/api/saved-shortlists/:id', adminOnly, (req, res) => {
  const result = db.prepare('DELETE FROM saved_shortlists WHERE id=?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Saved shortlist not found.' });
  res.json({ ok: true });
});

app.post('/api/saved-shortlists/:id/load', adminOnly, (req, res) => {
  const state = roundState();
  const mode = String(req.body?.mode || '');
  if (!['replace', 'append'].includes(mode)) return res.status(400).json({ error: 'Choose replace or append.' });
  const table = activeListTable(state);
  const maxSize = table === 'shortlist' ? shortlistMaxSize() : state.finalistsCount * 6;
  const saved = db.prepare('SELECT * FROM saved_shortlist_items WHERE saved_shortlist_id=? ORDER BY id').all(req.params.id);
  if (!db.prepare('SELECT 1 FROM saved_shortlists WHERE id=?').get(req.params.id)) {
    return res.status(404).json({ error: 'Saved shortlist not found.' });
  }
  const loaded = db.transaction(items => {
    if (mode === 'replace') {
      db.prepare(`DELETE FROM ${table}`).run();
      if (table === 'shortlist') db.prepare('DELETE FROM ballots').run();
    }
    if (table === 'two_round_pool') {
      db.prepare('UPDATE two_round_pool SET is_finalist=0').run();
      db.prepare('DELETE FROM round1_votes').run();
      db.prepare('DELETE FROM ballots').run();
      setSetting('round_stage', 'draft');
      setSetting('round1_id', randomUUID());
    }
    const existing = db.prepare(`SELECT source,source_id AS sourceId,title,type,year FROM ${table}`).all();
    let skippedCount = 0;
    let loadedCount = 0;
    for (const row of items) {
      const item = { source: row.source, sourceId: row.source_id, title: row.title, type: row.type, year: row.year };
      if (!mediaTypeAllowed(row.type) || existing.some(current =>
        (current.source === item.source && current.sourceId === item.sourceId) || sameTitle(current, item)
      ) || existing.length >= maxSize) {
        skippedCount++;
        continue;
      }
      insertShortlistRows.get(table).run(savedItemToShortlist(row));
      existing.push(item);
      loadedCount++;
    }
    return { loadedCount, skippedCount, newTotal: existing.length };
  })(saved);
  res.json({ ...loaded, ...roundState(), roundPoolSize: listCount('two_round_pool') });
});

app.get('/api/shortlist/export.csv', adminOnly, (req, res) => {
  const headers = ['Title', 'Year', 'MediaType', 'Source', 'ContentRating', 'Genres', 'Director', 'Stars', 'Metacritic', 'IMDb', 'RottenTomatoes'];
  const quote = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = activeListTitles().map(item => [
    item.title, item.year, item.type === 'tv' ? 'TV Show' : 'Movie',
    item.source === 'plex' ? 'On Plex' : item.providers.join(', ') || 'TMDB',
    item.contentRating, item.genres.join('|'), item.director, item.castTop2.join('|'),
    item.metacriticScore, item.imdbRating, item.rtScore
  ]);
  res.type('text/csv; charset=utf-8')
    .attachment('pick-what-we-watch-shortlist.csv')
    .send([headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n'));
});

app.post('/api/import/list', asyncRoute(async (req, res) => {
  if (!config().allow_guest_additions && !req.session?.admin) {
    return res.status(403).json({ error: 'The host has locked shortlist additions for this session.' });
  }
  let entries;
  try { entries = parseImportEntries(req.body || {}); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!entries.length) return res.status(400).json({ error: 'Paste a list or choose a CSV with titles.' });
  const settings = config();
  const matched = [], unmatched = [];
  for (let start = 0; start < entries.length; start += 50) {
    const batch = await mapLimit(entries.slice(start, start + 50), 4, async entry => ({
      entry, item: await matchImportEntry(entry, settings)
    }));
    for (const result of batch) {
      if (result.item) matched.push(result.item);
      else unmatched.push(result.entry);
    }
  }
  res.json({ matched, unmatched });
}));

app.get('/api/shortlist', (req, res) => {
  const state = roundState();
  const titles = activeListTitles(state);
  res.json(state.votingMode === 'standard'
    ? titles.filter(item => matchesActiveFilters(item, activeFilterSettings()))
    : titles);
});

app.post('/api/shortlist', asyncRoute(async (req, res) => {
  const state = roundState();
  const table = activeListTable(state);
  if (!config().allow_guest_additions && !req.session?.admin) {
    return res.status(403).json({ error: 'The host has locked shortlist additions for this session.' });
  }
  if (state.votingMode === 'two_round' && state.roundId && !req.session?.admin) {
    return res.status(403).json({ error: 'The Two-Round pool is managed by the host during a session.' });
  }
  const { source, sourceId, title, type, year, poster } = req.body || {};
  if (!['plex', 'tmdb'].includes(source) || !sourceId || !title || !['movie', 'tv'].includes(type)) {
    return res.status(400).json({ error: 'Incomplete title information.' });
  }
  if (!mediaTypeAllowed(type)) return res.status(400).json({ error: 'That media type is disabled by the host.' });
  if (source === 'tmdb' && !new RegExp(`^${type}:\\d+$`).test(String(sourceId))) {
    return res.status(400).json({ error: 'Invalid TMDB title ID.' });
  }
  if (db.prepare(`SELECT 1 FROM ${table} WHERE source=? AND source_id=?`).get(source, String(sourceId))) {
    return res.status(409).json({ error: 'That title is already shortlisted.' });
  }
  const maxSize = table === 'shortlist' ? shortlistMaxSize() : state.finalistsCount * 6;
  if (listCount(table) >= maxSize) {
    return res.status(409).json({ error: `The active list is full (${maxSize} titles maximum).` });
  }
  const item = {
    source, sourceId: String(sourceId), title: String(title), type,
    year: Number(year) || null, poster: String(poster || '')
  };
  const settings = config();
  const details = await enrichShortlist(item, settings);
  if (listCount(table) >= maxSize) {
    return res.status(409).json({ error: `The active list is full (${maxSize} titles maximum).` });
  }
  if (db.prepare(`SELECT 1 FROM ${table} WHERE source=? AND source_id=?`).get(source, item.sourceId)) {
    return res.status(409).json({ error: 'That title is already shortlisted.' });
  }
  saveShortlistItem(item, details, table);
  res.status(201).json({ id: `${source}:${sourceId}` });
}));

app.get('/api/ballot', (req, res) => {
  const voter = String(req.query.voter || '').trim().slice(0, 60);
  const ballot = voter ? db.prepare('SELECT ranks,approvals,vetoes FROM ballots WHERE voter=? COLLATE NOCASE').get(voter) : null;
  res.json(ballot ? {
    ranks: JSON.parse(ballot.ranks), approvals: JSON.parse(ballot.approvals), vetoes: JSON.parse(ballot.vetoes)
  } : { ranks: [], approvals: [], vetoes: [] });
});

app.post('/api/ballot', (req, res) => {
  const state = roundState();
  if (state.votingMode === 'two_round' && state.roundStage !== 'round2') {
    return res.status(409).json({
      error: state.roundStage === 'draft'
        ? 'The host has not opened Round 1 voting yet.'
        : 'Use the Round 1 card-by-card ballot.'
    });
  }
  const voter = String(req.body?.voter || '').trim().slice(0, 60);
  const ranks = Array.isArray(req.body?.ranks) ? req.body.ranks.map(String) : [];
  const approvals = Array.isArray(req.body?.approvals) ? [...new Set(req.body.approvals.map(String))] : [];
  const vetoes = Array.isArray(req.body?.vetoes) ? [...new Set(req.body.vetoes.map(String))] : [];
  if (!voter) return res.status(400).json({ error: 'Enter your name before voting.' });
  if (ranks.length > 3 || new Set(ranks).size !== ranks.length) return res.status(400).json({ error: 'Choose up to three distinct ranked titles.' });
  const activeTable = activeListTable(state);
  const titles = shortlistTitles(activeTable, activeTable === 'two_round_pool' && state.roundStage === 'round2');
  const ids = new Set(titles.filter(item => state.votingMode === 'standard'
    ? matchesActiveFilters(item, activeFilterSettings())
    : mediaTypeAllowed(item.type)).map(item => item.id));
  if ([...ranks, ...approvals, ...vetoes].some(id => !ids.has(id))) return res.status(400).json({ error: 'Your ballot contains a title no longer on the shortlist.' });
  db.prepare(`INSERT INTO ballots (voter,ranks,approvals,vetoes,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(voter) DO UPDATE SET ranks=excluded.ranks,approvals=excluded.approvals,
    vetoes=excluded.vetoes,updated_at=excluded.updated_at`)
    .run(voter, JSON.stringify(ranks), JSON.stringify(approvals), JSON.stringify(vetoes), new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/results', (req, res) => {
  const state = roundState();
  const table = activeListTable(state);
  const round2Active = table === 'two_round_pool' && state.roundStage === 'round2';
  const titles = table === 'two_round_pool' && !round2Active
    ? []
    : shortlistTitles(table, round2Active)
      .filter(item => state.votingMode === 'standard'
        ? matchesActiveFilters(item, activeFilterSettings())
        : mediaTypeAllowed(item.type))
      .map(({ id, title, type, year, poster, source, sourceId }) =>
        ({ id, title, type, year, poster, source, sourceId }));
  const ballots = db.prepare('SELECT voter,ranks,approvals,vetoes FROM ballots').all();
  const results = titles.map(title => {
    let score = 0, first = 0, second = 0;
    const willing = new Set(), vetoedBy = [];
    for (const ballot of ballots) {
      const ranks = JSON.parse(ballot.ranks);
      const approvals = JSON.parse(ballot.approvals);
      const vetoes = JSON.parse(ballot.vetoes);
      const rank = ranks.indexOf(title.id);
      if (rank === 0) { score += 3; first++; }
      if (rank === 1) { score += 2; second++; }
      if (rank === 2) score += 1;
      if (rank >= 0 || approvals.includes(title.id)) willing.add(ballot.voter);
      if (vetoes.includes(title.id)) { score -= 5; vetoedBy.push(ballot.voter); }
    }
    return { ...title, score, willing: willing.size, voters: ballots.length, first, second, vetoedBy };
  });
  results.sort((a, b) => b.score - a.score || b.willing - a.willing || b.first - a.first || b.second - a.second || a.title.localeCompare(b.title));
  res.json({ results, voters: ballots.length });
});

app.get('/admin', (req, res, next) => {
  if (!req.session?.admin) return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), error => error && next(error));
});
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.use(express.static(path.join(__dirname, 'public')));
app.get(['/vote', '/results'], (req, res) => res.sendFile(path.join(__dirname, 'public', `${req.path.slice(1)}.html`)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: error.message || 'Internal server error.' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Pick What We Watch is running at http://0.0.0.0:${port}`);
});

require('dotenv').config(process.env.PWW_ENV_PATH ? { path: process.env.PWW_ENV_PATH } : {});
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { createPin, getLabels, getLibraries, getSyncStats, plexServers, pollPin, syncLibraries } = require('./plex');
const { enrichShortlist } = require('./metadata');
const { isAllowedByRating, needsCertification } = require('./ratings');
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
const providers = [
  ['Netflix', 8], ['Disney+', 337], ['Hulu', 15], ['Max', 1899],
  ['Prime Video', 9], ['Apple TV+', 350], ['Peacock', 386], ['Paramount+', 531]
];

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
  voting_mode: 'standard',
  round_stage: 'round1',
  finalists_count: '10',
  round1_id: ''
})) {
  db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, value);
}

function shortlistMaxSize() {
  const size = Number(getSetting('shortlist_max_size', '20'));
  return Number.isInteger(size) && size >= 3 && size <= 100 ? size : 20;
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

const insertShortlistRow = db.prepare(`INSERT INTO shortlist
  (id,source,source_id,title,type,year,poster,summary,content_rating,genres,cast_top2,director,metacritic_score,
    imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers,runtime_mins,tmdb_vote_average,tmdb_vote_count)
  VALUES (@id,@source,@sourceId,@title,@type,@year,@poster,@summary,@content_rating,@genres,@cast_top2,@director,
    @metacritic_score,@imdb_rating,@rt_score,@imdb_id,@imdb_top250_rank,@providers,@runtime_mins,@tmdb_vote_average,@tmdb_vote_count)`);

function saveShortlistItem(item, details) {
  const id = `${item.source}:${item.sourceId}`;
  insertShortlistRow.run({
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

async function fillShortlistTo(targetSize, settings, options) {
  const currentCount = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  const needed = targetSize - currentCount;
  if (needed <= 0) return { addedCount: 0, newTotal: currentCount };
  const plex = await qualifyPlexCandidates(
    plexFillCandidates(settings, options.genres, options.eras, options.minDuration, options.maxDuration),
    settings.tmdbKey, options.eras
  );
  const streaming = await tmdbFillCandidates(
    settings, options.genres, options.eras, needed, options.minDuration, options.maxDuration
  );
  const known = db.prepare('SELECT source,source_id AS sourceId,title,type,year FROM shortlist').all();
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
    let total = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
    const existing = db.prepare('SELECT source,source_id AS sourceId,title,type,year FROM shortlist').all();
    let addedCount = 0;
    for (const { item, details } of items) {
      if (total >= targetSize) break;
      if (existing.some(row =>
        (row.source === item.source && row.sourceId === item.sourceId) || sameTitle(row, item)
      )) continue;
      saveShortlistItem(item, details);
      existing.push(item);
      total++;
      addedCount++;
    }
    return { addedCount, newTotal: total };
  })(enriched);
}

function shortlistTitles() {
  return db.prepare(`SELECT s.id,s.source,s.source_id AS sourceId,s.title,s.type,s.year,s.poster,s.summary,
    s.content_rating AS contentRating,s.genres,s.cast_top2 AS castTop2,s.director,
    s.metacritic_score AS metacriticScore,s.imdb_rating AS imdbRating,s.rt_score AS rtScore,
    s.imdb_id AS imdbId,s.imdb_top250_rank AS imdbTop250Rank,s.providers,
    COALESCE(s.runtime_mins, p.duration_mins) AS runtimeMins,
    s.tmdb_vote_average AS tmdbVoteAverage,s.tmdb_vote_count AS tmdbVoteCount
    FROM shortlist s LEFT JOIN plex_titles p ON s.source='plex' AND p.id=s.source_id
    ORDER BY s.title COLLATE NOCASE`).all().map(item => ({
    ...item, genres: JSON.parse(item.genres || '[]'), castTop2: JSON.parse(item.castTop2 || '[]'),
    providers: JSON.parse(item.providers || '[]')
  }));
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
    shortlistMaxSize: c.shortlistMaxSize,
    providers: c.providers, providerOptions: providers,
    votingClosed: getSetting('voting_closed', 'false') === 'true',
    ...roundState(),
    roundPoolSize: db.prepare('SELECT count(*) AS count FROM shortlist').get().count
  });
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

app.post('/api/admin/settings', adminOnly, (req, res) => {
  const body = req.body || {};
  const plexToken = String(body.plexToken || '').trim();
  const chosen = Array.isArray(body.providers) ? body.providers.map(Number) : [];
  const allowed = new Set(providers.map(([, id]) => id));
  if (chosen.some(id => !allowed.has(id))) return res.status(400).json({ error: 'Invalid streaming provider selection.' });
  const movieRatings = ['G', 'PG', 'PG-13', 'R', 'ALL'];
  const tvRatings = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'ALL'];
  const maxMovieRating = String(body.maxMovieRating ?? getSetting('max_movie_rating', 'ALL'));
  const maxTvRating = String(body.maxTvRating ?? getSetting('max_tv_rating', 'ALL'));
  const maxShortlistSize = body.shortlistMaxSize == null
    ? shortlistMaxSize()
    : Number(body.shortlistMaxSize);
  if (!Number.isInteger(maxShortlistSize) || maxShortlistSize < 3 || maxShortlistSize > 100) {
    return res.status(400).json({ error: 'Max shortlist size must be an integer from 3 to 100.' });
  }
  if (!movieRatings.includes(maxMovieRating) || !tvRatings.includes(maxTvRating)) {
    return res.status(400).json({ error: 'Invalid content rating selection.' });
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
    shortlist_max_size: maxShortlistSize,
    providers: JSON.stringify([...new Set(chosen)])
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

app.post('/api/admin/voting', adminOnly, (req, res) => {
  setSetting('voting_closed', req.body?.closed ? 'true' : 'false');
  res.json({ closed: req.body?.closed === true });
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
    db.prepare('DELETE FROM round1_votes').run();
    setSetting('round1_id', '');
    setSetting('round_stage', mode === 'two_round' ? 'draft' : 'round1');
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
  const currentCount = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  const result = await fillShortlistTo(Math.max(poolSize, currentCount), config(), options);
  if (!result.newTotal) return res.status(400).json({ error: 'Add titles to the shortlist or configure a source before generating the Round 1 pool.' });

  const roundId = randomUUID();
  const startRound = db.transaction(() => {
    db.prepare('DELETE FROM round1_votes').run();
    db.prepare('DELETE FROM ballots').run();
    setSetting('voting_mode', 'two_round');
    setSetting('round_stage', 'draft');
    setSetting('finalists_count', finalistsCount);
    setSetting('round1_id', roundId);
    setSetting('round1_fill_options', JSON.stringify(options));
    setSetting('voting_closed', 'false');
  });
  startRound();
  res.json({ ...roundState(), poolSize: result.newTotal, addedCount: result.addedCount });
}));

app.post('/api/admin/round1/refill', adminOnly, asyncRoute(async (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'draft' || !state.roundId) {
    return res.status(409).json({ error: 'The Round 1 pool can only be re-filled during draft review.' });
  }
  let options;
  try { options = parseFillOptions(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const targetSize = state.finalistsCount * 6;
  const result = await fillShortlistTo(targetSize, config(), options);
  setSetting('round1_fill_options', JSON.stringify(options));
  res.json({ ...result, poolSize: result.newTotal, targetSize });
}));

app.post('/api/admin/round1/release', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'draft' || !state.roundId) {
    return res.status(409).json({ error: 'There is no Round 1 draft to release.' });
  }
  const poolSize = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  if (poolSize < state.finalistsCount + 1) {
    return res.status(400).json({
      error: `The pool needs at least ${state.finalistsCount + 1} items before Round 1 can start.`
    });
  }
  setSetting('round_stage', 'round1');
  setSetting('voting_closed', 'false');
  res.json({ ...roundState(), poolSize });
});

app.get('/api/admin/round1/progress', adminOnly, (req, res) => {
  const state = roundState();
  const poolSize = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  const voters = db.prepare(`SELECT v.voter_name AS name, count(DISTINCT v.item_id) AS completed
    FROM round1_votes v JOIN shortlist s ON s.id = v.item_id
    GROUP BY v.voter_name COLLATE NOCASE ORDER BY v.voter_name COLLATE NOCASE`).all()
    .map(voter => ({ ...voter, done: poolSize > 0 && voter.completed >= poolSize }));
  res.json({ ...state, poolSize, voters });
});

app.post('/api/admin/round2/start', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'There is no active Round 1 pool.' });
  }
  const items = db.prepare('SELECT id FROM shortlist').all();
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
    const keep = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM shortlist WHERE id NOT IN (${keep})`).run(...ids);
    setSetting('round_stage', 'round2');
  });
  beginRound2(finalists);
  res.json({ roundStage: 'round2', finalistsCount: finalists.length });
});

app.delete('/api/admin/shortlist/:id', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode === 'two_round' && state.roundId && state.roundStage !== 'draft') {
    return res.status(409).json({ error: 'The shortlist is locked during two-round voting.' });
  }
  db.prepare('DELETE FROM shortlist WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/shortlist', adminOnly, (req, res) => {
  const state = roundState();
  if (state.votingMode === 'two_round' && state.roundId && state.roundStage !== 'draft') {
    return res.status(409).json({ error: 'The shortlist is locked during two-round voting.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM shortlist').run();
    db.prepare('DELETE FROM ballots').run();
    db.prepare('DELETE FROM round1_votes').run();
    setSetting('round1_id', '');
    setSetting('round_stage', getSetting('voting_mode', 'standard') === 'two_round' ? 'draft' : 'round1');
  })();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json({
  votingClosed: getSetting('voting_closed', 'false') === 'true',
  shortlistCount: db.prepare('SELECT count(*) AS count FROM shortlist').get().count,
  shortlistMaxSize: shortlistMaxSize(),
  ...roundState()
}));

app.get('/api/session/status', (req, res) => res.json({
  votingClosed: getSetting('voting_closed', 'false') === 'true',
  shortlistCount: db.prepare('SELECT count(*) AS count FROM shortlist').get().count,
  ...roundState()
}));

app.get('/api/round1/pool', (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'Round 1 is not active.' });
  }
  const voter = String(req.query.voter || '').trim().slice(0, 60);
  const items = shortlistTitles();
  const votes = Object.fromEntries(db.prepare(`SELECT item_id AS id, vote FROM round1_votes
    WHERE voter_name = ? COLLATE NOCASE`).all(voter).map(vote => [vote.id, vote.vote]));
  res.json({ roundId: state.roundId, items, votes });
});

app.post('/api/round1/vote', (req, res) => {
  const state = roundState();
  if (state.votingMode !== 'two_round' || state.roundStage !== 'round1' || !state.roundId) {
    return res.status(409).json({ error: 'Round 1 is not active.' });
  }
  if (getSetting('voting_closed', 'false') === 'true') return res.status(403).json({ error: 'Voting is closed.' });
  const voter = String(req.body?.voter || '').trim().slice(0, 60);
  const itemId = String(req.body?.itemId || '');
  const vote = req.body?.vote;
  if (!voter) return res.status(400).json({ error: 'Enter your name before voting.' });
  if (!itemId || ![0, 1].includes(vote)) return res.status(400).json({ error: 'Choose Yes or No for a title.' });
  if (!db.prepare('SELECT 1 FROM shortlist WHERE id = ?').get(itemId)) {
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
    omdbConfigured: Boolean(c.omdbKey)
  });
});

app.get('/api/search', asyncRoute(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json([]);
  const needle = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const settings = config();
  const plex = db.prepare(`SELECT id, title, type, year, poster, summary, rating
    FROM plex_titles WHERE title LIKE ? ESCAPE '\\' ORDER BY title`).all(needle)
    .filter(item => isAllowedByRating(item.type, item.rating, settings))
    .slice(0, 30)
    .map(({ rating, ...item }) => ({ ...item, source: 'plex', sourceId: item.id }));
  const remote = await tmdb.search(query, settings);
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
  if (roundState().votingMode === 'two_round' && roundState().roundId) {
    return res.status(409).json({ error: 'Use Generate Round 1 Pool to change a two-round shortlist.' });
  }
  if (getSetting('voting_closed', 'false') === 'true') {
    return res.status(403).json({ error: 'Shortlist editing is closed.' });
  }
  const settings = config();
  let options;
  try { options = parseFillOptions(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const currentCount = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  const result = await fillShortlistTo(settings.shortlistMaxSize, settings, options);
  res.json({
    ...result,
    ...(result.addedCount ? {} : {
      message: currentCount >= settings.shortlistMaxSize ? 'Shortlist is already full' : 'No matching titles found.'
    })
  });
}));

app.get('/api/shortlist', (req, res) => {
  res.json(shortlistTitles());
});

app.post('/api/shortlist', asyncRoute(async (req, res) => {
  if (roundState().votingMode === 'two_round' && roundState().roundId) {
    return res.status(403).json({ error: 'The shortlist is locked during two-round voting.' });
  }
  if (getSetting('voting_closed', 'false') === 'true') return res.status(403).json({ error: 'Shortlist editing is closed.' });
  const { source, sourceId, title, type, year, poster } = req.body || {};
  if (!['plex', 'tmdb'].includes(source) || !sourceId || !title || !['movie', 'tv'].includes(type)) {
    return res.status(400).json({ error: 'Incomplete title information.' });
  }
  if (source === 'tmdb' && !new RegExp(`^${type}:\\d+$`).test(String(sourceId))) {
    return res.status(400).json({ error: 'Invalid TMDB title ID.' });
  }
  if (db.prepare('SELECT 1 FROM shortlist WHERE source=? AND source_id=?').get(source, String(sourceId))) {
    return res.status(409).json({ error: 'That title is already shortlisted.' });
  }
  if (db.prepare('SELECT count(*) AS count FROM shortlist').get().count >= shortlistMaxSize()) {
    return res.status(409).json({ error: `The shortlist is full (${shortlistMaxSize()} titles maximum).` });
  }
  const item = {
    source, sourceId: String(sourceId), title: String(title), type,
    year: Number(year) || null, poster: String(poster || '')
  };
  const settings = config();
  const details = await enrichShortlist(item, settings);
  const count = db.prepare('SELECT count(*) AS count FROM shortlist').get().count;
  if (count >= settings.shortlistMaxSize) {
    return res.status(409).json({ error: `The shortlist is full (${settings.shortlistMaxSize} titles maximum).` });
  }
  if (db.prepare('SELECT 1 FROM shortlist WHERE source=? AND source_id=?').get(source, item.sourceId)) {
    return res.status(409).json({ error: 'That title is already shortlisted.' });
  }
  saveShortlistItem(item, details);
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
  if (getSetting('voting_closed', 'false') === 'true') return res.status(403).json({ error: 'Voting is closed.' });
  const voter = String(req.body?.voter || '').trim().slice(0, 60);
  const ranks = Array.isArray(req.body?.ranks) ? req.body.ranks.map(String) : [];
  const approvals = Array.isArray(req.body?.approvals) ? [...new Set(req.body.approvals.map(String))] : [];
  const vetoes = Array.isArray(req.body?.vetoes) ? [...new Set(req.body.vetoes.map(String))] : [];
  if (!voter) return res.status(400).json({ error: 'Enter your name before voting.' });
  if (ranks.length > 3 || new Set(ranks).size !== ranks.length) return res.status(400).json({ error: 'Choose up to three distinct ranked titles.' });
  const ids = new Set(db.prepare('SELECT id FROM shortlist').all().map(row => row.id));
  if ([...ranks, ...approvals, ...vetoes].some(id => !ids.has(id))) return res.status(400).json({ error: 'Your ballot contains a title no longer on the shortlist.' });
  db.prepare(`INSERT INTO ballots (voter,ranks,approvals,vetoes,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(voter) DO UPDATE SET ranks=excluded.ranks,approvals=excluded.approvals,
    vetoes=excluded.vetoes,updated_at=excluded.updated_at`)
    .run(voter, JSON.stringify(ranks), JSON.stringify(approvals), JSON.stringify(vetoes), new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/results', (req, res) => {
  const titles = db.prepare('SELECT id,title,type,year,poster,source,source_id AS sourceId FROM shortlist').all();
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

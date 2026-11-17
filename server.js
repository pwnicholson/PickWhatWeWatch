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
  max_movie_rating: 'ALL',
  include_unrated_movies: 'true',
  max_tv_rating: 'ALL',
  include_unrated_tv: 'true'
})) {
  db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, value);
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
    providers: c.providers, providerOptions: providers,
    votingClosed: getSetting('voting_closed', 'false') === 'true'
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

app.delete('/api/admin/shortlist/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM shortlist WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/shortlist', adminOnly, (req, res) => {
  db.prepare('DELETE FROM shortlist').run();
  db.prepare('DELETE FROM ballots').run();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json({
  votingClosed: getSetting('voting_closed', 'false') === 'true',
  shortlistCount: db.prepare('SELECT count(*) AS count FROM shortlist').get().count
}));

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

app.get('/api/shortlist', (req, res) => {
  const titles = db.prepare(`SELECT id,source,source_id AS sourceId,title,type,year,poster,genres,
    cast_top2 AS castTop2,director,metacritic_score AS metacriticScore,imdb_rating AS imdbRating,
    rt_score AS rtScore,imdb_id AS imdbId,imdb_top250_rank AS imdbTop250Rank,providers
    FROM shortlist ORDER BY title COLLATE NOCASE`).all();
  res.json(titles.map(item => ({
    ...item, genres: JSON.parse(item.genres || '[]'), castTop2: JSON.parse(item.castTop2 || '[]'),
    providers: JSON.parse(item.providers || '[]')
  })));
});

app.post('/api/shortlist', asyncRoute(async (req, res) => {
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
  if (db.prepare('SELECT count(*) AS count FROM shortlist').get().count >= 20) {
    return res.status(409).json({ error: 'The shortlist is full (20 titles maximum).' });
  }
  const details = await enrichShortlist({
    source, sourceId: String(sourceId), title: String(title), type,
    year: Number(year) || null
  }, config());
  const id = `${source}:${sourceId}`;
  db.prepare(`INSERT INTO shortlist
    (id,source,source_id,title,type,year,poster,genres,cast_top2,director,metacritic_score,
      imdb_rating,rt_score,imdb_id,imdb_top250_rank,providers)
    VALUES (@id,@source,@sourceId,@title,@type,@year,@poster,@genres,@cast_top2,@director,
      @metacritic_score,@imdb_rating,@rt_score,@imdb_id,@imdb_top250_rank,@providers)`)
    .run({
      id, source, sourceId: String(sourceId), title: String(title), type, year: Number(year) || null,
      poster: String(poster || ''), ...details
    });
  res.status(201).json({ id });
}));

app.get('/api/ballot', (req, res) => {
  const voter = String(req.query.voter || '').trim().slice(0, 60);
  const ballot = voter ? db.prepare('SELECT ranks,approvals,vetoes FROM ballots WHERE voter=? COLLATE NOCASE').get(voter) : null;
  res.json(ballot ? {
    ranks: JSON.parse(ballot.ranks), approvals: JSON.parse(ballot.approvals), vetoes: JSON.parse(ballot.vetoes)
  } : { ranks: [], approvals: [], vetoes: [] });
});

app.post('/api/ballot', (req, res) => {
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

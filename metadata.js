const db = require('./db');
const imdbTop250 = require('./data/imdb_top_250.json');
const tmdb = require('./tmdb');

function storedList(value) {
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) throw new Error('Stored title metadata is invalid.');
  return parsed;
}

function score(value) {
  const result = String(value || '').trim();
  return result && result !== 'N/A' ? result : null;
}

async function omdbDetails(title, year, imdbId, key) {
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key);
  if (imdbId) url.searchParams.set('i', imdbId);
  else {
    url.searchParams.set('t', title);
    if (year) url.searchParams.set('y', String(year));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OMDb returned ${response.status}.`);
  const item = await response.json();
  if (item.Response === 'False') {
    if (/invalid api key|request limit/i.test(item.Error || '')) {
      throw new Error(`OMDb lookup failed: ${item.Error}`);
    }
    return null;
  }
  return {
    imdbId: item.imdbID || imdbId || '',
    metacriticScore: score(item.Metascore),
    imdbRating: score(item.imdbRating),
    rtScore: score(item.Ratings?.find(rating => rating.Source === 'Rotten Tomatoes')?.Value)
  };
}

async function enrichShortlist(item, config) {
  const plex = item.source === 'plex'
    ? db.prepare('SELECT poster,summary,rating,genres,cast_top2,director FROM plex_titles WHERE id=?').get(item.sourceId)
    : null;
  let tmdbItem = null;
  if (config.tmdbKey) {
    if (item.source === 'tmdb') {
      const match = String(item.sourceId).match(/^(movie|tv):(\d+)$/);
      if (!match || match[1] !== item.type) throw new Error('Invalid TMDB title ID.');
      tmdbItem = await tmdb.details(match[1], match[2], config);
    } else {
      tmdbItem = await tmdb.findDetails(item.title, item.type, item.year, config);
    }
  }

  const genres = tmdbItem?.genres?.length ? tmdbItem.genres : storedList(plex?.genres);
  const castTop2 = tmdbItem?.castTop2?.length ? tmdbItem.castTop2 : storedList(plex?.cast_top2);
  const director = tmdbItem?.director || plex?.director || '';
  let imdbId = tmdbItem?.imdbId || '';
  const omdbItem = config.omdbKey
    ? await omdbDetails(item.title, item.year, imdbId, config.omdbKey)
    : null;
  imdbId = omdbItem?.imdbId || imdbId;

  return {
    poster: tmdbItem?.poster || plex?.poster || '',
    summary: tmdbItem?.summary || plex?.summary || '',
    content_rating: tmdbItem?.rating || plex?.rating || '',
    genres: JSON.stringify(genres),
    cast_top2: JSON.stringify(castTop2),
    director,
    metacritic_score: omdbItem?.metacriticScore || null,
    imdb_rating: omdbItem?.imdbRating || null,
    rt_score: omdbItem?.rtScore || null,
    imdb_id: imdbId || null,
    imdb_top250_rank: imdbTop250[imdbId] || null,
    providers: JSON.stringify([...new Set((tmdbItem?.providers || []).map(provider => provider.provider_name).filter(Boolean))])
  };
}

module.exports = { enrichShortlist };

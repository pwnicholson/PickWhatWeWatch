const db = require('./db');
const { isAllowedByRating } = require('./ratings');
const tmdb = require('./tmdb');

const fillGenres = {
  Action: { plex: ['action'], tmdb: ['28', '10759'] },
  Adventure: { plex: ['adventure'], tmdb: ['12', '10759'] },
  Animation: { plex: ['animation'], tmdb: ['16'] },
  Comedy: { plex: ['comedy'], tmdb: ['35'] },
  Crime: { plex: ['crime'], tmdb: ['80'] },
  Documentary: { plex: ['documentary'], tmdb: ['99'] },
  Drama: { plex: ['drama'], tmdb: ['18'] },
  Family: { plex: ['family'], tmdb: ['10751'] },
  Horror: { plex: ['horror'], tmdb: ['27'] },
  Mystery: { plex: ['mystery'], tmdb: ['9648'] },
  Romance: { plex: ['romance'], tmdb: ['10749'] },
  'Sci-Fi / Fantasy': { plex: ['science fiction', 'sci-fi', 'sci fi', 'fantasy'], tmdb: ['878', '14', '10765'] }
};

function fillEras() {
  const year = new Date().getFullYear();
  const eras = [
    { start: 1910, end: 1928, label: '1910–1928' },
    { start: 1929, end: 1949, label: '1929–1949' },
    { start: 1950, end: 1965, label: '1950–1965' },
    { start: 1966, end: 1979, label: '1966–1979' },
    { start: 1980, end: 1989, label: '1980–1989' },
    { start: 1990, end: 1999, label: '1990–1999' },
    { start: 2000, end: 2009, label: '2000–2009' },
    { start: 2010, end: 2019, label: '2010–2019' }
  ];
  const currentDecade = Math.floor(year / 10) * 10;
  for (let start = 2020; start <= currentDecade; start += 10) {
    const active = start === currentDecade;
    eras.push({ start, end: active ? year : start + 9, label: active ? `${start}–Present` : `${start}–${start + 9}` });
  }
  return eras.map(era => ({ ...era, id: `${era.start}:${era.end}` }));
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

async function mapLimit(items, limit, handler) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await handler(items[index], index);
    }
  }));
  return results;
}

function normalizeTitle(title) {
  return String(title || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function sameTitle(left, right) {
  const title = normalizeTitle(left.title);
  if (!title || left.type !== right.type || title !== normalizeTitle(right.title)) return false;
  return left.year == null || right.year == null || Math.abs(Number(left.year) - Number(right.year)) <= 1;
}

function effectiveMaxDuration(maxDuration) {
  return maxDuration === 9999 ? 9999 : maxDuration + 5;
}

function storedAudienceRating(item) {
  const value = item.audience_rating ?? item.rating;
  if (value == null || value === '') return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function plexFillCandidates(settings, genreNames, eras, minDuration = 0, maxDuration = 9999) {
  const sectionIds = settings.sectionIds.split(',').map(value => value.trim()).filter(id => /^\d+$/.test(id));
  if (!sectionIds.length) return [];
  const placeholders = sectionIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id,title,type,year,poster,summary,rating,audience_rating,duration_mins,genres,section_id,labels
    FROM plex_titles WHERE section_id IN (${placeholders})`).all(...sectionIds);
  const selectedGenres = genreNames.map(name => fillGenres[name]);
  const labelFilters = new Set(settings.labels);
  const effectiveMax = effectiveMaxDuration(maxDuration);
  const matches = rows.filter(item => {
    const labels = JSON.parse(item.labels || '[]').map(label => String(label).toLowerCase());
    if (labelFilters.size && !labels.some(label => labelFilters.has(label))) return false;
    if (eras.length && !eras.some(era => item.year >= era.start && item.year <= era.end)) return false;
    const genres = JSON.parse(item.genres || '[]').map(genre => String(genre).trim().toLowerCase());
    if (selectedGenres.length && !selectedGenres.some(mapping =>
      mapping.plex.some(genre => genres.some(value => value.includes(genre)))
    )) return false;
    if (!isAllowedByRating(item.type, item.rating, settings)) return false;
    const audienceRating = storedAudienceRating(item);
    if (audienceRating != null && audienceRating < 7.3) return false;
    const rawRuntime = item.duration_mins;
    const runtime = rawRuntime == null || rawRuntime === '' ? null : Number(rawRuntime);
    const hasRuntime = Number.isFinite(runtime) && runtime > 0;
    if (item.type === 'movie') {
      if (!hasRuntime || runtime < minDuration || runtime > effectiveMax) return false;
    }
    if (item.type === 'tv' && hasRuntime && runtime > effectiveMax) return false;
    return true;
  }).map(item => ({
    source: 'plex', sourceId: item.id, title: item.title, type: item.type, year: item.year,
    poster: item.poster, audienceRating: storedAudienceRating(item)
  }));
  return shuffle(matches.slice(0, 500)).slice(0, 200);
}

function tmdbDiscoverFilters(type, genreIds, era, settings, page, minDuration, maxDuration) {
  const isMovie = type === 'movie';
  const filters = {
    include_adult: 'false',
    watch_region: 'US',
    with_watch_providers: settings.providers.join('|'),
    with_watch_monetization_types: 'flatrate|free|ads',
    with_genres: genreIds.join('|'),
    'vote_average.gte': isMovie ? '7.2' : '7.3',
    'vote_count.gte': isMovie ? '1250' : '750',
    page
  };
  if (isMovie) {
    filters['with_runtime.gte'] = minDuration;
    filters['with_runtime.lte'] = effectiveMaxDuration(maxDuration);
  }
  if (era) {
    const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    filters[`${dateField}.gte`] = `${era.start}-01-01`;
    filters[`${dateField}.lte`] = `${era.end}-12-31`;
  }
  const maxRating = settings[type === 'movie' ? 'max_movie_rating' : 'max_tv_rating'];
  const includeUnrated = settings[type === 'movie' ? 'include_unrated_movies' : 'include_unrated_tv'];
  if (maxRating !== 'ALL' || !includeUnrated) {
    filters.certification_country = 'US';
    if (maxRating !== 'ALL') filters['certification.lte'] = maxRating;
    if (!includeUnrated) filters['certification.gte'] = type === 'movie' ? 'G' : 'TV-Y';
  }
  return filters;
}

function meetsTmdbQuality(item, type) {
  const votes = Number(item.vote_count);
  const rating = Number(item.vote_average);
  if (!Number.isFinite(votes) || !Number.isFinite(rating)) return false;
  if (type === 'movie') {
    if (votes < 1250) return false;
    return rating >= (votes >= 8000 ? 7.2 : votes >= 3000 ? 7.4 : 7.7);
  }
  if (votes < 750) return false;
  return rating >= (votes >= 5000 ? 7.3 : votes >= 2000 ? 7.5 : 7.8);
}

function tmdbRuntime(item) {
  const episodeRuntime = Number(item.episode_run_time?.[0]);
  const lastEpisodeRuntime = Number(item.last_episode_to_air?.runtime);
  if (Number.isFinite(episodeRuntime) && episodeRuntime > 0) return episodeRuntime;
  return Number.isFinite(lastEpisodeRuntime) && lastEpisodeRuntime > 0 ? lastEpisodeRuntime : null;
}

async function tmdbFillCandidates(settings, genreNames, eras, needed, minDuration = 0, maxDuration = 9999) {
  if (!settings.tmdbKey || !settings.providers.length) return [];
  const selectedEras = eras.length ? eras : [null];
  const genreIds = [...new Set(genreNames.flatMap(name => fillGenres[name].tmdb))];
  const jobs = ['movie', 'tv'].flatMap(type => selectedEras.map(era => ({ type, era })));
  const pagesPerJob = Math.min(3, Math.max(1, Math.ceil(needed / (jobs.length * 20))));
  const firstPages = await mapLimit(jobs, 6, async job => ({
    job,
    result: await tmdb.discover(job.type,
      tmdbDiscoverFilters(job.type, genreIds, job.era, settings, 1, minDuration, maxDuration), settings.tmdbKey)
  }));
  const pages = await mapLimit(firstPages, 6, async ({ job, result }) => {
    const maxPage = Math.min(15, Math.max(1, Number(result.total_pages) || 1));
    const pageNumbers = shuffle(Array.from({ length: maxPage }, (_, index) => index + 1)).slice(0, Math.min(pagesPerJob, maxPage));
    const responses = await mapLimit(pageNumbers, 3, page =>
      page === 1 ? result : tmdb.discover(job.type,
        tmdbDiscoverFilters(job.type, genreIds, job.era, settings, page, minDuration, maxDuration), settings.tmdbKey)
    );
    return responses.flatMap(response => (response.results || []).map(item => {
      const year = Number(String(job.type === 'movie' ? item.release_date || '' : item.first_air_date || '').slice(0, 4)) || null;
      return {
        source: 'tmdb', sourceId: `${job.type}:${item.id}`, title: job.type === 'movie' ? item.title : item.name,
        type: job.type === 'movie' ? 'movie' : 'tv', year,
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '',
        certification: item.certification, voteCount: item.vote_count, voteAverage: item.vote_average,
        runtime: job.type === 'tv' ? tmdbRuntime(item) : item.runtime
      };
    }));
  });
  let candidates = pages.flat().filter(item => item.title && meetsTmdbQuality({
    vote_count: item.voteCount,
    vote_average: item.voteAverage
  }, item.type) &&
    (!eras.length || eras.some(era => item.year >= era.start && item.year <= era.end)));
  if (maxDuration !== 9999) {
    const effectiveMax = effectiveMaxDuration(maxDuration);
    candidates = await mapLimit(candidates, 6, async item => {
      if (item.type !== 'tv') return item;
      if (item.runtime == null) item.runtime = await tmdb.tvRuntime(item.sourceId.slice(3), settings.tmdbKey);
      return item.runtime == null || item.runtime <= effectiveMax ? item : null;
    });
  }
  return candidates.filter(item => item &&
    (item.certification == null || isAllowedByRating(item.type, item.certification, settings)));
}

module.exports = {
  fillGenres, fillEras, mapLimit, plexFillCandidates, sameTitle, shuffle, tmdbFillCandidates,
  effectiveMaxDuration, meetsTmdbQuality
};

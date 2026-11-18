const providerCache = new Map();
const certificationCache = new Map();
const CACHE_MS = 15 * 60 * 1000;
const providerOptions = [
  ['Netflix', 8], ['Disney+', 337], ['Hulu', 15], ['Max', 1899],
  ['Prime Video', 9], ['Apple TV+', 350], ['Peacock', 386], ['Paramount+', 531],
  ['Kanopy', 191], ['Hoopla', 212], ['The Criterion Channel', 258],
  ['BritBox', 151], ['Acorn TV', 87], ['PBS', 209], ['PBS Masterpiece', 294]
];
const providerNames = new Map(providerOptions.map(([name, id]) => [
  id, id === 258 ? 'Criterion Channel' : name
]));

function matchingProviders(offers, config) {
  const active = new Set(config.providers);
  return [...new Map([...(offers?.flatrate || []), ...(offers?.free || []), ...(offers?.ads || [])]
    .filter(provider => active.has(Number(provider.provider_id)))
    .map(provider => {
      const name = providerNames.get(Number(provider.provider_id)) || provider.provider_name;
      return [provider.provider_id, { ...provider, provider_name: name }];
    })).values()];
}

async function tmdb(path, key) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDB returned ${response.status}.`);
  return response.json();
}

async function providers(type, id, key) {
  const cacheKey = `${type}:${id}`;
  const cached = providerCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.value;
  const result = await tmdb(`/${type}/${id}/watch/providers`, key);
  const value = result.results?.US || null;
  providerCache.set(cacheKey, { value, until: Date.now() + CACHE_MS });
  return value;
}

async function certification(type, id, key) {
  const cacheKey = `${type}:${id}`;
  const cached = certificationCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.value;
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const result = await tmdb(mediaType === 'movie' ? `/movie/${id}/release_dates` : `/tv/${id}/content_ratings`, key);
  const us = result.results?.find(region => region.iso_3166_1 === 'US');
  const value = mediaType === 'movie'
    ? us?.release_dates?.find(entry => entry.certification)?.certification || null
    : us?.rating || null;
  certificationCache.set(cacheKey, { value, until: Date.now() + CACHE_MS });
  return value;
}

async function discover(type, params, key) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== ''));
  return tmdb(`/discover/${type}?${query}`, key);
}

async function tvRuntime(id, key) {
  const result = await tmdb(`/tv/${encodeURIComponent(id)}`, key);
  const episodeRuntime = Number(result.episode_run_time?.[0]);
  const lastEpisodeRuntime = Number(result.last_episode_to_air?.runtime);
  if (Number.isFinite(episodeRuntime) && episodeRuntime > 0) return episodeRuntime;
  return Number.isFinite(lastEpisodeRuntime) && lastEpisodeRuntime > 0 ? lastEpisodeRuntime : null;
}

function compact(item, source) {
  const isTv = item.media_type === 'tv' || source === 'tv';
  return {
    source: 'tmdb',
    sourceId: `${isTv ? 'tv' : 'movie'}:${item.id}`,
    id: `${isTv ? 'tv' : 'movie'}:${item.id}`,
    title: isTv ? item.name : item.title,
    type: isTv ? 'tv' : 'movie',
    year: Number(String(isTv ? item.first_air_date || '' : item.release_date || '').slice(0, 4)) || null,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '',
    summary: item.overview || ''
  };
}

function creditMetadata(item, type) {
  const credits = item.credits || {};
  const castTop2 = [...(credits.cast || [])]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 2).map(person => person.name).filter(Boolean);
  const director = type === 'tv'
    ? item.created_by?.[0]?.name || credits.crew?.find(person => person.job === 'Director')?.name
    : credits.crew?.find(person => person.job === 'Director')?.name;
  return {
    genres: (item.genres || []).map(genre => genre.name).filter(Boolean),
    castTop2,
    director: director || '',
    imdbId: item.imdb_id || item.external_ids?.imdb_id || ''
  };
}

async function search(query, config) {
  if (!config.tmdbKey || !query) return [];
  const found = await tmdb(`/search/multi?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`, config.tmdbKey);
  const selected = (found.results || []).filter(item =>
    (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path
  ).slice(0, 20);
  const active = config.providers;
  if (!active.length) return [];
  const results = await Promise.all(selected.map(async item => {
    const type = item.media_type;
    const offers = await providers(type, item.id, config.tmdbKey);
    const matching = matchingProviders(offers, config);
    if (!matching.length) return null;
    return { ...compact(item), providers: [...new Map(matching.map(p => [p.provider_id, p])).values()] };
  }));
  return results.filter(Boolean);
}

async function findAvailable(query, type, year, config) {
  if (!config.tmdbKey || !config.providers.length) return null;
  const mediaTypes = type ? [type] : ['movie', 'tv'];
  const searches = await Promise.all(mediaTypes.map(async mediaType => {
    const result = await tmdb(`/search/${mediaType}?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`, config.tmdbKey);
    return (result.results || []).map(item => {
      const compactItem = compact({ ...item, media_type: mediaType });
      return { item, mediaType, compactItem };
    });
  }));
  const queryTitle = normalizeTitle(query);
  const targetYear = Number(year) || null;
  const candidates = searches.flat().filter(candidate =>
    normalizeTitle(candidate.compactItem.title) === queryTitle &&
    (!targetYear || !candidate.compactItem.year || Math.abs(targetYear - candidate.compactItem.year) <= 1)
  ).sort((a, b) => {
    const distance = candidate => targetYear && candidate.compactItem.year
      ? Math.abs(targetYear - candidate.compactItem.year)
      : Number.MAX_SAFE_INTEGER;
    return distance(a) - distance(b);
  });
  for (const candidate of candidates) {
    const offers = await providers(candidate.mediaType, candidate.item.id, config.tmdbKey);
    const matching = matchingProviders(offers, config);
    if (matching.length) {
      return {
        ...candidate.compactItem,
        providers: [...new Map(matching.map(provider => [provider.provider_id, provider])).values()]
      };
    }
  }
  return null;
}

async function details(type, id, config) {
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const [item, ratingData, offerData] = await Promise.all([
    tmdb(`/${mediaType}/${id}?append_to_response=credits&language=en-US`, config.tmdbKey),
    tmdb(mediaType === 'movie' ? `/movie/${id}/release_dates` : `/tv/${id}/content_ratings`, config.tmdbKey),
    providers(mediaType, id, config.tmdbKey)
  ]);
  let rating = '';
  if (mediaType === 'movie') {
    const us = ratingData?.results?.find(region => region.iso_3166_1 === 'US');
    rating = us?.release_dates?.find(entry => entry.certification)?.certification || '';
  } else {
    const us = ratingData?.results?.find(region => region.iso_3166_1 === 'US');
    rating = us?.rating || '';
  }
  return {
    ...compact({ ...item, media_type: mediaType }),
    ...creditMetadata(item, mediaType),
    summary: item.overview || '',
    rating,
    runtimeMins: mediaType === 'movie'
      ? Number(item.runtime) || null
      : Number(item.episode_run_time?.[0] || item.last_episode_to_air?.runtime) || null,
    tmdbVoteAverage: Number(item.vote_average) || null,
    tmdbVoteCount: Number(item.vote_count) || null,
    providers: matchingProviders(offerData, config)
  };
}

function normalizeTitle(title) {
  return String(title || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

async function findDetails(title, type, year, config) {
  if (!config.tmdbKey) return null;
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const result = await tmdb(`/search/${mediaType}?query=${encodeURIComponent(title)}&include_adult=false&language=en-US&page=1`, config.tmdbKey);
  const queryTitle = normalizeTitle(title);
  const candidates = (result.results || []).filter(item =>
    normalizeTitle(mediaType === 'tv' ? item.name : item.title) === queryTitle
  ).map(item => {
    const itemYear = Number(String(mediaType === 'tv' ? item.first_air_date || '' : item.release_date || '').slice(0, 4)) || null;
    return { item, itemYear, distance: year && itemYear ? Math.abs(year - itemYear) : Number.MAX_SAFE_INTEGER };
  }).sort((a, b) => a.distance - b.distance);
  const match = candidates.find(candidate => !year || !candidate.itemYear || candidate.distance <= 1);
  return match ? details(mediaType, match.item.id, config) : null;
}

module.exports = { providerOptions, search, findAvailable, details, findDetails, certification, discover, tvRuntime, tmdb };

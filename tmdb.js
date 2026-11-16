const providerCache = new Map();
const CACHE_MS = 15 * 60 * 1000;

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
    const matching = [...(offers?.flatrate || []), ...(offers?.free || []), ...(offers?.ads || [])]
      .filter(provider => active.includes(Number(provider.provider_id)));
    if (!matching.length) return null;
    return { ...compact(item), providers: [...new Map(matching.map(p => [p.provider_id, p])).values()] };
  }));
  return results.filter(Boolean);
}

async function details(type, id, config) {
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const [item, ratingData, offerData] = await Promise.all([
    tmdb(`/${mediaType}/${id}?language=en-US`, config.tmdbKey),
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
  const offers = [...(offerData?.flatrate || []), ...(offerData?.free || []), ...(offerData?.ads || [])];
  const active = new Set(config.providers);
  return {
    ...compact({ ...item, media_type: mediaType }),
    genres: (item.genres || []).map(genre => genre.name),
    summary: item.overview || '',
    rating,
    providers: [...new Map(offers.filter(provider => active.has(Number(provider.provider_id)))
      .map(provider => [provider.provider_id, provider])).values()]
  };
}

module.exports = { search, details, tmdb };

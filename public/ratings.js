(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PickWhatWeWatchRatings = api;
})(globalThis, function () {
  const movieRanks = { G: 1, PG: 2, 'PG-13': 3, R: 4, 'NC-17': 5 };
  const tvRanks = { 'TV-Y': 1, 'TV-Y7': 2, 'TV-Y7-FV': 2, 'TV-G': 3, 'TV-PG': 4, 'TV-14': 5, 'TV-MA': 6 };
  const unratedValues = new Set(['', 'NR', 'UNRATED', 'NOT RATED', 'UNKNOWN']);

  function includeUnrated(value) {
    if (value == null) return true;
    return value !== false && value !== 0 && !['false', '0'].includes(String(value).trim().toLowerCase());
  }

  function isAllowedByRating(mediaType, rawRating, settings) {
    const isMovie = mediaType === 'movie';
    const maxRating = settings[isMovie ? 'max_movie_rating' : 'max_tv_rating'] || 'ALL';
    const showUnrated = includeUnrated(settings[isMovie ? 'include_unrated_movies' : 'include_unrated_tv']);
    const rating = rawRating == null ? '' : String(rawRating).trim().toUpperCase();
    const ranks = isMovie ? movieRanks : tvRanks;
    const rank = ranks[rating];
    if (unratedValues.has(rating) || rank == null) return showUnrated;
    if (maxRating === 'ALL') return true;
    const maxRank = ranks[maxRating];
    return maxRank != null && rank <= maxRank;
  }

  function needsCertification(mediaType, settings) {
    const isMovie = mediaType === 'movie';
    return (settings[isMovie ? 'max_movie_rating' : 'max_tv_rating'] || 'ALL') !== 'ALL' ||
      !includeUnrated(settings[isMovie ? 'include_unrated_movies' : 'include_unrated_tv']);
  }

  return { isAllowedByRating, needsCertification };
});

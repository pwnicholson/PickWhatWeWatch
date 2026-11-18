(function (root, factory) {
  const isAllowedByRating = typeof module === 'object' && module.exports
    ? require('./ratings').isAllowedByRating
    : root.PickWhatWeWatchRatings.isAllowedByRating;
  const api = factory(isAllowedByRating);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PickWhatWeWatchFilters = api;
})(globalThis, function (isAllowedByRating) {
  function list(value) {
    let values;
    if (Array.isArray(value)) {
      values = value;
    } else if (typeof value === 'string' && value) {
      try {
        const parsed = JSON.parse(value);
        values = Array.isArray(parsed) ? parsed : value.split(',');
      } catch {
        values = value.split(',');
      }
    } else {
      return [];
    }
    return values.flatMap(item => typeof item === 'string' ? item.split(',') : [item])
      .map(item => typeof item === 'string' ? item.trim() : item)
      .filter(Boolean);
  }

  function filterValue(settings, snakeCase, camelCase, fallback) {
    return settings[snakeCase] ?? settings[camelCase] ?? fallback;
  }

  function genreMatches(genres, selected) {
    const aliases = {
      'sci-fi / fantasy': ['sci-fi', 'science fiction', 'fantasy'],
      'sci-fi': ['sci-fi', 'science fiction', 'sci-fi / fantasy'],
      'science fiction': ['science fiction', 'sci-fi', 'sci-fi / fantasy']
    };
    const names = aliases[selected.toLowerCase()] || [selected];
    return genres.some(genre => names.some(name =>
      genre.toLowerCase() === name.toLowerCase() ||
      genre.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(genre.toLowerCase())
    ));
  }

  function matchesActiveFilters(item, settings) {
    const reasons = [];
    const type = item.type ?? item.media_type;
    const mediaFilter = filterValue(settings, 'media_type_filter', 'mediaTypeFilter', 'both');
    if (mediaFilter === 'movies' && type !== 'movie' || mediaFilter === 'tv' && type !== 'tv') {
      reasons.push('media type');
    }

    const rating = item.contentRating ?? item.content_rating ?? item.rating;
    if (!isAllowedByRating(type, rating, settings)) reasons.push('content rating');

    const selectedGenres = list(settings.genres ?? settings.roundFillOptions?.genres)
      .map(value => String(value).trim()).filter(Boolean);
    const genres = list(item.genres).map(value => String(value).trim()).filter(Boolean);
    if (selectedGenres.length && !selectedGenres.some(selected => genreMatches(genres, selected))) {
      reasons.push('genres');
    }

    const selectedEras = list(settings.eras ?? settings.roundFillOptions?.eras);
    const year = Number(item.year);
    if (selectedEras.length && !selectedEras.some(era => {
      const range = typeof era === 'object'
        ? [Number(era.start), Number(era.end)]
        : String(era).split(':').map(Number);
      return range.length === 2 && Number.isFinite(year) &&
        year >= range[0] && year <= range[1];
    })) reasons.push('eras');

    const minDuration = Number(filterValue(settings, 'min_duration', 'minDuration', 0)) || 0;
    const rawMax = Number(filterValue(settings, 'max_duration', 'maxDuration', 9999));
    const maxDuration = Number.isFinite(rawMax) ? rawMax : 9999;
    const effectiveMax = maxDuration === 9999 ? 9999 : maxDuration + 5;
    const rawRuntime = item.runtimeMins ?? item.runtime_mins ?? item.duration_mins;
    const runtime = rawRuntime == null || rawRuntime === '' ? null : Number(rawRuntime);
    const hasRuntime = Number.isFinite(runtime) && runtime > 0;
    if (type === 'movie' && hasRuntime && (runtime < minDuration || runtime > effectiveMax)) {
      reasons.push('runtime');
    }
    if (type === 'tv' && hasRuntime && runtime > effectiveMax) reasons.push('runtime');

    return { allowed: reasons.length === 0, reasons };
  }

  return { matchesActiveFilters };
});

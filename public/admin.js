const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');
const plexAuthStatus = document.getElementById('plex-auth-status');
const plexServer = document.getElementById('plex-server');
const plexUrl = document.getElementById('plex-url');
const plexToken = document.getElementById('plex-token');
const sectionIds = document.getElementById('plex-sections');
const labelsInput = document.getElementById('plex-labels');
let shortlistMaxSize = 20;
let shortlistCount = 0;
let activeShortlistItems = [];
let standardShortlistItems = [];
let roundMode = { votingMode: 'standard', roundStage: 'round1', finalistsCount: 10, roundId: '' };
let roundProgressTimer;
let settingsSaveTimer;
let settingsStatusTimer;
let settingsSaveRevision = 0;
let settingsSaveQueue = Promise.resolve();
const fillGenreNames = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Horror', 'Mystery', 'Romance', 'Sci-Fi / Fantasy'
];

function fillEras() {
  const year = new Date().getFullYear();
  const eras = [
    [1910, 1928, '1910–1928 (Silent Era)'], [1929, 1949, '1929–1949 (Golden Age)'],
    [1950, 1965, '1950–1965 (Mid-Century)'], [1966, 1979, '1966–1979 (New Hollywood)'],
    [1980, 1989, '1980–1989 (1980s)'], [1990, 1999, '1990–1999 (1990s)'],
    [2000, 2009, '2000–2009 (2000s)'], [2010, 2019, '2010–2019 (2010s)']
  ];
  const currentDecade = Math.floor(year / 10) * 10;
  for (let start = 2020; start <= currentDecade; start += 10) {
    eras.push([start, start + 9, `${start}–${start + 9} (${start}s)`]);
  }
  return eras.map(([start, end, label]) => ({ id: `${start}-${end}`, label }));
}

function normalizeEraId(value) {
  if (value && typeof value === 'object') {
    if (value.start != null && value.end != null) return `${value.start}-${value.end}`;
    return normalizeEraId(value.id ?? value.label);
  }
  const text = String(value || '');
  const range = text.match(/^(\d{4})[:-](\d{4})$/);
  if (range) return `${range[1]}-${range[2]}`;
  const decade = text.match(/^(\d{4})s?$/i);
  return decade ? `${decade[1]}-${Number(decade[1]) + 9}` : text;
}

function showStatus(message, success = false) {
  settingsStatus.textContent = message;
  settingsStatus.className = `settings-save-pill ${success ? 'saved' : 'save-error'}`;
  clearTimeout(settingsStatusTimer);
  if (success) {
    settingsStatusTimer = setTimeout(() => {
      settingsStatus.textContent = '';
      settingsStatus.className = 'settings-save-pill';
    }, 1500);
  }
}

function showSaving() {
  clearTimeout(settingsStatusTimer);
  settingsStatus.textContent = 'Saving…';
  settingsStatus.className = 'settings-save-pill saving';
}

function collectSettings() {
  const maxSize = Number(document.getElementById('shortlist-max-size').value);
  if (!Number.isInteger(maxSize) || maxSize < 3 || maxSize > 100) {
    throw new Error('Max shortlist size must be an integer from 3 to 100.');
  }
  return {
    plexUrl: plexUrl.value,
    plexToken: plexToken.value,
    sectionIds: sectionIds.value,
    labels: labelsInput.value,
    tmdbKey: document.getElementById('tmdb-key').value,
    omdbKey: document.getElementById('omdb-key').value,
    maxMovieRating: document.getElementById('max-movie-rating').value,
    includeUnratedMovies: document.getElementById('include-unrated-movies').checked,
    maxTvRating: document.getElementById('max-tv-rating').value,
    includeUnratedTv: document.getElementById('include-unrated-tv').checked,
    allowGuestAdditions: document.getElementById('allow-guest-additions').checked,
    mediaTypeFilter: document.getElementById('media-type-filter').value,
    shortlistMaxSize: maxSize,
    providers: [...document.querySelectorAll('#provider-checks input:checked')].map(input => Number(input.value)),
    roundFillOptions: {
      ...selectedFillOptions(),
      seedShortlist: document.getElementById('seed-standard-shortlist').checked
    }
  };
}

function renderSourceStatus(elementId, configured) {
  const status = document.getElementById(elementId);
  status.textContent = configured ? 'Connected' : 'Optional - Not Configured';
  status.className = `source-pill ${configured ? 'connected' : ''}`;
}

function renderSourceStatuses(status) {
  renderSourceStatus('plex-source-status', status.plexConfigured);
  renderSourceStatus('tmdb-source-status', status.tmdbConfigured);
  renderSourceStatus('omdb-source-status', status.omdbConfigured);
}

async function saveSettings(showMessage = true) {
  clearTimeout(settingsSaveTimer);
  const revision = ++settingsSaveRevision;
  if (showMessage) showSaving();
  try {
    const settings = collectSettings();
    const request = settingsSaveQueue.catch(() => {}).then(() =>
      API.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(settings) })
    );
    settingsSaveQueue = request;
    await request;
    shortlistMaxSize = settings.shortlistMaxSize;
    renderShortlistCount();
    renderSourceStatuses(await API.request('/api/config/status'));
    updateMediaTypeControls();
    updateDynamicFilters();
    updatePlexControls();
    if (showMessage && revision === settingsSaveRevision) showStatus('Saved ✓', true);
  } catch (error) {
    if (showMessage && revision === settingsSaveRevision) showStatus(error.message);
    throw error;
  }
}

function updatePlexControls() {
  const ready = Boolean(plexUrl.value.trim() && plexToken.value.trim() && selectedIds().length);
  document.getElementById('sync-plex').disabled = !ready;
  document.getElementById('load-labels').disabled = !selectedIds().length;
}

function queueSettingsSave(delay = 0, refreshList = false) {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    try {
      await saveSettings();
      if (refreshList) await refreshActiveList();
    } catch (error) {
      showStatus(error.message);
    }
  }, delay);
}

function isTextSetting(input) {
  return ['plex-url', 'plex-token', 'plex-labels', 'tmdb-key', 'omdb-key'].includes(input.id);
}

function isSettingsControl(input) {
  return input.matches('input, select') &&
    input.type !== 'search' &&
    !input.closest('#admin-search-form') &&
    input.id !== 'plex-server';
}

function renderPlexStats(counts) {
  const status = document.getElementById('plex-stats');
  status.textContent = `Library Cache: ${counts.moviesCount} Movies, ${counts.showsCount} TV Shows synced`;
  status.className = 'status';
}

async function refreshPlexStats() {
  const status = document.getElementById('plex-stats');
  try {
    renderPlexStats(await API.request('/api/plex/stats'));
  } catch (error) {
    status.textContent = `Library Cache unavailable: ${error.message}`;
    status.className = 'status error';
  }
}

function selectedIds() {
  return [...document.querySelectorAll('#library-checks input:checked')].map(input => input.value);
}

function renderLibraries(libraries, selected = sectionIds.value.split(',').map(value => value.trim()).filter(Boolean)) {
  const checks = document.getElementById('library-checks');
  const selectedSet = new Set(selected);
  checks.replaceChildren(...libraries.map(library => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = library.id;
    input.checked = selected.length ? selectedSet.has(library.id) : true;
    input.addEventListener('change', () => { sectionIds.value = selectedIds().join(','); });
    label.append(input, document.createTextNode(`${library.title} (${library.type === 'show' ? 'TV Show' : 'Movie'})`));
    return label;
  }));
  sectionIds.value = selectedIds().join(',');
  updatePlexControls();
}

function renderLabels(labels, selected = labelsInput.value.split(',').map(value => value.trim()).filter(Boolean)) {
  const checks = document.getElementById('label-checks');
  const selectedSet = new Set(selected.map(label => label.toLocaleLowerCase()));
  checks.replaceChildren(...labels.map(name => {
    const label = document.createElement('label');
    label.className = 'label-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = name;
    input.checked = selectedSet.has(name.toLocaleLowerCase());
    input.addEventListener('change', () => {
      labelsInput.value = [...document.querySelectorAll('#label-checks input:checked')].map(control => control.value).join(',');
    });
    label.append(input, document.createTextNode(name));
    return label;
  }));
  labelsInput.value = [...document.querySelectorAll('#label-checks input:checked')].map(input => input.value).join(',');
  updatePlexControls();
}

async function loadServers(preferredUrl = '', selectFirst = false) {
  const { servers } = await API.request('/api/plex/servers');
  plexServer.replaceChildren(new Option('Select a Plex server…', ''));
  for (const server of servers) {
    const option = new Option(`${server.name} · ${server.local ? 'Local' : 'Remote'}`, server.url);
    plexServer.add(option);
  }
  const match = servers.find(server => server.url === preferredUrl);
  const chosen = match || (selectFirst ? servers[0] : null);
  if (chosen) {
    plexServer.value = chosen.url;
    plexUrl.value = chosen.url;
  }
  updatePlexControls();
  return servers;
}

async function loadLibraries(saveFirst = true) {
  const button = document.getElementById('load-libraries');
  const status = document.getElementById('library-status');
  button.disabled = true;
  try {
    if (saveFirst) await saveSettings(false);
    const { libraries } = await API.request('/api/plex/libraries');
    renderLibraries(libraries);
    if (saveFirst) await saveSettings(false);
    status.textContent = `${libraries.length} Movie and TV Show libraries loaded.`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
}

async function initializePlex(plexSettings) {
  if (plexSettings.plexOAuth) {
    try {
      const servers = await loadServers(plexSettings.plexUrl, !plexSettings.plexUrl);
      if (!plexUrl.value && servers.length) await saveSettings(false);
    } catch (error) {
      plexAuthStatus.textContent = error.message;
      plexAuthStatus.className = 'status error';
    }
  }
  if (plexUrl.value) await loadLibraries(false);
}

async function loadAdmin() {
  try {
    const [settings, sourceStatus] = await Promise.all([
      API.request('/api/admin/settings'), API.request('/api/config/status')
    ]);
    renderSourceStatuses(sourceStatus);
    plexUrl.value = settings.plexUrl;
    plexToken.value = settings.plexToken;
    sectionIds.value = settings.sectionIds;
    labelsInput.value = settings.labels;
    renderLabels(settings.labels ? settings.labels.split(',').map(value => value.trim()).filter(Boolean) : []);
    document.getElementById('tmdb-key').value = settings.tmdbKey;
    document.getElementById('omdb-key').value = settings.omdbKey;
    document.getElementById('max-movie-rating').value = settings.maxMovieRating;
    document.getElementById('include-unrated-movies').checked = settings.includeUnratedMovies;
    document.getElementById('max-tv-rating').value = settings.maxTvRating;
    document.getElementById('include-unrated-tv').checked = settings.includeUnratedTv;
    document.getElementById('allow-guest-additions').checked = settings.allowGuestAdditions;
    document.getElementById('media-type-filter').value = settings.mediaTypeFilter;
    updateMediaTypeControls();
    document.getElementById('shortlist-max-size').value = settings.shortlistMaxSize;
    shortlistMaxSize = settings.shortlistMaxSize;
    renderFillFilters();
    const fillOptions = settings.roundFillOptions || {};
    for (const input of document.querySelectorAll('#fill-genres input')) {
      input.checked = (fillOptions.genres || []).includes(input.value);
    }
    const savedEras = new Set((Array.isArray(fillOptions.eras) ? fillOptions.eras : [])
      .map(normalizeEraId));
    for (const input of document.querySelectorAll('#fill-eras input')) input.checked = savedEras.has(input.value);
    if (fillOptions.minDuration != null) document.getElementById('fill-min-duration').value = fillOptions.minDuration;
    if (fillOptions.maxDuration != null) document.getElementById('fill-max-duration').value = fillOptions.maxDuration;
    document.getElementById('seed-standard-shortlist').checked = fillOptions.seedShortlist !== false;
    const checks = document.getElementById('provider-checks');
    checks.replaceChildren(...settings.providerOptions.map(([name, id]) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = settings.providers.includes(id);
      label.append(input, document.createTextNode(name));
      return label;
    }));
    roundMode = settings;
    renderVoting();
    renderRoundMode();
    await refreshActiveList();
    const savedTab = sessionStorage.getItem('pickwhatwewatch-admin-tab');
    const configured = Boolean(settings.plexToken || settings.tmdbKey);
    setActiveTab(savedTab || (configured ? 'shortlist' : 'sources'));
    await refreshSavedShortlists();
    await refreshPlexStats();
    updatePlexControls();
    if (settings.plexToken) await initializePlex(settings);
  } catch (error) {
    showStatus(error.message);
    if (error.message.includes('PIN')) location.href = '/admin';
  }
}

function renderVoting() {
  document.getElementById('voting-mode').value = roundMode.votingMode;
}

function renderShortlist(items) {
  const list = document.getElementById('admin-shortlist');
  list.replaceChildren();
  activeShortlistItems = items;
  shortlistCount = items.length;
  renderShortlistCount();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'admin-item';
    const info = document.createElement('span');
    info.textContent = `${item.title}${item.year ? ` (${item.year})` : ''} · ${item.type === 'tv' ? 'TV Show' : 'Movie'}`;
    const metadata = document.createElement('span');
    metadata.className = 'admin-item-meta muted';
    const source = item.source === 'plex' ? 'On Plex' : (item.providers || []).join(', ') || 'Streaming';
    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'badge ballot-source';
    sourceBadge.textContent = source;
    const details = document.createElement('span');
    const parts = [];
    if (item.runtimeMins) parts.push(`${item.runtimeMins} min`);
    if (item.tmdbVoteAverage != null) {
      parts.push(`TMDB ${Number(item.tmdbVoteAverage).toFixed(1)} (${item.tmdbVoteCount || 0} votes)`);
    }
    if (item.metacriticScore) parts.push(`Metacritic ${item.metacriticScore}`);
    if (item.imdbRating) parts.push(`IMDb ${item.imdbRating}`);
    if (item.rtScore) parts.push(`RT ${item.rtScore}`);
    details.textContent = parts.join(' · ');
    metadata.append(sourceBadge, details);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      try {
        const path = roundMode.votingMode === 'two_round' ? '/api/two-round-pool/' : '/api/shortlist/';
        await API.request(`${path}${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        await refreshActiveList();
      } catch (error) { showStatus(error.message); }
    });
    const copy = document.createElement('span');
    copy.className = 'admin-item-copy';
    copy.append(info, metadata);
    row.append(copy, remove);
    list.append(row);
  }
  document.getElementById('clear-shortlist').disabled = !items.length;
  document.getElementById('clear-shortlist').textContent = 'Clear All';
  updateDynamicFilters();
}

async function refreshActiveList() {
  const path = roundMode.votingMode === 'two_round' && roundMode.roundStage !== 'round2'
    ? '/api/two-round-pool'
    : '/api/admin/shortlist';
  const [items, standard] = await Promise.all([
    API.request(path),
    API.request('/api/admin/shortlist?list=standard')
  ]);
  standardShortlistItems = standard;
  renderShortlist(items);
}

function activeFilterSettings() {
  return {
    media_type_filter: document.getElementById('media-type-filter').value,
    max_movie_rating: document.getElementById('max-movie-rating').value,
    include_unrated_movies: document.getElementById('include-unrated-movies').checked,
    max_tv_rating: document.getElementById('max-tv-rating').value,
    include_unrated_tv: document.getElementById('include-unrated-tv').checked,
    ...selectedFillOptions()
  };
}

function updateDynamicFilters() {
  const settings = activeFilterSettings();
  [...document.getElementById('admin-shortlist').children].forEach((row, index) => {
    const { allowed, reasons } = PickWhatWeWatchFilters.matchesActiveFilters(activeShortlistItems[index], settings);
    row.classList.toggle('filtered-out', !allowed);
    let badge = row.querySelector('.filter-reason-badge');
    if (allowed) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge hidden-type-badge filter-reason-badge';
      row.querySelector('.admin-item-meta').append(badge);
    }
    badge.textContent = `Hidden by filters: ${reasons.join(', ')}`;
  });

  const eligibleCount = standardShortlistItems.filter(item =>
    PickWhatWeWatchFilters.matchesActiveFilters(item, settings).allowed).length;
  const finalists = Number(document.getElementById('finalists-count').value) || roundMode.finalistsCount || 10;
  document.getElementById('round1-sampling-notice').hidden =
    roundMode.votingMode !== 'two_round' || eligibleCount <= finalists * 6;
}

document.getElementById('admin-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const query = document.getElementById('admin-search-query').value.trim();
  const status = document.getElementById('admin-search-status');
  const results = document.getElementById('admin-search-results');
  results.replaceChildren();
  if (query.length < 2) {
    status.textContent = 'Enter at least two characters to search.';
    status.className = 'status';
    return;
  }
  status.textContent = 'Searching Plex and TMDB…';
  status.className = 'status';
  try {
    const items = await API.request(`/api/search?q=${encodeURIComponent(query)}`);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'admin-search-result';
      row.append(posterNode(item.poster, item.title, 'admin-search-poster'));
      const info = document.createElement('div');
      info.className = 'admin-item-copy';
      const title = document.createElement('strong');
      title.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = `${item.type === 'tv' ? 'TV Show' : 'Movie'}${item.year ? ` · ${item.year}` : ''}`;
      const source = document.createElement('span');
      source.className = 'badge ballot-source';
      source.textContent = item.source === 'plex'
        ? 'On Plex'
        : (item.providers || []).map(provider => provider.provider_name || provider).join(', ') || 'TMDB';
      info.append(title, meta, source);
      const add = document.createElement('button');
      add.className = 'button secondary';
      add.type = 'button';
      add.textContent = 'Add to Shortlist';
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          await API.request('/api/shortlist', {
            method: 'POST',
            body: JSON.stringify({
              source: item.source, sourceId: item.sourceId, title: item.title,
              type: item.type, year: item.year, poster: item.poster
            })
          });
          await refreshActiveList();
          add.textContent = 'Added';
        } catch (error) {
          add.disabled = false;
          add.textContent = error.message;
        }
      });
      row.append(info, add);
      results.append(row);
    }
    status.textContent = items.length ? `${items.length} titles found` : 'No matches found.';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  }
});

function renderShortlistCount() {
  const activeRound = roundMode.votingMode === 'two_round';
  document.getElementById('list-manager-title').textContent =
    activeRound
      ? roundMode.roundStage === 'round2' ? 'Round 2 Finalists' : 'Round 1 Candidate Pool'
      : 'Active Shortlist';
  const label = activeRound && roundMode.roundStage === 'draft'
    ? `Draft Pool: ${shortlistCount} / ${roundMode.finalistsCount * 6} items`
    : activeRound && roundMode.roundStage === 'round1'
    ? `${shortlistCount} / ${Math.max(shortlistCount, roundMode.roundPoolSize || 0)} Round 1 titles`
    : activeRound && roundMode.roundStage === 'round2'
      ? `${shortlistCount} finalists`
      : `${shortlistCount} / ${shortlistMaxSize} titles`;
  document.getElementById('shortlist-count').textContent = label;
  const fillTarget = roundMode.votingMode === 'two_round'
    ? roundMode.finalistsCount * 6
    : shortlistMaxSize;
  document.getElementById('fill-shortlist').disabled = shortlistCount >= fillTarget ||
    (roundMode.votingMode === 'two_round' && roundMode.roundStage !== 'draft');
  updateDynamicFilters();
}

function renderRoundMode() {
  const isTwoRound = roundMode.votingMode === 'two_round';
  const isDraft = isTwoRound && roundMode.roundStage === 'draft';
  const canRefill = isDraft && Boolean(roundMode.roundId);
  const isRound1 = isTwoRound && roundMode.roundStage === 'round1' && Boolean(roundMode.roundId);
  document.getElementById('voting-mode').value = roundMode.votingMode;
  document.getElementById('finalists-count').value = roundMode.finalistsCount || 10;
  document.getElementById('finalists-setting').hidden = !isTwoRound;
  document.getElementById('seed-shortlist-setting').hidden = !isTwoRound;
  document.getElementById('populate-round1').hidden = !isDraft;
  document.getElementById('populate-round1-list').hidden = !isDraft;
  document.getElementById('two-round-admin').hidden = !isTwoRound;
  document.getElementById('standard-admin-search').hidden = isTwoRound;
  document.getElementById('generate-round1').hidden = isRound1;
  document.getElementById('refill-round1').hidden = !canRefill;
  document.getElementById('release-round1').hidden = !canRefill;
  document.getElementById('round1-progress-heading').hidden = !isRound1;
  document.getElementById('round1-progress').hidden = !isRound1;
  document.getElementById('start-round2').hidden = !isRound1;
  document.getElementById('round1-admin-status').textContent = isDraft
    ? roundMode.roundId
      ? 'Review the draft pool, remove any titles you do not want, then re-fill or send it out for voting.'
      : 'This is the separate Two-Round pool. Generate a draft pool to begin a voting session.'
    : '';
  renderFillHelperText();
  if (roundProgressTimer) clearInterval(roundProgressTimer);
  if (isRound1) {
    refreshRound1Progress();
    roundProgressTimer = setInterval(refreshRound1Progress, 4000);
  } else {
    document.getElementById('round1-progress').replaceChildren();
    if (isTwoRound && roundMode.roundStage === 'round2') {
      document.getElementById('round1-progress').textContent = 'Round 2 is active.';
    }
  }
  renderShortlistCount();
}

function updateMediaTypeControls() {
  const filter = document.getElementById('media-type-filter').value;
  const movieDisabled = filter === 'tv';
  const tvDisabled = filter === 'movies';
  for (const id of ['max-movie-rating', 'include-unrated-movies']) {
    document.getElementById(id).disabled = movieDisabled;
  }
  for (const id of ['max-tv-rating', 'include-unrated-tv']) {
    document.getElementById(id).disabled = tvDisabled;
  }
  document.getElementById('movie-rating-controls').classList.toggle('rating-disabled', movieDisabled);
  document.getElementById('tv-rating-controls').classList.toggle('rating-disabled', tvDisabled);
}

function setActiveTab(tab) {
  const activeTab = ['shortlist', 'filters', 'sources'].includes(tab) ? tab : 'shortlist';
  for (const [name, buttonId, panelId] of [
    ['shortlist', 'shortlist-tab-button', 'shortlist-tab'],
    ['filters', 'filters-tab-button', 'filters-tab'],
    ['sources', 'sources-tab-button', 'sources-tab']
  ]) {
    const active = name === activeTab;
    document.getElementById(buttonId).classList.toggle('active', active);
    document.getElementById(buttonId).setAttribute('aria-selected', String(active));
    document.getElementById(panelId).hidden = !active;
  }
  sessionStorage.setItem('pickwhatwewatch-admin-tab', activeTab);
}

function switchAdminTab(tab) {
  setActiveTab(tab);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.switchAdminTab = switchAdminTab;

function renderFillHelperText() {
  const helper = document.getElementById('fill-helper-text');
  const prefix = roundMode.votingMode === 'two_round'
    ? 'Auto-fill Round 1 list using content, duration, and other filters defined on '
    : 'Auto-fill shortlist using content, duration, and other filters defined on ';
  const link = document.createElement('a');
  link.href = '#';
  link.dataset.jumpTab = 'filters';
  link.textContent = 'Filters tab';
  helper.replaceChildren(document.createTextNode(prefix), link);
}

async function refreshSavedShortlists() {
  const list = document.getElementById('saved-shortlists');
  try {
    const saved = await API.request('/api/saved-shortlists');
    list.replaceChildren(...saved.map(shortlist => {
      const row = document.createElement('div');
      row.className = 'saved-shortlist-row';
      const copy = document.createElement('div');
      copy.className = 'saved-shortlist-copy';
      const title = document.createElement('strong');
      title.textContent = shortlist.name;
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = `${shortlist.itemCount} titles · saved ${new Date(shortlist.createdAt).toLocaleString()}`;
      copy.append(title, count);
      const actions = document.createElement('div');
      actions.className = 'saved-shortlist-actions';
      for (const [mode, label] of [['replace', 'Load (Replace)'], ['append', 'Append']]) {
        const button = document.createElement('button');
        button.className = 'button secondary';
        button.type = 'button';
        button.textContent = label;
        button.dataset.loadSaved = '';
        button.addEventListener('click', async () => {
          if (mode === 'replace' &&
              !window.confirm(`Replace the active ${roundMode.votingMode === 'two_round' ? 'Two-Round pool' : 'shortlist'}?`)) return;
          try {
            const result = await API.request(`/api/saved-shortlists/${encodeURIComponent(shortlist.id)}/load`, {
              method: 'POST', body: JSON.stringify({ mode })
            });
            roundMode = { ...roundMode, ...result };
            renderRoundMode();
            await refreshActiveList();
            document.getElementById('saved-shortlists-status').textContent =
              `Loaded ${result.loadedCount} titles${result.skippedCount ? ` · skipped ${result.skippedCount}` : ''}.`;
            document.getElementById('saved-shortlists-status').className = 'status success';
          } catch (error) {
            document.getElementById('saved-shortlists-status').textContent = error.message;
            document.getElementById('saved-shortlists-status').className = 'status error';
          }
        });
        actions.append(button);
      }
      const rename = document.createElement('button');
      rename.className = 'button secondary';
      rename.type = 'button';
      rename.textContent = 'Rename';
      rename.addEventListener('click', async () => {
        const name = window.prompt('New shortlist name:', shortlist.name)?.trim();
        if (!name) return;
        try {
          await API.request(`/api/saved-shortlists/${encodeURIComponent(shortlist.id)}`, {
            method: 'PATCH', body: JSON.stringify({ name })
          });
          await refreshSavedShortlists();
        } catch (error) {
          document.getElementById('saved-shortlists-status').textContent = error.message;
          document.getElementById('saved-shortlists-status').className = 'status error';
        }
      });
      const remove = document.createElement('button');
      remove.className = 'button danger';
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Delete "${shortlist.name}"?`)) return;
        try {
          await API.request(`/api/saved-shortlists/${encodeURIComponent(shortlist.id)}`, { method: 'DELETE' });
          await refreshSavedShortlists();
        } catch (error) {
          document.getElementById('saved-shortlists-status').textContent = error.message;
          document.getElementById('saved-shortlists-status').className = 'status error';
        }
      });
      actions.append(rename, remove);
      row.append(copy, actions);
      return row;
    }));
    document.getElementById('saved-shortlists-status').textContent = saved.length ? '' : 'No saved shortlists yet.';
    document.getElementById('saved-shortlists-status').className = 'status';
  } catch (error) {
    document.getElementById('saved-shortlists-status').textContent = error.message;
    document.getElementById('saved-shortlists-status').className = 'status error';
  }
}

async function refreshRound1Progress() {
  if (roundMode.votingMode !== 'two_round' || roundMode.roundStage !== 'round1' || !roundMode.roundId) return;
  try {
    const progress = await API.request('/api/admin/round1/progress');
    roundMode = { ...roundMode, ...progress, roundPoolSize: progress.poolSize };
    if (progress.votingMode !== 'two_round' || progress.roundStage !== 'round1' || !progress.roundId) {
      renderVoting();
      renderRoundMode();
      return;
    }
    const target = document.getElementById('round1-progress');
    const rows = progress.voters.map(voter => {
      const row = document.createElement('div');
      row.className = `round-progress-row ${voter.done ? 'done' : ''}`;
      const name = document.createElement('span');
      name.textContent = voter.name;
      const count = document.createElement('span');
      count.textContent = `${voter.completed}/${progress.poolSize}${voter.done ? ' (Done)' : ''}`;
      row.append(name, count);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('span');
      empty.textContent = `No voters yet · ${progress.poolSize} cards in the Round 1 pool.`;
      rows.push(empty);
    }
    target.replaceChildren(...rows);
    document.getElementById('start-round2').hidden = !progress.roundId;
    renderShortlistCount();
  } catch (error) {
    const target = document.getElementById('round1-progress');
    target.textContent = error.message;
    target.className = 'round-progress status error';
  }
}

function renderFillFilters() {
  const genres = document.getElementById('fill-genres');
  genres.replaceChildren(...fillGenreNames.map(name => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = name;
    label.append(input, document.createTextNode(name));
    return label;
  }));
  const eras = document.getElementById('fill-eras');
  eras.replaceChildren(...fillEras().map(era => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = era.id;
    label.append(input, document.createTextNode(era.label));
    return label;
  }));
}

function setAllChecked(containerId, checked) {
  document.querySelectorAll(`#${containerId} input`).forEach(input => { input.checked = checked; });
}

function selectedFillOptions() {
  return {
    genres: [...document.querySelectorAll('#fill-genres input:checked')].map(input => input.value),
    eras: [...document.querySelectorAll('#fill-eras input:checked')].map(input => input.value),
    minDuration: Number(document.getElementById('fill-min-duration').value),
    maxDuration: Number(document.getElementById('fill-max-duration').value)
  };
}

for (const [buttonId, containerId, checked] of [
  ['genres-select-all', 'fill-genres', true], ['genres-clear', 'fill-genres', false],
  ['eras-select-all', 'fill-eras', true], ['eras-clear', 'fill-eras', false]
]) {
  document.getElementById(buttonId).addEventListener('click', () => {
    setAllChecked(containerId, checked);
    updateDynamicFilters();
    queueSettingsSave();
  });
}

document.getElementById('fill-shortlist').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('fill-status');
  button.disabled = true;
  status.textContent = 'Finding highly rated titles…';
  status.className = 'status';
  try {
    await saveSettings(false);
    const result = await API.request('/api/shortlist/fill', {
      method: 'POST',
      body: JSON.stringify(selectedFillOptions())
    });
    if (roundMode.votingMode === 'two_round') {
      roundMode = {
        ...roundMode,
        ...await API.request('/api/admin/settings'),
        roundPoolSize: result.newTotal
      };
      renderRoundMode();
    }
    await refreshActiveList();
    status.textContent = result.message || `Added ${result.addedCount} ${result.addedCount === 1 ? 'title' : 'titles'}.`;
    status.className = `status ${result.addedCount ? 'success' : ''}`;
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    renderShortlistCount();
  }
});

settingsForm.addEventListener('change', event => {
  const input = event.target.closest('input, select');
  if (!input || !isSettingsControl(input)) return;
  if (input.id === 'media-type-filter') updateMediaTypeControls();
  updateDynamicFilters();
  updatePlexControls();
  queueSettingsSave(0, input.id === 'media-type-filter');
});

settingsForm.addEventListener('input', event => {
  const input = event.target.closest('input, select');
  if (input) updateDynamicFilters();
  if (input && isSettingsControl(input) && isTextSetting(input)) queueSettingsSave(600);
});

settingsForm.addEventListener('focusout', event => {
  const input = event.target.closest('input, select');
  if (input && isSettingsControl(input) && isTextSetting(input)) queueSettingsSave();
});

document.getElementById('media-type-filter').addEventListener('change', updateMediaTypeControls);
document.querySelectorAll('[data-admin-tab]').forEach(button => {
  button.addEventListener('click', () => setActiveTab(button.dataset.adminTab));
});
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-jump-tab]');
  if (!link) return;
  event.preventDefault();
  switchAdminTab(link.dataset.jumpTab);
});

async function saveVotingMode() {
  const finalistsCount = Number(document.getElementById('finalists-count').value);
  if (!Number.isInteger(finalistsCount) || finalistsCount < 3 || finalistsCount > 25) {
    showStatus('Number of finalists must be from 3 to 25.');
    document.getElementById('finalists-count').value = roundMode.finalistsCount || 10;
    return;
  }
  showSaving();
  try {
    roundMode = await API.request('/api/admin/voting-mode', {
      method: 'POST',
      body: JSON.stringify({ mode: document.getElementById('voting-mode').value, finalistsCount })
    });
    roundMode.roundPoolSize = roundMode.roundPoolSize || 0;
    await refreshActiveList();
    renderVoting();
    renderRoundMode();
    showStatus('Saved ✓', true);
  } catch (error) {
    document.getElementById('voting-mode').value = roundMode.votingMode;
    document.getElementById('finalists-count').value = roundMode.finalistsCount || 10;
    showStatus(error.message);
  }
}

document.getElementById('connect-plex').addEventListener('click', async event => {
  const button = event.currentTarget;
  const popup = window.open('about:blank', 'plex-auth', 'popup,width=700,height=760');
  if (!popup) {
    plexAuthStatus.textContent = 'Allow popups to connect with Plex.';
    plexAuthStatus.className = 'status error';
    return;
  }
  button.disabled = true;
  plexAuthStatus.textContent = 'Starting Plex sign-in…';
  plexAuthStatus.className = 'status';
  try {
    const pin = await API.request('/api/plex/auth/start', { method: 'POST', body: '{}' });
    popup.location.href = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(pin.clientId)}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=Pick%20What%20We%20Watch`;
    plexAuthStatus.textContent = 'Approve access in the Plex popup…';
    const expiresAt = Date.now() + Math.min(pin.expiresIn, 900) * 1000;
    let connected = false;
    while (Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const result = await API.request(`/api/plex/auth/poll/${encodeURIComponent(pin.pinId)}`);
      if (result.authorized) { connected = true; break; }
    }
    if (!connected) throw new Error('Plex sign-in expired. Please try again.');
    popup.close();
    const settings = await API.request('/api/admin/settings');
    plexToken.value = settings.plexToken;
    plexAuthStatus.textContent = 'Plex connected. Loading your servers…';
    const servers = await loadServers('', true);
    if (!servers.length) throw new Error('Plex connected, but no owned Plex servers were found.');
    await saveSettings(false);
    plexAuthStatus.textContent = 'Plex connected.';
    await loadLibraries(false);
  } catch (error) {
    plexAuthStatus.textContent = error.message;
    plexAuthStatus.className = 'status error';
    try {
      if (!popup.closed && popup.location.href === 'about:blank') {
        popup.document.body.textContent = `Plex sign-in could not start: ${error.message}. You can close this window.`;
      }
    } catch {}
  } finally {
    button.disabled = false;
  }
});

plexServer.addEventListener('change', async () => {
  const url = plexServer.value;
  if (!url) return;
  plexUrl.value = url;
  try {
    await saveSettings(false);
    await loadLibraries(true);
  } catch (error) {
    showStatus(error.message);
  }
});

document.getElementById('load-libraries').addEventListener('click', () => loadLibraries(true));

document.getElementById('load-labels').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('label-status');
  const ids = selectedIds();
  if (!ids.length) {
    status.textContent = 'Select one or more libraries first.';
    status.className = 'status error';
    return;
  }
  button.disabled = true;
  try {
    await saveSettings(false);
    const { labels } = await API.request(`/api/plex/labels?sectionIds=${encodeURIComponent(ids.join(','))}`);
    renderLabels(labels);
    status.textContent = `${labels.length} labels loaded.`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('sync-plex').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    await saveSettings(false);
    const counts = await API.request('/api/admin/sync', { method: 'POST', body: '{}' });
    renderPlexStats(counts);
    showStatus(`Plex sync complete: ${counts.moviesCount} Movies, ${counts.showsCount} TV Shows.`, true);
  } catch (error) { showStatus(error.message); }
  finally {
    button.disabled = false;
    button.textContent = 'Sync Plex Libraries';
  }
});

document.getElementById('reset-votes').addEventListener('click', async event => {
  if (!window.confirm('Reset all ranked-choice and Round 1 votes? This cannot be undone.')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await API.request('/api/admin/reset-votes', { method: 'POST', body: '{}' });
    showStatus(`Reset ${result.ballots + result.round1Votes} votes.`, true);
    if (roundMode.roundStage === 'round1') await refreshRound1Progress();
  } catch (error) {
    showStatus(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('voting-mode').addEventListener('change', saveVotingMode);
document.getElementById('finalists-count').addEventListener('change', saveVotingMode);
document.getElementById('finalists-count').addEventListener('input', updateDynamicFilters);
document.getElementById('seed-standard-shortlist').addEventListener('change', () => queueSettingsSave());

document.getElementById('generate-round1').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('round1-admin-status');
  const finalistsCount = Number(document.getElementById('finalists-count').value);
  if (!Number.isInteger(finalistsCount) || finalistsCount < 3 || finalistsCount > 25) {
    status.textContent = 'Number of finalists must be from 3 to 25.';
    status.className = 'status error';
    return;
  }
  button.disabled = true;
  status.textContent = 'Generating the Round 1 draft pool…';
  status.className = 'status';
  try {
    await saveSettings(false);
    const result = await API.request('/api/admin/round1/generate', {
      method: 'POST',
      body: JSON.stringify({
        finalistsCount,
        seedShortlist: document.getElementById('seed-standard-shortlist').checked,
        ...selectedFillOptions()
      })
    });
    roundMode = { ...roundMode, ...result, roundPoolSize: result.poolSize };
    await refreshActiveList();
    renderVoting();
    renderRoundMode();
    status.textContent = `Draft pool ready: ${result.poolSize} titles (${result.seededCount} copied, ${result.addedCount} added).`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

async function populateRound1FromShortlist() {
  const buttons = [
    document.getElementById('populate-round1'),
    document.getElementById('populate-round1-list')
  ];
  const status = document.getElementById('round1-admin-status');
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = 'Populating Round 1 from the Standard shortlist…';
  status.className = 'status';
  try {
    await saveSettings(false);
    const result = await API.request('/api/two-round/populate-from-shortlist', {
      method: 'POST',
      body: '{}'
    });
    roundMode = {
      ...roundMode,
      ...await API.request('/api/admin/settings'),
      roundPoolSize: result.count
    };
    await refreshActiveList();
    renderRoundMode();
    status.textContent = `Populated Round 1 with ${result.count} eligible titles.`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.getElementById('populate-round1').addEventListener('click', populateRound1FromShortlist);
document.getElementById('populate-round1-list').addEventListener('click', populateRound1FromShortlist);

document.getElementById('refill-round1').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('round1-admin-status');
  button.disabled = true;
  status.textContent = 'Filling empty draft slots…';
  status.className = 'status';
  try {
    await saveSettings(false);
    const result = await API.request('/api/admin/round1/refill', {
      method: 'POST',
      body: JSON.stringify(selectedFillOptions())
    });
    roundMode.roundPoolSize = result.poolSize;
    await refreshActiveList();
    status.textContent = `Draft pool: ${result.poolSize} / ${result.targetSize} items (${result.addedCount} added).`;
    status.className = result.addedCount ? 'status success' : 'status';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('release-round1').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  const status = document.getElementById('round1-admin-status');
  try {
    const result = await API.request('/api/admin/round1/release', { method: 'POST', body: '{}' });
    roundMode = { ...roundMode, ...result, roundPoolSize: result.poolSize };
    await refreshActiveList();
    renderVoting();
    renderRoundMode();
    status.textContent = `Round 1 is open to guests with ${result.poolSize} titles.`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('start-round2').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await API.request('/api/admin/round2/start', { method: 'POST', body: '{}' });
    roundMode.roundStage = result.roundStage;
    await refreshActiveList();
    renderVoting();
    renderRoundMode();
    document.getElementById('round1-admin-status').textContent =
      `Round 2 started with ${result.finalistsCount} finalists.`;
    document.getElementById('round1-admin-status').className = 'status success';
  } catch (error) {
    document.getElementById('round1-admin-status').textContent = error.message;
    document.getElementById('round1-admin-status').className = 'status error';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('clear-shortlist').addEventListener('click', async () => {
  if (!window.confirm('Clear the active list and its ballots? This cannot be undone.')) return;
  try {
    const path = roundMode.votingMode === 'two_round' ? '/api/two-round-pool' : '/api/shortlist';
    await API.request(path, { method: 'DELETE' });
    if (roundMode.votingMode === 'two_round') {
      roundMode.roundId = '';
      roundMode.roundStage = 'draft';
    }
    await refreshActiveList();
    renderRoundMode();
  } catch (error) { showStatus(error.message); }
});

document.getElementById('save-current-list').addEventListener('click', async () => {
  const name = window.prompt('Name this shortlist:')?.trim();
  if (!name) return;
  const status = document.getElementById('saved-shortlists-status');
  try {
    const saved = await API.request('/api/saved-shortlists', {
      method: 'POST', body: JSON.stringify({ name })
    });
    await refreshSavedShortlists();
    status.textContent = `Saved "${saved.name}" (${saved.itemCount} titles).`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  }
});

document.getElementById('push-plex-watchlist').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('plex-action-status');
  button.disabled = true;
  status.textContent = 'Adding titles to Plex Watchlist…';
  try {
    const result = await API.request('/api/plex/watchlist/push', { method: 'POST', body: '{}' });
    const failed = result.failedTitles || [];
    status.textContent = `Added ${result.addedCount}; failed ${failed.length}${failed.length ? ` · ${failed.map(item => item.title).join(', ')}` : ''}.`;
    status.className = `status${failed.length ? ' error' : ' success'}`;
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally { button.disabled = false; }
});

document.getElementById('save-plex-playlist').addEventListener('click', async event => {
  const name = window.prompt('Plex playlist name:', `Movie Night - ${new Date().toISOString().slice(0, 10)}`)?.trim();
  if (!name) return;
  const button = event.currentTarget;
  const status = document.getElementById('plex-action-status');
  button.disabled = true;
  try {
    const result = await API.request('/api/plex/playlist', {
      method: 'POST', body: JSON.stringify({ name })
    });
    status.textContent = `Playlist saved: ${result.addedCount} local Plex titles added; ${result.skippedStreamingCount} streaming-only titles skipped.`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally { button.disabled = false; }
});

window.addEventListener('shortlist-updated', () =>
  refreshActiveList().catch(error => showStatus(error.message)));

document.getElementById('logout').addEventListener('click', async () => {
  try { await API.request('/api/admin/logout', { method: 'POST', body: '{}' }); location.href = '/admin'; }
  catch (error) { showStatus(error.message); }
});

loadAdmin();

const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');
const plexAuthStatus = document.getElementById('plex-auth-status');
const plexServer = document.getElementById('plex-server');
const plexUrl = document.getElementById('plex-url');
const plexToken = document.getElementById('plex-token');
const sectionIds = document.getElementById('plex-sections');
const labelsInput = document.getElementById('plex-labels');
let votingClosed = false;
let shortlistMaxSize = 20;
let shortlistCount = 0;
let roundMode = { votingMode: 'standard', roundStage: 'round1', finalistsCount: 10, roundId: '' };
let roundProgressTimer;
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
  return eras.map(([start, end, label]) => ({ id: `${start}:${end}`, label }));
}

function showStatus(message, success = false) {
  settingsStatus.textContent = message;
  settingsStatus.className = `status ${success ? 'success' : 'error'}`;
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
    shortlistMaxSize: maxSize,
    providers: [...document.querySelectorAll('#provider-checks input:checked')].map(input => Number(input.value))
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
  const settings = collectSettings();
  await API.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(settings) });
  shortlistMaxSize = settings.shortlistMaxSize;
  renderShortlistCount();
  await refreshPlexStats();
  renderSourceStatuses(await API.request('/api/config/status'));
  if (showMessage) showStatus('Settings saved.', true);
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
    const [settings, titles, sourceStatus] = await Promise.all([
      API.request('/api/admin/settings'), API.request('/api/shortlist'), API.request('/api/config/status')
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
    document.getElementById('shortlist-max-size').value = settings.shortlistMaxSize;
    shortlistMaxSize = settings.shortlistMaxSize;
    renderFillFilters();
    const fillOptions = settings.roundFillOptions || {};
    for (const input of document.querySelectorAll('#fill-genres input')) {
      input.checked = (fillOptions.genres || []).includes(input.value);
    }
    for (const input of document.querySelectorAll('#fill-eras input')) {
      input.checked = (fillOptions.eras || []).includes(input.value);
    }
    if (fillOptions.minDuration != null) document.getElementById('fill-min-duration').value = fillOptions.minDuration;
    if (fillOptions.maxDuration != null) document.getElementById('fill-max-duration').value = fillOptions.maxDuration;
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
    votingClosed = settings.votingClosed;
    roundMode = settings;
    renderVoting();
    renderRoundMode();
    renderShortlist(titles);
    await refreshPlexStats();
    if (settings.plexToken) await initializePlex(settings);
  } catch (error) {
    showStatus(error.message);
    if (error.message.includes('PIN')) location.href = '/admin';
  }
}

function renderVoting() {
  document.getElementById('voting-state').textContent =
    `${votingClosed ? 'Voting is closed.' : 'Voting is open.'} ${roundMode.votingMode === 'two_round' ? `Build the List Together · ${roundMode.roundStage === 'draft' ? 'Draft review' : roundMode.roundStage === 'round2' ? 'Round 2' : 'Round 1'}` : 'Standard Mode'}`;
  document.getElementById('toggle-voting').textContent = votingClosed ? 'Reopen voting' : 'Close voting';
}

function renderShortlist(items) {
  const list = document.getElementById('admin-shortlist');
  list.replaceChildren();
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
    remove.hidden = roundMode.votingMode === 'two_round' &&
      Boolean(roundMode.roundId) && roundMode.roundStage !== 'draft';
    remove.addEventListener('click', async () => {
      try {
        await API.request(`/api/admin/shortlist/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        const updated = await API.request('/api/shortlist');
        renderShortlist(updated);
      } catch (error) { showStatus(error.message); }
    });
    const copy = document.createElement('span');
    copy.className = 'admin-item-copy';
    copy.append(info, metadata);
    row.append(copy, remove);
    list.append(row);
  }
  document.getElementById('clear-shortlist').disabled = !items.length ||
    (roundMode.votingMode === 'two_round' && Boolean(roundMode.roundId) && roundMode.roundStage !== 'draft');
}

function renderShortlistCount() {
  const activeRound = roundMode.votingMode === 'two_round' && roundMode.roundId;
  const label = activeRound && roundMode.roundStage === 'draft'
    ? `Draft Pool: ${shortlistCount} / ${roundMode.finalistsCount * 6} items`
    : activeRound && roundMode.roundStage === 'round1'
    ? `${shortlistCount} / ${Math.max(shortlistCount, roundMode.roundPoolSize || 0)} Round 1 titles`
    : activeRound && roundMode.roundStage === 'round2'
      ? `${shortlistCount} finalists`
      : `${shortlistCount} / ${shortlistMaxSize} titles`;
  document.getElementById('shortlist-count').textContent = label;
  document.getElementById('fill-shortlist').disabled =
    shortlistCount >= shortlistMaxSize || roundMode.votingMode === 'two_round';
}

function renderRoundMode() {
  const isTwoRound = roundMode.votingMode === 'two_round';
  const isDraft = isTwoRound && roundMode.roundStage === 'draft' && Boolean(roundMode.roundId);
  const isRound1 = isTwoRound && roundMode.roundStage === 'round1' && Boolean(roundMode.roundId);
  document.getElementById('voting-mode').value = roundMode.votingMode;
  document.getElementById('finalists-count').value = roundMode.finalistsCount || 10;
  document.getElementById('finalists-setting').hidden = !isTwoRound;
  document.getElementById('two-round-admin').hidden = !isTwoRound;
  document.getElementById('generate-round1').hidden = isRound1;
  document.getElementById('refill-round1').hidden = !isDraft;
  document.getElementById('release-round1').hidden = !isDraft;
  document.getElementById('round1-progress').hidden = !isRound1 && !(isTwoRound && roundMode.roundStage === 'round2');
  document.getElementById('start-round2').hidden = !isRound1;
  document.getElementById('round1-admin-status').textContent = isDraft
    ? 'Review the draft pool, remove any titles you do not want, then re-fill or send it out for voting.'
    : '';
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
  document.getElementById(buttonId).addEventListener('click', () => setAllChecked(containerId, checked));
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
    renderShortlist(await API.request('/api/shortlist'));
    status.textContent = result.message || `Added ${result.addedCount} ${result.addedCount === 1 ? 'title' : 'titles'}.`;
    status.className = `status ${result.addedCount ? 'success' : ''}`;
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = shortlistCount >= shortlistMaxSize;
  }
});

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await saveSettings();
  } catch (error) { showStatus(error.message); }
});

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
  await loadLibraries(true);
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

document.getElementById('toggle-voting').addEventListener('click', async () => {
  try {
    const response = await API.request('/api/admin/voting', { method: 'POST', body: JSON.stringify({ closed: !votingClosed }) });
    votingClosed = response.closed;
    renderVoting();
  } catch (error) { showStatus(error.message); }
});

document.getElementById('voting-mode').addEventListener('change', async event => {
  try {
    const finalistsCount = Number(document.getElementById('finalists-count').value);
    if (!Number.isInteger(finalistsCount) || finalistsCount < 3 || finalistsCount > 25) {
      throw new Error('Number of finalists must be from 3 to 25.');
    }
    roundMode = await API.request('/api/admin/voting-mode', {
      method: 'POST',
      body: JSON.stringify({ mode: event.currentTarget.value, finalistsCount })
    });
    roundMode.roundPoolSize = shortlistCount;
    renderVoting();
    renderRoundMode();
    renderShortlistCount();
  } catch (error) {
    showStatus(error.message);
    event.currentTarget.value = roundMode.votingMode;
  }
});

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
      body: JSON.stringify({ finalistsCount, ...selectedFillOptions() })
    });
    roundMode = { ...roundMode, ...result, roundPoolSize: result.poolSize };
    renderShortlist(await API.request('/api/shortlist'));
    renderVoting();
    renderRoundMode();
    status.textContent = `Draft pool ready: ${result.poolSize} titles (${result.addedCount} added).`;
    status.className = 'status success';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

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
    renderShortlist(await API.request('/api/shortlist'));
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
    renderShortlist(await API.request('/api/shortlist'));
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
    renderShortlist(await API.request('/api/shortlist'));
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
  if (!window.confirm('Clear every title and ballot? This cannot be undone.')) return;
  try {
    await API.request('/api/admin/shortlist', { method: 'DELETE' });
    roundMode.roundId = '';
    roundMode.roundStage = roundMode.votingMode === 'two_round' ? 'draft' : 'round1';
    renderShortlist([]);
    renderRoundMode();
  } catch (error) { showStatus(error.message); }
});

document.getElementById('logout').addEventListener('click', async () => {
  try { await API.request('/api/admin/logout', { method: 'POST', body: '{}' }); location.href = '/admin'; }
  catch (error) { showStatus(error.message); }
});

loadAdmin();

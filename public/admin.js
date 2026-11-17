const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');
const plexAuthStatus = document.getElementById('plex-auth-status');
const plexServer = document.getElementById('plex-server');
const plexUrl = document.getElementById('plex-url');
const plexToken = document.getElementById('plex-token');
const sectionIds = document.getElementById('plex-sections');
const labelsInput = document.getElementById('plex-labels');
let votingClosed = false;

function showStatus(message, success = false) {
  settingsStatus.textContent = message;
  settingsStatus.className = `status ${success ? 'success' : 'error'}`;
}

function collectSettings() {
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
    providers: [...document.querySelectorAll('#provider-checks input:checked')].map(input => Number(input.value))
  };
}

async function saveSettings(showMessage = true) {
  await API.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(collectSettings()) });
  await refreshPlexStats();
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
    const [settings, titles] = await Promise.all([API.request('/api/admin/settings'), API.request('/api/shortlist')]);
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
    renderVoting();
    renderShortlist(titles);
    await refreshPlexStats();
    if (settings.plexToken) await initializePlex(settings);
  } catch (error) {
    showStatus(error.message);
    if (error.message.includes('PIN')) location.href = '/admin';
  }
}

function renderVoting() {
  document.getElementById('voting-state').textContent = votingClosed ? 'Voting is closed.' : 'Voting is open.';
  document.getElementById('toggle-voting').textContent = votingClosed ? 'Reopen voting' : 'Close voting';
}

function renderShortlist(items) {
  const list = document.getElementById('admin-shortlist');
  list.replaceChildren();
  document.getElementById('shortlist-count').textContent = `${items.length}/20 titles`;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'admin-item';
    const info = document.createElement('span');
    info.textContent = `${item.title}${item.year ? ` (${item.year})` : ''} · ${item.type === 'tv' ? 'TV Show' : 'Movie'}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      try {
        await API.request(`/api/admin/shortlist/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        const updated = await API.request('/api/shortlist');
        renderShortlist(updated);
      } catch (error) { showStatus(error.message); }
    });
    row.append(info, remove);
    list.append(row);
  }
  document.getElementById('clear-shortlist').disabled = !items.length;
}

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

document.getElementById('clear-shortlist').addEventListener('click', async () => {
  if (!window.confirm('Clear every title and ballot? This cannot be undone.')) return;
  try {
    await API.request('/api/admin/shortlist', { method: 'DELETE' });
    renderShortlist([]);
  } catch (error) { showStatus(error.message); }
});

document.getElementById('logout').addEventListener('click', async () => {
  try { await API.request('/api/admin/logout', { method: 'POST', body: '{}' }); location.href = '/admin'; }
  catch (error) { showStatus(error.message); }
});

loadAdmin();

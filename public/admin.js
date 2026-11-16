const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');
let votingClosed = false;

function showStatus(message, success = false) {
  settingsStatus.textContent = message;
  settingsStatus.className = `status ${success ? 'success' : 'error'}`;
}

async function loadAdmin() {
  try {
    const [settings, titles] = await Promise.all([API.request('/api/admin/settings'), API.request('/api/shortlist')]);
    document.getElementById('plex-url').value = settings.plexUrl;
    document.getElementById('plex-token').value = settings.plexToken;
    document.getElementById('plex-sections').value = settings.sectionIds;
    document.getElementById('plex-labels').value = settings.labels;
    document.getElementById('tmdb-key').value = settings.tmdbKey;
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
  const data = {
    plexUrl: document.getElementById('plex-url').value,
    plexToken: document.getElementById('plex-token').value,
    sectionIds: document.getElementById('plex-sections').value,
    labels: document.getElementById('plex-labels').value,
    tmdbKey: document.getElementById('tmdb-key').value,
    providers: [...document.querySelectorAll('#provider-checks input:checked')].map(input => Number(input.value))
  };
  try {
    await API.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(data) });
    showStatus('Settings saved.', true);
  } catch (error) { showStatus(error.message); }
});

document.getElementById('sync-plex').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    await API.request('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({
        plexUrl: document.getElementById('plex-url').value,
        plexToken: document.getElementById('plex-token').value,
        sectionIds: document.getElementById('plex-sections').value,
        labels: document.getElementById('plex-labels').value,
        tmdbKey: document.getElementById('tmdb-key').value,
        providers: [...document.querySelectorAll('#provider-checks input:checked')].map(input => Number(input.value))
      })
    });
    const { count } = await API.request('/api/admin/sync', { method: 'POST', body: '{}' });
    showStatus(`Plex sync complete: ${count} titles.`, true);
  } catch (error) { showStatus(error.message); }
  finally { button.disabled = false; button.textContent = 'Sync Plex Libraries'; }
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

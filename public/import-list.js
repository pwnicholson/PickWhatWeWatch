const importModal = document.createElement('div');
importModal.className = 'modal-backdrop';
importModal.id = 'import-list-modal';
importModal.setAttribute('aria-hidden', 'true');
importModal.innerHTML = `
  <section class="modal import-modal" role="dialog" aria-modal="true" aria-label="Import list">
    <button class="modal-close" type="button" aria-label="Close import dialog">×</button>
    <div class="import-content">
      <h2>Import List</h2>
      <div class="import-tabs" role="tablist">
        <button class="button secondary" type="button" data-import-tab="watchlist">Plex Watchlist</button>
        <button class="button secondary" type="button" data-import-tab="paste">Paste List / Upload CSV</button>
      </div>
      <section id="import-watchlist-panel" class="import-panel">
        <p class="muted">Match Plex Watchlist titles to your local library first, then to active streaming services.</p>
        <button id="load-plex-watchlist" class="button secondary" type="button">Load Plex Watchlist</button>
        <div id="plex-watchlist-items" class="import-items"></div>
      </section>
      <section id="import-paste-panel" class="import-panel" hidden>
        <label class="field">One title per line, optionally followed by a year
          <textarea id="import-list-text" rows="7" placeholder="The Princess Bride (1987)"></textarea>
        </label>
        <label class="field">Or choose a CSV file<input id="import-list-file" type="file" accept=".csv,text/csv"></label>
        <button id="preview-import-list" class="button secondary" type="button">Preview Matches</button>
        <div id="import-list-matches" class="import-items"></div>
        <div id="import-list-unmatched" class="import-unmatched"></div>
      </section>
      <p id="import-list-status" class="status" aria-live="polite"></p>
      <button id="add-imported-titles" class="button" type="button">Add Selected to Shortlist</button>
    </div>
  </section>`;
document.body.append(importModal);

let activeImportTab = 'watchlist';
let importItems = { watchlist: [], paste: [] };
let importCsvText = '';

const importStatus = document.getElementById('import-list-status');
const importPanels = {
  watchlist: document.getElementById('import-watchlist-panel'),
  paste: document.getElementById('import-paste-panel')
};

function setImportStatus(message, error = false) {
  importStatus.textContent = message;
  importStatus.className = `status${error ? ' error' : ''}`;
}

function setImportTab(tab) {
  activeImportTab = tab;
  for (const [name, panel] of Object.entries(importPanels)) panel.hidden = name !== tab;
  for (const button of document.querySelectorAll('[data-import-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.importTab === tab));
  }
  setImportStatus('');
}

function renderImportItems(tab, container) {
  const items = importItems[tab];
  container.replaceChildren(...items.map((item, index) => {
    const row = document.createElement('label');
    row.className = 'import-item';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = String(index);
    check.checked = true;
    const poster = posterNode(item.poster, item.title, 'import-poster');
    const copy = document.createElement('span');
    copy.className = 'import-item-copy';
    const title = document.createElement('strong');
    title.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
    const meta = document.createElement('span');
    meta.textContent = `${item.type === 'tv' ? 'TV Show' : 'Movie'} · ${item.source === 'plex' ? 'On Plex' : (item.providers || []).join(', ') || 'TMDB'}`;
    copy.append(title, meta);
    row.append(check, poster, copy);
    return row;
  }));
}

function openImportModal() {
  importModal.classList.add('open');
  importModal.setAttribute('aria-hidden', 'false');
  setImportTab('watchlist');
  updateImportAddButton();
  loadPlexWatchlist();
}

function closeImportModal() {
  importModal.classList.remove('open');
  importModal.setAttribute('aria-hidden', 'true');
}

async function updateImportAddButton() {
  const button = document.getElementById('add-imported-titles');
  try {
    const status = await API.request('/api/status');
    const blockedMode = status.votingMode !== 'standard';
    const full = status.shortlistCount >= status.shortlistMaxSize;
    button.disabled = blockedMode || full;
    button.title = blockedMode
      ? 'Switch to Standard Mode to import titles without changing the Two-Round pool.'
      : full ? 'The Standard shortlist is full.' : '';
  } catch (error) {
    button.disabled = true;
    setImportStatus(error.message, true);
  }
}

async function loadPlexWatchlist() {
  const button = document.getElementById('load-plex-watchlist');
  button.disabled = true;
  setImportStatus('Loading Plex Watchlist…');
  try {
    const result = await API.request('/api/plex/watchlist');
    importItems.watchlist = result.items || [];
    renderImportItems('watchlist', document.getElementById('plex-watchlist-items'));
    const unmatched = result.unmatched?.length ? ` · ${result.unmatched.length} could not be matched.` : '';
    setImportStatus(`${importItems.watchlist.length} titles ready to import${unmatched}`);
  } catch (error) {
    setImportStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function previewPastedList() {
  const button = document.getElementById('preview-import-list');
  button.disabled = true;
  setImportStatus('Matching titles…');
  document.getElementById('import-list-unmatched').replaceChildren();
  try {
    const text = document.getElementById('import-list-text').value;
    const result = await API.request('/api/import/list', {
      method: 'POST',
      body: JSON.stringify(importCsvText ? { csv: importCsvText } : { text })
    });
    importItems.paste = result.matched || [];
    renderImportItems('paste', document.getElementById('import-list-matches'));
    const unmatched = document.getElementById('import-list-unmatched');
    if (result.unmatched?.length) {
      const heading = document.createElement('strong');
      heading.textContent = `Unmatched (${result.unmatched.length})`;
      const list = document.createElement('ul');
      for (const item of result.unmatched) {
        const line = document.createElement('li');
        line.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
        list.append(line);
      }
      unmatched.replaceChildren(heading, list);
    }
    setImportStatus(`${importItems.paste.length} matched · ${result.unmatched?.length || 0} unmatched.`);
  } catch (error) {
    setImportStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function addSelectedImports() {
  const selected = [...importPanels[activeImportTab].querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => importItems[activeImportTab][Number(input.value)]).filter(Boolean);
  if (!selected.length) return setImportStatus('Select at least one title to add.', true);
  const button = document.getElementById('add-imported-titles');
  button.disabled = true;
  try {
    const status = await API.request('/api/status');
    if (status.votingMode !== 'standard') {
      throw new Error('Switch to Standard Mode before importing titles. The Two-Round pool is managed separately.');
    }
    const available = Math.max(0, status.shortlistMaxSize - status.shortlistCount);
    if (!available) throw new Error('The Standard shortlist is full. Remove a title or increase its size first.');
    const batch = selected.slice(0, available);
    let added = 0;
    const failures = [];
    for (const item of batch) {
      try {
        await API.request('/api/shortlist', {
          method: 'POST',
          body: JSON.stringify({
            source: item.source, sourceId: item.sourceId, title: item.title,
            type: item.type, year: item.year, poster: item.poster
          })
        });
        added++;
      } catch (error) { failures.push(`${item.title}: ${error.message}`); }
    }
    if (added) window.dispatchEvent(new CustomEvent('shortlist-updated'));
    await updateImportAddButton();
    const capacityNote = selected.length > batch.length ? ` ${selected.length - batch.length} skipped because the list is full.` : '';
    const failureNote = failures.length ? ` ${failures.join('; ')}` : '';
    setImportStatus(`Added ${added} ${added === 1 ? 'title' : 'titles'}.${capacityNote}${failureNote}`, failures.length > 0);
  } catch (error) {
    setImportStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('[data-import-tab]').forEach(button =>
  button.addEventListener('click', () => setImportTab(button.dataset.importTab)));
document.getElementById('load-plex-watchlist').addEventListener('click', loadPlexWatchlist);
document.getElementById('preview-import-list').addEventListener('click', previewPastedList);
document.getElementById('add-imported-titles').addEventListener('click', addSelectedImports);
document.getElementById('import-list-file').addEventListener('change', async event => {
  const file = event.currentTarget.files?.[0];
  try {
    importCsvText = file ? await file.text() : '';
    if (file) setImportStatus(`Loaded ${file.name}. Preview it to match titles.`);
  } catch (error) {
    importCsvText = '';
    setImportStatus(`Could not read the CSV file: ${error.message}`, true);
  }
});
document.getElementById('import-list-text').addEventListener('input', () => {
  importCsvText = '';
  document.getElementById('import-list-file').value = '';
});
document.querySelectorAll('#open-import-list, #open-public-import-list').forEach(button =>
  button.addEventListener('click', openImportModal));
window.addEventListener('shortlist-updated', updateImportAddButton);
importModal.querySelector('.modal-close').addEventListener('click', closeImportModal);
importModal.addEventListener('click', event => { if (event.target === importModal) closeImportModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeImportModal(); });

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
const searchStatus = document.getElementById('search-status');
let searchTimer;

function searchCard(item) {
  return titleCard(item, () => openTitle(item, true));
}

async function loadSourceStatus() {
  const banner = document.getElementById('source-setup-banner');
  try {
    const status = await API.request('/api/config/status');
    banner.hidden = status.plexConfigured || status.tmdbConfigured || status.omdbConfigured;
  } catch (error) {
    banner.hidden = false;
    banner.querySelector('span').textContent = `Unable to check media-source setup: ${error.message}`;
  }
}

async function loadShortlist() {
  try {
    const [items, status] = await Promise.all([API.request('/api/shortlist'), API.request('/api/status')]);
    const list = document.getElementById('shortlist');
    list.replaceChildren(...items.map(item => titleCard(item, () => openTitle(item, false))));
    document.getElementById('empty-shortlist').hidden = items.length > 0;
    const full = items.length >= status.shortlistMaxSize;
    document.getElementById('shortlist-count').textContent = `${items.length} / ${status.shortlistMaxSize} titles`;
    searchInput.disabled = full;
    searchInput.classList.toggle('is-full', full);
    document.getElementById('shortlist-full-note').hidden = !full;
    if (full) {
      searchResults.replaceChildren();
      searchStatus.textContent = '';
    }
    document.getElementById('home-status').textContent = status.votingClosed ? 'Voting is closed.' : '';
  } catch (error) {
    document.getElementById('home-status').textContent = error.message;
    document.getElementById('home-status').className = 'status error';
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  searchResults.replaceChildren();
  if (query.length < 2) { searchStatus.textContent = ''; return; }
  searchStatus.textContent = 'Searching Plex and TMDB…';
  searchTimer = setTimeout(async () => {
    try {
      const items = await API.request(`/api/search?q=${encodeURIComponent(query)}`);
      searchResults.replaceChildren(...items.map(searchCard));
      searchStatus.textContent = items.length ? `${items.length} titles found` : 'No matches. Try another search or check your TMDB and Plex settings.';
    } catch (error) {
      searchStatus.textContent = error.message;
      searchStatus.className = 'status error';
    }
  }, 300);
});

document.getElementById('change-name').addEventListener('click', () => {
  const next = window.prompt('What should we call you?', localStorage.getItem('watch-night-name') || '')?.trim();
  if (next) {
    localStorage.setItem('watch-night-name', next.slice(0, 60));
    document.getElementById('welcome').textContent = `Welcome, ${next}!`;
  }
});

const name = askName();
document.getElementById('welcome').textContent = name ? `Welcome, ${name}!` : '';
window.addEventListener('shortlist-updated', loadShortlist);
loadSourceStatus();
loadShortlist();

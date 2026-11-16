const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
const searchStatus = document.getElementById('search-status');
let searchTimer;

function searchCard(item) {
  return titleCard(item, () => openTitle(item, true));
}

async function loadShortlist() {
  try {
    const [items, status] = await Promise.all([API.request('/api/shortlist'), API.request('/api/status')]);
    const list = document.getElementById('shortlist');
    list.replaceChildren(...items.map(item => titleCard(item, () => openTitle(item, false))));
    document.getElementById('empty-shortlist').hidden = items.length > 0;
    document.getElementById('shortlist-count').textContent = `${items.length}/20 titles`;
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
loadShortlist();

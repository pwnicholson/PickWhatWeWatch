const API = {
  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
};

function posterNode(src, title, className = 'poster') {
  const image = document.createElement('img');
  image.className = className;
  image.alt = `${title} poster`;
  image.loading = 'lazy';
  image.src = src || '';
  image.onerror = () => {
    const empty = document.createElement('div');
    empty.className = `${className} poster-empty`;
    empty.textContent = '🎬';
    image.replaceWith(empty);
  };
  return image;
}

function titleCard(item, click) {
  const button = document.createElement('button');
  button.className = 'title-card';
  button.type = 'button';
  button.append(posterNode(item.poster, item.title));
  const copy = document.createElement('span');
  copy.className = 'card-copy';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = item.title;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = `${item.type === 'tv' ? 'TV Show' : 'Movie'}${item.year ? ` · ${item.year}` : ''}`;
  copy.append(title, meta);
  button.append(copy);
  button.addEventListener('click', click);
  return button;
}

function openTitle(item, canAdd = false) {
  const backdrop = document.getElementById('detail-modal');
  backdrop.classList.add('open');
  backdrop.setAttribute('aria-hidden', 'false');
  const content = backdrop.querySelector('.modal-content');
  content.replaceChildren(document.createElement('div'), document.createElement('div'));
  content.children[0].className = 'detail-poster';
  content.children[1].className = 'modal-copy';
  content.children[0].append(posterNode(item.poster, item.title));
  content.children[1].textContent = 'Loading title details…';

  API.request(`/api/title?source=${encodeURIComponent(item.source)}&id=${encodeURIComponent(item.sourceId)}`)
    .then(detail => {
      const copy = content.children[1];
      copy.replaceChildren();
      const badge = document.createElement('span');
      badge.className = 'badge accent';
      badge.textContent = item.source === 'plex' ? 'On Plex' : (detail.providers || []).map(p => p.provider_name).join(', ') || 'TMDB';
      const heading = document.createElement('h2');
      heading.textContent = detail.title;
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = `${detail.type === 'tv' ? 'TV Show' : 'Movie'}${detail.year ? ` · ${detail.year}` : ''}${detail.rating ? ` · ${detail.rating}` : ''}`;
      const genres = document.createElement('p');
      genres.textContent = (detail.genres || []).join(' · ');
      const summary = document.createElement('p');
      summary.textContent = detail.summary || 'No plot summary available.';
      copy.append(badge, heading, meta, genres, summary);
      if (canAdd) {
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const add = document.createElement('button');
        add.className = 'button';
        add.textContent = 'Add to Shortlist';
        add.addEventListener('click', async () => {
          add.disabled = true;
          try {
            await API.request('/api/shortlist', {
              method: 'POST',
              body: JSON.stringify({
                source: item.source, sourceId: item.sourceId, title: detail.title,
                type: detail.type, year: detail.year, poster: detail.poster
              })
            });
            window.dispatchEvent(new CustomEvent('shortlist-updated'));
            add.textContent = 'Added!';
          } catch (error) {
            add.disabled = false;
            add.textContent = error.message;
          }
        });
        actions.append(add);
        copy.append(actions);
      }
    })
    .catch(error => {
      content.children[1].textContent = error.message;
    });
}

function closeModal() {
  const backdrop = document.getElementById('detail-modal');
  backdrop.classList.remove('open');
  backdrop.setAttribute('aria-hidden', 'true');
}

function askName() {
  let name = localStorage.getItem('watch-night-name') || '';
  if (!name) {
    name = window.prompt('What should we call you?')?.trim() || '';
    if (name) localStorage.setItem('watch-night-name', name.slice(0, 60));
  }
  return name;
}

function requireName() {
  const name = askName();
  if (!name) {
    const again = window.prompt('A name is needed to vote. What should we call you?')?.trim() || '';
    if (again) localStorage.setItem('watch-night-name', again.slice(0, 60));
    return again;
  }
  return name;
}

document.addEventListener('DOMContentLoaded', () => {
  const backdrop = document.getElementById('detail-modal');
  if (!backdrop) return;
  backdrop.querySelector('.modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
});

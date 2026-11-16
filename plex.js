const { XMLParser } = require('fast-xml-parser');
const db = require('./db');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

function plexUrl(path, base) {
  const url = new URL(path, base);
  return url;
}

async function plexRequest(path, config) {
  const url = plexUrl(path, config.serverUrl);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  const response = await fetch(url, { headers: { Accept: 'application/xml' } });
  if (!response.ok) throw new Error(`Plex returned ${response.status} for ${path}`);
  return parser.parse(await response.text());
}

function array(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

async function syncLibraries(config) {
  if (!config.serverUrl || !config.plexToken) throw new Error('Configure the Plex URL and token first.');
  const ids = config.sectionIds.split(',').map(value => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('Enter at least one Plex library section ID.');

  const added = [];
  for (const sectionId of ids) {
    const sectionDoc = await plexRequest(`/library/sections/${encodeURIComponent(sectionId)}`, config);
    const section = sectionDoc?.MediaContainer?.Directory;
    if (!section) throw new Error(`Plex library section ${sectionId} was not found.`);
    const type = section.type === 'show' ? 'tv' : section.type === 'movie' ? 'movie' : null;
    if (!type) throw new Error(`Section ${sectionId} is not a Movie or TV Show library.`);

    const endpointType = type === 'movie' ? 1 : 2;
    const doc = await plexRequest(`/library/sections/${encodeURIComponent(sectionId)}/all?type=${endpointType}`, config);
    const entries = array(doc?.MediaContainer?.Video ?? doc?.MediaContainer?.Directory);
    for (const item of entries) {
      const labels = array(item.Label).map(label => label.tag?.toLowerCase()).filter(Boolean);
      if (config.labels.length && !labels.some(label => config.labels.includes(label))) continue;
      const genres = array(item.Genre).map(genre => genre.tag).filter(Boolean);
      const id = String(item.ratingKey ?? item.key);
      if (!id) continue;
      added.push({
        id, title: item.title || 'Untitled', type,
        year: Number(item.year) || null, summary: item.summary || '',
        poster: item.thumb ? `/api/plex-image?path=${encodeURIComponent(item.thumb)}` : '',
        rating: item.contentRating || '', genres: JSON.stringify(genres), section_id: sectionId
      });
    }
  }

  const replace = db.transaction(items => {
    db.prepare('DELETE FROM plex_titles').run();
    const insert = db.prepare(`INSERT INTO plex_titles
      (id,title,type,year,summary,poster,rating,genres,section_id)
      VALUES (@id,@title,@type,@year,@summary,@poster,@rating,@genres,@section_id)`);
    for (const item of items) insert.run(item);
  });
  replace(added);
  return added.length;
}

module.exports = { syncLibraries, plexRequest };

const { XMLParser } = require('fast-xml-parser');
const db = require('./db');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const PLEX_PRODUCT = 'Pick What We Watch';

function plexUrl(path, base) {
  const url = new URL(path, base);
  return url;
}

function setting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

function headers(clientId, accept = 'application/json') {
  return {
    Accept: accept,
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Client-Identifier': clientId
  };
}

async function plexCloudRequest(url, options, clientId) {
  const response = await fetch(url, { ...options, headers: { ...headers(clientId), ...options?.headers } });
  if (!response.ok) throw new Error(`Plex authentication request failed (${response.status}).`);
  return response.json();
}

async function createPin(clientId) {
  const url = new URL('https://plex.tv/api/v2/pins');
  url.searchParams.set('strong', 'true');
  return plexCloudRequest(url, { method: 'POST' }, clientId);
}

async function pollPin(pinId, clientId) {
  return plexCloudRequest(`https://plex.tv/api/v2/pins/${encodeURIComponent(pinId)}`, { method: 'GET' }, clientId);
}

async function plexServers(token, clientId) {
  if (!token) throw new Error('Connect to Plex or enter a manual token first.');
  const url = new URL('https://plex.tv/api/v2/resources');
  url.searchParams.set('includeHttps', '1');
  url.searchParams.set('X-Plex-Token', token);
  const resources = await plexCloudRequest(url, { method: 'GET' }, clientId);
  const entries = Array.isArray(resources) ? resources : resources?.MediaContainer?.Device || [];
  return entries
    .filter(resource => (resource.owned === true || resource.owned === 1 || resource.owned === '1') &&
      String(resource.provides || '').split(',').map(value => value.trim()).includes('server'))
    .map(resource => {
      const connections = (resource.connections || [])
        .filter(connection => {
          try { return ['http:', 'https:'].includes(new URL(connection.uri).protocol); }
          catch { return false; }
        })
        .sort((a, b) => Number(Boolean(b.local)) - Number(Boolean(a.local)));
      const connection = connections[0];
      return connection ? {
        name: resource.name || resource.product || 'Plex Server',
        url: connection.uri.replace(/\/+$/, ''),
        local: Boolean(connection.local),
        clientIdentifier: resource.clientIdentifier || ''
      } : null;
    })
    .filter(Boolean);
}

async function plexRequest(path, config) {
  const url = plexUrl(path, config.serverUrl);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  const response = await fetch(url, { headers: { Accept: 'application/xml' } });
  if (!response.ok) throw new Error(`Plex returned ${response.status} for ${path}`);
  return parser.parse(await response.text());
}

async function plexJsonRequest(path, config) {
  const url = plexUrl(path, config.serverUrl);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Plex returned ${response.status} for ${path}`);
  return response.json();
}

function array(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

async function getLibraries(config = {}) {
  const serverUrl = config.serverUrl || setting('plex_url');
  const plexToken = config.plexToken || setting('plex_token');
  if (!serverUrl || !plexToken) throw new Error('Connect to Plex or enter a server URL and token first.');
  const data = await plexJsonRequest('/library/sections', { serverUrl, plexToken });
  return array(data?.MediaContainer?.Directory)
    .filter(library => library.type === 'movie' || library.type === 'show')
    .map(library => ({
      id: String(library.key || library.id),
      title: library.title || 'Untitled library',
      type: library.type
    }))
    .filter(library => library.id !== 'undefined');
}

async function getLabels(sectionIds, config = {}) {
  const serverUrl = config.serverUrl || setting('plex_url');
  const plexToken = config.plexToken || setting('plex_token');
  if (!serverUrl || !plexToken) throw new Error('Connect to Plex or enter a server URL and token first.');
  const distinct = new Map();
  for (const sectionId of sectionIds) {
    if (!/^\d+$/.test(sectionId)) throw new Error('Invalid Plex library section ID.');
    const data = await plexJsonRequest(`/library/sections/${sectionId}/label`, { serverUrl, plexToken });
    for (const label of array(data?.MediaContainer?.Directory ?? data?.MediaContainer?.Tag ?? data?.MediaContainer?.Metadata)) {
      const name = String(label.tag || label.title || label.name || '').trim();
      if (name && !distinct.has(name.toLocaleLowerCase())) distinct.set(name.toLocaleLowerCase(), name);
    }
  }
  return [...distinct.values()].sort((a, b) => a.localeCompare(b));
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

module.exports = { createPin, getLabels, getLibraries, plexRequest, plexServers, pollPin, syncLibraries };

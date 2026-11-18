const ballotList = document.getElementById('ballot-list');
const voteStatus = document.getElementById('vote-status');
let currentBallot = { ranks: [], approvals: [], vetoes: [] };
let round1 = null;
let round1PollTimer;
let round1PollMode = '';

function setRound1Poll(mode, callback, interval = 3000) {
  if (round1PollTimer && round1PollMode === mode) return;
  if (round1PollTimer) clearInterval(round1PollTimer);
  round1PollMode = mode;
  round1PollTimer = setInterval(callback, interval);
}

function descriptionControls(item) {
  const description = String(item.summary || item.overview || '').trim();
  if (!description) return [];

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'text-button description-toggle';
  toggle.textContent = 'Show Description';
  toggle.setAttribute('aria-expanded', 'false');
  const paragraph = document.createElement('p');
  paragraph.className = 'vote-description';
  paragraph.textContent = description;
  paragraph.hidden = true;
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    paragraph.hidden = !paragraph.hidden;
    toggle.textContent = paragraph.hidden ? 'Show Description' : 'Hide Description';
    toggle.setAttribute('aria-expanded', String(!paragraph.hidden));
  });
  return [toggle, paragraph];
}

function ballotRow(item) {
  const row = document.createElement('article');
  row.className = 'ballot-card';

  const posterButton = document.createElement('button');
  posterButton.type = 'button';
  posterButton.className = 'ballot-poster';
  posterButton.setAttribute('aria-label', `View details for ${item.title}`);
  posterButton.append(posterNode(item.poster, item.title));
  posterButton.addEventListener('click', () => openTitle(item));

  const content = document.createElement('div');
  content.className = 'ballot-content';
  const heading = document.createElement('div');
  heading.className = 'ballot-heading';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ballot-title';
  title.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
  title.addEventListener('click', () => openTitle(item));
  const source = document.createElement('span');
  source.className = 'badge ballot-source';
  source.textContent = item.source === 'plex' ? 'On Plex' : (item.providers || []).join(', ') || 'Streaming';
  heading.append(title, source);
  content.append(heading);

  const critics = [
    item.metacriticScore && `${item.metacriticScore} Metacritic`,
    item.imdbRating && `${item.imdbRating} IMDb`,
    item.rtScore && `${item.rtScore} RT`
  ].filter(Boolean);
  if (critics.length) {
    const line = document.createElement('div');
    line.className = 'ballot-critic';
    line.textContent = critics.join(' · ');
    content.append(line);
  }
  if (item.genres?.length) {
    const line = document.createElement('div');
    line.className = 'ballot-meta';
    line.textContent = item.genres.join(', ');
    content.append(line);
  }
  if (item.castTop2?.length) {
    const line = document.createElement('div');
    line.className = 'ballot-meta subtle';
    line.textContent = item.castTop2.join(', ');
    content.append(line);
  }
  if (item.director) {
    const line = document.createElement('div');
    line.className = 'ballot-meta subtle';
    line.textContent = `${item.type === 'tv' ? 'Created by' : 'Dir'}: ${item.director}`;
    content.append(line);
  }
  content.append(...descriptionControls(item));
  const controls = document.createElement('div');
  controls.className = 'ballot-controls';
  const rankGroup = document.createElement('div');
  rankGroup.className = 'ballot-rank-group';
  rankGroup.setAttribute('role', 'group');
  rankGroup.setAttribute('aria-label', `Rank ${item.title}`);
  const rankLabel = document.createElement('span');
  rankLabel.className = 'control-caption';
  rankLabel.textContent = 'Rank';
  const rankButtons = [];
  const rankIndex = currentBallot.ranks.indexOf(item.id);
  for (const value of ['1', '2', '3']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rank-button';
    button.textContent = `#${value}`;
    button.dataset.rank = item.id;
    button.dataset.value = value;
    button.setAttribute('aria-label', `Rank ${item.title} as choice #${value}`);
    button.setAttribute('aria-pressed', String(rankIndex === Number(value) - 1));
    rankButtons.push(button);
    rankGroup.append(button);
  }
  rankGroup.prepend(rankLabel);

  const approvalLabel = document.createElement('label');
  approvalLabel.className = 'ballot-toggle';
  const approval = document.createElement('input');
  approval.type = 'checkbox';
  approval.dataset.approval = item.id;
  approval.checked = currentBallot.approvals.includes(item.id) || rankIndex >= 0;
  approval.disabled = rankIndex >= 0;
  approvalLabel.append(approval, document.createTextNode('Willing to watch'));

  const vetoLabel = document.createElement('label');
  vetoLabel.className = 'ballot-toggle';
  const veto = document.createElement('input');
  veto.type = 'checkbox';
  veto.dataset.veto = item.id;
  veto.checked = currentBallot.vetoes.includes(item.id);
  vetoLabel.append(veto, document.createTextNode('Veto'));
  controls.append(rankGroup, approvalLabel, vetoLabel);
  content.append(controls);
  row.append(posterButton, content);

  const updateApproval = card => {
    const hasRank = card.querySelector('[data-rank][aria-pressed="true"]');
    const checkbox = card.querySelector('[data-approval]');
    if (hasRank) checkbox.checked = true;
    checkbox.disabled = Boolean(hasRank);
  };
  for (const button of rankButtons) {
    button.addEventListener('click', () => {
      const selected = button.getAttribute('aria-pressed') === 'true';
      if (!selected) {
        row.querySelectorAll('[data-rank]').forEach(other => other.setAttribute('aria-pressed', 'false'));
        ballotList.querySelectorAll('[data-rank]').forEach(other => {
          if (other !== button && other.dataset.value === button.dataset.value) {
            other.setAttribute('aria-pressed', 'false');
            updateApproval(other.closest('.ballot-card'));
          }
        });
      }
      button.setAttribute('aria-pressed', String(!selected));
      updateApproval(row);
    });
  }
  return row;
}

async function initializeBallot() {
  if (round1PollTimer) clearInterval(round1PollTimer);
  round1PollTimer = null;
  round1PollMode = '';
  const voter = requireName();
  document.getElementById('voter-label').textContent = voter ? `Voting as ${voter}` : 'Your name is saved only in this browser.';
  try {
    const status = await API.request('/api/session/status');
    if (status.votingMode === 'two_round' && status.roundStage === 'draft') {
      document.getElementById('vote-heading').textContent = 'Build the list together.';
      document.getElementById('vote-instructions').textContent = '';
      document.getElementById('standard-ballot').hidden = true;
      document.getElementById('round1-view').hidden = false;
      setDraftWaiting(true);
      setRound1Poll('draft', pollDraftStatus, 4000);
      return;
    }

    if (status.votingMode === 'two_round' && status.roundStage === 'round1') {
      document.getElementById('vote-heading').textContent = 'Build the list together.';
      document.getElementById('vote-instructions').textContent = 'For each title, choose Yes if you would include it in the shortlist, or No if not.';
      document.getElementById('standard-ballot').hidden = true;
      document.getElementById('round1-view').hidden = false;
      setDraftWaiting(false);
      await initializeRound1(voter);
      return;
    }

    document.getElementById('vote-heading').textContent = 'Cast your vote.';
    document.getElementById('vote-instructions').textContent =
      'Rank your top three (#1 = +3 pts, #2 = +2 pts, #3 = +1 pt), mark anything else you’re happy to watch, and veto any hard no (−5 pts).';
    document.getElementById('round1-view').hidden = true;
    document.getElementById('standard-ballot').hidden = false;
    const [titles, ballot] = await Promise.all([
      API.request('/api/shortlist'),
      API.request(`/api/ballot?voter=${encodeURIComponent(voter)}`)
    ]);
    currentBallot = ballot;
    document.getElementById('submit-vote').hidden = false;
    document.getElementById('empty-vote').hidden = titles.length !== 0;
    ballotList.replaceChildren(...titles.map(ballotRow));
  } catch (error) {
    voteStatus.textContent = error.message;
    voteStatus.className = 'status error';
  }
}

function setDraftWaiting(waiting) {
  document.getElementById('round1-draft-waiting').hidden = !waiting;
  for (const selector of [
    '#round1-banner', '#round1-progress-count', '#round1-card', '#round1-controls',
    '#round1-vote-status', '#round1-back', '#round1-waiting'
  ]) document.querySelector(selector).hidden = waiting;
}

async function pollDraftStatus() {
  try {
    const status = await API.request('/api/session/status');
    if (status.votingMode !== 'two_round') {
      if (round1PollTimer) clearInterval(round1PollTimer);
      return initializeBallot();
    }
    if (status.roundStage === 'round1') return initializeBallot();
    if (status.roundStage === 'round2') return initializeBallot();
  } catch (error) {
    const waiting = document.querySelector('#round1-draft-waiting p');
    waiting.textContent = error.message;
    waiting.className = 'status error';
  }
}

function shuffleIds(ids) {
  const shuffled = [...ids];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function saveRound1Progress() {
  localStorage.setItem(round1.storageKey, JSON.stringify({
    order: round1.order, index: round1.index
  }));
}

async function initializeRound1(voter) {
  const { roundId, items, votes } = await API.request(`/api/round1/pool?voter=${encodeURIComponent(voter)}`);
  const storageKey = `watch-night-round1:${roundId}:${voter.toLocaleLowerCase()}`;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
  const ids = items.map(item => item.id);
  const validOrder = saved?.order?.length === ids.length &&
    saved.order.every(id => ids.includes(id));
  const order = validOrder ? saved.order : shuffleIds(ids);
  let index = validOrder && Number.isInteger(saved.index)
    ? Math.max(0, Math.min(saved.index, order.length))
    : order.findIndex(id => !Object.hasOwn(votes, id));
  if (index < 0) index = order.length;
  while (index < order.length && Object.hasOwn(votes, order[index])) index++;
  round1 = { voter, items, votes, order, index, storageKey, roundId };
  saveRound1Progress();
  renderRound1();
}

function renderRound1() {
  const itemById = new Map(round1.items.map(item => [item.id, item]));
  const complete = round1.index >= round1.order.length;
  document.getElementById('round1-vote-status').textContent = '';
  const waiting = document.getElementById('round1-waiting');
  document.getElementById('round1-controls').hidden = complete;
  document.getElementById('round1-back').hidden = round1.order.length === 0;
  document.getElementById('round1-back').disabled = round1.index === 0;
  waiting.hidden = !complete;
  document.getElementById('round1-card').replaceChildren();
  document.getElementById('round1-progress-count').textContent = complete
    ? `Card ${round1.order.length} of ${round1.order.length}`
    : `Card ${round1.index + 1} of ${round1.order.length}`;
  if (complete) {
    setRound1Poll('round2', pollRound2Status);
    pollRound2Status();
    return;
  }
  setRound1Poll('active', pollActiveRound1Status);
  const item = itemById.get(round1.order[round1.index]);
  if (!item) {
    round1.index++;
    saveRound1Progress();
    return renderRound1();
  }
  const card = document.createElement('div');
  card.className = 'round1-card';
  const poster = posterNode(item.poster, item.title);
  poster.addEventListener('click', () => openTitle(item));
  const copy = document.createElement('div');
  copy.className = 'round1-copy';
  const badge = document.createElement('span');
  badge.className = 'badge ballot-source';
  badge.textContent = item.source === 'plex' ? 'On Plex' :
    (item.providers || []).map(provider => provider.provider_name || provider).join(', ') || 'Streaming';
  const title = document.createElement('h2');
  title.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = item.type === 'tv' ? 'TV Show' : 'Movie';
  copy.append(badge, title, meta);
  const critics = [
    item.metacriticScore && `${item.metacriticScore} Metacritic`,
    item.imdbRating && `${item.imdbRating} IMDb`,
    item.rtScore && `${item.rtScore} RT`
  ].filter(Boolean);
  if (critics.length) {
    const line = document.createElement('span');
    line.className = 'ballot-critic';
    line.textContent = critics.join(' · ');
    copy.append(line);
  }
  if (item.imdbTop250Rank) {
    const top250 = document.createElement('span');
    top250.className = 'badge accent';
    top250.textContent = `IMDb Top 250 #${item.imdbTop250Rank}`;
    copy.append(top250);
  }
  for (const text of [
    (item.genres || []).join(', '),
    (item.castTop2 || []).join(', '),
    item.director ? `${item.type === 'tv' ? 'Created by' : 'Dir'}: ${item.director}` : ''
  ]) {
    if (!text) continue;
    const line = document.createElement('span');
    line.className = 'ballot-meta';
    line.textContent = text;
    copy.append(line);
  }
  copy.append(...descriptionControls(item));
  if (Object.hasOwn(round1.votes, item.id)) {
    const savedVote = document.createElement('span');
    savedVote.className = 'muted';
    savedVote.textContent = `Saved choice: ${round1.votes[item.id] ? 'Yes' : 'No'} · answering again will update it.`;
    copy.append(savedVote);
  }
  card.append(poster, copy);
  document.getElementById('round1-card').replaceChildren(card);
}

async function saveRound1Vote(vote) {
  if (round1.busy) return;
  const itemId = round1.order[round1.index];
  round1.busy = true;
  document.getElementById('round1-no').disabled = true;
  document.getElementById('round1-yes').disabled = true;
  try {
    await API.request('/api/round1/vote', {
      method: 'POST',
      body: JSON.stringify({ voter: round1.voter, itemId, vote, roundId: round1.roundId })
    });
    round1.votes[itemId] = vote;
    round1.index++;
    while (round1.index < round1.order.length && Object.hasOwn(round1.votes, round1.order[round1.index])) {
      round1.index++;
    }
    saveRound1Progress();
    renderRound1();
  } catch (error) {
    const status = document.getElementById('round1-vote-status');
    status.textContent = error.message;
    status.className = 'status error';
  } finally {
    if (round1) round1.busy = false;
    document.getElementById('round1-no').disabled = false;
    document.getElementById('round1-yes').disabled = false;
  }
}

async function pollRound2Status() {
  if (!round1) return;
  try {
    const status = await API.request('/api/session/status');
    const banner = document.getElementById('round1-ready-status');
    const button = document.getElementById('start-round2');
    if (status.votingMode === 'two_round' && status.roundStage === 'round1' &&
        status.roundId !== round1.roundId) {
      return initializeRound1(round1.voter);
    }
    if (status.votingMode === 'two_round' && status.roundStage === 'round2') {
      banner.textContent = 'Round 2 is ready!';
      banner.className = 'status success';
      button.classList.add('round1-ready');
      if (round1PollTimer) clearInterval(round1PollTimer);
    } else {
      banner.textContent = 'Waiting for the admin to start Round 2…';
      banner.className = 'status';
      button.classList.remove('round1-ready');
    }
  } catch (error) {
    const banner = document.getElementById('round1-ready-status');
    banner.textContent = error.message;
    banner.className = 'status error';
  }
}

async function pollActiveRound1Status() {
  if (!round1 || round1.busy) return;
  try {
    const status = await API.request('/api/session/status');
    if (status.votingMode !== 'two_round' || status.roundStage !== 'round1') {
      return initializeBallot();
    }
    if (status.roundId !== round1.roundId) await initializeRound1(round1.voter);
  } catch (error) {
    document.getElementById('round1-vote-status').textContent = error.message;
    document.getElementById('round1-vote-status').className = 'status error';
  }
}

document.getElementById('round1-no').addEventListener('click', () => saveRound1Vote(0));
document.getElementById('round1-yes').addEventListener('click', () => saveRound1Vote(1));
document.getElementById('round1-back').addEventListener('click', () => {
  if (round1.index > 0) {
    round1.index--;
    saveRound1Progress();
    renderRound1();
  }
});
document.getElementById('start-round2').addEventListener('click', async () => {
  try {
    const status = await API.request('/api/session/status');
    if (status.votingMode !== 'two_round' || status.roundStage !== 'round2') {
      const notice = document.getElementById('round1-start-notice');
      notice.textContent = "Admin hasn't started Round 2 yet.";
      notice.className = 'status warning';
      return;
    }
    await initializeBallot();
  } catch (error) {
    const notice = document.getElementById('round1-start-notice');
    notice.textContent = error.message;
    notice.className = 'status error';
  }
});

document.getElementById('submit-vote').addEventListener('click', async () => {
  const voter = requireName();
  if (!voter) return;
  const ranks = [...ballotList.querySelectorAll('[data-rank][aria-pressed="true"]')]
    .sort((a, b) => Number(a.dataset.value) - Number(b.dataset.value))
    .map(button => button.dataset.rank);
  const approvals = [...ballotList.querySelectorAll('[data-approval]:checked')].map(input => input.dataset.approval);
  const vetoes = [...ballotList.querySelectorAll('[data-veto]:checked')].map(input => input.dataset.veto);
  try {
    await API.request('/api/ballot', { method: 'POST', body: JSON.stringify({ voter, ranks, approvals, vetoes }) });
    voteStatus.textContent = 'Your ballot is saved. You can update it any time before voting closes.';
    voteStatus.className = 'status success';
    document.getElementById('view-results').hidden = false;
  } catch (error) {
    voteStatus.textContent = error.message;
    voteStatus.className = 'status error';
  }
});

document.getElementById('change-voter').addEventListener('click', () => {
  const name = window.prompt('What should we call you?', localStorage.getItem('watch-night-name') || '')?.trim();
  if (name) { localStorage.setItem('watch-night-name', name.slice(0, 60)); initializeBallot(); }
});

initializeBallot();

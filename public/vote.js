const ballotList = document.getElementById('ballot-list');
const voteStatus = document.getElementById('vote-status');
let currentBallot = { ranks: [], approvals: [], vetoes: [] };
let votingClosed = false;

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
    button.disabled = votingClosed;
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
  approval.disabled = votingClosed || rankIndex >= 0;
  approvalLabel.append(approval, document.createTextNode('Willing to watch'));

  const vetoLabel = document.createElement('label');
  vetoLabel.className = 'ballot-toggle';
  const veto = document.createElement('input');
  veto.type = 'checkbox';
  veto.dataset.veto = item.id;
  veto.checked = currentBallot.vetoes.includes(item.id);
  veto.disabled = votingClosed;
  vetoLabel.append(veto, document.createTextNode('Veto'));
  controls.append(rankGroup, approvalLabel, vetoLabel);
  content.append(controls);
  row.append(posterButton, content);

  const updateApproval = card => {
    const hasRank = card.querySelector('[data-rank][aria-pressed="true"]');
    const checkbox = card.querySelector('[data-approval]');
    if (hasRank) checkbox.checked = true;
    checkbox.disabled = votingClosed || Boolean(hasRank);
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
  const voter = requireName();
  document.getElementById('voter-label').textContent = voter ? `Voting as ${voter}` : 'Your name is saved only in this browser.';
  try {
    const [titles, status, ballot] = await Promise.all([
      API.request('/api/shortlist'), API.request('/api/status'),
      API.request(`/api/ballot?voter=${encodeURIComponent(voter)}`)
    ]);
    currentBallot = ballot;
    votingClosed = status.votingClosed;
    document.getElementById('closed-notice').hidden = !votingClosed;
    document.getElementById('submit-vote').hidden = votingClosed;
    document.getElementById('empty-vote').hidden = titles.length !== 0;
    ballotList.replaceChildren(...titles.map(ballotRow));
  } catch (error) {
    voteStatus.textContent = error.message;
    voteStatus.className = 'status error';
  }
}

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

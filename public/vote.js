const ballotList = document.getElementById('ballot-list');
const voteStatus = document.getElementById('vote-status');
let shortlist = [];
let currentBallot = { ranks: [], approvals: [], vetoes: [] };
let votingClosed = false;

function ballotRow(item) {
  const row = document.createElement('article');
  row.className = 'ballot-row';
  const title = document.createElement('button');
  title.className = 'ballot-title';
  title.type = 'button';
  title.append(posterNode(item.poster, item.title));
  const titleText = document.createElement('span');
  titleText.className = 'card-title';
  titleText.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
  title.append(titleText);
  title.addEventListener('click', () => openTitle(item));

  const controls = document.createElement('div');
  controls.className = 'ballot-controls';
  const rankLabel = document.createElement('label');
  rankLabel.append(document.createTextNode('Rank'));
  const rank = document.createElement('select');
  rank.setAttribute('aria-label', `Rank for ${item.title}`);
  rank.dataset.id = item.id;
  for (const [value, text] of [['', '—'], ['1', '#1'], ['2', '#2'], ['3', '#3']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    rank.append(option);
  }
  const rankIndex = currentBallot.ranks.indexOf(item.id);
  if (rankIndex >= 0) rank.value = String(rankIndex + 1);
  rankLabel.append(rank);
  rank.addEventListener('change', () => {
    const used = [...ballotList.querySelectorAll('select')].filter(select => select !== rank && select.value && select.value === rank.value);
    for (const select of used) select.value = '';
  });

  const approvalLabel = document.createElement('label');
  const approval = document.createElement('input');
  approval.type = 'checkbox';
  approval.dataset.approval = item.id;
  approval.checked = currentBallot.approvals.includes(item.id) || rankIndex >= 0;
  approvalLabel.append(approval, document.createTextNode('Willing'));

  const vetoLabel = document.createElement('label');
  const veto = document.createElement('input');
  veto.type = 'checkbox';
  veto.dataset.veto = item.id;
  veto.checked = currentBallot.vetoes.includes(item.id);
  vetoLabel.append(veto, document.createTextNode('Veto'));
  controls.append(rankLabel, approvalLabel, vetoLabel);
  row.append(title, controls);
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
    shortlist = titles;
    currentBallot = ballot;
    votingClosed = status.votingClosed;
    document.getElementById('closed-notice').hidden = !votingClosed;
    document.getElementById('submit-vote').hidden = votingClosed;
    document.getElementById('empty-vote').hidden = titles.length !== 0;
    ballotList.replaceChildren(...titles.map(ballotRow));
    if (votingClosed) ballotList.querySelectorAll('input,select').forEach(control => control.disabled = true);
  } catch (error) {
    voteStatus.textContent = error.message;
    voteStatus.className = 'status error';
  }
}

document.getElementById('submit-vote').addEventListener('click', async () => {
  const voter = requireName();
  if (!voter) return;
  const rankValues = [...ballotList.querySelectorAll('select')];
  const ranks = [];
  for (const number of ['1', '2', '3']) {
    const selection = rankValues.find(select => select.value === number);
    if (selection) ranks.push(selection.dataset.id);
  }
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

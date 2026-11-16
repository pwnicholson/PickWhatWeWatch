const resultsList = document.getElementById('results-list');

function resultRow(item) {
  const row = document.createElement('article');
  row.className = 'result-row';
  row.append(posterNode(item.poster, item.title));
  const copy = document.createElement('div');
  const title = document.createElement('button');
  title.type = 'button';
  title.textContent = item.title;
  title.style.fontWeight = '800';
  title.addEventListener('click', () => openTitle(item));
  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = `${item.type === 'tv' ? 'TV Show' : 'Movie'}${item.year ? ` · ${item.year}` : ''}`;
  copy.append(title, meta);
  for (const name of item.vetoedBy) {
    const badge = document.createElement('span');
    badge.className = 'badge veto';
    badge.style.margin = '7px 5px 0 0';
    badge.textContent = `Vetoed by ${name}`;
    copy.append(badge);
  }
  row.append(copy);
  const score = document.createElement('div');
  score.className = 'score';
  score.textContent = `${item.score} pts`;
  const willing = document.createElement('small');
  willing.textContent = `${item.willing}/${item.voters} willing`;
  score.append(willing);
  row.append(score);
  return row;
}

async function loadResults() {
  try {
    const { results, voters } = await API.request('/api/results');
    resultsList.replaceChildren(...results.map(resultRow));
    document.getElementById('empty-results').hidden = results.length !== 0;
    document.getElementById('results-meta').textContent = `${voters} ${voters === 1 ? 'ballot' : 'ballots'} · ordered by net rank points, willing count, #1 votes, then #2 votes.`;
    const vetoed = results.filter(item => item.vetoedBy.length);
    const summary = document.getElementById('veto-summary');
    if (!vetoed.length) {
      summary.textContent = 'No titles received a veto.';
    } else {
      summary.replaceChildren();
      for (const item of vetoed) {
        const line = document.createElement('p');
        line.textContent = `${item.title} was vetoed by ${item.vetoedBy.join(', ')}`;
        summary.append(line);
      }
    }
  } catch (error) {
    const status = document.getElementById('results-status');
    status.textContent = error.message;
    status.className = 'status error';
  }
}

loadResults();

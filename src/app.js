import { classify, releasesAgo } from './utils.js';
import { resolveCommits, isAncestor } from './api-client.js';

const releasesUrl = 'data/releases.json';
let releasesData;

async function loadReleases() {
  if (!releasesData) {
    releasesData = await fetch(releasesUrl).then(r => r.json());
  }
  return releasesData;
}

function getBackendBase() {
  const html = document.documentElement;
  return html.getAttribute('data-backend')?.trim() || '';
}

async function backendFull(query) {
  const base = getBackendBase();
  if (!base) return null;
  const res = await fetch(`${base}/full?query=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  return res.json();
}

async function findFirstRelease(commitSha, channelReleases, token) {
  // Ensure oldest->newest ordering assumed
  const latest = channelReleases[channelReleases.length - 1];
  const latestIncluded = await isAncestor(commitSha, latest.framework_sha, token);
  if (!latestIncluded) return null;
  let low = 0, high = channelReleases.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midRelease = channelReleases[mid];
    if (await isAncestor(commitSha, midRelease.framework_sha, token)) {
      found = { release: midRelease, index: mid };
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

document.getElementById('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('query').value.trim();
  const token = localStorage.getItem('gh_pat') || null;
  const status = document.getElementById('status');
  status.textContent = 'Resolving…';

  const backendResult = await backendFull(input);
  let commits;
  let classification;
  if (backendResult) {
    commits = backendResult.commits;
    classification = backendResult.type;
    status.textContent = 'Resolved via backend.';
  } else {
    classification = classify(input);
    commits = await resolveCommits(classification, token);
    status.textContent = 'Resolved via client GitHub API.';
  }

  const resolvedDiv = document.getElementById('resolved');
  resolvedDiv.textContent = `Resolved commits: ${commits.length ? commits.join(', ') : '(none)'}`;

  const data = await loadReleases();
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  for (const [channel, list] of Object.entries(data.channels)) {
    if (!Array.isArray(list) || !list.length) continue;
    const latestIndex = list.length - 1;
    const latest = list[latestIndex];
    let included = false;
    let firstFound = null;

    for (const c of commits) {
      const found = await findFirstRelease(c, list, token);
      if (found) {
        included = true;
        firstFound = { ...found };
        break;
      }
    }

    const row = document.createElement('tr');
    const incHtml = included ? '<span class="success">✅</span>' : '<span class="danger">❌</span>';
    const releasesAgoVal = included ? releasesAgo(latestIndex, firstFound.index) : '—';
    const cells = [
      channel,
      latest.version,
      incHtml,
      firstFound?.release.version || '—',
      firstFound?.release.released || '—',
      releasesAgoVal
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.innerHTML = c;
      if (window.matchMedia('(max-width: 720px)').matches) {
        td.setAttribute('data-label', ['Channel','Latest Version','Included?','First Release','Date','Releases Ago'][i]);
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);
  }
});
// Resolve releases.json relative to this module so it works at /<repo>/
// instead of incorrectly resolving to the domain root.
let releasesData;

async function loadReleases() {
  if (!releasesData) {
    const releasesUrl = new URL('../data/releases.json', import.meta.url).href;
    console.debug('Loading releases from:', releasesUrl);
    const res = await fetch(releasesUrl, { cache: 'no-cache' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to load releases.json (${res.status}). ${text?.slice(0, 200)}`);
    }
    releasesData = await res.json();
  }
  return releasesData;
}

// Utility functions moved inline to keep this file self-contained.
// If you keep utils.js/api-client.js, adjust imports accordingly.
function classify(input) {
  const trimmed = input.trim();
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return { type: 'commit', value: trimmed };
  const prMatch = trimmed.match(/flutter\/flutter\/pull\/(\d+)/);
  if (prMatch) return { type: 'pr', value: prMatch[1] };
  const issueMatch = trimmed.match(/flutter\/flutter\/issues\/(\d+)/);
  if (issueMatch) return { type: 'issue', value: issueMatch[1] };
  const numOnly = trimmed.match(/^#?(\d+)$/);
  if (numOnly) return { type: 'maybe-pr-or-issue', value: numOnly[1] };
  return { type: 'unknown', value: trimmed };
}
function releasesAgo(latestIndex, firstIndex) {
  if (firstIndex == null) return '—';
  return (latestIndex - firstIndex).toString();
}

const GH_BASE = 'https://api.github.com/repos/flutter/flutter';
async function ghJson(url, token) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}
async function resolveCommits(classified, token) {
  switch (classified.type) {
    case 'commit': return [classified.value];
    case 'pr': {
      const commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
      return commits?.map(c => c.sha) ?? [];
    }
    case 'issue': {
      const events = await ghJson(`${GH_BASE}/issues/${classified.value}/events`, token);
      if (!events) return [];
      const closed = events.find(e => e.event === 'closed' && e.commit_id);
      if (closed?.commit_id) return [closed.commit_id];
      const cross = events.filter(e => e.event === 'cross-referenced' && e.source?.issue?.pull_request);
      for (const ref of cross) {
        const prNum = ref.source.issue.number;
        const commits = await ghJson(`${GH_BASE}/pulls/${prNum}/commits`, token);
        if (commits?.length) return commits.map(c => c.sha);
      }
      return [];
    }
    case 'maybe-pr-or-issue': {
      const pr = await ghJson(`${GH_BASE}/pulls/${classified.value}`, token);
      if (pr?.number) {
        const commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
        return commits?.map(c => c.sha) ?? [];
      }
      const issue = await ghJson(`${GH_BASE}/issues/${classified.value}`, token);
      if (issue?.number) return await resolveCommits({ type: 'issue', value: classified.value }, token);
      return [];
    }
    default: return [];
  }
}
async function isAncestor(fixSha, releaseSha, token) {
  const data = await ghJson(`${GH_BASE}/compare/${fixSha}...${releaseSha}`, token);
  if (!data) return false;
  return data.status === 'behind' || data.status === 'identical';
}
async function findFirstRelease(commitSha, channelReleases, token) {
  if (!channelReleases?.length) return null;
  const latest = channelReleases[channelReleases.length - 1];
  const latestIncluded = await isAncestor(commitSha, latest.framework_sha, token);
  if (!latestIncluded) return null;
  let low = 0, high = channelReleases.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midRel = channelReleases[mid];
    if (await isAncestor(commitSha, midRel.framework_sha, token)) {
      found = { release: midRel, index: mid };
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
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';
  status.textContent = 'Resolving…';

  try {
    const classification = classify(input);
    const commits = await resolveCommits(classification, token);
    status.textContent = 'Resolved input. Loading releases…';

    const data = await loadReleases();

    // GUARD: If channels are empty, surface that to the user and stop.
    const channelEntries = Object.entries(data.channels || {});
    if (!channelEntries.length) {
      status.textContent = 'No release data found. Run “Update Flutter Releases” to generate public/data/releases.json.';
      return;
    }

    const resolvedDiv = document.getElementById('resolved');
    resolvedDiv.textContent = `Resolved commits: ${commits.length ? commits.join(', ') : '(none)'}`;

    status.textContent = 'Performing channel checks…';
    for (const [channel, list] of channelEntries) {
      if (!Array.isArray(list) || !list.length) continue;
      const latestIndex = list.length - 1;
      const latest = list[latestIndex];
      let included = false;
      let firstFound = null;

      for (const c of commits) {
        const found = await findFirstRelease(c, list, token);
        if (found) { included = true; firstFound = found; break; }
      }

      const row = document.createElement('tr');
      const incHtml = included ? `<span class="success">✅</span>` : `<span class="danger">❌</span>`;
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
    status.textContent = 'Done.';
  } catch (err) {
    console.error(err);
    status.textContent = 'Error: ' + (err?.message || 'Failed to load data. Ensure releases.json exists and try again.');
  }
});
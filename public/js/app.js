// Resolve releases.json relative to this module so it works at /<repo>/
let releasesData;

// Simple local cache for compare results to reduce API calls across sessions
function getCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function setCache(key, val, ttlSec = 7 * 24 * 3600) {
  const rec = { v: val, exp: Date.now() + ttlSec * 1000 };
  try { localStorage.setItem(key, JSON.stringify(rec)); } catch {}
}
function getCachedOrNull(key) {
  const rec = getCache(key);
  if (!rec) return null;
  if (rec.exp && Date.now() > rec.exp) return null;
  return rec.v;
}

// Tiny throttle to avoid secondary rate limits
const queue = [];
let active = false;
async function throttle(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runQueue();
  });
}
async function runQueue() {
  if (active) return;
  active = true;
  while (queue.length) {
    const { fn, resolve, reject } = queue.shift();
    try {
      // Small spacing between requests
      const res = await fn();
      resolve(res);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      reject(e);
      // Backoff a bit on error (especially 403/abuse)
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  active = false;
}

async function loadReleases() {
  if (!releasesData) {
    const releasesUrl = new URL('../data/releases.json', import.meta.url).href;
    const res = await fetch(releasesUrl, { cache: 'no-cache' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to load releases.json (${res.status}). ${text?.slice(0, 200)}`);
    }
    releasesData = await res.json();
  }
  return releasesData;
}

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

function getToken() {
  return localStorage.getItem('gh_pat') || null;
}

async function ghJson(url, token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await throttle(() => fetch(url, { headers }));
  if (res.status === 403) {
    // Try to surface the reason
    let msg = `GitHub API error 403 for ${url}`;
    try {
      const body = await res.json();
      if (body?.message) msg += `: ${body.message}`;
    } catch {}
    throw new Error(msg + '. Add a token in Settings to raise rate limits.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}

async function resolveCommits(classified, token) {
  switch (classified.type) {
    case 'commit': return [{ sha: classified.value }];
    case 'pr': {
      const commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
      return (commits || []).map(c => ({ sha: c.sha }));
    }
    case 'issue': {
      const events = await ghJson(`${GH_BASE}/issues/${classified.value}/events`, token);
      if (!events) return [];
      const closed = events.find(e => e.event === 'closed' && e.commit_id);
      if (closed?.commit_id) return [{ sha: closed.commit_id }];
      const cross = events.filter(e => e.event === 'cross-referenced' && e.source?.issue?.pull_request);
      for (const ref of cross) {
        const prNum = ref.source.issue.number;
        const commits = await ghJson(`${GH_BASE}/pulls/${prNum}/commits`, token);
        if (commits?.length) return commits.map(c => ({ sha: c.sha }));
      }
      return [];
    }
    case 'maybe-pr-or-issue': {
      let commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
      if (commits?.length) return commits.map(c => ({ sha: c.sha }));
      const issue = await ghJson(`${GH_BASE}/issues/${classified.value}`, token);
      if (issue?.number) return await resolveCommits({ type: 'issue', value: classified.value }, token);
      return [];
    }
    default:
      return [];
  }
}

// IMPORTANT: inclusion when compare(base=fix, head=release) returns AHEAD or IDENTICAL
async function isAncestor(fixSha, releaseSha, token) {
  const cacheKey = `cmp:${fixSha}:${releaseSha}`;
  const cached = getCachedOrNull(cacheKey);
  if (typeof cached === 'boolean') return cached;

  const data = await ghJson(`${GH_BASE}/compare/${fixSha}...${releaseSha}`, token);
  if (!data) {
    setCache(cacheKey, false, 7 * 24 * 3600);
    return false;
  }
  const included = data.status === 'ahead' || data.status === 'identical';
  setCache(cacheKey, included, 7 * 24 * 3600);
  return included;
}

async function findFirstRelease(item, channelReleases, token) {
  if (!channelReleases?.length) return null;
  const latest = channelReleases[channelReleases.length - 1];
  const latestIncluded = await isAncestor(item.sha, latest.framework_sha, token);
  if (!latestIncluded) return null;

  let low = 0, high = channelReleases.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rel = channelReleases[mid];
    const inc = await isAncestor(item.sha, rel.framework_sha, token);
    if (inc) {
      found = { release: rel, index: mid };
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

function initSettingsUI() {
  const tokenInput = document.getElementById('token-input');
  const saveBtn = document.getElementById('save-token');
  const clearBtn = document.getElementById('clear-token');
  const rate = document.getElementById('rate-status');

  if (tokenInput) tokenInput.value = getToken() || '';

  saveBtn?.addEventListener('click', () => {
    const val = tokenInput?.value?.trim();
    if (val) {
      localStorage.setItem('gh_pat', val);
      rate.textContent = 'Token saved. Reload page to take effect.';
    }
  });
  clearBtn?.addEventListener('click', () => {
    localStorage.removeItem('gh_pat');
    if (tokenInput) tokenInput.value = '';
    rate.textContent = 'Token cleared. Reload page.';
  });

  // Show current remaining (best-effort)
  (async () => {
    try {
      const token = getToken();
      // A cheap request to get headers/limits
      const res = await throttle(() => fetch(`${GH_BASE}`, {
        headers: {
          'Accept': 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }));
      const rem = res.headers.get('X-RateLimit-Remaining');
      const lim = res.headers.get('X-RateLimit-Limit');
      if (rem && lim) rate.textContent = `Rate limit: ${rem}/${lim} remaining`;
    } catch {}
  })();
}

document.getElementById('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('query').value.trim();
  const token = getToken();
  const status = document.getElementById('status');
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';
  status.textContent = 'Resolving…';

  try {
    const classification = classify(input);
    const items = await resolveCommits(classification, token);
    const commitsStr = items.map(i => i.sha.slice(0, 12)).join(', ');
    status.textContent = 'Resolved input. Loading releases…';

    const data = await loadReleases();
    const channelEntries = Object.entries(data.channels || {});
    if (!channelEntries.length) {
      status.textContent = 'No release data found. Run “Update Flutter Releases”.';
      return;
    }

    const resolvedDiv = document.getElementById('resolved');
    resolvedDiv.textContent = `Resolved commits: ${commitsStr || '(none)'}`;

    status.textContent = 'Performing channel checks…';
    for (const [channel, list] of channelEntries) {
      if (!Array.isArray(list) || !list.length) continue;
      const latestIndex = list.length - 1;
      const latest = list[latestIndex];

      let included = false;
      let firstFound = null;

      for (const itm of items) {
        const found = await findFirstRelease(itm, list, token);
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
    const msg = err?.message || 'Unknown error';
    status.textContent = 'Error: ' + msg;
  }
});

// Initialize Settings UI
initSettingsUI();

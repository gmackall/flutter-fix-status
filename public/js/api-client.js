const GH_BASE = 'https://api.github.com/repos/flutter/flutter';

export async function ghJson(url, token) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}

export async function resolveCommits(classified, token) {
  switch (classified.type) {
    case 'commit':
      return [classified.value];
    case 'pr': {
      const commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
      if (!commits) return [];
      return commits.map(c => c.sha);
    }
    case 'issue': {
      // Use issue events to find closing commit/PR
      const events = await ghJson(`${GH_BASE}/issues/${classified.value}/events`, token);
      if (!events) return [];
      const closed = events.find(e => e.event === 'closed');
      if (closed?.commit_id) return [closed.commit_id];
      // Look for cross-referenced PR
      const cross = events.filter(e => e.event === 'cross-referenced' && e.source?.issue?.pull_request);
      // Simplify: take merged PR commits
      for (const ref of cross) {
        const prNum = ref.source.issue.number;
        const commits = await ghJson(`${GH_BASE}/pulls/${prNum}/commits`, token);
        if (commits?.length) return commits.map(c => c.sha);
      }
      return [];
    }
    case 'maybe-pr-or-issue': {
      // Try PR first
      const pr = await ghJson(`${GH_BASE}/pulls/${classified.value}`, token);
      if (pr?.number) {
        const commits = await ghJson(`${GH_BASE}/pulls/${classified.value}/commits`, token);
        return commits?.map(c => c.sha) ?? [];
      }
      // Then issue
      const issue = await ghJson(`${GH_BASE}/issues/${classified.value}`, token);
      if (issue?.number) {
        return await resolveCommits({ type: 'issue', value: classified.value }, token);
      }
      return [];
    }
    default:
      return [];
  }
}

export async function isAncestor(fixSha, releaseSha, token) {
  const data = await ghJson(`${GH_BASE}/compare/${fixSha}...${releaseSha}`, token);
  if (!data) return false;
  const status = data.status;
  return status === 'behind' || status === 'identical';
}
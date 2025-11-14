import type { VercelRequest, VercelResponse } from '@vercel/node';

const GH_BASE = 'https://api.github.com/repos/flutter/flutter';

function classify(input: string) {
  const trimmed = input.trim();
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return { type: 'commit', value: trimmed };
  const prMatch = trimmed.match(/flutter\/flutter\/pull\/(\d+)/);
  if (prMatch) return { type: 'pr', value: prMatch[1] };
  const issueMatch = trimmed.match(/flutter\/flutter\/issues\/(\d+)/);
  if (issueMatch) return { type: 'issue', value: issueMatch[1] };
  const numOnly = trimmed.match(/^#?(\d+)$/);
  if (numOnly) return { type: 'maybe', value: numOnly[1] };
  return { type: 'unknown', value: trimmed };
}

async function gh(url: string, token?: string) {
  const headers: Record<string,string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'flutter-fix-checker'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub error ${res.status} for ${url}`);
  return res.json();
}

async function resolveCommits(cls: {type:string,value:string}, token?: string): Promise<string[]> {
  switch (cls.type) {
    case 'commit': return [cls.value];
    case 'pr': {
      const commits = await gh(`${GH_BASE}/pulls/${cls.value}/commits`, token);
      return commits?.map((c: any) => c.sha) ?? [];
    }
    case 'issue': {
      const events = await gh(`${GH_BASE}/issues/${cls.value}/events`, token);
      if (!events) return [];
      const closed = events.find((e: any) => e.event === 'closed' && e.commit_id);
      if (closed?.commit_id) return [closed.commit_id];
      const cross = events.filter((e: any) => e.event === 'cross-referenced' && e.source?.issue?.pull_request);
      for (const ref of cross) {
        const prNum = ref.source.issue.number;
        const commits = await gh(`${GH_BASE}/pulls/${prNum}/commits`, token);
        if (commits?.length) return commits.map((c: any) => c.sha);
      }
      return [];
    }
    case 'maybe': {
      const pr = await gh(`${GH_BASE}/pulls/${cls.value}`, token);
      if (pr?.number) {
        const commits = await gh(`${GH_BASE}/pulls/${cls.value}/commits`, token);
        return commits?.map((c: any) => c.sha) ?? [];
      }
      const issue = await gh(`${GH_BASE}/issues/${cls.value}`, token);
      if (issue?.number) return resolveCommits({ type: 'issue', value: cls.value }, token);
      return [];
    }
    default:
      return [];
  }
}

async function isAncestor(fixSha: string, releaseSha: string, token?: string) {
  const cmp = await gh(`${GH_BASE}/compare/${fixSha}...${releaseSha}`, token);
  if (!cmp) return false;
  return cmp.status === 'behind' || cmp.status === 'identical';
}

async function earliest(commitSha: string, channelReleases: any[], token?: string) {
  if (!channelReleases.length) return null;
  const latest = channelReleases[channelReleases.length - 1];
  if (!(await isAncestor(commitSha, latest.framework_sha, token))) return null;
  let low = 0, high = channelReleases.length - 1;
  let found: any = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rel = channelReleases[mid];
    if (await isAncestor(commitSha, rel.framework_sha, token)) {
      found = { release: rel, index: mid };
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { query } = req;
    const path = req.url?.split('?')[0] || '/';
    const token = process.env.GITHUB_TOKEN;

    const releasesResp = await fetch(process.env.RELEASES_JSON_URL!);
    if (!releasesResp.ok) throw new Error('Failed to fetch releases JSON');
    const releases = await releasesResp.json();

    if (path === '/full') {
      const q = query.query as string;
      if (!q) return res.status(400).json({ error: 'missing query' });
      const cls = classify(q);
      const commits = await resolveCommits(cls, token);
      const channels: any[] = [];
      for (const [channel, list] of Object.entries(releases.channels)) {
        const arr = list as any[];
        const latestIndex = arr.length - 1;
        const latest = arr[latestIndex];
        let included = false;
        let first = null;
        for (const c of commits) {
          const e = await earliest(c, arr, token);
          if (e) {
            included = true;
            first = e;
            break;
          }
        }
        channels.push({
          channel,
          latest_version: latest?.version,
          included,
          first_version: first?.release.version ?? null,
          first_date: first?.release.released ?? null,
          releases_ago: first ? (latestIndex - first.index) : null
        });
      }
      return res.json({ query: q, type: cls.type, commits, channels });
    }

    if (path === '/resolve') {
      const q = query.query as string;
      if (!q) return res.status(400).json({ error: 'missing query' });
      const cls = classify(q);
      const commits = await resolveCommits(cls, token);
      return res.json({ original: q, type: cls.type, commits });
    }

    if (path === '/check') {
      const commit = query.commit as string;
      if (!commit) return res.status(400).json({ error: 'missing commit' });
      const channels: any[] = [];
      for (const [channel, list] of Object.entries(releases.channels)) {
        const arr = list as any[];
        const latestIndex = arr.length - 1;
        const latest = arr[latestIndex];
        const first = await earliest(commit, arr, token);
        channels.push({
          channel,
          latest_version: latest?.version,
          included: !!first,
          first_version: first?.release.version ?? null,
          first_date: first?.release.released ?? null,
          releases_ago: first ? (latestIndex - first.index) : null
        });
      }
      return res.json({ commit, channels });
    }

    res.status(404).json({ error: 'not found' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
}
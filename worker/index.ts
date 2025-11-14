import type { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';

interface Env {
  GITHUB_TOKEN?: string;
}

const GH_BASE = 'https://api.github.com/repos/flutter/flutter';

async function gh(url: string, env: Env) {
  const headers: Record<string,string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'flutter-fix-checker'
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub error ${res.status} for ${url}`);
  return res.json();
}

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

async function resolveCommits(classified: {type:string,value:string}, env: Env): Promise<string[]> {
  switch (classified.type) {
    case 'commit': return [classified.value];
    case 'pr': {
      const commits = await gh(`${GH_BASE}/pulls/${classified.value}/commits`, env);
      return commits?.map((c: any) => c.sha) ?? [];
    }
    case 'issue': {
      const events = await gh(`${GH_BASE}/issues/${classified.value}/events`, env);
      if (!events) return [];
      const closed = events.find((e: any) => e.event === 'closed' && e.commit_id);
      if (closed?.commit_id) return [closed.commit_id];
      const cross = events.filter((e: any) => e.event === 'cross-referenced' && e.source?.issue?.pull_request);
      for (const ref of cross) {
        const prNum = ref.source.issue.number;
        const commits = await gh(`${GH_BASE}/pulls/${prNum}/commits`, env);
        if (commits?.length) return commits.map((c: any) => c.sha);
      }
      return [];
    }
    case 'maybe': {
      // try PR then issue
      const pr = await gh(`${GH_BASE}/pulls/${classified.value}`, env);
      if (pr?.number) {
        const commits = await gh(`${GH_BASE}/pulls/${classified.value}/commits`, env);
        return commits?.map((c: any) => c.sha) ?? [];
      }
      const issue = await gh(`${GH_BASE}/issues/${classified.value}`, env);
      if (issue?.number) return resolveCommits({ type: 'issue', value: classified.value }, env);
      return [];
    }
    default:
      return [];
  }
}

async function isAncestor(fixSha: string, releaseSha: string, env: Env) {
  const compare = await gh(`${GH_BASE}/compare/${fixSha}...${releaseSha}`, env);
  if (!compare) return false;
  return compare.status === 'behind' || compare.status === 'identical';
}

async function fetchReleases(env: Env): Promise<any> {
  // Expect Releases JSON served from repo raw or embedded
  // Simplest: bundle a static URL; adjust to your deployed location
  const res = await fetch('https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/data/releases.json');
  if (!res.ok) throw new Error(`Failed to fetch releases.json`);
  return res.json();
}

async function earliestInChannel(commitSha: string, channelReleases: any[], env: Env) {
  if (!channelReleases.length) return null;
  const latest = channelReleases[channelReleases.length - 1];
  const includedLatest = await isAncestor(commitSha, latest.framework_sha, env);
  if (!includedLatest) return null;
  let low = 0, high = channelReleases.length - 1;
  let found: any = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = channelReleases[mid];
    if (await isAncestor(commitSha, candidate.framework_sha, env)) {
      found = { release: candidate, index: mid };
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/full') {
      const q = url.searchParams.get('query');
      if (!q) return new Response('Missing query', { status: 400 });
      const classification = classify(q);
      const commits = await resolveCommits(classification as any, env);
      const releases = await fetchReleases(env);
      const result: any = {
        query: q,
        type: classification.type,
        commits,
        channels: []
      };
      for (const [channel, list] of Object.entries(releases.channels)) {
        const cast = list as any[];
        const latestIndex = cast.length - 1;
        const latest = cast[latestIndex];
        let included = false;
        let earliest = null;
        for (const c of commits) {
          const e = await earliestInChannel(c, cast, env);
            if (e) {
              included = true;
              earliest = e;
              break;
            }
        }
        result.channels.push({
          channel,
            latest_version: latest?.version,
            included,
            first_version: earliest?.release.version ?? null,
            first_date: earliest?.release.released ?? null,
            releases_ago: earliest ? (latestIndex - earliest.index) : null
        });
      }
      return json(result);
    }

    if (path === '/resolve') {
      const q = url.searchParams.get('query');
      if (!q) return new Response('Missing query', { status: 400 });
      const classification = classify(q);
      const commits = await resolveCommits(classification as any, env);
      return json({ original: q, type: classification.type, commits });
    }

    if (path === '/check') {
      const commit = url.searchParams.get('commit');
      if (!commit) return new Response('Missing commit', { status: 400 });
      const releases = await fetchReleases(env);
      const channels = [];
      for (const [channel, list] of Object.entries(releases.channels)) {
        const cast = list as any[];
        const earliest = await earliestInChannel(commit, cast, env);
        const latestIndex = cast.length - 1;
        const latest = cast[latestIndex];
        channels.push({
          channel,
          latest_version: latest?.version,
          included: !!earliest,
          first_version: earliest?.release.version ?? null,
          first_date: earliest?.release.released ?? null,
          releases_ago: earliest ? (latestIndex - earliest.index) : null
        });
      }
      return json({ commit, channels });
    }

    return new Response('Not found', { status: 404 });
  }
};

function json(obj: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init
  });
}
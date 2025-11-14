# Flutter Fix Inclusion Checker

A web app that tells you whether a Flutter fix (commit, PR, or issue) has landed in each release channel (stable, beta, dev, main).  
It identifies the earliest release containing the fix and how many releases ago it was introduced.

## Features

- Input: Commit SHA, PR URL/number, Issue URL/number
- Resolves PRs to their effective merge commit and constituent commits
- Resolves issues to closing PR (when available)
- Efficient ancestry checks using GitHub Compare API (`base...head`)
- Binary search to find the earliest release containing a fix
- Scheduled scraping of [Flutter Archive](https://docs.flutter.dev/install/archive) to build `data/releases.json`
- Caching compare results (Worker in-memory + optional durable KV; client-side `localStorage`)

## Architecture

| Component | Purpose |
|----------|---------|
| GitHub Pages (static) | Serves UI (index.html + JS) |
| GitHub Action | Nightly scrape generating `data/releases.json` |
| Cloudflare Worker (optional) | Normalizes input + ancestry checks (cached) |
| Vercel Function (optional) | Alternate backend implementation |
| Client Fallback | Direct GitHub API calls if no backend configured |

## Quick Start

```bash
# Install dependencies
pnpm install
# OR: npm install

# Run scraper locally
node scripts/scrape.js

# Serve static (simple dev)
npx http-server . -c-1
```

Deploy GitHub Pages:
1. Push repository.
2. Ensure `scrape-and-deploy.yml` workflow runs or manually enable Pages (Settings → Pages → GitHub Actions).
3. Confirm site at `https://<your-username>.github.io/<repo>/`.

Configure backend (Cloudflare Worker):
```bash
cd worker
pnpm install
pnpm run deploy  # after setting CLOUDFLARE_API_TOKEN
```

Set `BACKEND_BASE_URL` (optional):
- Edit `index.html` `data-backend` attribute or set via environment injection.

## Environment Variables

| Variable | Location | Description |
|----------|----------|-------------|
| GITHUB_TOKEN | Worker / Vercel | GitHub PAT (fine-grained, read-only public repo + PR + issues) |
| BACKEND_BASE_URL | Front-end | URL to Worker or Vercel API root (e.g. `https://fix-checker.example.workers.dev`) |

## Ancestry Logic

We use `GET /repos/flutter/flutter/compare/{fixSha}...{releaseSha}`.  
Statuses considered "included": `behind`, `identical`.  
All others (`ahead`, `diverged`) → not included.

Binary search over releases (chronological ascending) after verifying inclusion in latest.

## API (Backend)

`GET /resolve?query=<input>`  
Returns `{ commits: [sha], type: 'commit'|'pr'|'issue', original: '<input>' }`.

`GET /check?commit=<sha>`  
Returns `{ channels: [...], commit: '<sha>' }`.

`GET /full?query=<input>`  
Combines resolve + inclusion; returns earliest release per channel.

## Vercel Alternative

Place `vercel/api.ts` in `/api` of a Vercel project or adapt.

## License

MIT

## Future Enhancements

- GraphQL commit ancestry batched queries
- Durable caching (KV / R2 / Redis)
- Issue to multiple PR resolution
- Diff stats summarization

## Testing

```bash
# Run unit tests
npm test

# Run linter
npm run lint
```

## Contributing

PRs welcome. Run `npm lint` and `npm test` before pushing.
import fs from 'fs';
import fetch from 'node-fetch';

// Use Flutter's official releases metadata instead of scraping HTML.
// This JSON includes all releases with channel, hash, version, and release_date.
const SOURCE_URL = 'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json';

const res = await fetch(SOURCE_URL, {
  headers: {
    // A UA helps some CDNs; optional but harmless.
    'User-Agent': 'flutter-fix-status-scraper/1.0'
  }
});
if (!res.ok) {
  throw new Error(`Failed to fetch Flutter releases JSON: ${res.status} ${res.statusText}`);
}
const json = await res.json();

// Shape we want:
// {
//   generated_at: ISO,
//   source: SOURCE_URL,
//   channels: {
//     stable: [{ version, released, framework_sha, archive_url? }],
//     beta:   [...],
//     dev:    [...],
//     // main omitted (not a released channel)
//   }
// }

const channels = { stable: [], beta: [], dev: [] };

for (const r of json.releases || []) {
  const ch = r.channel;
  // Keep only known release channels
  if (!(ch in channels)) continue;

  const releasedISO = r.release_date ? new Date(r.release_date).toISOString() : '';
  channels[ch].push({
    version: r.version,
    released: releasedISO.slice(0, 10), // YYYY-MM-DD
    framework_sha: r.hash,
    // Optionally build an archive URL; not strictly needed for this app.
    // archive_url: `https://storage.googleapis.com/flutter_infra_release/releases/${ch}/${r.hash}/flutter_linux_${r.version}.tar.xz`
  });
}

// Ensure chronological order: oldest -> newest for binary search
for (const ch of Object.keys(channels)) {
  channels[ch].sort((a, b) => new Date(a.released) - new Date(b.released));
}

const out = {
  generated_at: new Date().toISOString(),
  source: SOURCE_URL,
  channels
};

// Write inside the published site so Pages serves it
fs.mkdirSync('public/data', { recursive: true });
fs.writeFileSync('public/data/releases.json', JSON.stringify(out, null, 2));
console.log(`Wrote ${Object.values(channels).reduce((n, arr) => n + arr.length, 0)} releases to public/data/releases.json`);
import fs from 'fs';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const url = 'https://docs.flutter.dev/install/archive';
const html = await fetch(url).then(r => {
  if (!r.ok) throw new Error(`Failed to fetch archive: ${r.status}`);
  return r.text();
});

const $ = cheerio.load(html);
const channels = {};

$('table').each((_, table) => {
  $(table).find('tbody tr').each((__, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const version = $(tds[0]).text().trim();
    const channel = $(tds[1]).text().trim().toLowerCase();
    const released = $(tds[2]).text().trim();
    const frameworkSha = $(tds[3]).text().trim();
    const archiveUrl = $(tds[0]).find('a').attr('href') || '';
    if (!version || !channel || !frameworkSha) return;
    channels[channel] ||= [];
    channels[channel].push({
      version,
      released,
      framework_sha: frameworkSha,
      archive_url: archiveUrl
    });
  });
});

for (const ch of Object.keys(channels)) {
  channels[ch].sort((a, b) => new Date(a.released) - new Date(b.released));
}

const out = {
  generated_at: new Date().toISOString(),
  source: url,
  channels
};

fs.mkdirSync('data', { recursive: true });
const path = 'data/releases.json';
const prior = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
const changed = JSON.stringify(prior) !== JSON.stringify(out);
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log(changed ? 'Updated data/releases.json' : 'No changes detected');
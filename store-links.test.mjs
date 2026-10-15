// App Store campaign attribution on every surface this package ships. Apple reads pt=/ct= only on
// the /app/apple-store/id<ID> path, before the product page renders; a link without them lands in
// App Store Connect's undifferentiated "Web Referrer" bucket and cannot be backfilled. The private
// repo's verify-store-links.sh guards its mirror of these files, but THIS repo is where npm, the
// MCP Registry, LobeHub and the .mcpb are built from, so the rule has to hold here too: llms.txt
// shipped untagged in 1.6.5 because nothing here checked it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = '6784185201';
const PROVIDER = '129083290';
const STORE_RE = /https?:\/\/apps\.apple\.com\/[^\s"'<>)\]`\\]+/g;

/** Every App Store URL in a text, with what is wrong with each (empty when it is fine). */
export function storeLinkProblems(text) {
  const out = [];
  for (const [url] of text.matchAll(STORE_RE)) {
    const wrong = [];
    if (!url.includes(`/app/apple-store/id${APP_ID}`)) wrong.push('not on the /app/apple-store/ campaign path');
    let q;
    try { q = new URL(url).searchParams; } catch { wrong.push('unparseable'); q = new URLSearchParams(); }
    if (q.get('pt') !== PROVIDER) wrong.push(`pt is not ${PROVIDER}`);
    // Repo rule for campaign tokens: lowercase letters and digits only.
    if (!/^[a-z0-9]{1,40}$/.test(q.get('ct') ?? '')) wrong.push('ct missing or not lowercase alphanumeric');
    if (wrong.length) out.push(`${url} (${wrong.join('; ')})`);
  }
  return out;
}

// What ships: the npm tarball's files plus the repo-only listing sources (registry, LobeHub, Glama).
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const surfaces = [...new Set([
  ...pkg.files.filter((f) => !f.includes('*')),
  'README.md', 'AGENTS.md', 'llms.txt', 'manifest.json', 'server.json', 'glama.json', 'lhm.plugin.json',
  ...fs.readdirSync(path.join(here, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
])].filter((f) => fs.existsSync(path.join(here, f)) && fs.statSync(path.join(here, f)).isFile()
  && /\.(md|txt|json|mjs)$/.test(f));

test('every App Store link on a shipped surface carries pt= and ct= on the campaign path', () => {
  const bad = surfaces.flatMap((f) => storeLinkProblems(fs.readFileSync(path.join(here, f), 'utf8')).map((p) => `${f}: ${p}`));
  assert.deepEqual(bad, [], `untagged App Store links:\n  ${bad.join('\n  ')}`);
  assert.ok(surfaces.includes('llms.txt') && surfaces.includes('README.md') && surfaces.includes('manifest.json'));
});

test('the packed .mcpb manifest carries only tagged App Store links (every one, not the first)', () => {
  const packed = execFileSync('unzip', ['-p', path.join(here, 'health-export.mcpb'), 'manifest.json'], { encoding: 'utf8' });
  assert.ok(packed.match(STORE_RE)?.length >= 1, 'the bundle manifest should link the companion app');
  assert.deepEqual(storeLinkProblems(packed), []);
});

test('the checker itself: each kind of mistake is caught, a correct link passes', () => {
  const ok = `https://apps.apple.com/app/apple-store/id${APP_ID}?pt=${PROVIDER}&ct=githubreadme&mt=8`;
  assert.deepEqual(storeLinkProblems(`see ${ok}.`), []);
  assert.equal(storeLinkProblems(`https://apps.apple.com/app/id${APP_ID}`).length, 1);
  assert.equal(storeLinkProblems(`https://apps.apple.com/app/id${APP_ID}?pt=${PROVIDER}&ct=x&mt=8`).length, 1);
  assert.equal(storeLinkProblems(`https://apps.apple.com/app/apple-store/id${APP_ID}?ct=x`).length, 1);
  assert.equal(storeLinkProblems(`https://apps.apple.com/app/apple-store/id${APP_ID}?pt=${PROVIDER}&ct=Bad-Token`).length, 1);
  // The second of two links is checked too.
  assert.equal(storeLinkProblems(`${ok} and https://apps.apple.com/app/id${APP_ID}`).length, 1);
});

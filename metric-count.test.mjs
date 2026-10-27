// Every "N metrics" claim a user or registry reads must equal the catalog the server ships.
// On 2026-10-27 the catalog had 194 rows (the app added 5 derived CGM metrics) while README,
// llms.txt, package.json, server.json, manifest.json and lhm.plugin.json still said 190, which
// is what npm, the MCP Registry and LobeHub displayed. This keeps them pinned to the catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRIC_CATALOG } from './metric-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// glama.json and the SVGs joined in 1.7.3: Glama, the GitHub social card and the README diagram still said 190.
const SURFACES = ['README.md', 'llms.txt', 'package.json', 'server.json', 'manifest.json', 'lhm.plugin.json', 'AGENTS.md',
  'glama.json', 'assets/architecture.svg', 'assets/social-preview.svg'];
// "190 metrics", "**190 metrics**", "190 Apple Health metrics", "(190 metrics)". Not "190-metric" (an adjective
// in prose) and not "~15 metrics" (an approximate count, e.g. the synthetic demo dataset).
const CLAIM = /(?<![~\d])\b(\d{2,3})\*{0,2}(?:\s|&nbsp;)+(?:Apple Health |HealthKit |Apple Health and Apple Watch )?metrics\b/gi;

test('the catalog has one row per metric id', () => {
  const ids = METRIC_CATALOG.map((r) => r[0]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate metric id in metric-catalog.mjs');
});

for (const f of SURFACES) {
  test(`${f} states the shipped metric count`, () => {
    const p = path.join(here, f);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(CLAIM)) {
      assert.equal(Number(m[1]), METRIC_CATALOG.length,
        `${f}: "${m[0]}" but metric-catalog.mjs ships ${METRIC_CATALOG.length} metrics`);
    }
  });
}

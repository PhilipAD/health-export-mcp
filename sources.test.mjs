// Tests for the Track B3 `sources` block (cache schema minor 2): when the app ships per-source
// attribution, the server stops claiming per-source disagreement "cannot be seen in the file" and
// instead surfaces which source won each metric and where two sources disagreed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-sources-'));

// A schema-minor-2 export: heart rate recorded by a Watch and a ring on 2026-10-18 (multi-source
// day), single-source the day before, plus the health-sources.json the app writes alongside it.
function build() {
  const cache = {
    _meta: { schema: 1, schemaMinor: 2, app: '1.16', writtenAt: '2026-10-19T12:00:00Z' },
    heart_rate: {
      unit: 'count/min',
      cumulative: false,
      daily: [
        { d: '2026-10-17', v: 61 },
        { d: '2026-10-18', v: 63, src: 'Apple Watch', by: { 'Apple Watch': 63, Oura: 61 } },
      ],
    },
  };
  fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify(cache));
  fs.writeFileSync(path.join(DIR, 'health-sources.json'), JSON.stringify({
    schema: 1, app: '1.16', writtenAt: '2026-10-19T12:00:00Z', sourceCount: 2,
    sources: [
      { label: 'Apple Watch', class: 'watch', metrics: ['heart_rate'], days: 2, firstDay: '2026-10-17', lastDay: '2026-10-18' },
      { label: 'Oura', class: 'ring', metrics: ['heart_rate'], days: 1, firstDay: '2026-10-18', lastDay: '2026-10-18' },
    ],
    metrics: {
      heart_rate: { rule: 'priority', priority: ['watch', 'ring'], daysBySource: { 'Apple Watch': 2, Oura: 1 }, multiSourceDays: 1 },
    },
    rules: { heart: 'watch, band, ring' },
    priorityOrders: { heart: ['watch', 'ring'] },
  }));
}
build();

process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');
const norm = await import('./normalize.mjs');

test('hasSourceAttribution is true for a schemaMinor 2 cache', () => {
  assert.equal(store.hasSourceAttribution(), true);
});

test('sourceMerge flips to available under attribution, stays not_available without it', () => {
  const avail = norm.sourceMerge(true);
  assert.equal(avail.perSourceValuesInExport, true);
  assert.equal(avail.disagreementDetection, 'available');

  const base = norm.sourceMerge(false);
  assert.equal(base.perSourceValuesInExport, false);
  assert.equal(base.disagreementDetection, 'not_available');
});

test('resolve_metric carries the sources block + dynamic sourceMerge', async () => {
  const r = await store.resolveMetric({ name: 'heart_rate' });
  assert.equal(r.sourceMerge.disagreementDetection, 'available');
  assert.equal(r.sources.sourceCount, 2);
  assert.deepEqual(r.sources.sources.map((s) => s.label), ['Apple Watch', 'Oura']);
  assert.equal(r.sources.metrics.heart_rate.rule, 'priority');
  assert.deepEqual(r.sources.metrics.heart_rate.daysBySource, { 'Apple Watch': 2, Oura: 1 });
});

test('data answers pass src/by through at day granularity', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate', start: '2026-10-18', end: '2026-10-18', granularity: 'day' });
  const p = out.heart_rate.points[0];
  assert.equal(p.src, 'Apple Watch');
  assert.deepEqual(p.by, { 'Apple Watch': 63, Oura: 61 });
});

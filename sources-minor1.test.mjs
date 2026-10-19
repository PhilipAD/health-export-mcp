// A pre-B3 export (schema minor 1, no health-sources.json): every answer must read exactly as before.
// Absent attribution means "not attributed", never "single source".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-sources1-'));
fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify({
  _meta: { schema: 1, schemaMinor: 1, app: '1.15', writtenAt: '2026-10-19T12:00:00Z' },
  heart_rate: { unit: 'count/min', cumulative: false, daily: [{ d: '2026-10-17', v: 61 }, { d: '2026-10-18', v: 63 }] },
}));
process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');

test('no attribution: sourceMerge stays not_available and no sources block appears', async () => {
  assert.equal(store.hasSourceAttribution(), false);
  const r = await store.resolveMetric({ name: 'heart_rate' });
  assert.equal(r.sourceMerge.perSourceValuesInExport, false);
  assert.equal(r.sourceMerge.disagreementDetection, 'not_available');
  assert.ok(!('sources' in r));
});

test('no attribution: day points carry only date, value (and recomputed_at), never src/by', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate', start: '2026-10-17', end: '2026-10-18', granularity: 'day' });
  for (const p of out.heart_rate.points) assert.deepEqual(Object.keys(p).sort(), ['date', 'value']);
});

test('no attribution: status says so', async () => {
  const s = await store.status();
  assert.equal(s.contextFiles.sources, false);
  assert.equal(s.sourceAttribution, false);
});

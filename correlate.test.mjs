// Tests for correlate_metrics: lag alignment (the off-by-one trap), the 10-pair floor, the
// always-present causation caveat, and degenerate series. The fixture makes the alignment
// PROVABLE: metric B is metric A shifted forward one day exactly, so lag 1 must read r = 1 and
// lag 0 must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-corr-'));
process.env.HEALTH_DATA_DIR = DIR;

// Deliberately jagged values so the series does not correlate with its own neighbour: a smooth
// ramp would score high at EVERY lag and the off-by-one assertion would prove nothing.
const A = [62, 45, 71, 50, 66, 43, 58, 74, 39, 69, 55, 48, 73, 41, 60, 52, 68, 46, 63, 57, 70, 44, 59, 49, 72, 40, 65, 53, 61, 47];
const day = (i) => `2026-07-${String(i + 1).padStart(2, '0')}`;     // A on 07-01..07-30
const dayB = (i) => (i + 2 <= 31 ? `2026-07-${String(i + 2).padStart(2, '0')}` : '2026-08-01');

fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify({
  metric_a: { unit: 'ms', cumulative: false, daily: A.map((v, i) => ({ d: day(i), v })) },
  // B on day d+1 carries exactly A's day-d value: the "effect lands the following day" shape.
  metric_b: { unit: 'ms', cumulative: false, daily: A.map((v, i) => ({ d: dayB(i), v })) },
  constant: { unit: 'count', cumulative: false, daily: A.map((_, i) => ({ d: day(i), v: 5 })) },
}));

const store = await import('./healthstore.mjs');

test('lag 1 reads the planted next-day alignment as r = 1', async () => {
  const out = await store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: 1 });
  assert.equal(out.alignedPairs, 30);
  assert.ok(out.r > 0.999, `expected r ~ 1 at lag 1, got ${out.r}`);
  assert.equal(out.metricA.mean, out.metricB.mean, 'aligned means are over the same 30 values');
  assert.match(out.attribution, /FOLLOWING day/);
});

test('lag 0 on the same data reads clearly lower: the alignment is real, not an artifact', async () => {
  const out = await store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: 0 });
  assert.equal(out.alignedPairs, 29);   // B has no 07-01 value, so one fewer same-day pair
  assert.ok(out.r === null || Math.abs(out.r) < 0.9, `expected weak same-day correlation, got ${out.r}`);
});

test('fewer than 10 aligned pairs withholds r with a note, never a confident number', async () => {
  const out = await store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: 1, start: '2026-07-01', end: '2026-07-05' });
  assert.equal(out.alignedPairs, 5);
  assert.equal(out.r, null);
  assert.match(out.note, /not enough to correlate/);
});

test('the causation caveat travels in EVERY payload, including the withheld ones', async () => {
  for (const args of [
    { metricA: 'metric_a', metricB: 'metric_b', lag: 1 },
    { metricA: 'metric_a', metricB: 'metric_b', lag: 0, start: '2026-07-01', end: '2026-07-03' },
  ]) {
    const out = await store.correlateMetrics(args);
    assert.equal(out.caveat, "Association, not causation. A correlation here reflects alignment in this file's daily values only.");
  }
});

test('a constant series has no defined correlation and says so', async () => {
  const out = await store.correlateMetrics({ metricA: 'metric_a', metricB: 'constant' });
  assert.equal(out.r, null);
  assert.match(out.note, /constant/);
});

test('lag outside 0..3 and unknown metrics are loud errors', async () => {
  await assert.rejects(() => store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: 4 }), /between 0 and 3/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: -1 }), /between 0 and 3/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'metric_a', metricB: 'metric_b', lag: 1.5 }), /between 0 and 3/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'nope', metricB: 'metric_b' }), /unknown metricA/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'metric_a', metricB: 'nope' }), /unknown metricB/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'metric_a' }), /required/);
});

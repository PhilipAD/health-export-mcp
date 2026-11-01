// Pins MCP parity with AskEngine: a zero baseline has no percentage.
// changePercent must be null (not 0) beside direction "up".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-zero-'));
process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');

function writeCache(cache) {
  const p = path.join(DIR, '.health-cache.json');
  fs.writeFileSync(p, JSON.stringify(cache));
  const t = Date.now() / 1000 + Math.random() * 10 + 1;
  fs.utimesSync(p, t, t);
}

test('get_trends omits changePercent on a zero prior baseline', async () => {
  // 7 zero prior days + 7 active recent days
  const daily = [];
  for (let i = 0; i < 7; i++) {
    daily.push({ d: `2026-07-${String(i + 1).padStart(2, '0')}`, v: 0 });
  }
  for (let i = 0; i < 7; i++) {
    daily.push({ d: `2026-07-${String(i + 8).padStart(2, '0')}`, v: 30 });
  }
  writeCache({ apple_exercise_time: { unit: 'min', cumulative: true, daily } });
  const t = await store.getTrends({ metric: 'apple_exercise_time', window: 7 });
  assert.equal(t.changePercent, null, 'zero baseline must not invent 0%');
  assert.equal(t.direction, 'up');
});

test('compare_periods omits changePercent on a zero periodB baseline', async () => {
  const daily = [];
  for (let i = 0; i < 7; i++) {
    daily.push({ d: `2026-07-${String(i + 1).padStart(2, '0')}`, v: 0 });
  }
  for (let i = 0; i < 7; i++) {
    daily.push({ d: `2026-07-${String(i + 8).padStart(2, '0')}`, v: 30 });
  }
  writeCache({ apple_exercise_time: { unit: 'min', cumulative: true, daily } });
  const r = await store.comparePeriods({
    metric: 'apple_exercise_time',
    periodA: { start: '2026-07-08', end: '2026-07-14' },
    periodB: { start: '2026-07-01', end: '2026-07-07' },
  });
  assert.equal(r.changePercent, null, 'MCP must match AskEngine omit-on-zero');
  assert.ok(r.periodA.value > 0);
  assert.equal(r.periodB.value, 0);
});

test('getStructuredExport rejects cache-absent catalog-like names', async () => {
  writeCache({
    step_count: {
      unit: 'count',
      cumulative: true,
      daily: [{ d: '2026-08-04', v: 9000 }],
    },
  });
  await assert.rejects(
    () => store.getStructuredExport({
      metrics: ['step_count', 'vo2_max'],
      start: '2026-08-01',
      end: '2026-08-07',
    }),
    /unknown metric/,
  );
});

console.log('zero-baseline.test.mjs: loaded');

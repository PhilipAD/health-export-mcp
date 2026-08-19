// Tests for get_workouts: filters, cursor pagination stability, summary honesty, and the rule
// that records ship AS-IS (an old cache without the newer optional keys gets nothing fabricated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-workouts-'));
process.env.HEALTH_DATA_DIR = DIR;

const store = await import('./healthstore.mjs');

test('absent workouts cache answers available:false, never an empty page', async () => {
  const out = await store.getWorkouts({});
  assert.equal(out.available, false);
  assert.match(out.note, /\.health-workouts-cache\.json/);
  assert.match(out.note, /not that none happened/);
});

// Seven workouts written OUT of order, including: a pre-1.5 record with none of the new keys, a
// 1.5 record with intervals and running dynamics, and two workouts sharing a start instant (a
// paused-and-resumed pair) that only differ by id — the cursor tie-break case.
const W = (id, day, extra = {}) => ({
  id, name: extra.name ?? 'Running', activityType: extra.activityType ?? 37,
  start: `2026-08-${day}T07:30:00+01:00`, end: `2026-08-${day}T08:15:00+01:00`,
  duration: 2700, activeEnergyBurned: 400, distanceMeters: 7500, distanceSource: 'watch',
  ...extra,
});
const WORKOUTS = [
  W('w-05', '05', { avgHeartRate: 151, maxHeartRate: 176, runningPowerAvgWatts: 262, strideLengthAvgMeters: 1.1,
    verticalOscillationAvgCm: 8.1, groundContactTimeAvgMs: 251, hasRoute: true,
    intervals: [{ start: '2026-08-05T07:30:00+01:00', end: '2026-08-05T07:45:00+01:00', duration: 900, kind: 'lap' }] }),
  W('w-01', '01'),                                        // old-cache record: NO new keys at all
  W('w-09b', '09'), W('w-09a', '09'),                     // identical start, distinct ids
  W('w-03', '03', { name: 'Cycling', activityType: 13, cyclingPowerAvgWatts: 210, cadenceAvg: 88 }),
  W('w-07', '07', { name: 'Walking', activityType: 52 }),
  W('w-11', '11'),
];

test('old records come back as-is: absent new keys stay absent, never fabricated', async () => {
  // Written inside the first data test, not at module level: module code runs before any test,
  // which would silently defeat the absent-file test above.
  fs.writeFileSync(path.join(DIR, '.health-workouts-cache.json'), JSON.stringify(WORKOUTS));
  const out = await store.getWorkouts({ start: '2026-08-01', end: '2026-08-01' });
  const w = out.workouts[0];
  assert.equal(w.id, 'w-01');
  assert.equal('avgHeartRate' in w, false);
  assert.equal('intervals' in w, false);
  assert.equal('hasRoute' in w, false);
});

test('new optional keys survive intact when the cache has them', async () => {
  const out = await store.getWorkouts({ start: '2026-08-05', end: '2026-08-05' });
  const w = out.workouts[0];
  assert.equal(w.runningPowerAvgWatts, 262);
  assert.equal(w.intervals.length, 1);
  assert.equal(w.intervals[0].kind, 'lap');
});

test('activityType filters by name (case-insensitive) and by raw id equally', async () => {
  const byName = await store.getWorkouts({ activityType: 'cycling' });
  const byId = await store.getWorkouts({ activityType: '13' });
  assert.equal(byName.summary.count, 1);
  assert.deepEqual(byName.workouts.map((w) => w.id), byId.workouts.map((w) => w.id));
});

test('summary counts the whole filtered set, not the returned page', async () => {
  const out = await store.getWorkouts({ limit: 2 });
  assert.equal(out.returned, 2);
  assert.equal(out.summary.count, 7);
  assert.deepEqual(out.summary.byActivityType, { Running: 5, Cycling: 1, Walking: 1 });
});

test('pagination is stable: every workout exactly once, ascending, ties broken by id', async () => {
  const seen = [];
  let cursor, pages = 0;
  do {
    const page = await store.getWorkouts({ limit: 2, ...(cursor && { cursor }) });
    seen.push(...page.workouts.map((w) => w.id));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 20, 'pagination did not terminate');
  } while (cursor);
  assert.deepEqual(seen, ['w-01', 'w-03', 'w-05', 'w-07', 'w-09a', 'w-09b', 'w-11']);
  assert.equal(new Set(seen).size, seen.length, 'a workout was served on two pages');
});

test('a cursor past the end yields an empty final page, not a restart from page one', async () => {
  const out = await store.getWorkouts({ cursor: '2099-01-01T00:00:00+01:00#zzz' });
  assert.equal(out.returned, 0);
  assert.equal(out.nextCursor, null);
});

test('date range and malformed dates behave like every other tool', async () => {
  const out = await store.getWorkouts({ start: '2026-08-03', end: '2026-08-07' });
  assert.deepEqual(out.workouts.map((w) => w.id), ['w-03', 'w-05', 'w-07']);
  await assert.rejects(() => store.getWorkouts({ start: 'yesterday' }), /YYYY-MM-DD/);
  await assert.rejects(() => store.getWorkouts({ start: '2026-08-09', end: '2026-08-01' }), /is after end/);
});

test('limit is clamped to the 1..200 contract', async () => {
  const one = await store.getWorkouts({ limit: 0 });
  assert.equal(one.returned >= 1, true);   // 0 clamps up to at least 1, not an empty loop forever
  const big = await store.getWorkouts({ limit: 9999 });
  assert.equal(big.returned, 7);           // capped, and 7 is all there is
});

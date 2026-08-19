// Tests for segment honesty (contract section 8): boundary detection (point events only, range
// events and visits excluded, unknown point types included), the compare_periods event anchor,
// filterDays with negate, and excludeTravelDays day counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-seg-'));
process.env.HEALTH_DATA_DIR = DIR;

// 60 days ending 2026-08-18. HRV is 40 on the shift-block days and 60 everywhere else, so the
// day-filter answers are exactly predictable.
const dayAt = (back) => new Date(Date.UTC(2026, 7, 18) - back * 86400000).toISOString().slice(0, 10);
const SHIFT_DAYS = new Set(['2026-08-08', '2026-08-09', '2026-08-10']);
const daily = [];
for (let back = 59; back >= 0; back--) {
  const d = dayAt(back);
  daily.push({ d, v: SHIFT_DAYS.has(d) ? 40 : 60 });
}
fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify({
  heart_rate_variability: { unit: 'ms', cumulative: false, daily },
  step_count: { unit: 'count', cumulative: true, daily: daily.map((p) => ({ d: p.d, v: 1000 })) },
}));

fs.writeFileSync(path.join(DIR, 'health-events.json'), JSON.stringify({
  schema: 1, app: '1.5', writtenAt: '2026-08-18T21:00:00Z',
  events: [
    { id: 'e-old', date: '2026-01-01', type: 'medication', title: 'Ancient start' },          // outside every window
    { id: 'e-life', date: '2026-07-15', type: 'life', title: 'Moved house' },                 // boundary
    { id: 'e-shift', date: '2026-08-08', endDate: '2026-08-10', type: 'shift', title: 'Nights', tags: ['nights'] }, // range: NOT a boundary
    { id: 'e-med', date: '2026-08-10', type: 'medication', title: 'Dose change', tags: ['propranolol'] },           // boundary
    { id: 'e-visit', date: '2026-08-12', type: 'visit', title: 'GP review' },                 // point but observational: NOT a boundary
    { id: 'e-zap', date: '2026-08-14', type: 'zap', title: 'Unknown intervention' },          // unknown point type: boundary
  ],
}));

const store = await import('./healthstore.mjs');

test('boundary detection: point events of boundary types plus unknown types, never range events or visits', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate_variability' });
  const m = out.heart_rate_variability;
  assert.deepEqual(m.segmentBoundaries.map((b) => b.date), ['2026-07-15', '2026-08-10', '2026-08-14']);
  assert.deepEqual(m.segmentBoundaries.map((b) => b.type), ['life', 'medication', 'zap']);
  assert.equal(m.segmentNote, 'The window spans 3 logged event(s). An average across a boundary can be a number that was true on no actual day; consider compare_periods anchored at the event date.');
});

test('the window bounds the boundary list', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate_variability', start: '2026-08-01', end: '2026-08-18' });
  assert.deepEqual(out.heart_rate_variability.segmentBoundaries.map((b) => b.date), ['2026-08-10', '2026-08-14']);
});

test('multi-metric calls carry no segment decoration (single-metric answers only)', async () => {
  const out = await store.getHealthMetrics({});
  assert.equal('segmentBoundaries' in out.heart_rate_variability, false);
  assert.equal('segmentBoundaries' in out.step_count, false);
});

test('get_trends lists boundaries inside its compared span, still excluding the range event', async () => {
  // window 7 spans 2026-08-05..2026-08-18: e-med and e-zap are inside, e-shift covers days inside
  // but is a state, not a boundary.
  const out = await store.getTrends({ metric: 'heart_rate_variability', window: 7 });
  assert.deepEqual(out.segmentBoundaries.map((b) => b.date), ['2026-08-10', '2026-08-14']);
  assert.match(out.segmentNote, /spans 2 logged event/);
});

test('compare_periods reports boundaries across BOTH periods, deduplicated', async () => {
  const out = await store.comparePeriods({
    metric: 'heart_rate_variability',
    periodA: { start: '2026-07-01', end: '2026-07-31' },
    periodB: { start: '2026-08-01', end: '2026-08-18' },
  });
  assert.deepEqual(out.segmentBoundaries.map((b) => b.date), ['2026-07-15', '2026-08-10', '2026-08-14']);
});

test('anchor builds equal windows around the event with the event day excluded from both', async () => {
  const out = await store.comparePeriods({ metric: 'heart_rate_variability', anchor: { eventId: 'e-med', days: 5 } });
  assert.deepEqual(out.periodA, { ...out.periodA, start: '2026-08-05', end: '2026-08-09' });
  assert.deepEqual(out.periodB, { ...out.periodB, start: '2026-08-11', end: '2026-08-15' });
  assert.equal(out.anchor.eventId, 'e-med');
  assert.equal(out.anchor.date, '2026-08-10');
  assert.match(out.anchor.note, /excluded from both sides/);
  // The anchoring event itself cannot appear as a boundary: its day belongs to neither side.
  assert.equal((out.segmentBoundaries || []).some((b) => b.date === '2026-08-10'), false);
});

test('an unknown eventId is a loud error naming the fix', async () => {
  await assert.rejects(
    () => store.comparePeriods({ metric: 'heart_rate_variability', anchor: { eventId: 'e-nope', days: 5 } }),
    /unknown eventId "e-nope".*list_events/);
});

test('anchor rejects contradictions and nonsense days', async () => {
  await assert.rejects(
    () => store.comparePeriods({
      metric: 'heart_rate_variability',
      periodA: { start: '2026-08-01', end: '2026-08-05' },
      periodB: { start: '2026-08-06', end: '2026-08-10' },
      anchor: { eventId: 'e-med', days: 5 },
    }), /not both/);
  await assert.rejects(() => store.comparePeriods({ metric: 'heart_rate_variability', anchor: { eventId: 'e-med', days: 0 } }), /at least 1/);
  await assert.rejects(() => store.comparePeriods({ metric: 'heart_rate_variability', anchor: { days: 5 } }), /eventId/);
});

test('filterDays restricts to event-covered days, endDate inclusive, and states the match count', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate_variability', filterDays: { eventType: 'shift' } });
  const m = out.heart_rate_variability;
  assert.equal(out.filterDays.matchedEventDays, 3);
  assert.equal(m.pointsInRange, 3);
  assert.equal(m.aggregate, 40, 'only the shift-block days were averaged');
});

test('filterDays negate:true inverts to the days NOT covered', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate_variability', filterDays: { eventType: 'shift', negate: true } });
  const m = out.heart_rate_variability;
  assert.equal(out.filterDays.negate, true);
  assert.equal(m.pointsInRange, 57);
  assert.equal(m.aggregate, 60, 'the shift-block days were excluded');
  assert.match(out.filterDays.note, /OUTSIDE/);
});

test('filterDays matches by tag too', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate_variability', filterDays: { eventTag: 'nights' } });
  assert.equal(out.filterDays.matchedEventDays, 3);
});

test('excludeTravelDays with no timezone log excludes nothing and says why', async () => {
  const out = await store.getTrends({ metric: 'heart_rate_variability', window: 7, excludeTravelDays: true });
  assert.equal(out.travelDaysExcluded, 0);
  assert.match(out.travelNote, /health-days\.json is not present/);
});

test('get_trends counts exactly the travel days dropped inside its compared span', async () => {
  // The timezone log appears only NOW (inside the test: module-level writes run before any test,
  // which would defeat the no-log test above). Changes land on 2026-08-06 (prior window) and
  // 2026-08-13 (recent window), plus one long before the data starts, which must never be counted.
  fs.writeFileSync(path.join(DIR, 'health-days.json'), JSON.stringify({
    schema: 1, writtenAt: '2026-08-18T21:00:00Z', currentTz: 'Europe/London',
    changes: [
      { from: '2026-05-01', tz: 'America/New_York', utcOffsetMin: -240 },
      { from: '2026-08-06', tz: 'Europe/Paris', utcOffsetMin: 120 },
      { from: '2026-08-13', tz: 'Europe/London', utcOffsetMin: 60 },
    ],
    note: 'Timezone history is recorded from 2026-05-01 onward.',
  }));
  const out = await store.getTrends({ metric: 'heart_rate_variability', window: 7, excludeTravelDays: true });
  assert.equal(out.travelDaysExcluded, 2, '2026-08-06 and 2026-08-13 sit inside the two windows; 2026-05-01 does not');
  assert.match(out.travelNote, /not 24 hours long/);
  assert.equal(out.recentDays, 6);
  assert.equal(out.priorDays, 6);
});

test('compare_periods reports travel exclusions per period', async () => {
  const out = await store.comparePeriods({
    metric: 'heart_rate_variability',
    periodA: { start: '2026-08-01', end: '2026-08-07' },
    periodB: { start: '2026-08-11', end: '2026-08-17' },
    excludeTravelDays: true,
  });
  assert.deepEqual(out.travelDaysExcluded, { periodA: 1, periodB: 1 });
  assert.match(out.travelNote, /1 from periodA, 1 from periodB/);
  assert.equal(out.periodA.pointsInRange, 6);
  assert.equal(out.periodB.pointsInRange, 6);
});

test('without the flag, travel days stay in and no travel keys appear', async () => {
  const out = await store.getTrends({ metric: 'heart_rate_variability', window: 7 });
  assert.equal('travelDaysExcluded' in out, false);
  assert.equal(out.recentDays, 7);
});

// Regression tests for the ANSWER layer — the numbers an agent is handed.
//
// This file exists because these tools were the last surface in the project with essentially no
// coverage, and an audit of them found four defects in a single pass: a trend that reported a flat
// series as "up 133%", a sum over a metric that must never be summed, a window labelled "7 days"
// that spanned two months, and pagination that could not terminate. Every one of them returned a
// confident, well-formed, wrong number — which is the failure mode this whole project is about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-answers-'));
process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');

function writeCache(cache) {
  const p = path.join(DIR, '.health-cache.json');
  fs.writeFileSync(p, JSON.stringify(cache));
  // Bump mtime: the reader memoizes on (mtime, size), so a same-second rewrite looks unchanged.
  const t = Date.now() / 1000 + Math.random() * 10 + 1;
  fs.utimesSync(p, t, t);
}
const days = (n, v, from = Date.UTC(2026, 6, 1)) =>
  Array.from({ length: n }, (_, i) => ({
    d: new Date(from + i * 86400000).toISOString().slice(0, 10),
    v: typeof v === 'function' ? v(i) : v,
  }));

// --- trends -----------------------------------------------------------------

test('a flat cumulative series is not reported as a rise', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(10, 10000) } });
  const t = await store.getTrends({ metric: 'step_count', window: 7 });
  // Ten days against a window of seven leaves only three in the prior side. Summing both sides made
  // 70,000 vs 30,000 and reported "up 133%" for a series that never changed.
  assert.equal(t.changePercent, 0, 'a flat series must report no change');
  assert.equal(t.direction, 'flat');
  assert.equal(t.change, null, 'the raw delta is meaningless across unequal spans');
  assert.ok(t.note, 'unequal windows must be stated');
});

test('a genuine rise is still detected across equal windows', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(14, (i) => (i < 7 ? 5000 : 10000)) } });
  const t = await store.getTrends({ metric: 'step_count', window: 7 });
  assert.equal(t.recentDays, 7);
  assert.equal(t.priorDays, 7);
  assert.equal(t.changePercent, 100);
  assert.equal(t.direction, 'up');
});

test('a trend window is calendar days, not the last N recorded points', async () => {
  // Weight logged weekly: six points spanning six weeks.
  writeCache({ body_mass: { unit: 'kg', cumulative: false,
    daily: days(6, 80).map((p, i) => ({ d: new Date(Date.UTC(2026, 5, 1) + i * 7 * 86400000).toISOString().slice(0, 10), v: 80 })) } });
  const t = await store.getTrends({ metric: 'body_mass', window: 7 });
  const span = (Date.parse(t.recentRange.to) - Date.parse(t.recentRange.from)) / 86400000;
  assert.equal(span, 6, 'a 7-day window must cover 7 calendar days, not 7 recorded points');
  assert.ok(t.recentDays <= 7);
});

// --- aggregation ------------------------------------------------------------

test('summing a non-cumulative metric returns the mean and says so', async () => {
  writeCache({ resting_heart_rate: { unit: 'count/min', cumulative: false, daily: days(5, 60) } });
  const r = await store.getHealthMetrics({ metric: 'resting_heart_rate', aggregation: 'sum' });
  const m = r.resting_heart_rate;
  assert.equal(m.aggregate, 60, '365 daily heart rates must not add up to a total');
  assert.equal(m.aggregation, 'avg', 'the reported aggregation must be the one actually used');
  assert.ok(m.aggregationAdjusted, 'the caller must be told their request was not honoured');
});

test('summing a cumulative metric is still a sum', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(5, 1000) } });
  const r = await store.getHealthMetrics({ metric: 'step_count', aggregation: 'sum' });
  assert.equal(r.step_count.aggregate, 5000);
  assert.equal(r.step_count.aggregation, 'sum');
  assert.equal(r.step_count.aggregationAdjusted, undefined);
});

// --- compare_periods --------------------------------------------------------

test('a period without usable bounds is rejected rather than compared to all time', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(30, 1000) } });
  for (const bad of [{}, { start: '2026-07-01' }, '2026-07', null]) {
    await assert.rejects(
      () => store.comparePeriods({ metric: 'step_count', periodA: bad, periodB: { start: '2026-07-01', end: '2026-07-07' } }),
      // `null` trips the earlier required-argument guard; the others reach the bounds check.
      /start and end|required/,
      `periodA ${JSON.stringify(bad)} must be rejected, not silently matched against all history`);
  }
});

test('periods of different lengths are flagged as not comparable', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(60, 1000) } });
  const r = await store.comparePeriods({
    metric: 'step_count',
    periodA: { start: '2026-07-01', end: '2026-07-31' },   // 31 days
    periodB: { start: '2026-08-01', end: '2026-08-28' },   // 28 days
  });
  assert.equal(r.comparable, false);
  assert.ok(r.note, 'a 31-vs-28-day comparison of a total must not look like a real change');
  assert.equal(r.periodA.days, 31);
  assert.equal(r.periodB.days, 28);
});

// --- pagination -------------------------------------------------------------

test('an unrecognised cursor resumes after it — never restarts, never skips', async () => {
  // Two failure modes, both real. `indexOf` alone gave -1 -> Math.max(0,-1) -> 0, so an agent
  // paginating in a loop re-served page one forever. Rejecting an unrecognised cursor outright
  // fixed that but broke the opposite case: `pick` is sorted, so a metric syncing mid-pagination
  // inserts a name BEFORE the cursor and is then skipped forever while the caller believes it has
  // the whole catalogue. A successor search terminates in both cases and skips nothing.
  const mk = () => ({ unit: 'count', cumulative: true, daily: days(3, 1) });
  writeCache({ aaa: mk(), bbb: mk(), ccc: mk() });
  await store.getStructuredExport({});                 // warm

  // A metric appears before the cursor between pages.
  writeCache({ aaa: mk(), aab: mk(), bbb: mk(), ccc: mk() });
  const page = await store.getStructuredExport({ cursor: 'aab' });
  const names = Object.keys(page.metrics || page);
  assert.equal(names[0], 'aab', 'a newly inserted metric at the cursor must not be skipped');

  // A cursor past the end terminates rather than wrapping.
  const past = await store.getStructuredExport({ cursor: 'zzzzz' });
  assert.equal(Object.keys(past.metrics || past).length, 0, 'pagination must terminate');
});

// --- lock -------------------------------------------------------------------

test('locked tools report the lock instead of reporting no data', async () => {
  writeCache({ step_count: { unit: 'count', cumulative: true, daily: days(3, 1000) } });
  fs.writeFileSync(path.join(DIR, '.health-pair.json'),
                   JSON.stringify({ v: 1, alg: 'sha256', hash: 'deadbeef'.repeat(8) }));
  process.env.HEALTH_PAIR_SECRET = 'definitely-the-wrong-secret';
  try {
    // An agent that calls list_metrics first must not be told the user simply has no health data.
    await assert.rejects(() => store.listMetrics(), /pair|lock|secret/i);
    await assert.rejects(() => store.queryHealthData({ question: 'steps today' }), /pair|lock|secret/i);
  } finally {
    delete process.env.HEALTH_PAIR_SECRET;
    fs.rmSync(path.join(DIR, '.health-pair.json'), { force: true });
  }
});

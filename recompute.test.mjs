// Late-arrival recompute provenance (cache schema minor 1, docs/SCHEMA-CONTRACTS.md section 9).
//
// The iOS app rebuilds past days after samples dated before its re-read window arrive (or are
// deleted) and stamps each rebuilt day with `r`; days older than its rebuild cap are recorded in
// `_meta.recompute.capped`. These tests pin that an agent can tell a rebuilt day from an untouched
// one in every data tool, that the cap marker is surfaced instead of dropped, and that a cache
// written before any of this still answers exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeCache } from './receiver.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recompute-'));
const FILE = path.join(DIR, '.health-cache.json');
const day = (i) => new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);   // 2026-07-01 + i
const REBUILT_AT = '2026-09-30T08:15:00Z';

// 60 days of steps (1,000/day); days 40 and 41 were rebuilt after a late sample (1,250 and 1,100).
// Weight has a cap marker: samples dated in 2025 arrived but were older than the 90-day cap.
function recomputedCache() {
  const steps = [];
  for (let i = 0; i < 60; i++) {
    const p = { d: day(i), v: 1000 };
    if (i === 40) Object.assign(p, { v: 1250, r: REBUILT_AT });
    if (i === 41) Object.assign(p, { v: 1100, r: '2026-09-29T07:00:00Z' });
    steps.push(p);
  }
  const weight = [];
  for (let i = 0; i < 60; i += 2) weight.push({ d: day(i), v: 70 });
  return {
    _meta: {
      schema: 1, schemaMinor: 1, app: '1.9', writtenAt: '2026-09-30T08:15:01Z',
      recompute: {
        capDays: 90, lastRebuiltAt: REBUILT_AT, lastRebuiltDays: 1, lastRebuiltMetrics: ['step_count'],
        capped: {
          weight_body_mass: {
            at: REBUILT_AT, reason: 'late_samples', oldest: '2025-01-10', newest: '2025-03-01',
            lastDays: 4, uncheckedBefore: '2026-07-02',
          },
        },
      },
    },
    step_count: { unit: 'count', cumulative: true, daily: steps },
    weight_body_mass: { unit: 'kg', cumulative: false, daily: weight },
  };
}

// The same data as an app from before this change wrote it: no _meta at all, no `r`.
function legacyCache() {
  const c = recomputedCache();
  delete c._meta;
  for (const m of [c.step_count, c.weight_body_mass]) m.daily = m.daily.map(({ d, v }) => ({ d, v }));
  c.step_count.daily.push({ d: day(60), v: 1 });   // different byte size: forces the memo to re-read
  return c;
}

const write = (obj) => fs.writeFileSync(FILE, JSON.stringify(obj));
write(recomputedCache());
process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');

test('get_health_metrics marks rebuilt days and leaves untouched days bare', async () => {
  write(recomputedCache());
  const r = await store.getHealthMetrics({ metric: 'step_count', start: day(35), end: day(45), granularity: 'day' });
  const pts = r.step_count.points;
  const rebuilt = pts.filter((p) => p.recomputed_at);
  assert.deepEqual(rebuilt.map((p) => p.date), [day(40), day(41)]);
  assert.equal(pts.find((p) => p.date === day(40)).recomputed_at, REBUILT_AT);
  assert.equal(pts.find((p) => p.date === day(39)).recomputed_at, undefined, 'an untouched day carries no stamp');
  assert.equal(r.step_count.recompute.backfilled_days, 2);
  assert.equal(r.step_count.recompute.recomputed_at, REBUILT_AT, 'the most recent rebuild');
  assert.deepEqual(r.step_count.recompute.rebuiltDays, [day(40), day(41)]);
  assert.match(r.step_count.recompute.note, /rebuilt from Apple Health/);
  assert.doesNotMatch(r.step_count.recompute.note, /[–—]/, 'house rule: no en or em dashes');
});

test('a range that touches no rebuilt day carries no recompute block at all', async () => {
  write(recomputedCache());
  const r = await store.getHealthMetrics({ metric: 'step_count', start: day(1), end: day(10) });
  assert.equal(r.step_count.recompute, undefined);
  assert.ok(r.step_count.points.every((p) => p.recomputed_at === undefined));
});

test('rolled-up buckets count their rebuilt days', async () => {
  write(recomputedCache());
  const r = await store.getHealthMetrics({ metric: 'step_count', granularity: 'month' });
  const aug = r.step_count.points.find((p) => p.date === '2026-08');
  assert.equal(aug.backfilled_days, 2);
  const jul = r.step_count.points.find((p) => p.date === '2026-07');
  assert.equal(jul.backfilled_days, undefined);
});

test('the cap marker is surfaced, never silently dropped, when the question reaches back that far', async () => {
  write(recomputedCache());
  const r = await store.getHealthMetrics({ metric: 'weight_body_mass' });
  const c = r.weight_body_mass.recompute?.capped;
  assert.ok(c, 'capped marker present');
  assert.equal(c.reason, 'late_samples');
  assert.equal(c.oldest, '2025-01-10');
  assert.equal(c.uncheckedBefore, '2026-07-02');
  assert.equal(r.weight_body_mass.recompute.backfilled_days, 0);
  assert.match(r.weight_body_mass.recompute.note, /NOT rebuilt/);
  assert.match(r.weight_body_mass.recompute.note, /Your full history/);
  // A window that starts after the unchecked stretch is not affected by it.
  const later = await store.getHealthMetrics({ metric: 'weight_body_mass', start: day(10), end: day(20) });
  assert.equal(later.weight_body_mass.recompute, undefined);
});

test('a deletion marker (dates unknowable) shows only when the caller explicitly asks before it', async () => {
  const c = recomputedCache();
  c._meta.recompute.capped.step_count = { at: new Date().toISOString(), reason: 'deleted_samples', uncheckedBefore: day(20) };
  c.step_count.daily.push({ d: day(61), v: 2 });   // size change: defeat the memo
  write(c);
  const dflt = await store.getHealthMetrics({ metric: 'step_count', start: undefined, end: day(10) });
  assert.equal(dflt.step_count.recompute, undefined, 'default range: no permanent warning');
  const asked = await store.getHealthMetrics({ metric: 'step_count', start: day(0), end: day(10) });
  assert.equal(asked.step_count.recompute.capped.reason, 'deleted_samples');
  assert.doesNotMatch(asked.step_count.recompute.note, /rebuilds them/, 'a full-history export cannot remove a deleted day');
  // Nothing can resolve a dateless deletion marker, so it expires after 30 days.
  c._meta.recompute.capped.step_count.at = new Date(Date.now() - 31 * 86400000).toISOString();
  c.step_count.daily.push({ d: day(62), v: 3 });
  write(c);
  const old = await store.getHealthMetrics({ metric: 'step_count', start: day(0), end: day(10) });
  assert.equal(old.step_count.recompute, undefined);
  assert.equal((await store.status()).recompute.capped?.some((x) => x.metric === 'step_count') ?? false, false);
});

test('get_mcp_status summarises rebuilt days and cap markers', async () => {
  write(recomputedCache());
  const s = await store.status();
  assert.equal(s.recompute.supported, true);
  assert.equal(s.recompute.capDays, 90);
  assert.equal(s.recompute.recomputed_at, REBUILT_AT);
  assert.equal(s.recompute.backfilled_days, 2);
  assert.deepEqual(s.recompute.metricsWithRebuiltDays, ['step_count']);
  assert.deepEqual(s.recompute.capped.map((c) => c.metric), ['weight_body_mass']);
  assert.doesNotMatch(s.recompute.cappedNote, /[–—]/);
});

test('get_structured_export keeps the per-day `r` and the recompute block', async () => {
  write(recomputedCache());
  const r = await store.getStructuredExport({ metrics: ['step_count'], start: day(38), end: day(42), granularity: 'day' });
  const daily = r.metrics.step_count.daily;
  assert.equal(daily.find((p) => p.d === day(40)).r, REBUILT_AT);
  assert.equal(daily.find((p) => p.d === day(38)).r, undefined);
  assert.equal(r.metrics.step_count.recompute.backfilled_days, 2);
});

test('get_trends and compare_periods say which window holds rebuilt days', async () => {
  write(recomputedCache());
  const t = await store.getTrends({ metric: 'step_count', window: 14 });
  assert.equal(t.recompute.backfilled_days, 2, 'days 40 and 41 sit inside the last 28 days');
  const c = await store.comparePeriods({ metric: 'step_count',
    periodA: { start: day(36), end: day(45) }, periodB: { start: day(0), end: day(9) } });
  assert.equal(c.recompute.periodA.backfilled_days, 2);
  assert.equal(c.recompute.periodB, undefined, 'the untouched period carries nothing');
});

test('a legacy cache (no _meta, no r) answers exactly as before, with recompute unsupported', async () => {
  write(legacyCache());
  const r = await store.getHealthMetrics({ metric: 'step_count', start: day(35), end: day(45), granularity: 'day' });
  assert.equal(r.step_count.recompute, undefined);
  assert.ok(r.step_count.points.every((p) => Object.keys(p).join() === 'date,value'));
  assert.equal(r.step_count.aggregate, 1000 * 9 + 1250 + 1100);
  const s = await store.status();
  assert.equal(s.recompute.supported, false);
  assert.equal(s.recompute.backfilled_days, 0);
  assert.equal(s.recompute.capped, undefined);
  const t = await store.getTrends({ metric: 'step_count', window: 7 });
  assert.equal(t.recompute, undefined);
});

test('LAN receiver keeps a valid `r`, preserves it across later pushes, and rejects junk', () => {
  const first = mergeCache({}, { step_count: { unit: 'count', cumulative: true,
    daily: [{ d: day(40), v: 1250, r: REBUILT_AT }, { d: day(41), v: 1000, r: '<script>' }] } });
  assert.equal(first.step_count.daily[0].r, REBUILT_AT);
  assert.equal(first.step_count.daily[1].r, undefined, 'only a plain ISO instant survives sanitising');
  // A later ordinary push re-sends day 40 unstamped with the same value: the stamp stays.
  const second = mergeCache(first, { step_count: { unit: 'count', cumulative: true, daily: [{ d: day(40), v: 1250 }] } });
  assert.deepEqual(second.step_count.daily[0], { d: day(40), v: 1250, r: REBUILT_AT });
  // A different unstamped value makes the stamp stale (same rule as HealthCache.merge).
  const third = mergeCache(second, { step_count: { unit: 'count', cumulative: true, daily: [{ d: day(40), v: 1260 }] } });
  assert.deepEqual(third.step_count.daily[0], { d: day(40), v: 1260 });
});

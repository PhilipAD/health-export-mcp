// Tests for the query API's history behaviour: granularity, pagination, coverage, validation and
// the size guards. These exist because the 1.2 full-history export changes the cache from ~3 days
// to potentially a decade, and every one of these paths previously either returned the entire
// dataset or failed silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-store-'));

// A decade of daily values for three metrics: one cumulative, two not.
const DAYS = 3653;
function build() {
  const cache = {};
  const start = Date.UTC(2016, 0, 1);
  for (const [name, cumulative] of [['step_count', true], ['heart_rate', false], ['weight_body_mass', false]]) {
    const daily = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
      daily.push({ d, v: cumulative ? 1000 : 60 });   // flat values make aggregates exactly predictable
    }
    cache[name] = { unit: cumulative ? 'count' : 'count/min', cumulative, daily };
  }
  fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify(cache));
}
build();

process.env.HEALTH_DATA_DIR = DIR;
const store = await import('./healthstore.mjs');

test('rejects a malformed date instead of silently matching nothing', async () => {
  await assert.rejects(() => store.getHealthMetrics({ metric: 'step_count', start: '2026-8-1' }), /YYYY-MM-DD/);
  await assert.rejects(() => store.getHealthMetrics({ metric: 'step_count', start: 'last tuesday' }), /YYYY-MM-DD/);
});

test('rejects a date that looks well-formed but is not real', async () => {
  await assert.rejects(() => store.getHealthMetrics({ metric: 'step_count', start: '2026-02-30' }), /not a real date/);
});

test('rejects an inverted range rather than returning an empty series', async () => {
  await assert.rejects(
    () => store.getHealthMetrics({ metric: 'step_count', start: '2026-01-01', end: '2025-01-01' }),
    /is after end/);
});

test('auto granularity rolls a decade up instead of returning 3653 points', async () => {
  const out = await store.getHealthMetrics({ metric: 'step_count' });
  const m = out.step_count;
  assert.notEqual(m.granularity, 'day');
  assert.ok(m.points.length < 400, `expected a rolled-up series, got ${m.points.length} points`);
  assert.equal(m.pointsInRange, DAYS);
  assert.ok(m.note && /rolled up/.test(m.note));
});

test('a short range still comes back at day granularity', async () => {
  const out = await store.getHealthMetrics({ metric: 'step_count', start: '2025-01-01', end: '2025-03-31' });
  assert.equal(out.step_count.granularity, 'day');
  assert.equal(out.step_count.points.length, 90);
});

test('the aggregate is computed over the full range, never over the rolled-up points', async () => {
  // 3653 days x 1000 steps. If the sum were taken over monthly buckets it would still be 3.653M,
  // but if roll-up double-counted or dropped a bucket it would not.
  const out = await store.getHealthMetrics({ metric: 'step_count', aggregation: 'sum' });
  assert.equal(out.step_count.aggregate, DAYS * 1000);
  // A non-cumulative metric averages to its flat value regardless of granularity.
  const hr = await store.getHealthMetrics({ metric: 'heart_rate', aggregation: 'avg' });
  assert.equal(hr.heart_rate.aggregate, 60);
});

test('explicit granularity is honoured and buckets carry their day counts', async () => {
  const out = await store.getHealthMetrics({ metric: 'step_count', granularity: 'year' });
  assert.equal(out.step_count.granularity, 'year');
  // 3653 days from 2016-01-01 lands exactly on 2025-12-31, so the span is 2016..2025 = 10 years.
  assert.equal(out.step_count.points.length, 10);
  assert.equal(out.step_count.points[0].days, 366);        // 2016 was a leap year
  const total = out.step_count.points.reduce((a, p) => a + p.value, 0);
  assert.equal(total, DAYS * 1000, 'roll-up must conserve the cumulative total');
});

test('an unknown granularity is rejected', async () => {
  await assert.rejects(() => store.getHealthMetrics({ metric: 'step_count', granularity: 'fortnight' }), /granularity must be/);
});

test('every result carries honest coverage', async () => {
  const out = await store.getHealthMetrics({ metric: 'heart_rate' });
  assert.deepEqual(out.heart_rate.coverage, { firstDate: '2016-01-01', lastDate: '2025-12-31', days: DAYS });
});

test('get_trends says when the file cannot satisfy the window it was asked for', async () => {
  const deep = await store.getTrends({ metric: 'step_count', window: 30 });
  assert.equal(deep.daysAvailable, DAYS);
  assert.equal(deep.windowSatisfied, true);
  const tooDeep = await store.getTrends({ metric: 'step_count', window: 5000 });
  assert.equal(tooDeep.windowSatisfied, false, 'a 5000-day window over 3653 days must not claim success');
});

test('get_trends rejects a nonsense window', async () => {
  await assert.rejects(() => store.getTrends({ metric: 'step_count', window: 0 }), /at least 1 whole day/);
  await assert.rejects(() => store.getTrends({ metric: 'step_count', window: -7 }), /at least 1 whole day/);
  // 0.5 passed the old `> 0` check and then floored to 0, producing an EMPTY result with no error —
  // an agent asking for half a day was told, in effect, that there is no data.
  await assert.rejects(() => store.getTrends({ metric: 'step_count', window: 0.5 }), /at least 1 whole day/);
  await assert.rejects(() => store.getTrends({ metric: 'step_count', window: 'seven' }), /number of days/);
});

test('structured export paginates and every metric appears exactly once across pages', async () => {
  const seen = [];
  let cursor, pages = 0;
  do {
    const page = await store.getStructuredExport(cursor ? { cursor } : {});
    seen.push(...Object.keys(page.metrics));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 50, 'pagination did not terminate');
  } while (cursor);
  assert.deepEqual([...seen].sort(), ['heart_rate', 'step_count', 'weight_body_mass']);
  assert.equal(new Set(seen).size, seen.length, 'a metric was returned on two pages');
});

test('a named-metric export is not silently truncated', async () => {
  const out = await store.getStructuredExport({ metrics: ['step_count'], start: '2025-01-01', end: '2025-01-31' });
  assert.equal(out.returnedMetrics, 1);
  assert.equal(out.nextCursor, null);
  assert.equal(out.metrics.step_count.daily.length, 31);
});

test('query_health_data no longer returns a whole decade for one metric', async () => {
  const out = await store.queryHealthData({ question: 'what are my steps' });
  const points = out.result.step_count.points.length;
  assert.ok(points < 400, `query_health_data returned ${points} points`);
});

test('an oversize cache is a loud error, not an empty result', () => {
  // The old code returned {} above the size cap, so the server reported "no health data" and
  // "unknown metric" for a user whose only problem was a big file.
  const script = `
    process.env.HEALTH_DATA_DIR = ${JSON.stringify(DIR)};
    process.env.HEALTH_MAX_CACHE_BYTES = '1024';
    const s = await import(${JSON.stringify(path.join(HERE, 'healthstore.mjs'))});
    try { await s.listMetrics(); console.log('NO_THROW'); }
    catch (e) { console.log(/read limit/.test(e.message) ? 'THREW_CLEARLY' : 'THREW_OTHER:' + e.message); }
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  assert.equal(out, 'THREW_CLEARLY');
});

test('repeat reads are memoized on file identity', async () => {
  // Asserted by object identity, not by elapsed time: on a small fixture both reads round to a
  // millisecond or two and the comparison flips at random. Identity is what the memo actually
  // promises - the second call must not re-parse.
  const a = await store.loadMetrics();
  const b = await store.loadMetrics();
  assert.equal(a, b, 'the second read must return the memoized object, not a fresh parse');
});

test('rewriting the cache invalidates the memo', async () => {
  const before = await store.listMetrics();
  assert.equal(before.length, 3);
  const p = path.join(DIR, '.health-cache.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  c.vo2_max = { unit: 'ml/kg*min', cumulative: false, daily: [{ d: '2026-01-01', v: 48 }] };
  // Bump mtime explicitly: a same-second rewrite of a same-size file would otherwise look unchanged.
  fs.writeFileSync(p, JSON.stringify(c));
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(p, t, t);
  const after = await store.listMetrics();
  assert.equal(after.length, 4, 'a rewritten cache must be re-read');
});

// ---- Intraday window (health-intraday.json, app 1.4+) ----------------------

test('intraday: absent file answers available:false with setup guidance, never an error', async () => {
  const out = await store.getIntraday();
  assert.equal(out.available, false);
  assert.match(out.note, /hourly automation/i);
});

test('intraday: parses the HAE envelope, keeps hour resolution, reports latest', async () => {
  const envelope = { data: { metrics: [
    { name: 'heart_rate', units: 'count/min', data: [
      { date: '2026-08-17 08:00:00 +0100', qty: 62 },
      { date: '2026-08-17 09:00:00 +0100', qty: 71, min: 58, max: 84 },
    ]},
    { name: 'blood_oxygen_saturation', units: '%', data: [
      { date: '2026-08-17 09:00:00 +0100', qty: 0.97 },
    ]},
  ]}};
  fs.writeFileSync(path.join(DIR, 'health-intraday.json'), JSON.stringify(envelope));
  const out = await store.getIntraday();
  assert.equal(out.available, true);
  assert.equal(out.replacedEachRun, true);
  assert.equal(out.metrics.length, 2);
  const hr = out.metrics.find((m) => m.name === 'heart_rate');
  assert.equal(hr.points.length, 2);
  assert.equal(hr.points[1].v, 71);
  assert.equal(hr.points[1].max, 84);          // extra envelope fields survive
  assert.equal(hr.latest.v, 71);
  const spo2 = out.metrics.find((m) => m.name === 'blood_oxygen_saturation');
  assert.equal(spo2.latest.v, 0.97);           // fractions stay fractions, same as the daily cache
});

test('intraday: metric filter hits and misses honestly', async () => {
  const hit = await store.getIntraday({ metric: 'heart_rate' });
  assert.equal(hit.metrics.length, 1);
  assert.equal(hit.metrics[0].name, 'heart_rate');
  const miss = await store.getIntraday({ metric: 'step_count' });
  assert.equal(miss.available, true);
  assert.equal(miss.found, false);
  assert.match(miss.note, /heart_rate/);       // says what IS present
});

test('intraday: status reports the window presence additively', async () => {
  const s = await store.status();
  assert.equal(s.intraday.present, true);
  assert.ok(s.intraday.lastWrite);
  fs.rmSync(path.join(DIR, 'health-intraday.json'));
  const s2 = await store.status();
  assert.equal(s2.intraday.present, false);
});

test('intraday: a corrupt file degrades to available:false, not a crash', async () => {
  fs.writeFileSync(path.join(DIR, 'health-intraday.json'), '{not json');
  const out = await store.getIntraday();
  assert.equal(out.available, false);
  fs.rmSync(path.join(DIR, 'health-intraday.json'));
});

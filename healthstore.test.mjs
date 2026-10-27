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

// The install-intent -> unlock middle was dark: npm installs and clones ran 40-60x the unlocks and
// no tool answer carried an attributable link to the app. get_mcp_status is the tool every agent is
// told to call first, so that is where the tagged link goes, now on EVERY answer. The old gate
// (link only for no export / stale / demo) hid it exactly where it mattered: the common order is
// buy the app, export, then wire up the server, so that user always had a usable export and never
// saw a payment surface. Measured: 1 visit in 90 days vs ~290 installs/week. Assert the TAG, not
// just the presence, or a refactor can silently drop the campaign and the funnel goes dark again
// with a green suite. Each case is a fresh process because the data dir and demo flag are read once
// at import. The sole exception is status()'s encrypted early return, where the export came from the
// app and the fix is the passphrase, not a link (see envelope.test.mjs and freshness.test.mjs).
const statusIn = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import(${JSON.stringify(path.join(HERE, 'healthstore.mjs'))}).then(async (s) => console.log(JSON.stringify(await s.status())))`],
  { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
const assertTagged = (app) => {
  assert.equal(app.unlockUrl, store.UNLOCK_URL);
  assert.equal(app.appStoreUrl, store.APP_STORE_URL);
  const a = new URL(app.appStoreUrl);
  assert.equal(a.searchParams.get('ct'), 'mcpserver');
  assert.equal(a.searchParams.get('ppid'), '2c28f88a-d94f-48f9-8e6a-74a8d89ce66e');
  assert.equal(app.name, 'MetricBridge');
  const u = new URL(app.unlockUrl);
  assert.equal(u.origin, 'https://www.healthexport.dev');
  assert.equal(u.searchParams.get('utm_source'), 'mcp');
  assert.equal(u.searchParams.get('utm_medium'), 'agent-tool');
  // site/app.js copies utm_campaign into Apple's campaign token, which allows at most 30 characters.
  assert.equal(u.searchParams.get('utm_campaign'), 'mcp-unlock');
  assert.doesNotMatch(app.note, /\b(share|tell|give|send|must|always)\b/i, 'the note describes, it does not instruct the agent');
};

test('status carries the campaign-tagged companion-app link even when a fresh export is present', async () => {
  const s = await store.status();
  assert.equal(s.ok, true);
  assert.equal(s.freshness.stale, false);
  assertTagged(s.app);
});

test('status carries the campaign-tagged companion-app link when there is no export', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-empty-'));
  const s = statusIn({ HEALTH_DATA_DIR: empty });
  assert.equal(s.ok, false);
  assert.equal(s.metricCount, 0);
  assertTagged(s.app);
  // The link must ALSO ride the freshness recommendation -- the prose an agent relays. app.unlockUrl
  // alone sat unread in structuredContent and the measured result was 1 visit in 90 days.
  assert.ok(s.freshness.recommendation.includes(store.UNLOCK_URL),
    `freshness.recommendation must carry the tagged link:\n${s.freshness.recommendation}`);
  assert.ok(s.freshness.recommendation.includes(store.APP_STORE_URL),
    `freshness.recommendation must carry the App Store link:\n${s.freshness.recommendation}`);
});

test('status carries the link when the export has gone stale (a paused trial stops the writes)', () => {
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-stale-'));
  const f = path.join(stale, '.health-cache.json');
  fs.writeFileSync(f, JSON.stringify({ step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-01-01', v: 1 }] } }));
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(f, old, old);
  const s = statusIn({ HEALTH_DATA_DIR: stale });
  assert.equal(s.freshness.stale, true);
  assertTagged(s.app);
  // The paused-trial wall: the stale recommendation must relay the tagged link in prose too.
  assert.ok(s.freshness.recommendation.includes(store.UNLOCK_URL),
    `stale freshness.recommendation must carry the tagged link:\n${s.freshness.recommendation}`);
});

test('a fresh mid-trial export names the trial and relays the unlock link (the money moment)', () => {
  // A working export written by an app still inside its 7-day trial. The stale path above only
  // reaches a trial that already ENDED; this is the user whose export still works and whose trial
  // is about to lapse -- the one un-nudged payer moment. `_meta.license` is the non-health marker
  // the iOS app stamps; assert the prose carries the tagged link, and that the status answer does
  // too (the app card is now unconditional, so this fresh-trial user sees the payment surface).
  const trial = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-trial-'));
  const f = path.join(trial, '.health-cache.json');
  fs.writeFileSync(f, JSON.stringify({
    _meta: { schema: 1, app: '1.9.0', writtenAt: new Date().toISOString(), license: { state: 'trial', daysRemaining: 3 } },
    step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-01-01', v: 1 }] },
  }));
  const s = statusIn({ HEALTH_DATA_DIR: trial });
  assert.equal(s.freshness.stale, false);
  assertTagged(s.app);
  assert.match(s.freshness.recommendation, /trial ends in 3 days/);
  assert.ok(s.freshness.recommendation.includes(store.UNLOCK_URL),
    `mid-trial freshness.recommendation must carry the tagged link:\n${s.freshness.recommendation}`);
});

test('an unlocked fresh export carries no trial note (paid users are never nudged)', () => {
  const paid = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-paid-'));
  const f = path.join(paid, '.health-cache.json');
  fs.writeFileSync(f, JSON.stringify({
    _meta: { schema: 1, app: '1.9.0', writtenAt: new Date().toISOString(), license: { state: 'unlocked' } },
    step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-01-01', v: 1 }] },
  }));
  const s = statusIn({ HEALTH_DATA_DIR: paid });
  assert.equal(s.freshness.stale, false);
  assert.doesNotMatch(s.freshness.recommendation, /trial/i);
  assert.doesNotMatch(s.freshness.recommendation, /unlock/i);
});

test('status carries the link in demo mode, where no real export is read', () => {
  const s = statusIn({ HEALTH_DEMO: '1' });
  assert.equal(s.demo, true);
  assertTagged(s.app);
});

// 1.7.3: an unconfigured server on a Mac reads the MetricBridge iCloud folder, not the client's cwd.
test('resolveDataDir: HEALTH_DATA_DIR wins, ~ expands, the Mac default is the iCloud folder', async () => {
  const { resolveDataDir, ICLOUD_DIR } = await import('./healthstore.mjs');
  assert.deepEqual(resolveDataDir({ HEALTH_DATA_DIR: '/x' }, 'darwin', () => true), { dir: '/x', how: 'HEALTH_DATA_DIR' });
  assert.equal(resolveDataDir({ HEALTH_DATA_DIR: '~/h' }, 'linux', () => false).dir, path.join(os.homedir(), 'h'));
  assert.equal(resolveDataDir({}, 'darwin', (p) => p === ICLOUD_DIR).dir, ICLOUD_DIR);
  assert.match(resolveDataDir({}, 'darwin', (p) => p === ICLOUD_DIR).how, /iCloud/);
  assert.equal(resolveDataDir({}, 'darwin', () => false).dir, '.', 'no iCloud folder: current directory');
  assert.equal(resolveDataDir({}, 'linux', () => true).dir, '.', 'not a Mac: current directory');
  assert.ok(ICLOUD_DIR.endsWith('Library/Mobile Documents/iCloud~ai~healthexport~app/Documents'));
});

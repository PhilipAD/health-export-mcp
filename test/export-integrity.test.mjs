// Export integrity (1.8.0): a long-term user (ring + running watch, iCloud folder read on a Mac) reported, with dates,
// that the server called a day-old export fresh, could not log an event, dropped individual blood
// pressure readings and returned the same night twice. Every scenario below FAILED on 1.7.3; the
// contract is docs/SCHEMA-CONTRACTS.md section 10 (section 13 in the app repo).
//
//   1. freshness: stale is judged on the core files; .health-manifest.json and iCloud expose a stale copy
//   2. add_event / remove_event write health-events-agent.json only; readers merge both event files
//   3. health-readings.json: blood pressure readings ride on get_health_metrics at day granularity
//   4. get_sleep_sessions collapses duplicate copies of one night
//   5. get_intraday passes the hour's Min/Max through
//   6. recompute.supported is null (with a reason) for a cache without _meta
//
// DATA_DIR and DEMO are read when healthstore.mjs is imported, so the in-process tests share one
// folder (cleared per test) and the stdio tests spawn the real server, as an MCP client does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealEnvelope, isEnvelope, MIN_ITERATIONS } from '../envelope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const HOUR = 3600000;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-347-'));
process.env.HEALTH_DATA_DIR = DIR;
delete process.env.HEALTH_STALE_AFTER_HOURS;
delete process.env.HEALTH_EXPORT_PASSPHRASE;
delete process.env.HEALTH_EXPORT_PASSPHRASE_FILE;
delete process.env.PAIRING_SECRET;
const store = await import('../healthstore.mjs');
const ev = await import('../events.mjs');
const { TOOLS } = await import('../server.mjs');

const localDay = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const dayOffset = (n, from = Date.now()) => localDay(from - n * 86400000);

function cache({ meta = true, days = 14, bp = false } = {}) {
  const daily = (fn) => Array.from({ length: days }, (_, i) => ({ d: dayOffset(days - 1 - i), v: fn(i) }));
  return {
    ...(meta && { _meta: { schema: 1, schemaMinor: 2, app: '1.20', writtenAt: new Date().toISOString() } }),
    step_count: { unit: 'count', cumulative: true, daily: daily((i) => 8000 + i) },
    heart_rate_variability: { unit: 'ms', cumulative: false, daily: daily((i) => 50 + i) },
    ...(bp && {
      blood_pressure_systolic: { unit: 'mmHg', cumulative: false, daily: daily(() => 121) },
      blood_pressure_diastolic: { unit: 'mmHg', cumulative: false, daily: daily(() => 79) },
    }),
  };
}
const night = (n, { start = '23:10:00', end = '06:40:00', hours = 7.5, ...rest } = {}) =>
  ({ start: `${dayOffset(n + 1)}T${start}-05:00`, end: `${dayOffset(n)}T${end}-05:00`, day: dayOffset(n), hours, ...rest });
const sessionsFile = (sessions) => ({ schema: 1, writtenAt: new Date().toISOString(), sessions });

/** Write `obj` as JSON and stamp its mtime `ageH` hours ago. A per-write pad defeats the
 *  (mtime, size) memo the way freshness.test.mjs does. Returns the bytes written. */
let pad = 0;
function put(name, obj, ageH = 0, now = Date.now()) {
  const p = path.join(DIR, name);
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj) + ' '.repeat(++pad % 5);
  fs.writeFileSync(p, text);
  const t = (now - ageH * HOUR) / 1000;
  fs.utimesSync(p, t, t);
  return Buffer.from(text);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** The manifest the app writes LAST: one entry per file, describing the bytes the PHONE wrote. */
function manifest(entries, { lastNight = null, writtenAt = new Date().toISOString() } = {}) {
  const files = {};
  for (const [name, { bytes, at }] of Object.entries(entries)) {
    files[name] = { writtenAt: at ?? writtenAt, bytes: bytes.length, sha256: sha(bytes) };
  }
  return { schema: 1, app: '1.20', generation: 1834, writtenAt, files, lastNight };
}
function clear() {
  for (const n of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, n), { recursive: true, force: true });
}

// ---- 1. freshness ------------------------------------------------------------------------------

test('R1b: a fresh intraday file no longer makes a 30-hour-old cache and sessions read as fresh', async () => {
  clear();
  const now = Date.now();
  put('.health-cache.json', cache(), 30, now);
  put('health-sessions.json', sessionsFile([night(1)]), 30, now);
  put('health-intraday.json', { data: { metrics: [] } }, 0.5, now);
  put('health-events.json', { schema: 1, events: [] }, 0.2, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'stale');
  assert.equal(f.stale, true);
  assert.equal(f.stale_basis, 'core_files');
  assert.ok(['.health-cache.json', 'health-sessions.json'].includes(f.newest_write.file));
  assert.equal(f.age_hours, 30);
  // The non-core files are still reported, per file, and are not stale on their own.
  assert.equal(f.files['health-intraday.json'].age_hours, 0.5);
  assert.equal(f.files['health-intraday.json'].core, undefined);
  assert.equal(f.files['.health-cache.json'].core, true);
  assert.deepEqual(f.stale_files.sort(), ['.health-cache.json', 'health-sessions.json']);
});

test('the newest CORE file decides: a fresh cache with an older sessions file is fresh', async () => {
  clear();
  const now = Date.now();
  put('.health-cache.json', cache(), 2, now);
  put('health-sessions.json', sessionsFile([night(0)]), 40, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'fresh');
  assert.equal(f.newest_write.file, '.health-cache.json');
});

test('a folder with no core file falls back to the newest of the family (basis all_files)', async () => {
  clear();
  put('health-events.json', { schema: 1, events: [] }, 1);
  const f = await store.freshness();
  assert.equal(f.stale_basis, 'all_files');
  assert.equal(f.newest_write.file, 'health-events.json');
  assert.equal(store.newestWrite().basis, 'all_files');
  clear();
  assert.equal(store.newestWrite(), null);
  assert.equal((await store.freshness()).state, 'no_data');
});

test('manifest matches every local file: fresh, each file marked matchesPhone, nothing flagged', async () => {
  clear();
  const c = put('.health-cache.json', cache(), 1);
  const s = put('health-sessions.json', sessionsFile([night(0)]), 1);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: c }, 'health-sessions.json': { bytes: s } },
    { lastNight: { day: dayOffset(0), end: night(0).end } }));
  const f = await store.freshness();
  assert.equal(f.state, 'fresh');
  assert.equal(f.stale_copy, undefined);
  assert.equal(f.files['.health-cache.json'].matchesPhone, true);
  assert.equal(f.files['health-sessions.json'].matchesPhone, true);
  assert.equal(f.manifest.present, true);
  assert.equal(f.manifest.generation, 1834);
  assert.equal(f.sessions_last_night, undefined, 'the advisory is for exports without a manifest');
});

test('R1a with a manifest: yesterday\'s copy of the cache (hash differs, older) is a stale_copy, whatever its age', async () => {
  clear();
  const now = Date.now();
  // This Mac holds the copy written 20 h ago: inside the 26 h window, so 1.7.3 called it fresh.
  const local = put('.health-cache.json', cache({ days: 13 }), 20, now);
  const phone = Buffer.from(JSON.stringify(cache({ days: 14 })));
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: phone, at: new Date(now - 0.5 * HOUR).toISOString() } }), 0.5, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'stale_copy');
  assert.equal(f.stale, true);
  assert.equal(f.stale_copy.length, 1);
  const c = f.stale_copy[0];
  assert.equal(c.file, '.health-cache.json');
  assert.equal(c.core, true);
  assert.equal(c.reason, local.length === phone.length ? 'hash_mismatch' : 'size_mismatch');
  assert.equal(c.phoneWrittenAt, new Date(now - 0.5 * HOUR).toISOString());
  assert.ok(Math.abs(Date.parse(c.localWrittenAt) - (now - 20 * HOUR)) < 1000, `localWrittenAt ${c.localWrittenAt} is this copy's write time`);
  assert.equal(f.files['.health-cache.json'].matchesPhone, false);
  // The fix is iCloud, explained without a destructive command, and it is not the trial wall.
  assert.match(f.recommendation, /older copy of \.health-cache\.json than the phone last wrote/);
  assert.match(f.recommendation, /iCloud Drive on this Mac has not downloaded the latest version/);
  assert.match(f.recommendation, /Download Now/);
  assert.match(f.recommendation, /removes only this Mac's local copy/);
  assert.doesNotMatch(f.recommendation, /\brm\b|healthexport\.dev|free trial/);
});

test('equal size, different bytes: the sha256 catches it (reason hash_mismatch)', async () => {
  clear();
  const local = put('.health-cache.json', '{"step_count":{"unit":"count","daily":[{"d":"2026-10-26","v":1}]}}', 3);
  const phone = Buffer.from(local.toString().replace('"v":1', '"v":2'));
  assert.equal(phone.length, local.length);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: phone } }), 0);
  const f = await store.freshness();
  assert.equal(f.state, 'stale_copy');
  assert.equal(f.stale_copy[0].reason, 'hash_mismatch');
  // A rewrite of the local file (new mtime) is hashed again, not served from the memo.
  put('.health-cache.json', phone.toString(), 0);
  const g = await store.freshness();
  assert.equal(g.state, 'fresh');
  assert.equal(g.files['.health-cache.json'].matchesPhone, true);
});

test('local file NEWER than its manifest entry: the manifest is lagging (manifest_behind), not stale', async () => {
  clear();
  const now = Date.now();
  put('.health-cache.json', cache(), 0.1, now);
  const older = Buffer.from(JSON.stringify(cache({ days: 13 })));
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: older, at: new Date(now - 5 * HOUR).toISOString() } }), 5, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'fresh');
  assert.equal(f.manifest_behind, true);
  assert.equal(f.stale_copy, undefined);
  assert.equal(f.files['.health-cache.json'].localNewer, true);
});

test('manifest.lastNight later than the newest local session: health-sessions.json is a stale copy', async () => {
  clear();
  const now = Date.now();
  const c = put('.health-cache.json', cache(), 1, now);
  // Same bytes as listed, so only the lastNight rule can see it.
  const s = put('health-sessions.json', sessionsFile([night(2), night(1)]), 1, now);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: c }, 'health-sessions.json': { bytes: s } },
    { lastNight: { day: dayOffset(0), end: night(0).end } }), 0, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'stale_copy');
  assert.deepEqual(f.stale_copy.map((x) => [x.file, x.reason]), [['health-sessions.json', 'last_night_missing']]);
  assert.match(f.recommendation, /last night's sleep is missing from this copy/);
  // Already flagged by its hash: the missing night is still recorded on the same entry.
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: c }, 'health-sessions.json': { bytes: Buffer.from('{"phone":1}') } },
    { lastNight: { day: dayOffset(0), end: night(0).end } }), 0.01, now);   // new mtime: never a memo hit
  const g = await store.freshness({ now });
  assert.equal(g.stale_copy.length, 1);
  assert.equal(g.stale_copy[0].lastNightMissing, true);
  assert.match(g.recommendation, /last night's sleep is missing/);
});

test('a stale copy of a NON-core file is listed (core:false) but does not change the verdict', async () => {
  clear();
  const c = put('.health-cache.json', cache(), 1);
  put('health-intraday.json', { data: { metrics: [] } }, 2);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: c }, 'health-intraday.json': { bytes: Buffer.from('{"data":{"metrics":[1]}}') } }), 0);
  const f = await store.freshness();
  assert.equal(f.state, 'fresh');
  assert.equal(f.stale, false);
  assert.deepEqual(f.stale_copy.map((x) => [x.file, x.core]), [['health-intraday.json', false]]);
  assert.match(f.recommendation, /older copy of health-intraday\.json/);
});

test('a manifest file missing locally is reported, and an unreadable manifest is never guessed around', async () => {
  clear();
  const c = put('.health-cache.json', cache(), 1);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: c }, 'health-sessions.json': { bytes: Buffer.from('{}') } }), 0);
  const f = await store.freshness();
  assert.deepEqual(f.manifest.missingLocally, ['health-sessions.json']);
  put('.health-manifest.json', sealEnvelope('{"schema":1,"files":{}}', 'pw-not-configured', { iter: MIN_ITERATIONS }), 0);
  const g = await store.freshness();
  assert.equal(g.state, 'fresh');
  assert.deepEqual(g.manifest, { present: true, readable: false, error: 'passphrase_missing' });
  put('.health-manifest.json', { schema: 2, files: {} }, 0);
  assert.equal((await store.freshness()).manifest.error, 'unsupported_schema_2');
});

test('no manifest: sessions_last_night is an advisory (absent / present) that never changes state', async () => {
  clear();
  const now = Date.now();
  put('.health-cache.json', cache(), 24, now);
  put('health-sessions.json', sessionsFile([night(2), night(1)]), 24, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'fresh');
  assert.equal(f.sessions_last_night, 'absent');
  assert.match(f.recommendation, /No sleep session in health-sessions\.json ends today/);
  put('health-sessions.json', sessionsFile([night(1), night(0)]), 1, now);
  const g = await store.freshness({ now });
  assert.equal(g.sessions_last_night, 'present');
  assert.doesNotMatch(g.recommendation, /No sleep session/);
});

test('iCloud says `downloaded` on a core file: stale_copy (reason icloud_newer_version), icloud block in detail', async () => {
  clear();
  put('.health-cache.json', cache(), 2);
  const probe = () => ({ '.health-cache.json': { status: 'downloaded', dataless: false } });
  const f = await store.freshness({ _icloud: probe });
  assert.equal(f.state, 'stale_copy');
  assert.equal(f.stale_copy[0].reason, 'icloud_newer_version');
  assert.deepEqual(f.icloud, probe());
  const compact = await store.freshness({ detail: false, _icloud: probe });
  assert.equal(compact.state, 'stale_copy');
  assert.equal(compact.icloud, undefined, 'the iCloud detail stays out of the compact block');
  const current = await store.freshness({ _icloud: () => ({ '.health-cache.json': { status: 'current', dataless: false } }) });
  assert.equal(current.state, 'fresh');
});

test('icloudStatus: macOS and ~/Library/Mobile Documents only, parses osascript + stat, memoizes, never throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-347-root-'));
  const dir = path.join(root, 'iCloud~ai~healthexport~app', 'Documents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.health-cache.json'), '{}');
  fs.writeFileSync(path.join(dir, 'health-sessions.json'), '{"sessions":[]}');
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(cmd);
    if (cmd.endsWith('osascript')) {
      const files = args.slice(4);
      return JSON.stringify({ [files[0]]: 'NSURLUbiquitousItemDownloadingStatusDownloaded', [files[1]]: 'NSURLUbiquitousItemDownloadingStatusCurrent' });
    }
    return 'hidden,compressed,dataless\n-\n';
  };
  const names = ['.health-cache.json', 'health-sessions.json'];
  assert.equal(store.icloudStatus(names, { platform: 'linux', dir, root, exec }), null);
  assert.equal(store.icloudStatus(names, { platform: 'darwin', dir: os.tmpdir(), root, exec }), null);
  assert.equal(calls.length, 0, 'no process is spawned when the probe does not apply');
  const now = Date.now();
  const r = store.icloudStatus(names, { platform: 'darwin', dir, root, exec, now });
  assert.deepEqual(r, {
    '.health-cache.json': { status: 'downloaded', dataless: true },
    'health-sessions.json': { status: 'current', dataless: false },
  });
  assert.equal(calls.length, 2);
  store.icloudStatus(names, { platform: 'darwin', dir, root, exec, now: now + 1000 });
  assert.equal(calls.length, 2, 'memoized per file stamp');
  store.icloudStatus(names, { platform: 'darwin', dir, root, exec, now: now + 61000 });
  assert.equal(calls.length, 4, 'and re-probed after a minute: iCloud can change its mind without the file changing');
  const boom = () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
  fs.writeFileSync(path.join(dir, '.health-cache.json'), '{"x":1}');
  assert.deepEqual(store.icloudStatus(['.health-cache.json'], { platform: 'darwin', dir, root, exec: boom }),
    { '.health-cache.json': { status: null, dataless: false } });
});

test('get_mcp_status surfaces the stale-copy verdict in its compact freshness block', async () => {
  clear();
  put('.health-cache.json', cache({ days: 13 }), 3);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: Buffer.from(JSON.stringify(cache())) } }), 0);
  const s = await store.status();
  assert.equal(s.freshness.state, 'stale_copy');
  assert.equal(s.freshness.stale, true);
  assert.equal(s.freshness.stale_copy[0].file, '.health-cache.json');
  assert.ok(!('files' in s.freshness), 'still compact');
  assert.equal(s.contextFiles.manifest, true);
});

test('the cron gate agrees: core-file age, and a stale copy exits 1 even when the file is recent', () => {
  clear();
  const now = Date.now();
  put('.health-cache.json', cache(), 30, now);
  put('health-intraday.json', { data: { metrics: [] } }, 0.5, now);
  const gate = (n) => spawnSync(process.execPath, [SERVER, 'status', '--max-age', String(n)],
    { env: { PATH: process.env.PATH, HEALTH_DATA_DIR: DIR }, encoding: 'utf8', timeout: 15000 });
  const a = gate(26);
  assert.equal(a.status, 1, a.stdout);
  assert.match(a.stdout, /\.health-cache\.json/);
  put('.health-cache.json', cache({ days: 13 }), 1, now);
  put('.health-manifest.json', manifest({ '.health-cache.json': { bytes: Buffer.from(JSON.stringify(cache())) } }), 0, now);
  const b = gate(26);
  assert.equal(b.status, 1, b.stdout);
  assert.match(b.stdout, /older copy of \.health-cache\.json/);
});

// ---- 6. recompute wording -----------------------------------------------------------------------

test('recompute.supported: null with a reason when the cache has no _meta; false when _meta predates it', async () => {
  clear();
  put('.health-cache.json', cache({ meta: false }), 1);
  const s = await store.status();
  assert.equal(s.recompute.supported, null);
  assert.match(s.recompute.reason, /no _meta block/);
  put('.health-cache.json', { _meta: { schema: 1, app: '1.3' }, ...cache({ meta: false }) }, 1);
  const t = await store.status();
  assert.equal(t.recompute.supported, false);
  assert.equal(t.recompute.reason, undefined);
});

// ---- 3. blood pressure readings ----------------------------------------------------------------

const reading = (n, hhmm, sys, dia, extra = {}) =>
  ({ id: `bp-${n}-${hhmm}`, t: `${dayOffset(n)}T${hhmm}:00-05:00`, day: dayOffset(n), systolic: sys, diastolic: dia, unit: 'mmHg', source: 'Omron Connect', manual: false, ...extra });

test('R6: get_health_metrics attaches the individual readings for blood pressure at day granularity', async () => {
  clear();
  put('.health-cache.json', cache({ bp: true }), 1);
  put('health-readings.json', { schema: 1, writtenAt: new Date().toISOString(), bloodPressure: [
    reading(0, '20:00', 112, 74), reading(0, '08:00', 138, 88), reading(1, '08:05', 128, 82, { manual: true, source: 'Health' }),
    reading(5, '08:00', 150, 95),
  ] }, 1);
  const r = await store.getHealthMetrics({ metric: 'blood_pressure_systolic', start: dayOffset(1), end: dayOffset(0), granularity: 'day' });
  const m = r.blood_pressure_systolic;
  assert.deepEqual(m.readings.map((x) => [x.systolic, x.diastolic]), [[128, 82], [138, 88], [112, 74]], 'in range only, oldest first');
  assert.deepEqual(m.readings[0], { t: `${dayOffset(1)}T08:05:00-05:00`, systolic: 128, diastolic: 82, source: 'Health', manual: true });
  assert.equal(m.aggregate, 121, 'the daily mean is unchanged');
  const d = await store.getHealthMetrics({ metric: 'blood_pressure_diastolic', start: dayOffset(0), end: dayOffset(0) });
  assert.equal(d.blood_pressure_diastolic.readings.length, 2);
  const steps = await store.getHealthMetrics({ metric: 'step_count', start: dayOffset(1), end: dayOffset(0) });
  assert.equal(steps.step_count.readings, undefined, 'only the two blood pressure metrics carry readings');
  const rolled = await store.getHealthMetrics({ metric: 'blood_pressure_systolic', granularity: 'month' });
  assert.equal(rolled.blood_pressure_systolic.readings, undefined);
  assert.match(rolled.blood_pressure_systolic.readingsNote, /4 individual blood pressure reading\(s\).*granularity:"day"/);
});

test('readings are capped within the wire budget, newest kept, the omitted count stated', async () => {
  clear();
  put('.health-cache.json', cache({ bp: true }), 1);
  const many = [];
  for (let n = 0; n < 14; n++) for (let h = 0; h < 15; h++) many.push(reading(n, `${String(h + 6).padStart(2, '0')}:00`, 120 + h, 80));
  put('health-readings.json', { schema: 1, bloodPressure: many }, 1);
  const r = await store.getHealthMetrics({ metric: 'blood_pressure_systolic', granularity: 'day' });
  const m = r.blood_pressure_systolic;
  assert.equal(m.readings.length, 150);
  assert.equal(m.readingsOmitted, 60);
  assert.match(m.readingsNote, /210 readings in range; the 150 most recent/);
  assert.equal(m.readings.at(-1).t, `${dayOffset(0)}T20:00:00-05:00`);
});

test('no health-readings.json: the blood pressure answer is byte-for-byte what it was', async () => {
  clear();
  put('.health-cache.json', cache({ bp: true }), 1);
  const r = await store.getHealthMetrics({ metric: 'blood_pressure_systolic', start: dayOffset(1), end: dayOffset(0) });
  assert.deepEqual(Object.keys(r.blood_pressure_systolic).filter((k) => /reading/i.test(k)), []);
});

// ---- 4. sleep sessions ---------------------------------------------------------------------------

test('S2: a second copy of one night (same end, later start) is collapsed to the longer, and counted', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  put('health-sessions.json', sessionsFile([
    night(0),
    night(0, { start: '23:55:00', hours: 6.75 }),                          // same end, later start
    night(1),
    // The post-midnight half of night(1), rebuilt on its own: lies entirely inside the full night.
    { start: `${dayOffset(1)}T01:30:00-05:00`, end: `${dayOffset(1)}T05:00:00-05:00`, day: dayOffset(1), hours: 3.4 },
    { start: `${dayOffset(2)}T13:00:00-05:00`, end: `${dayOffset(2)}T13:40:00-05:00`, day: dayOffset(2), hours: 0.6 },
    night(2),                                                              // nap + night = genuine split day
  ]));
  const r = await ev.getSleepSessions({});
  assert.equal(r.count, 4);
  assert.equal(r.collapsedDuplicates, 2);
  const byDay = (d) => r.sessions.filter((s) => s.day === d);
  assert.equal(byDay(dayOffset(0)).length, 1);
  assert.equal(byDay(dayOffset(0))[0].hours, 7.5, 'the longer copy wins');
  assert.equal(byDay(dayOffset(2)).length, 2, 'a nap and a night that do not overlap are both kept');
  assert.match(r.note, /2 duplicate session\(s\) were collapsed/);
  const one = await ev.getSleepSessions({ day: dayOffset(0) });
  assert.equal(one.count, 1);
  assert.equal(one.collapsedDuplicates, 1);
});

test('no duplicates: no collapsedDuplicates key; manualInBed sessions are counted and explained', async () => {
  clear();
  put('health-sessions.json', sessionsFile([night(1), night(0, { manualInBed: true })]));
  const r = await ev.getSleepSessions({});
  assert.equal(r.count, 2);
  assert.equal(r.collapsedDuplicates, undefined);
  assert.equal(r.manualInBedSessions, 1);
  assert.equal(r.sessions.find((s) => s.day === dayOffset(0)).manualInBed, true);
  assert.match(r.note, /In Bed" entry the user typed into the Health app/);
});

// ---- 5. intraday Min/Max ---------------------------------------------------------------------------

test('get_intraday passes the hour\'s Min and Max through (HAE shape {date, qty, Min, Max})', async () => {
  clear();
  put('health-intraday.json', { data: { metrics: [{ name: 'oxygen_saturation', units: '%', data: [
    { date: `${dayOffset(1)} 23:00:00 -0500`, qty: 95.1, Min: 93, Max: 97 },
    { date: `${dayOffset(0)} 03:00:00 -0500`, qty: 94.5, Min: 89, Max: 97 },
  ] }] } });
  const r = await store.getIntraday({ metric: 'oxygen_saturation' });
  assert.deepEqual(r.metrics[0].points, [
    { t: `${dayOffset(1)} 23:00:00 -0500`, v: 95.1, Min: 93, Max: 97 },
    { t: `${dayOffset(0)} 03:00:00 -0500`, v: 94.5, Min: 89, Max: 97 },
  ]);
  const d = TOOLS.find((t) => t.name === 'get_intraday').description;
  assert.match(d, /48-hour span, yesterday 00:00 local to now/);
  assert.match(d, /Min and Max/);
});

// ---- 2. agent events ---------------------------------------------------------------------------

const APP_EVENTS = { schema: 1, app: '1.20', writtenAt: new Date().toISOString(), events: [
  { id: 'e-visit', date: dayOffset(9), type: 'visit', title: 'GP review' },
] };
const agentFile = () => JSON.parse(fs.readFileSync(path.join(DIR, ev.AGENT_EVENTS_FILE), 'utf8'));
const leftovers = () => fs.readdirSync(DIR).filter((n) => /\.tmp|\.lock/.test(n));

test('R3: add_event writes ONLY health-events-agent.json; list_events merges both files with source labels', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  put('health-events.json', APP_EVENTS);
  const appBytes = fs.readFileSync(path.join(DIR, 'health-events.json'));
  const before = fs.readdirSync(DIR).sort();
  const r = await ev.addEvent({ date: dayOffset(5), type: 'medication', title: '  Started magnesium  ', tags: ['magnesium', 'magnesium'], note: 'evening' });
  assert.equal(r.added, true);
  assert.match(r.event.id, /^agent-[0-9a-f-]{36}$/);
  assert.equal(r.event.source, 'agent');
  assert.equal(r.event.title, 'Started magnesium');
  assert.deepEqual(r.event.tags, ['magnesium']);
  assert.deepEqual(fs.readdirSync(DIR).sort(), [...before, ev.AGENT_EVENTS_FILE].sort(), 'exactly one new file');
  assert.deepEqual(fs.readFileSync(path.join(DIR, 'health-events.json')), appBytes, 'the app file is untouched');
  assert.deepEqual(leftovers(), [], 'no temp or lock file left behind');
  const file = agentFile();
  assert.equal(file.schema, 1);
  assert.equal(file.writer, 'health-export-mcp');
  assert.ok(Number.isFinite(Date.parse(file.writtenAt)));
  assert.equal(file.events.length, 1);
  assert.equal(file.events[0].source, undefined, 'source is a read-time label, never stored');
  assert.ok(Number.isFinite(Date.parse(file.events[0].createdAt)));
  assert.equal((fs.statSync(path.join(DIR, ev.AGENT_EVENTS_FILE)).mode & 0o777), 0o600);

  const l = await ev.listEvents({});
  assert.equal(l.count, 2);
  assert.deepEqual(l.events.map((e) => [e.id.startsWith('agent-') ? 'agent' : e.id, e.source]), [['e-visit', 'app'], ['agent', 'agent']]);
  assert.equal((await ev.listEvents({ type: 'medication' })).count, 1);
  const s = await store.status();
  assert.equal(s.contextFiles.events, true);
  assert.equal(s.contextFiles.agentEvents, true);
});

test('agent events count everywhere events are read: anchors, filterDays and segment boundaries', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  const { event } = await ev.addEvent({ date: dayOffset(6), type: 'habit', title: 'Stopped late coffee' });
  const l = await ev.listEvents({});
  assert.equal(l.available, true, 'available with only the agent file present');
  const cp = await store.comparePeriods({ metric: 'heart_rate_variability', anchor: { eventId: event.id, days: 3 } });
  assert.equal(cp.anchor.eventId, event.id);
  assert.equal(cp.anchor.source, 'agent');
  const fd = await store.getHealthMetrics({ metric: 'step_count', filterDays: { eventType: 'habit' } });
  assert.equal(fd.filterDays.matchedEventDays, 1);
  const hm = await store.getHealthMetrics({ metric: 'step_count' });
  assert.deepEqual(hm.step_count.segmentBoundaries.map((b) => b.date), [dayOffset(6)]);
});

test('add_event is idempotent: the same clientEventId, or the same content without one, adds nothing', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  const a = await ev.addEvent({ date: dayOffset(3), type: 'visit', title: 'Dentist', clientEventId: 'k-1' });
  const b = await ev.addEvent({ date: dayOffset(3), type: 'visit', title: 'Dentist again', clientEventId: 'k-1' });
  assert.equal(b.added, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.event.id, a.event.id);
  const c = await ev.addEvent({ date: dayOffset(2), type: 'travel', title: 'Lisbon', endDate: dayOffset(1) });
  const d = await ev.addEvent({ date: dayOffset(2), type: 'travel', title: 'Lisbon', endDate: dayOffset(1) });
  assert.equal(d.duplicate, true);
  assert.equal(d.event.id, c.event.id);
  const e = await ev.addEvent({ date: dayOffset(2), type: 'travel', title: 'Lisbon', endDate: dayOffset(1), clientEventId: 'second-trip' });
  assert.equal(e.added, true, 'a distinct clientEventId logs a second one on purpose');
  assert.equal(agentFile().events.length, 3);
});

test('add_event validates strictly and writes nothing on a bad call', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  const ok = { date: dayOffset(1), type: 'habit', title: 'x' };
  const bad = [
    [{ type: 'habit', title: 'x' }, /date is required/],
    [{ ...ok, date: '2026-13-01' }, /date must be YYYY-MM-DD|not a real date/],
    [{ ...ok, date: 'yesterday' }, /date must be YYYY-MM-DD/],
    [{ ...ok, type: 'Medication' }, /type must be one of medication, habit/],
    [{ ...ok, type: undefined }, /type must be one of/],
    [{ ...ok, title: '   ' }, /title is required/],
    [{ ...ok, title: 'y'.repeat(201) }, /title is 201 characters; the limit is 200/],
    [{ ...ok, endDate: dayOffset(3) }, /endDate .* is before date/],
    [{ ...ok, tags: 'magnesium' }, /tags must be an array/],
    [{ ...ok, tags: ['ok', 7] }, /tags\[1\] must be a string/],
    [{ ...ok, id: 'agent-mine' }, /add_event does not take "id"/],
    [{ ...ok, source: 'app' }, /does not take "source"/],
    [{ ...ok, note: 'n'.repeat(2001) }, /note is 2001 characters/],
  ];
  for (const [args, re] of bad) await assert.rejects(ev.addEvent(args), re, JSON.stringify(args).slice(0, 80));
  assert.equal(fs.existsSync(path.join(DIR, ev.AGENT_EVENTS_FILE)), false);
});

test('remove_event removes only agent events, refuses app events, and is a no-op the second time', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  put('health-events.json', APP_EVENTS);
  const { event } = await ev.addEvent({ date: dayOffset(4), type: 'life', title: 'Moved house' });
  await assert.rejects(ev.removeEvent({ id: 'e-visit' }), /not an agent-logged event.*edited or deleted in the app/);
  await assert.rejects(ev.removeEvent({}), /id is required/);
  await assert.rejects(ev.removeEvent({ id: event.id, force: true }), /takes only "id"/);
  const r = await ev.removeEvent({ id: event.id });
  assert.equal(r.removed, true);
  assert.equal(r.event.title, 'Moved house');
  assert.deepEqual(agentFile().events, []);
  const again = await ev.removeEvent({ id: event.id });
  assert.equal(again.removed, false);
  assert.match(again.note, /Nothing was changed/);
  assert.equal((await ev.listEvents({})).count, 1, 'the app event is still there');
  assert.deepEqual(leftovers(), []);
});

test('the lock: a live lock makes a writer wait then fail cleanly; a crashed writer\'s lock is reclaimed', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  const lock = path.join(DIR, `.${ev.AGENT_EVENTS_FILE}.lock.nosync`);
  fs.writeFileSync(lock, '99999\n');
  const t0 = Date.now();
  await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /Another add_event or remove_event is writing/);
  assert.ok(Date.now() - t0 >= 2500, 'it waited for the live lock before giving up');
  assert.ok(fs.existsSync(lock), 'someone else\'s live lock is left alone');
  const old = (Date.now() - 31000) / 1000;
  fs.utimesSync(lock, old, old);
  const r = await ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' });
  assert.equal(r.added, true);
  assert.deepEqual(leftovers(), [], 'the reclaimed lock is released after the write');
});

test('a failed write leaves no temp file, releases the lock and changes nothing', async () => {
  clear();
  put('.health-cache.json', cache(), 1);
  // A directory where the file should be makes the final rename fail.
  fs.mkdirSync(path.join(DIR, ev.AGENT_EVENTS_FILE));
  fs.writeFileSync(path.join(DIR, ev.AGENT_EVENTS_FILE, 'keep'), 'x');
  await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /Could not write health-events-agent\.json .*Nothing was changed/);
  assert.deepEqual(leftovers(), []);
  assert.ok(fs.statSync(path.join(DIR, ev.AGENT_EVENTS_FILE)).isDirectory());
});

test('write tools refuse a folder with no export and a folder they cannot write', async (t) => {
  clear();
  await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /holds none \(no \.health-cache\.json\)/);
  put('.health-cache.json', cache(), 1);
  if (process.getuid?.() === 0) { t.skip('root ignores directory permissions'); return; }
  fs.chmodSync(DIR, 0o555);
  try {
    await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /is not writable by this server/);
    await assert.rejects(ev.removeEvent({ id: 'agent-x' }), /is not writable by this server/);
  } finally { fs.chmodSync(DIR, 0o755); }
});

test('an encrypted export: the agent file is sealed with the passphrase, and refused without one', async () => {
  clear();
  const PASS = 'correct horse battery staple';
  put('.health-cache.json', sealEnvelope(JSON.stringify(cache()), PASS, { iter: MIN_ITERATIONS }), 1);
  await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /encrypted and HEALTH_EXPORT_PASSPHRASE is not set.*will not write it in plaintext/);
  assert.equal(fs.existsSync(path.join(DIR, ev.AGENT_EVENTS_FILE)), false);
  process.env.HEALTH_EXPORT_PASSPHRASE = 'the wrong one';
  try {
    await assert.rejects(ev.addEvent({ date: dayOffset(1), type: 'habit', title: 'x' }), /add_event: .*different passphrase/);
    process.env.HEALTH_EXPORT_PASSPHRASE = PASS;
    const r = await ev.addEvent({ date: dayOffset(1), type: 'medication', title: 'Started iron' });
    assert.equal(r.added, true);
    const raw = agentFile();
    assert.ok(isEnvelope(raw), 'sealed on disk');
    assert.doesNotMatch(JSON.stringify(raw), /Started iron/);
    const l = await ev.listEvents({});
    assert.deepEqual(l.events.map((e) => [e.title, e.source]), [['Started iron', 'agent']]);
    assert.equal((await ev.removeEvent({ id: r.event.id })).removed, true);
  } finally { delete process.env.HEALTH_EXPORT_PASSPHRASE; }
});

// ---- over stdio, as an MCP client sees it --------------------------------------------------------

function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const pending = new Map(); let id = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const req = (method, params) => new Promise((resolve, reject) => {
    const my = ++id; pending.set(my, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    setTimeout(() => { if (pending.has(my)) { pending.delete(my); reject(new Error(`timeout ${method}`)); } }, 20000);
  });
  const call = async (name, args = {}) => {
    const r = await req('tools/call', { name, arguments: args });
    return { data: r.result?.structuredContent, isError: r.result?.isError, text: r.result?.content?.[0]?.text ?? '' };
  };
  return {
    req, call,
    init: () => req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'export-integrity', version: '1' } }),
    stop() { try { proc.kill(); } catch {} },
  };
}

test('over stdio: 18 tools, the two writers annotated honestly, and an add/list/remove round trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-347-stdio-'));
  fs.writeFileSync(path.join(dir, '.health-cache.json'), JSON.stringify(cache()));
  fs.writeFileSync(path.join(dir, 'health-sessions.json'), JSON.stringify(sessionsFile([night(2), night(1)])));
  const s = startServer({ HEALTH_DATA_DIR: dir });
  try {
    await s.init();
    const tools = (await s.req('tools/list')).result.tools;
    assert.equal(tools.length, 18);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(by.add_event.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(by.remove_event.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(by.add_event.inputSchema.required, ['date', 'type', 'title']);
    assert.deepEqual(by.add_event.inputSchema.properties.type.enum, ev.KNOWN_EVENT_TYPES);
    for (const t of tools.filter((x) => !['add_event', 'remove_event'].includes(x.name))) {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name} stays read-only`);
    }

    const added = await s.call('add_event', { date: dayOffset(3), type: 'medication', title: 'Started magnesium', clientEventId: 'jose-1' });
    assert.equal(added.isError, false);
    assert.equal(added.data.added, true);
    const listed = await s.call('list_events');
    assert.deepEqual(listed.data.events.map((e) => e.source), ['agent']);
    const bad = await s.call('add_event', { date: dayOffset(3), type: 'nap', title: 'x' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /type must be one of/);
    const removed = await s.call('remove_event', { id: added.data.event.id });
    assert.equal(removed.data.removed, true);

    // R1a without a manifest: 2 nights, neither ending today. Advisory only.
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.freshness.state, 'fresh');
    assert.equal(st.data.freshness.sessions_last_night, 'absent');
  } finally { s.stop(); }
});

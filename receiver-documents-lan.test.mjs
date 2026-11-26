// Typed documents over the LAN receiver (workouts, events, time zones, sleep sessions): the app's typed document is sanitised, merged by HealthKit id into
// .health-workouts-cache.json and read by the MCP server's workout reader. Until 1.12 the LAN path
// carried no workouts, so an agent fed only by the receiver never saw a run (reported 2026-11-26 with
// years of Strava runs to backfill).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-lan-workouts-'));
process.env.HEALTH_DATA_DIR = DIR;
const { startReceiver, sanitizeWorkouts, mergeWorkouts, workoutKey, WORKOUTS_FILE } = await import('./receiver.mjs');
const store = await import('./healthstore.mjs');

const TOKEN = 'PAIR-CODE-W';
const PORT = 27391;
const server = startReceiver({ dir: DIR, host: '127.0.0.1', port: PORT, token: TOKEN });
after(() => server.close());

const run = (id, start, km, extra = {}) => ({
  id, source: 'Strava', name: 'Running', activityType: 37, start,
  end: start.replace('T08:00', 'T08:30'), duration: 1800, distanceMeters: km * 1000, ...extra,
});
const doc = (workouts) => ({ type: 'workouts', schema: 1, id: 'msg-' + Math.random(), app: 'MetricBridge', sentAt: new Date().toISOString(), data: { workouts } });

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/health-cache', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-token': TOKEN, 'content-length': Buffer.byteLength(data), host: '127.0.0.1' } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject); req.end(data);
  });
}
const onDisk = () => JSON.parse(fs.readFileSync(path.join(DIR, WORKOUTS_FILE), 'utf8'));

test('history arriving in pieces accumulates, and a resent run lands once', async () => {
  let r = await post(doc([run('A', '2019-04-07T08:00:00Z', 5), run('B', '2019-04-14T08:00:00Z', 10)]));
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'workouts');
  assert.equal(r.body.workouts, 2);
  r = await post(doc([run('C', '2024-06-01T08:00:00Z', 21.1)]));
  assert.equal(r.body.workouts, 3, 'a later batch adds to the file, it does not replace it');
  r = await post(doc([run('B', '2019-04-14T08:00:00Z', 10.2)]));   // corrected re-send of B
  assert.equal(r.body.workouts, 3, 'same id: replaced, not duplicated');
  const all = onDisk();
  assert.deepEqual(all.map((w) => w.id), ['A', 'B', 'C'], 'oldest first');
  assert.equal(all.find((w) => w.id === 'B').distanceMeters, 10200);
  // The daily summary file is untouched by a workouts document.
  assert.ok(!fs.existsSync(path.join(DIR, '.health-cache.json')));
});

test('the MCP server reads what the receiver wrote', async () => {
  const w = await store.loadWorkouts();
  assert.equal(w.length, 3);
  assert.equal(w[2].name, 'Running');
});

test('sanitiser: scalar fields only, one level of alsoRecordedBy, records need a start', () => {
  const [clean] = sanitizeWorkouts(doc([{
    ...run('X', '2023-01-01T08:00:00Z', 5),
    route: [{ lat: 1, lon: 2 }], 'bad key': 'x', notes: 'n'.repeat(500), nested: { a: 1 },
    alsoRecordedBy: [{ ...run('Y', '2023-01-01T08:00:00Z', 5), source: 'Apple Watch', alsoRecordedBy: [{ id: 'Z' }] }],
  }]));
  assert.equal(clean.route, undefined);
  assert.equal(clean['bad key'], undefined);
  assert.equal(clean.nested, undefined);
  assert.equal(clean.notes.length, 200);
  assert.equal(clean.alsoRecordedBy[0].source, 'Apple Watch');
  assert.equal(clean.alsoRecordedBy[0].alsoRecordedBy, undefined, 'one level only');
  assert.equal(sanitizeWorkouts(doc([{ id: 'nostart' }, null, 7, 'x'])).length, 0);
  assert.equal(sanitizeWorkouts({ type: 'workouts' }).length, 0);
});

test('identity matches the app: id first, start|type for records without one', () => {
  assert.equal(workoutKey({ id: 'U', start: 's' }), 'U');
  assert.equal(workoutKey({ start: '2020-01-01T00:00:00Z', type: 'Running' }), '2020-01-01T00:00:00Z|Running');
  const merged = mergeWorkouts([{ start: '2020-01-01T00:00:00Z', type: 'Running', v: 1 }], [{ start: '2020-01-01T00:00:00Z', type: 'Running', v: 2 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].v, 2);
});

test('a wrong token is refused before anything is written', async () => {
  const data = JSON.stringify(doc([run('EVIL', '2020-01-01T08:00:00Z', 1)]));
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/health-cache', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-token': 'nope', host: '127.0.0.1' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(data);
  });
  assert.equal(status, 401);
  assert.ok(!onDisk().some((w) => w.id === 'EVIL'));
});

// ---- sleep.sessions, timezone.changes, events: the webhook's context documents over LAN ----------
const { cleanContext, EVENTS_FILE, DAYS_FILE, SESSIONS_FILE } = await import('./receiver.mjs');
const env = (type, data) => ({ type, schema: 1, id: 'm-' + Math.random(), app: 'MetricBridge 1.26 (300)', sentAt: new Date().toISOString(), data: { metrics: [], ...data } });
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('events replace health-events.json whole, in the app file shape', async () => {
  let r = await post(env('events', { events: { mode: 'replace', events: [{ id: 'e1', date: '2026-11-01', type: 'travel', title: 'Lisbon' }, { id: 'e2', date: '2026-11-10', type: 'illness', title: 'Cold' }] } }));
  assert.equal(r.status, 200); assert.equal(r.body.count, 2);
  r = await post(env('events', { events: { mode: 'replace', events: [{ id: 'e2', date: '2026-11-10', type: 'illness', title: 'Cold' }] } }));
  const f = read(EVENTS_FILE);
  assert.equal(f.schema, 1); assert.deepEqual(f.events.map((e) => e.id), ['e2'], 'a deleted event disappears');
});

test('timezone.changes replace health-days.json without the mode marker', async () => {
  const r = await post(env('timezone.changes', { timeZones: { mode: 'replace', currentTz: 'Europe/London', changes: [{ from: '2026-11-01', tz: 'Europe/Lisbon', utcOffsetMin: 0 }], note: 'n' } }));
  assert.equal(r.status, 200);
  const f = read(DAYS_FILE);
  assert.equal(f.currentTz, 'Europe/London'); assert.equal(f.changes.length, 1); assert.equal(f.mode, undefined);
});

test('sleep.sessions replace exactly the covered waking days', async () => {
  const s = (day, start, h) => ({ day, start, end: start, hours: h, nap: false, tz: 'Europe/London', segments: [{ stage: 'deep', start, end: start, source: 'com.apple.health' }] });
  await post(env('sleep.sessions', { coverage: { fromDay: '2026-11-01', toDay: '2026-11-03', mode: 'replace_days' }, sleepSessions: [s('2026-11-01', '2026-10-31T23:00:00+00:00', 7), s('2026-11-02', '2026-11-01T23:00:00+00:00', 6), s('2026-11-03', '2026-11-02T23:00:00+00:00', 8)] }));
  // A later resend of the 2nd only: the 2nd is replaced, the 1st and 3rd stay.
  const r = await post(env('sleep.sessions', { coverage: { fromDay: '2026-11-02', toDay: '2026-11-02', mode: 'replace_days' }, sleepSessions: [s('2026-11-02', '2026-11-01T23:30:00+00:00', 6.5)] }));
  assert.equal(r.status, 200);
  const f = read(SESSIONS_FILE);
  assert.deepEqual(f.sessions.map((x) => [x.day, x.hours]), [['2026-11-01', 7], ['2026-11-02', 6.5], ['2026-11-03', 8]]);
  assert.equal(f.sessions[1].segments[0].stage, 'deep');
  const bad = await post(env('sleep.sessions', { sleepSessions: [] }));
  assert.equal(bad.status, 400, 'no coverage: refused, nothing replaced');
});

test('context values are cleaned: bad keys, long strings, deep nesting and non-finite numbers are dropped', () => {
  const c = cleanContext({ ok: 'x'.repeat(900), 'bad key': 1, n: Infinity, deep: { a: { b: { c: { d: { e: 1 } } } } }, list: [1, 'a', null] });
  assert.equal(c.ok.length, 500); assert.equal(c['bad key'], undefined); assert.equal(c.n, undefined);
  assert.deepEqual(c.list, [1, 'a']); assert.equal(c.deep.a.b.c.d, undefined);
});

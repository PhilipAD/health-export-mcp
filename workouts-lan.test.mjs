// `workouts` over the LAN receiver: the app's typed document is sanitised, merged by HealthKit id into
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

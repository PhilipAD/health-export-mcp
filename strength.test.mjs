// get_strength_log over health-strength.json (docs/SCHEMA-CONTRACTS.md section 14): the strength
// log the user types into the iOS app, exported only when they switch it on. Zero-dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-strength-'));
process.env.HEALTH_DATA_DIR = DIR;
const ev = await import('./events.mjs');
const FILE = path.join(DIR, 'health-strength.json');

// The shape StrengthStore.exportPayload writes (Tests/StrengthExportTests.swift pins the app side).
const set = (reps, kg, kind = 'working', rpe) => ({ reps, ...(kg != null && { kg }), kind, ...(rpe != null && { rpe }) });
const FIXTURE = {
  schema: 1, app: '1.17', writtenAt: '2026-10-28T19:00:00Z', unit: 'kg', formula: 'strength-v1',
  sessions: [
    { id: 's1', start: '2026-10-01T18:00:00+01:00', day: '2026-10-01', volumeKg: 1200, workingSets: 3, minutes: 50, effort: 7,
      exercises: [{ name: 'Back squat', volumeKg: 1200, bestEstimateKg: 93.3, sets: [set(8, 40, 'warmup'), set(5, 80, 'working', 8), set(5, 80), set(5, 80)] }] },
    { id: 's2', start: '2026-10-08T18:00:00+01:00', day: '2026-10-08', volumeKg: 2130, workingSets: 6,
      exercises: [
        { name: 'Back squat', volumeKg: 1237.5, bestEstimateKg: 96.3, sets: [set(5, 82.5), set(5, 82.5), set(5, 82.5)] },
        { name: 'Pull-up', volumeKg: 0, sets: [set(8), set(8), set(8)] },
        { name: 'Bench press', volumeKg: 892.5, bestEstimateKg: 70.2, sets: [set(6, 58.5), set(6, 58.5), set(6, 58.5)] },
      ] },
    { id: 's3', start: '2026-10-15T07:30:00+01:00', day: '2026-10-15', volumeKg: 960, workingSets: 3,
      exercises: [{ name: 'Bench press', volumeKg: 960, bestEstimateKg: 74.7, sets: [set(5, 64), set(5, 64), set(5, 64)] }] },
  ],
  records: [
    { exercise: 'Bench press', bestEstimateKg: 74.7, bestEstimateDay: '2026-10-15', heaviestKg: 64, sessions: 2, lastDay: '2026-10-15' },
    { exercise: 'Back squat', bestEstimateKg: 96.3, bestEstimateDay: '2026-10-08', heaviestKg: 82.5, sessions: 2, lastDay: '2026-10-08' },
    { exercise: 'Pull-up', sessions: 1, lastDay: '2026-10-08' },
  ],
};
// readJSONCached memoizes on (mtime, size): give every rewrite a distinct mtime.
let tick = 0;
function write(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj));
  const t = new Date(Date.UTC(2026, 9, 1) + ++tick * 1000);
  fs.utimesSync(FILE, t, t);
}

test('absent file answers available:false, never "no training"', async () => {
  fs.rmSync(FILE, { force: true });
  const r = await ev.getStrengthLog({});
  assert.equal(r.available, false);
  assert.match(r.note, /health-strength\.json/);
  assert.match(r.note, /off by default/i);
  assert.match(r.note, /not that nothing happened/);
});

test('every session oldest first, sets as exported, records and notes attached', async () => {
  write(FIXTURE);
  const r = await ev.getStrengthLog({});
  assert.equal(r.available, true);
  assert.equal(r.unit, 'kg');
  assert.equal(r.formula, 'strength-v1');
  assert.equal(r.count, 3);
  assert.deepEqual(r.sessions.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(r.sessions[0].exercises[0].sets[0], { reps: 8, kg: 40, kind: 'warmup' });
  assert.equal(r.records.length, 3);
  assert.deepEqual(r.exercises, [
    { name: 'Back squat', sessions: 2 }, { name: 'Bench press', sessions: 2 }, { name: 'Pull-up', sessions: 1 },
  ]);
  assert.match(r.note, /never a load to attempt/);
  assert.match(r.note, /never read from Apple Health/);
  assert.equal(r.sessionsOmitted, undefined);
});

test('exercise filter is exact, case-insensitive, and trims each session to that exercise', async () => {
  write(FIXTURE);
  const r = await ev.getStrengthLog({ exercise: '  bench PRESS ' });
  assert.equal(r.count, 2);
  assert.deepEqual(r.sessions.map((s) => s.id), ['s2', 's3']);
  for (const s of r.sessions) assert.deepEqual(s.exercises.map((e) => e.name), ['Bench press']);
  assert.equal(r.sessions[0].volumeKg, 2130, 'session totals stay whole-session, and the note says so');
  assert.match(r.note, /session-level volumeKg and workingSets still cover the whole session/);
  assert.deepEqual(r.records.map((x) => x.exercise), ['Bench press']);
  // "Bench" is not "Bench press": no fuzzy match that could merge two different lifts.
  const partial = await ev.getStrengthLog({ exercise: 'Bench' });
  assert.equal(partial.count, 0);
});

test('an unknown exercise returns count 0 with the names in the log', async () => {
  write(FIXTURE);
  const r = await ev.getStrengthLog({ exercise: 'Deadlift' });
  assert.equal(r.available, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.sessions, []);
  assert.deepEqual(r.knownExercises, ['Back squat', 'Bench press', 'Pull-up']);
  assert.match(r.note, /No session includes an exercise named "Deadlift"/);
});

test('start and end filter by local day, inclusive; records stay all-time', async () => {
  write(FIXTURE);
  const r = await ev.getStrengthLog({ start: '2026-10-08', end: '2026-10-15' });
  assert.deepEqual(r.sessions.map((s) => s.id), ['s2', 's3']);
  assert.equal(r.records.length, 3);
  assert.match(r.recordsNote, /all-time/);
  const one = await ev.getStrengthLog({ exercise: 'back squat', start: '2026-10-02' });
  assert.deepEqual(one.sessions.map((s) => s.id), ['s2']);
});

test('bad arguments are refused, not guessed', async () => {
  write(FIXTURE);
  await assert.rejects(ev.getStrengthLog({ start: '2026-10-15', end: '2026-10-01' }), /after end/);
  await assert.rejects(ev.getStrengthLog({ start: '15/10/2026' }), /YYYY-MM-DD/);
  await assert.rejects(ev.getStrengthLog({ exercise: 42 }), /exercise must be a string/);
});

test('over 150 matching sessions, the newest 150 are listed and the rest counted', async () => {
  const many = Array.from({ length: 160 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return { id: `m${i}`, start: `${day}T18:00:00Z`, day, volumeKg: 400, workingSets: 1,
      exercises: [{ name: 'Deadlift', volumeKg: 400, bestEstimateKg: 120, sets: [set(3, 120)] }] };
  });
  write({ ...FIXTURE, sessions: many, records: [] });
  const r = await ev.getStrengthLog({});
  assert.equal(r.count, 160);
  assert.equal(r.sessions.length, 150);
  assert.equal(r.sessionsOmitted, 10);
  assert.equal(r.sessions[0].id, 'm10');
  assert.equal(r.sessions.at(-1).id, 'm159');
  assert.deepEqual(r.exercises, [{ name: 'Deadlift', sessions: 160 }], 'counts cover every match, omitted ones too');
});

test('a malformed file reads as unavailable, and malformed rows are skipped', async () => {
  write({ schema: 1, sessions: 'nope' });
  assert.equal((await ev.getStrengthLog({})).available, false);
  write({ ...FIXTURE, sessions: [null, { id: 'x' }, ...FIXTURE.sessions] });
  assert.equal((await ev.getStrengthLog({})).count, 3);
});

test('routines ride along: listed in order, filtered by exercise, empty for an older file', async () => {
  const routines = [
    { id: 'r1', name: 'Squat day', createdAt: '2026-09-01T10:00:00Z', lastUsedDay: '2026-10-08',
      exercises: [{ name: 'Back squat', sets: [set(8, 40, 'warmup'), set(5, 80)] }, { name: 'Pull-up', sets: [set(8)] }] },
    { id: 'r2', name: 'Upper body', createdAt: '2026-09-02T10:00:00Z',
      exercises: [{ name: 'Bench press', sets: [set(6, 60), set(6, 60)] }, { name: 'Face pull', sets: [set(15, 10)] }] },
  ];
  write({ ...FIXTURE, sessions: FIXTURE.sessions.map((s) => (s.id === 's2' ? { ...s, routineId: 'r1' } : s)), routines });
  const all = await ev.getStrengthLog({});
  assert.deepEqual(all.routines.map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(all.routines[0].exercises[1].sets[0], { reps: 8, kind: 'working' });
  assert.equal(all.sessions[1].routineId, 'r1');
  assert.match(all.routinesNote, /not a programme the app recommends/);
  const squat = await ev.getStrengthLog({ exercise: 'back SQUAT', start: '2026-10-15' });
  assert.deepEqual(squat.routines.map((r) => r.id), ['r1'], 'routines are filtered by exercise, never by date');
  // An exercise only planned in a routine is known, and the note says it is planned, not logged.
  const planned = await ev.getStrengthLog({ exercise: 'face pull' });
  assert.equal(planned.count, 0);
  assert.deepEqual(planned.routines.map((r) => r.id), ['r2']);
  assert.ok(planned.knownExercises.includes('Face pull'), 'routine-only names are listed');
  assert.match(planned.note, /planned in 1 saved routine \(listed in routines\) but not logged yet/);
  const unknown = await ev.getStrengthLog({ exercise: 'Leg press' });
  assert.doesNotMatch(unknown.note, /planned in/);
  write(FIXTURE);
  assert.deepEqual((await ev.getStrengthLog({})).routines, []);
});

test('tools/list declares get_strength_log read-only, and the demo dataset answers it', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'server.mjs'), '--demo'], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_strength_log', arguments: { exercise: 'Back squat' } } },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
  });
  const [list, call] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const tool = list.result.tools.find((t) => t.name === 'get_strength_log');
  assert.ok(tool, 'get_strength_log is listed');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['end', 'exercise', 'start']);
  const text = call.result.content[0].text;
  assert.match(text, /^\[SYNTHETIC DEMO DATA\]/);
  const data = JSON.parse(text.replace(/^\[SYNTHETIC DEMO DATA\]\s*/, ''));
  assert.equal(data.available, true);
  assert.equal(data.count, 9);
  // 80 kg + 2.5 kg a week for three weeks: the last session is 85 kg × 5, Epley 99.2.
  assert.equal(data.sessions.at(-1).exercises[0].bestEstimateKg, 99.2);
  assert.equal(data.records[0].bestEstimateKg, 99.2);
});

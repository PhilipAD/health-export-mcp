// Tests for health-sessions.json (sleep sessions, waking-day attribution, split nights) and
// health-cycles.json (day-in-cycle and coarse phase, derived from observed starts only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-sess-'));
process.env.HEALTH_DATA_DIR = DIR;

const ev = await import('./events.mjs');

test('absent sessions file answers available:false', async () => {
  const out = await ev.getSleepSessions({});
  assert.equal(out.available, false);
  assert.match(out.note, /health-sessions\.json/);
});

test('absent cycles file answers available:false', async () => {
  const out = await ev.getCycleContext({});
  assert.equal(out.available, false);
  assert.match(out.note, /health-cycles\.json/);
});

test('sessions filter by waking day and split nights come back as-is', async () => {
  // Two ordinary nights plus a SPLIT night: day 2026-08-19 carries the main session and a short
  // morning return to bed. The reader must return both, untouched. Written inside the test, not
  // at module level, so the absent-file tests above actually see an absent file.
  fs.writeFileSync(path.join(DIR, 'health-sessions.json'), JSON.stringify({
    schema: 1, writtenAt: '2026-08-19T10:00:00Z',
    sessions: [
      { start: '2026-08-16T23:04:00+01:00', end: '2026-08-17T06:52:00+01:00', day: '2026-08-17', hours: 7.8,
        stages: { core: 4.1, deep: 1.2, rem: 1.9, awake: 0.6 } },
      { start: '2026-08-17T23:30:00+01:00', end: '2026-08-18T06:10:00+01:00', day: '2026-08-18', hours: 6.7 },
      { start: '2026-08-18T23:15:00+01:00', end: '2026-08-19T05:20:00+01:00', day: '2026-08-19', hours: 6.1 },
      { start: '2026-08-19T06:00:00+01:00', end: '2026-08-19T07:30:00+01:00', day: '2026-08-19', hours: 1.5 },
    ],
  }));
  const all = await ev.getSleepSessions({});
  assert.equal(all.available, true);
  assert.equal(all.count, 4);
  assert.match(all.note, /WAKING day/);
  assert.match(all.note, /split night/);
  const split = await ev.getSleepSessions({ day: '2026-08-19' });
  assert.equal(split.count, 2, 'both sessions of the split night belong to the same waking day');
  assert.deepEqual(split.sessions.map((s) => s.hours), [6.1, 1.5]);
  // Stage data survives when present and is simply absent when it was not recorded.
  const withStages = await ev.getSleepSessions({ day: '2026-08-17' });
  assert.equal(withStages.sessions[0].stages.deep, 1.2);
  const without = await ev.getSleepSessions({ day: '2026-08-18' });
  assert.equal('stages' in without.sessions[0], false);
});

test('start/end range filters on the waking day, not the clock time', async () => {
  // The 08-17 session STARTED on 08-16; a range beginning 08-17 must still include it.
  const out = await ev.getSleepSessions({ start: '2026-08-17', end: '2026-08-18' });
  assert.deepEqual(out.sessions.map((s) => s.day), ['2026-08-17', '2026-08-18']);
});

test('day-in-cycle and phase derive from the OBSERVED midpoint of a completed cycle', async () => {
  // Cycle fixture: two completed cycles (28 and 29 days) and an ongoing third. Written here so
  // the absent-file test above ran against a genuinely absent file.
  fs.writeFileSync(path.join(DIR, 'health-cycles.json'), JSON.stringify({
    schema: 1, writtenAt: '2026-08-19T10:00:00Z',
    cycleStarts: ['2026-06-02', '2026-06-30', '2026-07-29'],
  }));
  // Cycle 2026-06-02 .. 2026-06-29 is 28 days; midpoint 14.
  const d14 = await ev.getCycleContext({ date: '2026-06-15' });
  assert.equal(d14.context.dayInCycle, 14);
  assert.equal(d14.context.phase, 'follicular');
  assert.equal(d14.context.observedCycleLengthDays, 28);
  const d15 = await ev.getCycleContext({ date: '2026-06-16' });
  assert.equal(d15.context.dayInCycle, 15);
  assert.equal(d15.context.phase, 'luteal');
});

test('the ongoing cycle has no observed length and falls back to day 14', async () => {
  const early = await ev.getCycleContext({ date: '2026-08-10' });
  assert.equal(early.context.cycleStart, '2026-07-29');
  assert.equal(early.context.dayInCycle, 13);
  assert.equal(early.context.phase, 'follicular');
  assert.equal(early.context.observedCycleLengthDays, null);
  assert.equal(early.context.ongoing, true);
  const later = await ev.getCycleContext({ date: '2026-08-15' });
  assert.equal(later.context.dayInCycle, 18);
  assert.equal(later.context.phase, 'luteal');
});

test('a date before the first logged start yields no context, honestly', async () => {
  const out = await ev.getCycleContext({ date: '2026-05-01' });
  assert.equal(out.available, true);
  assert.equal(out.context, null);
  assert.match(out.note, /before the first logged cycle start/);
});

test('every cycle answer states it is derived from logged periods, not predictive', async () => {
  for (const args of [{}, { date: '2026-06-15' }, { date: '2026-05-01' }]) {
    const out = await ev.getCycleContext(args);
    assert.match(JSON.stringify(out), /not predictive/);
  }
});

test('the default answer walks the last cycle per day from day 1', async () => {
  const out = await ev.getCycleContext({});
  assert.equal(out.lastCycle.start, '2026-07-29');
  assert.ok(out.lastCycle.days.length >= 1);
  assert.equal(out.lastCycle.days[0].dayInCycle, 1);
  assert.equal(out.lastCycle.days[0].phase, 'follicular');
});

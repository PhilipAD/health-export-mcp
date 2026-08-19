// Tests for the health-events.json reader: absence semantics, filters, ordering, unknown-type
// passthrough, and the pairing gate. These paths exist because an events file is OPTIONAL and the
// difference between "not exported" and "nothing happened" is the whole point of the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-events-'));
process.env.HEALTH_DATA_DIR = DIR;

// A small daily cache so healthstore's data tools have something to stand on.
const cache = {
  heart_rate_variability: {
    unit: 'ms', cumulative: false,
    daily: Array.from({ length: 30 }, (_, i) => ({ d: `2026-07-${String(i + 1).padStart(2, '0')}`, v: 50 + i })),
  },
};
fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify(cache));

const ev = await import('./events.mjs');
const store = await import('./healthstore.mjs');

test('absent file answers available:false with an absence note, never "no data"', async () => {
  const out = await ev.listEvents({});
  assert.equal(out.available, false);
  assert.match(out.note, /health-events\.json/);
  assert.match(out.note, /not that nothing happened/);
  assert.doesNotMatch(out.note, /no data/i);
});

test('filterDays with no events file is a loud error, not an empty match', async () => {
  await assert.rejects(
    () => store.getHealthMetrics({ metric: 'heart_rate_variability', filterDays: { eventType: 'shift' } }),
    /health-events\.json/);
});

test('anchor with no events file is a loud error', async () => {
  await assert.rejects(
    () => store.comparePeriods({ metric: 'heart_rate_variability', anchor: { eventId: 'x', days: 7 } }),
    /health-events\.json/);
});

// Written OUT of date order on purpose: the reader must sort ascending regardless. Written INSIDE
// the first test that needs it: module-level writes run before ANY test does, which would silently
// defeat the absent-file tests above.
const EVENTS = {
  schema: 1, app: '1.5', writtenAt: '2026-07-30T10:00:00Z',
  events: [
    { id: 'e-shift', date: '2026-07-10', endDate: '2026-07-12', type: 'shift', title: 'Night block', tags: ['nights'] },
    { id: 'e-med', date: '2026-07-05', type: 'medication', title: 'Started propranolol', tags: ['propranolol'] },
    // An event type this server has never heard of, with an extra key: both must survive untouched.
    { id: 'e-new', date: '2026-07-20', type: 'infusion', title: 'Iron infusion', clinic: 'St Mary' },
    { id: 'e-visit', date: '2026-07-15', type: 'visit', title: 'GP review', tags: ['gp'] },
  ],
};

test('events come back sorted ascending by date', async () => {
  fs.writeFileSync(path.join(DIR, 'health-events.json'), JSON.stringify(EVENTS));
  const out = await ev.listEvents({});
  assert.equal(out.available, true);
  assert.equal(out.count, 4);
  assert.deepEqual(out.events.map((e) => e.id), ['e-med', 'e-shift', 'e-visit', 'e-new']);
});

test('unknown event types pass through unharmed, extra keys intact', async () => {
  const out = await ev.listEvents({ type: 'infusion' });
  assert.equal(out.count, 1);
  assert.equal(out.events[0].type, 'infusion');
  assert.equal(out.events[0].clinic, 'St Mary');   // no allowlist stripped the record
});

test('type and tag filters match exactly', async () => {
  assert.equal((await ev.listEvents({ type: 'medication' })).count, 1);
  assert.equal((await ev.listEvents({ tag: 'nights' })).count, 1);
  assert.equal((await ev.listEvents({ type: 'medication', tag: 'nights' })).count, 0);
});

test('an empty match on a present file says so, distinct from an absent file', async () => {
  const out = await ev.listEvents({ type: 'travel' });
  assert.equal(out.available, true);
  assert.equal(out.count, 0);
  assert.match(out.note, /file is present/);
});

test('a range event matches a window it overlaps, not only one it starts in', async () => {
  // Window covers only the TAIL of the shift block (starts 07-10, window starts 07-11).
  const out = await ev.listEvents({ start: '2026-07-11', end: '2026-07-13' });
  assert.deepEqual(out.events.map((e) => e.id), ['e-shift']);
});

test('date filters reject malformed dates like the daily tools do', async () => {
  await assert.rejects(() => ev.listEvents({ start: 'last tuesday' }), /YYYY-MM-DD/);
  await assert.rejects(() => ev.listEvents({ start: '2026-07-10', end: '2026-07-01' }), /is after end/);
});

test('eventDays covers endDate ranges inclusively and point events as one day', () => {
  assert.deepEqual(ev.eventDays({ date: '2026-07-10', endDate: '2026-07-12' }),
    ['2026-07-10', '2026-07-11', '2026-07-12']);
  assert.deepEqual(ev.eventDays({ date: '2026-07-05' }), ['2026-07-05']);
});

test('a rewritten events file invalidates the memo', async () => {
  const p = path.join(DIR, 'health-events.json');
  const next = JSON.parse(fs.readFileSync(p, 'utf8'));
  next.events.push({ id: 'e-life', date: '2026-07-25', type: 'life', title: 'Moved house' });
  fs.writeFileSync(p, JSON.stringify(next));
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(p, t, t);   // same-second same-size rewrites would otherwise look unchanged
  assert.equal((await ev.listEvents({})).count, 5);
});

test('the pairing gate covers events exactly like the cache', async () => {
  const hash = crypto.createHash('sha256').update('the-real-secret').digest('hex');
  fs.writeFileSync(path.join(DIR, '.health-pair.json'), JSON.stringify({ hash }));
  try {
    await assert.rejects(() => ev.listEvents({}), /Locked/);
    await assert.rejects(() => ev.getProfile(), /Locked/);
    await assert.rejects(() => ev.getSleepSessions({}), /Locked/);
    await assert.rejects(() => ev.getCycleContext({}), /Locked/);
  } finally {
    fs.rmSync(path.join(DIR, '.health-pair.json'));
  }
});

test('a corrupt events file degrades to available:false, not a crash', async () => {
  const p = path.join(DIR, 'health-events.json');
  fs.writeFileSync(p, '{not json');
  const t = Date.now() / 1000 + 10;
  fs.utimesSync(p, t, t);
  const out = await ev.listEvents({});
  assert.equal(out.available, false);
});

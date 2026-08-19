// Tests for the health-profile.json reader. The contract's core rule: a field the user did not
// enable is ABSENT, and absence must never be read as "none". Every answer restates that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-profile-'));
process.env.HEALTH_DATA_DIR = DIR;

const ev = await import('./events.mjs');

test('absent profile answers available:false and still teaches the absence rule', async () => {
  const out = await ev.getProfile();
  assert.equal(out.available, false);
  assert.match(out.note, /health-profile\.json/);
  assert.match(out.note, /withheld/);
  assert.match(out.note, /must not be read as "none"/);
});

test('present profile reports exactly the opted-in fields', async () => {
  fs.writeFileSync(path.join(DIR, 'health-profile.json'), JSON.stringify({
    schema: 1, writtenAt: '2026-08-19T10:00:00Z',
    fields: { conditions: ['migraine'], goals: ['sleep 7.5 hours'] },
  }));
  const out = await ev.getProfile();
  assert.equal(out.available, true);
  assert.deepEqual(out.presentFields.sort(), ['conditions', 'goals']);
  assert.deepEqual(out.fields.conditions, ['migraine']);
  // The withheld statement travels IN the payload, because a PDF or an agent strips context.
  assert.match(out.note, /withheld by the user or never enabled/);
  assert.match(out.note, /must not be read as "none"/);
});

test('fields this server does not know pass through unharmed', async () => {
  const p = path.join(DIR, 'health-profile.json');
  fs.writeFileSync(p, JSON.stringify({
    schema: 1, writtenAt: '2026-08-19T10:00:00Z',
    fields: { notes: 'training for a half marathon', bloodType: 'O+' },
  }));
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(p, t, t);
  const out = await ev.getProfile();
  assert.deepEqual(out.presentFields.sort(), ['bloodType', 'notes']);
  assert.equal(out.fields.bloodType, 'O+');
});

test('a corrupt profile degrades to available:false, not a crash', async () => {
  const p = path.join(DIR, 'health-profile.json');
  fs.writeFileSync(p, 'nope');
  const t = Date.now() / 1000 + 10;
  fs.utimesSync(p, t, t);
  assert.equal((await ev.getProfile()).available, false);
});

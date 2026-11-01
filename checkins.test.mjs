// get_check_ins (#401 item 22): the opt-in morning check-ins file. Absent is the default state and
// must read as "not shared"; present, the rows come back filtered by day with a summary computed
// only from valid ratings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-checkins-'));
process.env.HEALTH_DATA_DIR = DIR;
delete process.env.HEALTH_EXPORT_PASSPHRASE;
delete process.env.HEALTH_EXPORT_PASSPHRASE_FILE;
delete process.env.PAIRING_SECRET;
const ev = await import('./events.mjs');
const { TOOLS } = await import('./server.mjs');

const FILE = path.join(DIR, 'health-check-ins.json');

test('absent file: available false, and the note says it is opt-in and off by default', async () => {
  fs.rmSync(FILE, { force: true });
  const r = await ev.getCheckIns({});
  assert.equal(r.available, false);
  assert.match(r.note, /off by default/);
  assert.match(r.note, /not that nothing happened/);
});

test('rows are filtered by day, sorted, and summarised from valid ratings only', async () => {
  fs.writeFileSync(FILE, JSON.stringify({
    schema: 1, generatedAt: '2026-10-29T07:00:00Z',
    checkIns: [
      { date: '2026-10-28', feeling: 4, intention: 'Walk at lunch', intentionMet: true },
      { date: '2026-10-26', feeling: 2, note: 'Late night' },
      { date: '2026-10-27', feeling: 9 },                       // out of range: never averaged
      { date: '2026-10-29', feeling: 5, intention: 'Stretch' }, // intention not answered yet
      { date: '2026-10-20', feeling: 1 },
    ],
  }));
  const r = await ev.getCheckIns({ start: '2026-10-26', end: '2026-10-29' });
  assert.equal(r.available, true);
  assert.deepEqual(r.checkIns.map((x) => x.date), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
  assert.deepEqual(r.summary, { rated: 3, averageFeeling: 3.7, intentionsAnswered: 1, intentionsMet: 1 });
  assert.equal(r.writtenAt, '2026-10-29T07:00:00Z');
  assert.match(r.note, /self-rating/);
});

test('bad ranges are refused', async () => {
  await assert.rejects(ev.getCheckIns({ start: '2026-10-29', end: '2026-10-01' }), /after end/);
  await assert.rejects(ev.getCheckIns({ start: 'yesterday' }));
});

test('the tool is registered read-only with a closed schema', () => {
  const t = TOOLS.find((x) => x.name === 'get_check_ins');
  assert.ok(t, 'get_check_ins missing');
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.ok(!t.annotations || t.annotations.readOnlyHint !== false);
});

// list_tags over health-tags.json (contract section 14): the file is opt-in in the iOS app, so the
// absent answer is the common one and must say so; the kind filter splits supplements from
// lifestyle tags by the file's own `supplements` list; nothing is ever written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-tags-'));
process.env.HEALTH_DATA_DIR = DIR;
const ev = await import('./events.mjs');
const store = await import('./healthstore.mjs');
const { TOOLS } = await import('./server.mjs');

const FILE = path.join(DIR, 'health-tags.json');
function put(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj));
  // readJSONCached keys on mtime; push it forward so a rewrite in the same millisecond is seen.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(FILE, t, t);
}

test('absent file: available false, says it is opt-in, still carries the basis', async () => {
  const r = await ev.listTags();
  assert.equal(r.available, false);
  assert.match(r.note, /health-tags\.json/);
  assert.match(r.note, /off by default/);
  assert.match(r.basis, /not evidence/);
  assert.equal((await store.status()).contextFiles.tags, false);
});

test('kind filter, per-tag rows and per-day names', async () => {
  put({
    schema: 1,
    days: {
      '2026-10-01': ['Creatine', 'Sauna'],
      '2026-10-02': ['Creatine', 'Magnesium', 'Alcohol'],
      '2026-10-03': ['Creatine'],
    },
    supplements: ['Creatine', 'Magnesium'],
  });
  const all = await ev.listTags();
  assert.equal(all.available, true);
  assert.deepEqual(all.tags.map((t) => t.name), ['Creatine', 'Alcohol', 'Magnesium', 'Sauna']);
  assert.deepEqual(all.tags[0], { name: 'Creatine', kind: 'supplement', days: 3, firstDay: '2026-10-01', lastDay: '2026-10-03' });

  const sup = await ev.listTags({ kind: 'supplement' });
  assert.deepEqual(sup.tags.map((t) => t.name), ['Creatine', 'Magnesium']);
  assert.ok(sup.tags.every((t) => t.kind === 'supplement'));
  assert.deepEqual(sup.days['2026-10-02'], ['Creatine', 'Magnesium']);

  const life = await ev.listTags({ kind: 'lifestyle' });
  assert.deepEqual(life.tags.map((t) => t.name), ['Alcohol', 'Sauna']);
  assert.equal(life.days['2026-10-03'], undefined, 'a day with only supplements drops out of a lifestyle answer');

  const window = await ev.listTags({ start: '2026-10-02', end: '2026-10-02' });
  assert.deepEqual(Object.keys(window.days), ['2026-10-02']);
  assert.equal((await store.status()).contextFiles.tags, true);
});

test('bad arguments are refused, not guessed', async () => {
  await assert.rejects(() => ev.listTags({ kind: 'medication' }), /kind must be one of/);
  await assert.rejects(() => ev.listTags({ start: '2026-10-05', end: '2026-10-01' }), /after end/);
  await assert.rejects(() => ev.listTags({ start: 'yesterday' }), /YYYY-MM-DD/);
});

test('a corrupt file reads as absent', async () => {
  put({ schema: 1, days: ['not', 'a', 'map'] });
  assert.equal((await ev.listTags()).available, false);
});

test('the tool is declared read-only with the kind enum', () => {
  const tool = TOOLS.find((t) => t.name === 'list_tags');
  assert.ok(tool, 'list_tags is registered');
  // No annotations of its own, so tools/list serves the shared read-only set (exposure.test.mjs
  // checks every tool's served annotations end to end).
  assert.equal(tool.annotations, undefined);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.kind.enum, ['all', 'supplement', 'lifestyle']);
});

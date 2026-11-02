// get_lab_results over health-labs.json (docs/SCHEMA-CONTRACTS.md section 17): lab results from Apple
// Health Records, exported only when the user switches it on, to a picked folder (never iCloud Drive).
// Zero-dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-labs-'));
process.env.HEALTH_DATA_DIR = DIR;
const ev = await import('./events.mjs');
const FILE = path.join(DIR, 'health-labs.json');

// The shape LabRecords.exportPayload writes (Tests/LabExportTests.swift pins the app side).
const r = (id, day, extra) => ({ id, date: `${day}T09:00:00+00:00`, day, institution: 'Sample Clinic', fhir: 'R4', ...extra });
const FIXTURE = {
  schema: 1, app: '1.21', writtenAt: '2026-10-29T19:00:00Z', source: 'apple-health-records',
  tests: [
    { name: 'C-Reactive Protein', results: [r('crp', '2026-09-20', { valueText: '<5', unit: 'mg/L' })], unit: 'mg/L' },
    { name: 'LDL Cholesterol', loinc: '13457-7', unit: 'mg/dL', results: [
      r('ldl-1', '2025-03-01', { value: 131, unit: 'mg/dL', refLow: 0, refHigh: 99, fhir: 'DSTU2' }),
      r('ldl-2', '2026-09-20', { value: 96, unit: 'mg/dL', refRangeText: '0-99 mg/dL', refLow: 0, refHigh: 99 }),
    ] },
    { name: 'Vitamin D, 25-Hydroxy', loinc: '1989-3', unit: 'ng/mL', splitByUnit: true, results: [r('vd-a', '2026-09-20', { value: 28, unit: 'ng/mL' })] },
    { name: 'Vitamin D, 25-Hydroxy', loinc: '1989-3', unit: 'nmol/L', splitByUnit: true, results: [r('vd-b', '2025-03-01', { value: 61, unit: 'nmol/L', institution: 'Sample Hospital' })] },
  ],
};
// readJSONCached memoizes on (mtime, size): give every rewrite a distinct mtime.
let tick = 0;
function write(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj));
  const t = new Date(Date.UTC(2026, 9, 1) + ++tick * 1000);
  fs.utimesSync(FILE, t, t);
}

test('absent file answers available:false, never "no lab results"', async () => {
  fs.rmSync(FILE, { force: true });
  const a = await ev.getLabResults({});
  assert.equal(a.available, false);
  assert.match(a.note, /health-labs\.json/);
  assert.match(a.note, /never to iCloud Drive/);
  assert.match(a.note, /off by default/i);
  assert.match(a.note, /not that nothing happened/);
});

test('every test, results oldest first, values exactly as exported, interpretation withheld', async () => {
  write(FIXTURE);
  const a = await ev.getLabResults({});
  assert.equal(a.available, true);
  assert.equal(a.count, 5);
  assert.equal(a.testCount, 4);
  const ldl = a.tests.find((t) => t.loinc === '13457-7');
  assert.deepEqual(ldl.results.map((x) => x.id), ['ldl-1', 'ldl-2']);
  assert.equal(ldl.results[1].value, 96);
  assert.equal(ldl.results[1].refRangeText, '0-99 mg/dL');
  assert.equal(a.tests.find((t) => t.name === 'C-Reactive Protein').results[0].valueText, '<5');
  assert.match(a.note, /nothing is flagged, graded or interpreted/);
  assert.match(a.note, /never converted/);
  assert.match(a.note, /clinician/);
  assert.equal(a.resultsOmitted, undefined);
  assert.equal(a.knownTests, undefined);
});

test('a test in two units stays two entries and is never merged or converted', async () => {
  write(FIXTURE);
  const a = await ev.getLabResults({ test: 'vitamin d' });
  assert.equal(a.testCount, 2);
  assert.deepEqual(a.tests.map((t) => t.unit).sort(), ['ng/mL', 'nmol/L']);
  assert.ok(a.tests.every((t) => t.splitByUnit === true));
});

test('test filter is a case-insensitive part of the name; loinc is exact', async () => {
  write(FIXTURE);
  assert.deepEqual((await ev.getLabResults({ test: '  LDL ' })).tests.map((t) => t.name), ['LDL Cholesterol']);
  assert.equal((await ev.getLabResults({ loinc: '13457-7' })).count, 2);
  assert.equal((await ev.getLabResults({ loinc: '13457' })).count, 0, 'a partial code is not a match');
  assert.equal((await ev.getLabResults({ test: 'ldl', loinc: '1989-3' })).count, 0, 'both filters must hold');
});

test('start and end filter by the result day, inclusive, and drop emptied tests', async () => {
  write(FIXTURE);
  const a = await ev.getLabResults({ start: '2026-01-01' });
  assert.equal(a.count, 3);
  assert.deepEqual(a.tests.find((t) => t.loinc === '13457-7').results.map((x) => x.id), ['ldl-2']);
  assert.ok(!a.tests.some((t) => t.unit === 'nmol/L'), 'a test with no result in range is not listed');
  const one = await ev.getLabResults({ start: '2025-03-01', end: '2025-03-01' });
  assert.deepEqual(one.tests.flatMap((t) => t.results.map((x) => x.id)).sort(), ['ldl-1', 'vd-b']);
});

test('no match returns count 0 with every known test', async () => {
  write(FIXTURE);
  const a = await ev.getLabResults({ test: 'ferritin' });
  assert.equal(a.available, true);
  assert.equal(a.count, 0);
  assert.deepEqual(a.tests, []);
  assert.deepEqual(a.knownTests.map((t) => t.name), ['C-Reactive Protein', 'LDL Cholesterol', 'Vitamin D, 25-Hydroxy', 'Vitamin D, 25-Hydroxy']);
  assert.equal(a.knownTests.find((t) => t.loinc === '13457-7').latestDay, '2026-09-20');
  assert.match(a.note, /No lab result matches this filter/);
});

test('bad arguments are refused, not guessed', async () => {
  write(FIXTURE);
  await assert.rejects(ev.getLabResults({ start: '2026-10-15', end: '2026-10-01' }), /after end/);
  await assert.rejects(ev.getLabResults({ start: '15/10/2026' }), /YYYY-MM-DD/);
  await assert.rejects(ev.getLabResults({ test: 42 }), /test must be a string/);
  await assert.rejects(ev.getLabResults({ loinc: 1 }), /loinc must be a string/);
});

test('over 400 matching results, the newest 400 are listed and the rest counted', async () => {
  const results = Array.from({ length: 410 }, (_, i) => {
    const day = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return r(`g${i}`, day, { value: 5 + (i % 10) / 10, unit: 'mmol/L' });
  });
  write({ ...FIXTURE, tests: [{ name: 'Glucose', loinc: '2345-7', unit: 'mmol/L', results }] });
  const a = await ev.getLabResults({});
  assert.equal(a.count, 410);
  assert.equal(a.tests[0].results.length, 400);
  assert.equal(a.resultsOmitted, 10);
  assert.equal(a.tests[0].results[0].id, 'g10');
  assert.equal(a.tests[0].results.at(-1).id, 'g409');
});

test('a malformed file reads as unavailable, and malformed rows are skipped', async () => {
  write({ schema: 1, tests: 'nope' });
  assert.equal((await ev.getLabResults({})).available, false);
  write({ ...FIXTURE, tests: [null, { name: 'x' }, ...FIXTURE.tests] });
  assert.equal((await ev.getLabResults({})).count, 5);
});

test('tools/list declares get_lab_results read-only, and the demo dataset answers it', () => {
  const run = spawnSync(process.execPath, [path.join(HERE, 'server.mjs'), '--demo'], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_lab_results', arguments: { test: 'ldl' } } },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
  });
  const [list, call] = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const tool = list.result.tools.find((t) => t.name === 'get_lab_results');
  assert.ok(tool, 'get_lab_results is listed');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['end', 'loinc', 'start', 'test']);
  assert.match(tool.description, /never iCloud Drive/);
  const text = call.result.content[0].text;
  assert.match(text, /^\[SYNTHETIC DEMO DATA\]/);
  const data = JSON.parse(text.replace(/^\[SYNTHETIC DEMO DATA\]\s*/, ''));
  assert.equal(data.available, true);
  assert.equal(data.count, 3);
  assert.deepEqual(data.tests[0].results.map((x) => x.value), [131, 118, 96]);
});

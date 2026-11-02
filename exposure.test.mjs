// Zero-dependency test for the bridge's exposure boundary: the server's data readers only ever
// open the documented export files, never a workout route (GPX) or any other format, and every
// tool is declared read-only except the two that log an agent's events to their own file. The iOS app states the same list under Settings > What agents can
// see, and healthexport.dev/mcp states it under "What agents can see"; a new file read here needs
// both statements updated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DOCUMENTED = new Set([
  '.health-cache.json',          // daily value per metric
  'health-export.json',          // the same daily data under a Files-visible name
  '.health-workouts-cache.json', // one summary per workout
  'health-intraday.json',        // the current hourly window
  'health-sessions.json',        // sleep sessions
  'health-sources.json',         // which device or app recorded each value (server 1.7.0+, app 1.16+)
  'health-events.json',          // events the user typed
  'health-profile.json',         // profile fields the user switched on
  'health-cycles.json',          // cycle start dates (sensitive categories only)
  'health-days.json',            // time zone changes
  'health-readings.json',        // individual blood pressure readings (server 1.8.0+)
  'health-strength.json',        // the strength log, when its export is switched on in the app
  'health-events-agent.json',    // events an agent logged with add_event (server 1.8.0+)
  'health-labs.json',            // lab results, folder export only (opt-in in the app)
  'health-tags.json',            // tags the user logged, supplements marked (opt-in in the app)
  'health-check-ins.json',       // morning check-ins, only when the user switched the export on
  '.health-manifest.json',       // what the phone last wrote: sizes, hashes, times (server 1.8.0+)
  '.health-pair.json',           // pairing gate: a hash of the code, no health data
]);

// The ONLY tools allowed to write, each to health-events-agent.json alone (server 1.8.0+). A new
// writer here is a new claim on What agents can see, and needs both statements updated first.
const WRITERS = {
  add_event:    { destructiveHint: false, idempotentHint: true },
  remove_event: { destructiveHint: true,  idempotentHint: true },
};

function fileNamesIn(file) {
  const src = fs.readFileSync(path.join(HERE, file), 'utf8');
  return [...src.matchAll(/['"`]([A-Za-z0-9._-]+\.(?:json|gpx|xml|csv|txt|fit|tcx))['"`]/g)].map((m) => m[1]);
}

test('the data readers open only the documented export files', () => {
  const seen = new Set(['healthstore.mjs', 'events.mjs', 'server.mjs', 'prompts.mjs'].flatMap(fileNamesIn));
  assert.ok(seen.size > 0, 'scan found no file names: the pattern or the module layout changed');
  const undocumented = [...seen].filter((f) => !DOCUMENTED.has(f));
  assert.deepEqual(undocumented, [], `server reads files the exposure statement does not list: ${undocumented}`);
  assert.ok(![...seen].some((f) => /\.(gpx|tcx|fit)$/i.test(f)), 'no workout route file may be read');
});

test('every tool is read-only and closed-world, except the two agent-event writers', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'exposure-test', version: '0' } } };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const r = spawnSync(process.execPath, [path.join(HERE, 'server.mjs'), '--demo'], {
    input: JSON.stringify(init) + '\n' + JSON.stringify(list) + '\n', encoding: 'utf8', timeout: 15000,
  });
  const msgs = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tools = msgs.find((m) => m.id === 2)?.result?.tools;
  assert.ok(Array.isArray(tools) && tools.length > 0, `no tools/list result: ${r.stderr}`);
  for (const t of tools) {
    assert.equal(t.annotations?.openWorldHint, false, `${t.name} is not closed-world`);
    const writer = WRITERS[t.name];
    if (!writer) { assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is not read-only`); continue; }
    assert.equal(t.annotations?.readOnlyHint, false, `${t.name} must declare that it writes`);
    assert.equal(t.annotations?.destructiveHint, writer.destructiveHint, `${t.name} destructiveHint`);
    assert.equal(t.annotations?.idempotentHint, writer.idempotentHint, `${t.name} idempotentHint`);
  }
  assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort(),
                   Object.keys(WRITERS).sort(), 'exactly the agent-event tools write');
});

test('the writers write only health-events-agent.json', () => {
  const src = fs.readFileSync(path.join(HERE, 'events.mjs'), 'utf8');
  // The file itself lands only by an atomic rename onto health-events-agent.json.
  const renames = [...src.matchAll(/fs\.renameSync\(([^,]+),\s*([^)]+\))\)/g)].map((m) => m[2].trim());
  assert.ok(renames.length > 0, 'no rename found: the pattern or the module layout changed');
  for (const dest of renames) assert.equal(dest, 'dataPath(AGENT_EVENTS_FILE)', `events.mjs renames onto ${dest}`);
  assert.ok(!/fs\.(?:writeFileSync|appendFileSync|copyFileSync)\(/.test(src), 'events.mjs writes a file other than by rename');
  // Scratch files (the lock and the temp) are opened exclusively and named .nosync, so iCloud never
  // uploads them to the phone.
  for (const m of src.matchAll(/fs\.openSync\(([^,]+),\s*'([a-z+]+)'/g)) assert.equal(m[2], 'wx', `openSync(${m[1]}) not exclusive`);
  assert.ok((src.match(/\.nosync/g) || []).length >= 2, 'lock and temp names must end in .nosync');
  for (const f of ['healthstore.mjs', 'server.mjs', 'prompts.mjs']) {
    const other = fs.readFileSync(path.join(HERE, f), 'utf8');
    assert.ok(!/fs\.(?:writeFileSync|appendFileSync|copyFileSync|renameSync|writeSync)\(/.test(other), `${f} writes a file`);
  }
});

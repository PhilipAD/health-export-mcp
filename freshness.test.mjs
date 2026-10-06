// Staleness signalling (docs/feature-requests/fr-freshness-without-export.md, part b).
//
// An agent pointed at an exported file had no machine-readable way to tell whether what it read
// was this morning's data or three weeks old. These tests pin the contract of the `freshness`
// block on get_mcp_status and the `get_freshness` tool:
//   - `stale` is decided by the age of the newest write across the export file family, against a
//     documented threshold (default 26 h, HEALTH_STALE_AFTER_HOURS, or the caller's maxAgeHours);
//   - `as_of` is the app's own `_meta.writtenAt` when present, else the cache file time;
//   - per-file write times expose "cache fresh, events stale";
//   - the tool and the `status --max-age N` cron gate agree for the same N;
//   - locked, demo, encrypted and empty folders each answer explicitly instead of guessing;
//   - every existing get_mcp_status field is unchanged (the block is additive).
// The last test drives the real server over stdio, the way an MCP client does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealEnvelope, MIN_ITERATIONS } from './envelope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const HOUR = 3600000;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-'));
process.env.HEALTH_DATA_DIR = DIR;
delete process.env.HEALTH_STALE_AFTER_HOURS;
const store = await import('./healthstore.mjs');

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const WRITTEN_AT = '2026-10-04T06:30:00.000Z';

function cache({ meta = true, lastDay = '2026-10-04' } = {}) {
  const end = Date.parse(lastDay + 'T00:00:00Z');
  const daily = Array.from({ length: 5 }, (_, i) => ({ d: isoDay(end - (4 - i) * 86400000), v: 1000 + i }));
  return {
    ...(meta && { _meta: { schema: 1, schemaMinor: 1, app: '1.9', writtenAt: WRITTEN_AT } }),
    step_count: { unit: 'count', cumulative: true, daily },
    heart_rate: { unit: 'count/min', cumulative: false, daily: daily.slice(0, 3).map((p) => ({ ...p, v: 60 })) },
  };
}

/** Write a file and stamp its mtime `ageH` hours before `now`. A unique size per write defeats the
 *  (mtime, size) parse memo the same way parity.test.mjs does. */
let salt = 0;
function put(dir, name, obj, ageH, now = Date.now()) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj) + ' '.repeat(++salt % 7));
  const t = (now - ageH * HOUR) / 1000;
  fs.utimesSync(p, t, t);
}
function clear(dir) {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true });
}

test('fresh export: state fresh, as_of from _meta.writtenAt, age, last data date and lag', async () => {
  clear(DIR);
  const now = Date.parse('2026-10-05T09:00:00Z');
  put(DIR, '.health-cache.json', cache(), 2, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'fresh');
  assert.equal(f.stale, false);
  assert.equal(f.stale_after_hours, store.DEFAULT_STALE_AFTER_HOURS);
  assert.equal(f.stale_after_hours, 26);
  assert.equal(f.checked_at, '2026-10-05T09:00:00.000Z');
  assert.equal(f.as_of, WRITTEN_AT);
  assert.equal(f.as_of_source, 'cache_meta');
  assert.deepEqual(f.newest_write, { file: '.health-cache.json', at: new Date(now - 2 * HOUR).toISOString() });
  assert.equal(f.age_hours, 2);
  assert.equal(f.last_data_date, '2026-10-04');
  assert.equal(typeof f.data_lag_days, 'number');
  assert.ok(f.data_lag_days >= 0 && f.data_lag_days <= 2, `lag ${f.data_lag_days} (server-local calendar)`);
  assert.deepEqual(Object.keys(f.files), ['.health-cache.json']);
  assert.deepEqual(f.stale_files, []);
  assert.match(f.recommendation, /26-hour freshness window/);
});

test('old export: stale true once the newest write passes the threshold, with a refresh hint', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache(), 30, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'stale');
  assert.equal(f.stale, true);
  assert.equal(f.age_hours, 30);
  assert.deepEqual(f.stale_files, ['.health-cache.json']);
  assert.match(f.recommendation, /30 hours old, older than the 26-hour window/);
  assert.match(f.recommendation, /2026-10-04/);
  // Just inside the threshold is fresh; just past it is stale even when both ROUND to 26.0, because
  // the decision uses the exact age, the same comparison the cron gate makes.
  put(DIR, '.health-cache.json', cache(), 25.99, now);
  assert.equal((await store.freshness({ now })).stale, false);
  put(DIR, '.health-cache.json', cache(), 26.02, now);
  const edge = await store.freshness({ now });
  assert.equal(edge.age_hours, 26);
  assert.equal(edge.stale, true);
});

test('per-file ages expose "cache fresh, events stale"; stale follows the NEWEST write', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache(), 1, now);
  put(DIR, 'health-events.json', { schema: 1, events: [] }, 500, now);
  const f = await store.freshness({ now });
  assert.equal(f.stale, false);
  assert.equal(f.newest_write.file, '.health-cache.json');
  assert.equal(f.files['health-events.json'].age_hours, 500);
  assert.deepEqual(f.stale_files, ['health-events.json']);
});

test('maxAgeHours overrides the threshold; nonsense values are rejected loudly', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache(), 5, now);
  assert.equal((await store.freshness({ now, maxAgeHours: 4 })).stale, true);
  assert.equal((await store.freshness({ now, maxAgeHours: 6 })).stale, false);
  assert.equal((await store.freshness({ now, maxAgeHours: 0.5 })).stale_after_hours, 0.5);
  for (const bad of [0, -1, '6', NaN, Infinity, 8761, true]) {
    await assert.rejects(store.freshness({ now, maxAgeHours: bad }), /maxAgeHours must be a number/, `rejects ${String(bad)}`);
  }
});

test('HEALTH_STALE_AFTER_HOURS sets the default; a malformed value falls back instead of disabling it', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache(), 5, now);
  try {
    process.env.HEALTH_STALE_AFTER_HOURS = '4';
    const f = await store.freshness({ now });
    assert.equal(f.stale_after_hours, 4);
    assert.equal(f.stale, true);
    assert.equal((await store.freshness({ now, maxAgeHours: 10 })).stale, false, 'the argument beats the env');
    for (const junk of ['24h', '0', '-3', 'abc', '99999']) {
      process.env.HEALTH_STALE_AFTER_HOURS = junk;
      assert.equal((await store.freshness({ now })).stale_after_hours, 26, `falls back on ${junk}`);
    }
  } finally {
    delete process.env.HEALTH_STALE_AFTER_HOURS;
  }
});

test('a cache without _meta (pre-1.2 app, LAN receiver) dates as_of from the file time', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache({ meta: false }), 3, now);
  const f = await store.freshness({ now });
  assert.equal(f.as_of_source, 'file_mtime');
  assert.ok(Math.abs(Date.parse(f.as_of) - (now - 3 * HOUR)) < 5, `as_of ${f.as_of} is the file time`);
  assert.equal(f.last_data_date, '2026-10-04');
});

test('empty folder: state no_data and stale true, nothing invented', async () => {
  clear(DIR);
  const f = await store.freshness();
  assert.equal(f.state, 'no_data');
  assert.equal(f.stale, true);
  assert.equal(f.as_of, null);
  assert.equal(f.age_hours, null);
  assert.equal(f.last_data_date, null);
  assert.deepEqual(f.files, {});
  assert.match(f.recommendation, /No export files/);
});

test('a file stamped in the future (clock skew) reads as age 0, never negative', async () => {
  clear(DIR);
  const now = Date.now();
  put(DIR, '.health-cache.json', cache(), -2, now);
  const f = await store.freshness({ now });
  assert.equal(f.age_hours, 0);
  assert.equal(f.stale, false);
});

test('an encrypted cache with no passphrase still reports write-time freshness', async () => {
  clear(DIR);
  const now = Date.now();
  const sealed = sealEnvelope(JSON.stringify(cache()), 'correct horse battery staple', { iter: MIN_ITERATIONS });
  put(DIR, '.health-cache.json', sealed, 40, now);
  const f = await store.freshness({ now });
  assert.equal(f.state, 'stale');
  assert.equal(f.age_hours, 40);
  assert.equal(f.as_of_source, 'file_mtime');
  assert.equal(f.last_data_date, null);
  assert.equal(f.cacheReadError, 'passphrase_missing');
  assert.match(f.recommendation, /could not be read \(passphrase_missing\)/);
  const s = await store.status();
  assert.equal(s.encrypted, true);
  assert.equal(s.freshness.state, 'stale');
  // A RECENT unreadable cache keeps its write-time state but still says it is not usable.
  put(DIR, '.health-cache.json', sealed, 1, now);
  const g = await store.freshness({ now });
  assert.equal(g.state, 'fresh');
  assert.equal(g.cacheReadError, 'passphrase_missing');
  assert.match(g.recommendation, /^Within the 26-hour freshness window.*could not be read \(passphrase_missing\).*data tools will fail/);
});

test('get_mcp_status carries a compact freshness block and every existing field is unchanged', async () => {
  clear(DIR);
  put(DIR, '.health-cache.json', cache(), 1);
  const s = await store.status();
  for (const k of ['ok', 'source', 'paired', 'locked', 'encrypted', 'metricCount', 'workoutCount', 'lastDataDate',
    'recompute', 'intraday', 'contextFiles', 'metrics']) assert.ok(k in s, `status still has ${k}`);
  assert.equal(s.metricCount, 2);
  assert.equal(s.lastDataDate, '2026-10-04');
  assert.equal(s.freshness.state, 'fresh');
  assert.equal(s.freshness.last_data_date, s.lastDataDate);
  assert.ok(!('files' in s.freshness) && !('stale_files' in s.freshness), 'compact: no per-file breakdown');
});

// ---- child-process scenarios: DATA_DIR, DEMO and pairing are read at module load ----

function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map(); let id = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const req = (method, params) => new Promise((resolve, reject) => {
    const my = ++id; pending.set(my, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    setTimeout(() => { if (pending.has(my)) { pending.delete(my); reject(new Error(`timeout ${method}`)); } }, 20000);
  });
  const call = async (name, args = {}) => {
    const r = await req('tools/call', { name, arguments: args });
    return { data: r.result?.structuredContent, isError: r.result?.isError, text: r.result?.content?.[0]?.text ?? '' };
  };
  return {
    req, call,
    async init() {
      const r = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fresh-test', version: '1' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    stop() { try { proc.kill(); } catch {} },
  };
}

test('locked by pairing: state locked, no file times disclosed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-lock-'));
  put(dir, '.health-cache.json', cache(), 1);
  fs.writeFileSync(path.join(dir, '.health-pair.json'), JSON.stringify({ hash: createHash('sha256').update('RIGHT').digest('hex') }));
  const s = startServer({ HEALTH_DATA_DIR: dir, PAIRING_SECRET: 'WRONG' });
  try {
    await s.init();
    const f = await s.call('get_freshness');
    assert.equal(f.isError, false);
    assert.equal(f.data.state, 'locked');
    assert.equal(f.data.stale, null);
    assert.ok(!('files' in f.data) && !('newest_write' in f.data) && !('as_of' in f.data));
  } finally { s.stop(); }
});

test('PAIRING_SECRET set but no .health-pair.json: fail-closed to locked, no file times', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-nopair-'));
  put(dir, '.health-cache.json', cache(), 1);
  const s = startServer({ HEALTH_DATA_DIR: dir, PAIRING_SECRET: 'AB3CD-EFGHJ-K2MNP-QRST4' });
  try {
    await s.init();
    const f = await s.call('get_freshness');
    assert.equal(f.isError, false);
    assert.equal(f.data.state, 'locked');
    assert.equal(f.data.stale, null);
    assert.ok(!('files' in f.data) && !('newest_write' in f.data) && !('as_of' in f.data) && !('age_hours' in f.data));
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.freshness.state, 'locked');
  } finally { s.stop(); }
});

test('demo mode: state demo, no fabricated age, watermark intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-demo-'));
  const s = startServer({ HEALTH_DATA_DIR: dir, HEALTH_DEMO: '1' });
  try {
    await s.init();
    const f = await s.call('get_freshness');
    assert.equal(f.data.demo, true);
    assert.equal(f.data.state, 'demo');
    assert.equal(f.data.stale, null);
    assert.ok(!('age_hours' in f.data));
    assert.match(f.text, /^\[SYNTHETIC DEMO DATA\]/);
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.freshness.state, 'demo');
  } finally { s.stop(); }
});

test('the tool and the `status --max-age N` cron gate agree for the same N', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-gate-'));
  put(dir, '.health-cache.json', cache(), 10);
  put(dir, 'health-profile.json', { schema: 1, fields: {} }, 50);
  const s = startServer({ HEALTH_DATA_DIR: dir });
  try {
    await s.init();
    for (const n of [5, 9.9, 10.5, 48]) {
      const gate = spawnSync(process.execPath, [SERVER, 'status', '--max-age', String(n)], {
        env: { PATH: process.env.PATH, HEALTH_DATA_DIR: dir }, encoding: 'utf8', timeout: 15000 });
      const f = await s.call('get_freshness', { maxAgeHours: n });
      assert.equal(gate.status === 1, f.data.stale, `N=${n}: gate exit ${gate.status}, tool stale ${f.data.stale}`);
      assert.match(gate.stdout, /\.health-cache\.json/, 'gate names the same newest file');
      assert.equal(f.data.newest_write.file, '.health-cache.json');
    }
  } finally { s.stop(); }
});

test('end to end over stdio: tools/list advertises get_freshness and a stale export is flagged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-fresh-e2e-'));
  put(dir, '.health-cache.json', cache(), 72);
  put(dir, 'health-events.json', { schema: 1, events: [] }, 1);
  const s = startServer({ HEALTH_DATA_DIR: dir, HEALTH_STALE_AFTER_HOURS: '48' });
  try {
    const init = await s.init();
    assert.match(init.result.instructions, /get_freshness/);
    const tl = await s.req('tools/list');
    const tool = tl.result.tools.find((t) => t.name === 'get_freshness');
    assert.ok(tool, 'get_freshness is listed');
    assert.equal(tl.result.tools.length, 16);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.properties.maxAgeHours.type, 'number');
    assert.equal(tool.inputSchema.properties.maxAgeHours.exclusiveMinimum, 0);
    assert.equal(tool.inputSchema.properties.maxAgeHours.maximum, 8760);

    // Newest write (events, 1 h) is inside the env threshold; the cache itself is flagged per file.
    const f = await s.call('get_freshness');
    assert.equal(f.isError, false);
    assert.equal(JSON.stringify(f.data), f.text, 'text and structured copies match');
    assert.equal(f.data.stale_after_hours, 48);
    assert.equal(f.data.stale, false);
    assert.deepEqual(f.data.stale_files, ['.health-cache.json']);
    assert.equal(f.data.files['.health-cache.json'].age_hours, 72);
    assert.equal(f.data.as_of, WRITTEN_AT);

    // Drop the fresh file: now the whole export is stale.
    fs.rmSync(path.join(dir, 'health-events.json'));
    const g = await s.call('get_freshness');
    assert.equal(g.data.state, 'stale');
    assert.equal(g.data.age_hours, 72);
    assert.equal(g.data.last_data_date, '2026-10-04');

    const st = await s.call('get_mcp_status');
    assert.equal(st.data.freshness.stale, true);
    assert.equal(st.data.metricCount, 2);

    const bad = await s.call('get_freshness', { maxAgeHours: -5 });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /maxAgeHours must be a number/);
  } finally { s.stop(); }
});

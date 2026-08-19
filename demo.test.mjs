// Tests for --demo mode: every tool answers, every answer is watermarked in BOTH copies, the
// dataset is deterministic across processes (fixed seed, fixed anchor date, no Date.now), status
// reports the mode loudly, and the wire-budget gate still stands in front of demo answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-demo-'));   // proves demo needs no data

function client(args, env) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    env: { ...process.env, HEALTH_DATA_DIR: EMPTY, ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = ''; const pending = new Map(); let id = 0;
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
    const myId = ++id; pending.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout ${method}`)); } }, 8000);
  });
  const call = async (name, args2) => {
    const r = await req('tools/call', { name, arguments: args2 || {} });
    return { data: r.result?.structuredContent, text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError };
  };
  return { req, call, kill: () => proc.kill() };
}

// Arguments that make each of the 14 tools return a real (non-error) answer against the demo set.
const CALLS = [
  ['get_mcp_status', {}],
  ['list_metrics', {}],
  ['get_health_metrics', { metric: 'resting_heart_rate', start: '2026-07-01', end: '2026-08-18' }],
  ['get_trends', { metric: 'heart_rate_variability', window: 14 }],
  ['compare_periods', { metric: 'step_count', periodA: { start: '2026-07-01', end: '2026-07-31' }, periodB: { start: '2026-06-01', end: '2026-06-30' } }],
  ['get_structured_export', { metrics: ['sleep_analysis'], start: '2026-08-01', end: '2026-08-18' }],
  ['get_intraday', {}],
  ['query_health_data', { question: 'average hrv this month' }],
  ['list_events', {}],
  ['get_profile', {}],
  ['get_workouts', { limit: 5 }],
  ['get_sleep_sessions', { start: '2026-08-01' }],
  ['get_cycle_context', {}],
  ['correlate_metrics', { metricA: 'step_count', metricB: 'sleep_analysis', lag: 1 }],
];

test('demo mode: every tool answers with demo:true and the [SYNTHETIC DEMO DATA] text prefix', async () => {
  const c = client(['--demo']);
  try {
    await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    for (const [name, args] of CALLS) {
      const r = await c.call(name, args);
      assert.equal(r.data?.demo, true, `${name}: structuredContent must carry demo:true`);
      assert.ok(r.text.startsWith('[SYNTHETIC DEMO DATA] '), `${name}: text copy must carry the watermark`);
    }
  } finally { c.kill(); }
});

test('demo status is loud and the dataset is the contracted shape', async () => {
  const c = client(['--demo']);
  try {
    await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const st = (await c.call('get_mcp_status')).data;
    assert.equal(st.demo, true);
    assert.match(st.demoNote, /SYNTHETIC DEMO DATA/);
    assert.match(st.demoNote, /Restart without the flag/);
    assert.equal(st.lastDataDate, '2026-08-18', 'anchored to the FIXED end date, never the clock');
    assert.ok(st.metricCount >= 15, `~15 representative metrics, got ${st.metricCount}`);
    assert.equal(st.workoutCount, 30);
    const le = (await c.call('list_events')).data;
    assert.equal(le.count, 8);
    const ss = (await c.call('get_sleep_sessions')).data;
    assert.equal(ss.count, 60);
    const cy = (await c.call('get_cycle_context')).data;
    assert.equal(cy.cycleStarts.length, 3);
    const gl = (await c.call('get_health_metrics', { metric: 'glucose_time_in_range_pct', start: '2026-08-01', end: '2026-08-18' })).data;
    assert.ok(gl.glucose_time_in_range_pct.points.every((p) => p.value > 0 && p.value <= 1), 'derived glucose metrics are 0..1 fractions');
    const wo = (await c.call('get_workouts', { activityType: 'Running', limit: 1 })).data;
    assert.ok(Array.isArray(wo.workouts[0].intervals) && wo.workouts[0].intervals.length > 0, 'demo running workouts carry intervals');
    // Demo errors are watermarked too: a pasted error must not pass for a real one.
    const err = await c.call('get_health_metrics', { metric: 'nope' });
    assert.equal(err.isError, true);
    assert.ok(err.text.startsWith('[SYNTHETIC DEMO DATA] '));
  } finally { c.kill(); }
});

test('the demo dataset is byte-identical across processes (seeded PRNG, fixed anchor)', async () => {
  const args = { metric: 'step_count', start: '2026-08-01', end: '2026-08-18' };
  const one = client(['--demo']);
  const two = client([], { HEALTH_DEMO: '1' });   // the env spelling must serve the same data
  try {
    await one.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await two.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const a = (await one.call('get_health_metrics', args)).data;
    const b = (await two.call('get_health_metrics', args)).data;
    assert.deepEqual(a, b);
  } finally { one.kill(); two.kill(); }
});

test('the wire-budget gate still stands in demo mode', async () => {
  const c = client(['--demo'], { HEALTH_MAX_RESULT_CHARS: '2000' });
  try {
    await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const r = await c.call('get_structured_export', {});
    assert.equal(r.isError, true);
    assert.equal(r.data.error, 'result_too_large');
    assert.equal(r.data.demo, true, 'even the budget refusal is watermarked');
    assert.match(r.data.fix, /Narrow the request/);
  } finally { c.kill(); }
});

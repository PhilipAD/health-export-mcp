// End-to-end integration test for the MCP layer (no-bridge architecture).
//
//   iOS app → iCloud Drive (.health-cache.json + context files)  →  MCP server  →  agent (JSON-RPC)
//
// Writes every file the iOS app can export, exactly as its exporters do, then spawns the
// MCP server over stdio and exercises every tool an agent calls — proving the full
// file → MCP → tools pipeline with no receiver and no Docker. Also asserts the protocol
// surfaces added in 1.4: tool annotations, prompts, and the per-answer wire budget.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, '..', 'server.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
const BUDGET = 100000;   // the server's default HEALTH_MAX_RESULT_CHARS wire budget

let mcp, failures = 0;
const ok = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.log(`  ✗ ${m}`); failures++; } };
function isoDay(offset) { const d = new Date(); d.setUTCDate(d.getUTCDate() - offset); return d.toISOString().slice(0, 10); }

// Build a 14-day cache in the exact shape the iOS app writes.
function sampleCache() {
  const days = (fn) => Array.from({ length: 14 }, (_, i) => ({ d: isoDay(13 - i), v: fn(i) }));
  return {
    heart_rate:             { unit: 'count/min', cumulative: false, daily: days((i) => 60 + (i % 5) * 1.5) },
    step_count:             { unit: 'count',     cumulative: true,  daily: days((i) => 8000 + (i % 5) * 400) },
    heart_rate_variability: { unit: 'ms',        cumulative: false, daily: days((i) => 55 + (i % 5) * 2) },
    sleep_analysis:         { unit: 'hr',        cumulative: false, daily: days((i) => 7 + (i % 3) * 0.3) },
  };
}

// Every context file from docs/SCHEMA-CONTRACTS.md, written as the app would.
function writeContextFiles() {
  const j = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2));
  j('.health-workouts-cache.json', [
    { id: 'w1', name: 'Running', activityType: 37, start: `${isoDay(3)}T07:30:00+01:00`, end: `${isoDay(3)}T08:15:00+01:00`,
      duration: 2700, activeEnergyBurned: 450, distanceMeters: 8000, distanceSource: 'watch',
      avgHeartRate: 148, maxHeartRate: 171, hasRoute: true,
      intervals: [{ start: `${isoDay(3)}T07:30:00+01:00`, end: `${isoDay(3)}T07:45:00+01:00`, duration: 900, kind: 'lap' }] },
    { id: 'w2', name: 'Walking', activityType: 52, start: `${isoDay(1)}T18:00:00+01:00`, end: `${isoDay(1)}T18:40:00+01:00`,
      duration: 2400, activeEnergyBurned: 160, distanceMeters: 3200, distanceSource: 'watch' },
  ]);
  j('health-events.json', { schema: 1, app: '1.5', writtenAt: new Date().toISOString(), events: [
    { id: 'evt-med', date: isoDay(7), type: 'medication', title: 'Started magnesium', tags: ['magnesium'] },
    { id: 'evt-trip', date: isoDay(5), endDate: isoDay(4), type: 'travel', title: 'Weekend away' },
  ] });
  j('health-profile.json', { schema: 1, writtenAt: new Date().toISOString(), fields: { goals: ['sleep 7.5 hours'] } });
  j('health-sessions.json', { schema: 1, writtenAt: new Date().toISOString(), sessions: [
    { start: `${isoDay(2)}T23:10:00+01:00`, end: `${isoDay(1)}T06:50:00+01:00`, day: isoDay(1), hours: 7.7,
      stages: { core: 4.2, deep: 1.1, rem: 1.8, awake: 0.6 } },
  ] });
  j('health-cycles.json', { schema: 1, writtenAt: new Date().toISOString(), cycleStarts: [isoDay(40), isoDay(12)] });
  j('health-days.json', { schema: 1, writtenAt: new Date().toISOString(), currentTz: 'Europe/London',
    changes: [{ from: isoDay(4), tz: 'Europe/London', utcOffsetMin: 60 }],
    note: 'Timezone history is recorded from this build onward.' });
}

// --- MCP stdio JSON-RPC client ---
function mcpClient(proc) {
  let buf = ''; const pending = new Map();
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
  let id = 0;
  const req = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id; pending.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout ${method}`)); } }, 5000);
  });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, args) => {
    const r = await req('tools/call', { name, arguments: args || {} });
    return { raw: r, data: r.result?.structuredContent, text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError };
  };
  return { req, notify, call };
}

async function main() {
  console.log(`\nMCP end-to-end integration  (data dir: ${DATA})\n`);

  // 1. iOS-app-equivalent: write the cache and every context file into the (test) iCloud folder.
  fs.writeFileSync(path.join(DATA, '.health-cache.json'), JSON.stringify(sampleCache(), null, 2));
  writeContextFiles();
  ok(fs.existsSync(path.join(DATA, '.health-cache.json')), 'app wrote .health-cache.json (no receiver)');

  // 2. MCP server reads the same data dir.
  mcp = spawn('node', [MCP], { env: { ...process.env, HEALTH_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'inherit'] });
  const c = mcpClient(mcp);

  const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1.0' } });
  ok(init.result?.serverInfo?.name === 'health-export-ai', `initialize → ${init.result?.serverInfo?.name}`);
  ok(!!init.result?.capabilities?.tools, 'advertises tools capability');
  ok(!!init.result?.capabilities?.prompts, 'advertises prompts capability');
  c.notify('notifications/initialized');

  const tl = await c.req('tools/list');
  const tools = tl.result?.tools || [];
  const names = tools.map((t) => t.name);
  ok(names.length === 14, `tools/list → ${names.length} tools (expected 14)`);
  for (const t of ['get_mcp_status', 'list_metrics', 'get_health_metrics', 'get_trends', 'compare_periods',
    'get_structured_export', 'get_intraday', 'query_health_data',
    'list_events', 'get_profile', 'get_workouts', 'get_sleep_sessions', 'get_cycle_context', 'correlate_metrics'])
    ok(names.includes(t), `tool present: ${t}`);
  ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.idempotentHint === true && t.annotations?.openWorldHint === false),
    'every tool carries readOnly/idempotent/closed-world annotations');

  const pl = await c.req('prompts/list');
  const prompts = pl.result?.prompts || [];
  ok(prompts.length >= 22, `prompts/list → ${prompts.length} prompts (expected >= 22)`);
  const pg = await c.req('prompts/get', { name: 'experiment', arguments: { intervention: 'magnesium at night' } });
  ok(pg.result?.messages?.[0]?.content?.text?.includes('magnesium at night'), 'prompts/get substitutes arguments');

  // 3. One call per tool, asserting each stays inside the wire budget.
  const calls = [];
  const track = async (name, args) => { const r = await c.call(name, args); calls.push([name, r]); return r; };

  const st = await track('get_mcp_status');
  ok(st.data?.ok && st.data.metricCount >= 4, `get_mcp_status → ${st.data?.metricCount} metrics, last ${st.data?.lastDataDate}`);
  ok(st.data?.contextFiles?.events === true && st.data?.contextFiles?.cycles === true, 'status reports context files present');

  const lm = await track('list_metrics');
  ok(Array.isArray(lm.data?.metrics) && lm.data.metrics.find((m) => m.name === 'step_count')?.days === 14, 'list_metrics → step_count has 14 days');

  const hm = await track('get_health_metrics', { metric: 'step_count', aggregation: 'sum' });
  ok(hm.data?.step_count?.points?.length === 14 && hm.data.step_count.aggregate > 0, `get_health_metrics(step_count,sum) → ${hm.data?.step_count?.aggregate}`);
  ok(Array.isArray(hm.data?.step_count?.segmentBoundaries) && hm.data.step_count.segmentBoundaries.length === 1,
    'single-metric answer lists the point event as a segment boundary');

  const tr = await track('get_trends', { metric: 'heart_rate_variability', window: 7, excludeTravelDays: true });
  ok(tr.data?.recent != null && ['up', 'down', 'flat'].includes(tr.data.direction), `get_trends(hrv) → ${tr.data?.direction} (${tr.data?.changePercent}%)`);
  ok(tr.data?.travelDaysExcluded === 1 && /timezone change/.test(tr.data?.travelNote || ''), `excludeTravelDays dropped ${tr.data?.travelDaysExcluded} day`);

  const cp = await track('compare_periods', { metric: 'heart_rate_variability', anchor: { eventId: 'evt-med', days: 5 } });
  ok(cp.data?.anchor?.eventId === 'evt-med' && cp.data?.periodA?.value != null, `compare_periods(anchor) → A ${cp.data?.periodA?.value} vs B ${cp.data?.periodB?.value}`);

  const ex = await track('get_structured_export', { metrics: ['sleep_analysis'] });
  ok(ex.data?.metrics?.sleep_analysis?.daily?.length === 14, `get_structured_export(sleep) → ${ex.data?.metrics?.sleep_analysis?.daily?.length} days`);

  const it = await track('get_intraday');
  ok(it.data?.available === false && /hourly automation/i.test(it.data?.note || ''), 'get_intraday absent → available:false with guidance');

  const nl = await track('query_health_data', { question: 'what is my average HRV?' });
  ok(nl.data?.interpreted?.includes('heart_rate_variability'), `query_health_data routed → "${nl.data?.interpreted}"`);

  const le = await track('list_events', {});
  ok(le.data?.available === true && le.data.count === 2, `list_events → ${le.data?.count} events`);

  const pr = await track('get_profile');
  ok(pr.data?.available === true && pr.data.presentFields?.includes('goals') && /withheld/.test(pr.data?.note || ''),
    'get_profile → presentFields plus withheld-fields note');

  const wo = await track('get_workouts', { activityType: 'Running' });
  ok(wo.data?.available === true && wo.data.summary?.count === 1 && wo.data.workouts?.[0]?.intervals?.length === 1,
    'get_workouts(Running) → 1 workout with intervals intact');

  const sl = await track('get_sleep_sessions', {});
  ok(sl.data?.available === true && sl.data.count === 1 && /WAKING day/.test(sl.data?.note || ''),
    'get_sleep_sessions → waking-day attribution stated');

  const cy = await track('get_cycle_context', {});
  ok(cy.data?.available === true && /not predictive/.test(JSON.stringify(cy.data)), 'get_cycle_context → derived, not predictive');

  const co = await track('correlate_metrics', { metricA: 'step_count', metricB: 'sleep_analysis', lag: 1 });
  ok(co.data?.alignedPairs === 13 && /Association, not causation/.test(co.data?.caveat || ''),
    `correlate_metrics(lag 1) → ${co.data?.alignedPairs} pairs, caveat present`);

  ok(calls.length === 14, `exercised ${calls.length} tools (one call each)`);
  const oversized = calls.filter(([, r]) => (r.text.length * 2) > BUDGET);
  ok(oversized.length === 0, `every answer within the ${BUDGET}-char wire budget${oversized.length ? ` (over: ${oversized.map(([n]) => n).join(', ')})` : ''}`);

  const err = await c.call('get_health_metrics', { metric: 'does_not_exist' });
  ok(err.isError === true, 'unknown metric → graceful tool error (isError:true)');

  console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}\n`);
}

main().catch((e) => { console.error('FATAL', e); failures++; }).finally(() => {
  try { mcp?.kill(); } catch {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
});

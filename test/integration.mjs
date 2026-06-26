// End-to-end integration test for the MCP layer (no-bridge architecture).
//
//   iOS app → iCloud Drive (.health-cache.json)  →  MCP server  →  agent (JSON-RPC)
//
// Writes a cache file exactly as the iOS app's ICloudExporter does, then spawns the
// MCP server over stdio and exercises every tool an agent calls — proving the full
// file → MCP → tools pipeline with no receiver and no Docker.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, '..', 'server.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));

let mcp, failures = 0;
const ok = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.log(`  ✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    return { raw: r, data: r.result?.structuredContent, isError: r.result?.isError };
  };
  return { req, notify, call };
}

async function main() {
  console.log(`\nMCP end-to-end integration  (data dir: ${DATA})\n`);

  // 1. iOS-app-equivalent: write the cache file into the (test) iCloud folder.
  fs.writeFileSync(path.join(DATA, '.health-cache.json'), JSON.stringify(sampleCache(), null, 2));
  ok(fs.existsSync(path.join(DATA, '.health-cache.json')), 'app wrote .health-cache.json (no receiver)');

  // 2. MCP server reads the same data dir.
  mcp = spawn('node', [MCP], { env: { ...process.env, HEALTH_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'inherit'] });
  const c = mcpClient(mcp);

  const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1.0' } });
  ok(init.result?.serverInfo?.name === 'health-export-ai', `initialize → ${init.result?.serverInfo?.name}`);
  ok(!!init.result?.capabilities?.tools, 'advertises tools capability');
  c.notify('notifications/initialized');

  const tl = await c.req('tools/list');
  const names = (tl.result?.tools || []).map((t) => t.name);
  ok(names.length === 7, `tools/list → ${names.length} tools`);
  for (const t of ['get_mcp_status', 'list_metrics', 'get_health_metrics', 'get_trends', 'compare_periods', 'get_structured_export', 'query_health_data'])
    ok(names.includes(t), `tool present: ${t}`);

  const st = await c.call('get_mcp_status');
  ok(st.data?.ok && st.data.metricCount >= 4, `get_mcp_status → ${st.data?.metricCount} metrics, last ${st.data?.lastDataDate}`);

  const lm = await c.call('list_metrics');
  ok(Array.isArray(lm.data?.metrics) && lm.data.metrics.find((m) => m.name === 'step_count')?.days === 14, 'list_metrics → step_count has 14 days');

  const hm = await c.call('get_health_metrics', { metric: 'step_count', aggregation: 'sum' });
  ok(hm.data?.step_count?.points?.length === 14 && hm.data.step_count.aggregate > 0, `get_health_metrics(step_count,sum) → ${hm.data?.step_count?.aggregate}`);

  const hr = await c.call('get_health_metrics', { metric: 'heart_rate', start: isoDay(2), end: isoDay(0), aggregation: 'avg' });
  ok(hr.data?.heart_rate?.points?.length <= 3 && hr.data.heart_rate.aggregate > 0, `date-range filter → ${hr.data?.heart_rate?.points?.length} points`);

  const tr = await c.call('get_trends', { metric: 'heart_rate_variability', window: 7 });
  ok(tr.data?.recent != null && tr.data?.prior != null && ['up', 'down', 'flat'].includes(tr.data.direction), `get_trends(hrv) → ${tr.data?.direction} (${tr.data?.changePercent}%)`);

  const cp = await c.call('compare_periods', { metric: 'step_count', periodA: { start: isoDay(6), end: isoDay(0) }, periodB: { start: isoDay(13), end: isoDay(7) } });
  ok(cp.data?.periodA?.value != null && cp.data?.periodB?.value != null, `compare_periods → A ${cp.data?.periodA?.value} vs B ${cp.data?.periodB?.value}`);

  const ex = await c.call('get_structured_export', { metrics: ['sleep_analysis'] });
  ok(ex.data?.metrics?.sleep_analysis?.daily?.length === 14, `get_structured_export(sleep) → ${ex.data?.metrics?.sleep_analysis?.daily?.length} days`);

  const nl = await c.call('query_health_data', { question: 'what is my average HRV?' });
  ok(nl.data?.interpreted?.includes('heart_rate_variability'), `query_health_data routed → "${nl.data?.interpreted}"`);

  const err = await c.call('get_health_metrics', { metric: 'does_not_exist' });
  ok(err.isError === true, 'unknown metric → graceful tool error (isError:true)');

  console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}\n`);
}

main().catch((e) => { console.error('FATAL', e); failures++; }).finally(() => {
  try { mcp?.kill(); } catch {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
});

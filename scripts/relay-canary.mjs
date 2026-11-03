#!/usr/bin/env node
// relay-canary.mjs - does the PUBLISHED health-export-mcp relay a LAN push into an agent's answer?
//
// Issue #538 asks whether the MCP relay (app -> HTTP/WebSocket push -> receiver -> cache -> MCP tools) works
// under real npm traffic. The product phones nothing home by design, so real pushes cannot be observed; the
// industry answer for software like that is a synthetic canary on the released artifact. This installs the
// exact tarball npm serves, starts it the way a user does (HEALTH_LISTEN=1, stdio MCP), pushes a payload over
// HTTP and over the WebSocket the iOS app uses, and asserts the pushed values come back through the tools.
// Negative paths are asserted too (bad token 401, DNS-rebinding Host 403), because a relay that accepts
// everything also "works".
//
//   node scripts/relay-canary.mjs [--version 1.10.2|latest] [--force] [--require-provenance] [--out result.json]
//   node scripts/relay-canary.mjs --dir .     # this checkout, no download (pre-publish gate)
//
// Runs automatically from release.yml after every publish (job `post-publish-canary`), which is the
// one moment its extra `npm pack` is invisible: the classifier in the app repo's npm_usage_signal.py
// already counts publish day and the day after as release burst. Issue PhilipAD/health-export-ai#538.
//
// COUNTER HYGIENE. `npm pack` is one more download of the package, and npm_usage_signal.py is deciding
// whether downloads are organic. So the canary only runs on a publish day or the day after, when the
// classifier already counts every download as release-burst, and skips otherwise unless --force.
// Exit: 0 pass or skipped, 1 a check failed, 2 could not run.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PKG = 'health-export-mcp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const version = opt('--version', 'latest');
const force = args.includes('--force');
const requireProvenance = args.includes('--require-provenance');
const outFile = opt('--out', '');
const localDir = opt('--dir', '');

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`); };
const finish = (code, extra = {}) => {
  const res = { package: PKG, ok: code === 0, checks, ...extra };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
  process.exit(code);
};
const npm = (a, opts = {}) => execFileSync('npm', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

// ---- resolve the version and apply the counter-hygiene guard
let resolved;
try {
  if (localDir) {
    resolved = `local:${path.basename(path.resolve(localDir))}`;
  } else {
  const time = JSON.parse(npm(['view', PKG, 'time', '--json']));
  resolved = version === 'latest' ? npm(['view', PKG, 'version']) : version;
  const published = new Date(time[resolved]);
  if (isNaN(published)) throw new Error(`no publish time for ${resolved}`);
  const dayMs = 86400000;
  const publishDay = Date.UTC(published.getUTCFullYear(), published.getUTCMonth(), published.getUTCDate());
  const ageDays = Math.floor((Date.now() - publishDay) / dayMs);
  if (ageDays > 1 && !force) {
    console.log(`SKIP ${PKG}@${resolved} was published ${ageDays} days ago; a canary download now would be an extra organic-looking fetch. Use --force to run anyway.`);
    finish(0, { skipped: true, version: resolved });
  }
  }
} catch (e) {
  console.error('could not resolve the package:', e.message);
  finish(2, { error: e.message });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-relay-canary-'));
const data = path.join(work, 'data');
fs.mkdirSync(data);
let mcp;
const cleanup = () => { try { mcp?.kill(); } catch {} fs.rmSync(work, { recursive: true, force: true }); };
process.on('exit', cleanup);

try {
  // ---- the exact artifact npm serves (npm verifies the tarball integrity on pack)
  let pkgDir;
  if (localDir) {
    pkgDir = path.resolve(localDir);
  } else {
    // npm view can show a version before the CDN serves its tarball: retry like the other release gates do.
    let tgz;
    for (let attempt = 1; attempt <= 8 && !tgz; attempt++) {
      try { tgz = npm(['pack', `${PKG}@${resolved}`, '--pack-destination', work, '--silent']).split('\n').pop(); }
      catch (e) { if (attempt === 8) throw e; console.log(`registry not serving ${PKG}@${resolved} yet (attempt ${attempt}/8), waiting 15s`); await sleep(15000); }
    }
    if (requireProvenance) {
      const att = npm(['view', `${PKG}@${resolved}`, 'dist.attestations.provenance.predicateType']);
      check('published with an npm provenance attestation (SLSA)', att.startsWith('https://slsa.dev/provenance'), att || 'no dist.attestations');
    }
    execFileSync('tar', ['-xzf', path.join(work, tgz), '-C', work]);
    pkgDir = path.join(work, 'package');
  }
  check(`using ${PKG}@${resolved}`, fs.existsSync(path.join(pkgDir, 'server.mjs')));

  const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const token = crypto.randomBytes(9).toString('hex');
  mcp = spawn('node', [path.join(pkgDir, 'server.mjs')], {
    env: { ...process.env, HEALTH_DATA_DIR: data, HEALTH_LISTEN: '1', HEALTH_LISTEN_HOST: '127.0.0.1', HEALTH_LISTEN_PORT: String(port), HEALTH_LISTEN_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errBuf = ''; mcp.stderr.on('data', (c) => { errBuf += c; });

  // ---- minimal stdio MCP client
  let id = 0, buf = ''; const pending = new Map();
  mcp.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    setTimeout(() => { if (pending.delete(n)) reject(new Error(`timeout ${method}`)); }, 8000);
  });
  const call = async (name, a = {}) => { const r = await rpc('tools/call', { name, arguments: a }); return r.result?.structuredContent ?? null; };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-canary', version: '1' } });
  check('MCP server initialises', init.result?.serverInfo?.name === 'health-export-ai', JSON.stringify(init.result?.serverInfo));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // wait for the in-process receiver to bind
  for (let i = 0; i < 40; i++) {
    const up = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (up) break; await new Promise((r) => setTimeout(r, 100));
  }

  const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  const payload = (steps) => ({ step_count: { unit: 'count', cumulative: true, daily: [{ d: day(2), v: steps }, { d: day(1), v: steps + 1 }] } });
  const post = (body, headers = {}) => new Promise((resolve) => {
    const req = import('node:http').then(({ default: http }) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/health-cache', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      r.on('error', (e) => resolve({ status: 0, body: String(e) })); r.end(JSON.stringify(body));
    });
  });

  // ---- negative paths first: a relay that accepts everything also "works"
  const bad = await post(payload(1), { 'x-health-token': 'WRONG' });
  check('wrong token is refused (401)', bad.status === 401, `got ${bad.status}`);
  const rebind = await post(payload(1), { 'x-health-token': token, host: `attacker.example.com:${port}` });
  check('DNS-rebinding Host is refused (403)', rebind.status === 403, `got ${rebind.status}`);

  // ---- HTTP push (the app's "Local network" path)
  const http1 = await post(payload(7000), { 'x-health-token': token });
  check('HTTP push accepted (200 ok)', http1.status === 200 && JSON.parse(http1.body || '{}').ok === true, `got ${http1.status} ${http1.body.slice(0, 80)}`);

  // ---- WebSocket push (the foreground real-time path), hand-rolled client as in the package's own test
  const wsAck = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET /health-cache-ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Health-Token: ${token}\r\n\r\n`);
    });
    let phase = 'handshake', acc = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (phase === 'handshake' && acc.toString().includes('\r\n\r\n')) {
        if (!acc.toString().startsWith('HTTP/1.1 101')) return reject(new Error('no 101: ' + acc.toString().slice(0, 40)));
        const body = Buffer.from(JSON.stringify({ heart_rate: { unit: 'count/min', cumulative: false, daily: [{ d: day(1), v: 61 }] } }));
        const mask = crypto.randomBytes(4); const masked = Buffer.from(body);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        const hdr = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([body.length >> 8, body.length & 255])]);
        sock.write(Buffer.concat([hdr, mask, masked])); phase = 'ack'; acc = Buffer.alloc(0);
      } else if (phase === 'ack' && acc.length >= 2) {
        sock.end(); resolve(JSON.parse(acc.subarray(2, 2 + (acc[1] & 0x7f)).toString('utf8')));
      }
    });
    sock.on('error', reject); setTimeout(() => reject(new Error('ws timeout')), 5000);
  }).catch((e) => ({ ok: false, error: e.message }));
  check('WebSocket push acknowledged', wsAck.ok === true, JSON.stringify(wsAck));

  // ---- the pushed values come back through the MCP tools, in the same process that received them
  const status = await call('get_mcp_status');
  check('get_mcp_status sees the pushed metrics', status?.ok === true && status.metricCount >= 2, JSON.stringify(status)?.slice(0, 160));
  const steps = await call('get_health_metrics', { metric: 'step_count', aggregation: 'sum' });
  const sum = steps?.step_count?.aggregate;
  check('HTTP-pushed step_count is readable through get_health_metrics', sum === 7000 + 7001, `aggregate=${sum}`);
  const hr = await call('get_health_metrics', { metric: 'heart_rate' });
  check('WebSocket-pushed heart_rate is readable', JSON.stringify(hr).includes('61'), JSON.stringify(hr)?.slice(0, 120));

  const failed = checks.filter((c) => !c.ok);
  if (failed.length && errBuf) console.error('server stderr:', errBuf.slice(-400));
  finish(failed.length ? 1 : 0, { version: resolved, port_bound: true });
} catch (e) {
  console.error('canary could not run:', e.message);
  finish(2, { version: resolved, error: e.message });
}

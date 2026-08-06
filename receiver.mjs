// receiver.mjs — optional, ZERO-DEPENDENCY LAN push listener for Health Export AI.
//
// Lets the iOS app push the health cache directly to this machine over the local network —
// the "WebSocket" path marketed alongside MCP — when the user can't/doesn't use a synced folder.
// It runs INSIDE the same Node process as the stdio MCP server (no separate daemon/bridge), so it
// MUST log only to stderr (stdout belongs to the MCP JSON-RPC stream).
//
//   POST /health-cache          (HTTP — reliable, works from iOS background uploads)
//   GET  /health-cache-ws       (WebSocket upgrade — foreground real-time push)
//   Both write <HEALTH_DATA_DIR>/.health-cache.json, which the MCP server then reads.
//
// Security:
//   - Binds 127.0.0.1 by default; HEALTH_LISTEN_HOST=0.0.0.0 for LAN.
//   - On a NON-loopback bind a token is MANDATORY — we fail closed (refuse to listen) without one.
//   - X-Health-Token is compared in constant time (HEALTH_LISTEN_TOKEN = the iOS pairing code).
//   - DNS-rebinding defense: reject any request carrying an Origin header (the native app sends none)
//     and require the Host header to be loopback or a numeric IP literal (not a registered domain).
//   - WS frame reader caps buffered bytes, honours close/ping control frames, and times out idle sockets.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BODY = 64 * 1024 * 1024;
const MAX_WS_BUF = 70 * 1024 * 1024;
const MAX_METRICS = 2000, MAX_DAYS = 8000;
const log = (...a) => process.stderr.write('[receiver] ' + a.map(String).join(' ') + '\n');

function expandTilde(p) {
  return (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;
}
function readJSON(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
// The merge base for an accumulated cache. ABSENT means start fresh; PRESENT-BUT-CORRUPT
// must never become {} and overwrite the whole history — quarantine it, then start fresh.
function readMergeBase(file, fb) {
  if (!fs.existsSync(file)) return fb;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { try { const bak = `${file}.corrupt-${process.pid}`; fs.renameSync(file, bak); log(`quarantined unreadable ${file} -> ${bak}`); } catch {} return fb; }
}
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

// Validate/sanitise a pushed summary so a malicious LAN client can't poison the agent's context.
function sanitize(incoming) {
  const out = {};
  if (!incoming || typeof incoming !== 'object') return out;
  let metrics = 0;
  for (const [name, m] of Object.entries(incoming)) {
    if (metrics >= MAX_METRICS) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) continue;          // strict metric-name allowlist
    if (!m || !Array.isArray(m.daily)) continue;
    const daily = [];
    for (const p of m.daily.slice(0, MAX_DAYS)) {
      if (!p || typeof p.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.d)) continue;
      const v = Number(p.v);
      if (!Number.isFinite(v)) continue;
      daily.push({ d: p.d, v });
    }
    if (!daily.length) continue;
    out[name] = { unit: typeof m.unit === 'string' ? m.unit.slice(0, 32) : '', cumulative: !!m.cumulative, daily };
    metrics++;
  }
  return out;
}

// Merge a pushed (sanitised) summary into the cache — union by metric+day, last-write-wins.
function mergeCache(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [name, m] of Object.entries(sanitize(incoming))) {
    const byDay = new Map((merged[name]?.daily || []).map((p) => [p.d, p.v]));
    for (const p of m.daily) byDay.set(p.d, p.v);
    merged[name] = { unit: m.unit || merged[name]?.unit || '', cumulative: !!m.cumulative,
      daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ d, v })) };
  }
  return merged;
}

function writeCache(dir, json) {
  const file = path.join(dir, '.health-cache.json');
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;  // unique → no concurrent-write race
  fs.mkdirSync(dir, { recursive: true });
  const merged = mergeCache(readMergeBase(file, {}), json);
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, file);
  log(`merged ${Object.keys(sanitize(json)).length} -> ${Object.keys(merged).length} metrics in ${file}`);
  return Object.keys(merged).length;
}

/// Start the HTTP + WebSocket listener. Returns the http.Server, or null if it refused to start.
export function startReceiver({
  dir = expandTilde(process.env.HEALTH_DATA_DIR || '.'),
  host = process.env.HEALTH_LISTEN_HOST || '127.0.0.1',
  port = Number(process.env.HEALTH_LISTEN_PORT || 27184),
  token = process.env.HEALTH_LISTEN_TOKEN || '',
  onCache = (json) => writeCache(dir, json),
} = {}) {
  // Fail closed: never expose an unauthenticated write endpoint on the network.
  if (!isLoopback(host) && !token) {
    log(`REFUSING to listen on non-loopback ${host} without HEALTH_LISTEN_TOKEN — set the iOS pairing code as the token.`);
    return null;
  }

  const tokenOk = (req) => {
    if (!token) return true;                                    // loopback-only, token optional
    const got = Buffer.from(String(req.headers['x-health-token'] || ''));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  // Reject browser-originated / DNS-rebinding requests; native iOS sends no Origin and an IP-literal Host.
  // A Host that is a domain name (not localhost / not an IP literal) is the rebinding vector → reject it.
  const hostOk = (req) => {
    if (req.headers['origin'] !== undefined) return false;
    const raw = String(req.headers['host'] || '');
    const v6 = raw.match(/^\[([^\]]+)\]/);                 // "[::1]:27184" → "::1"  (strip brackets BEFORE the colon split)
    const hn = (v6 ? v6[1] : raw.split(':')[0]).toLowerCase().replace(/%.*$/, ''); // strip port; strip IPv6 zone (%en0)
    if (!hn) return false;
    // loopback name, valid IPv4/IPv6 literal, or a private DNS name (Tailscale MagicDNS / mDNS). Browser
    // DNS-rebinding still can't pass: browsers always send an Origin header (rejected above) and a token is
    // mandatory on a non-loopback bind.
    return hn === 'localhost' || hn.endsWith('.ts.net') || hn.endsWith('.local') || net.isIP(hn) !== 0;
  };
  // Distinguish "wrong/blocked host" (403) from "bad token" (401) so the app can tell the user the real reason.
  const gate = (req) => {
    if (!hostOk(req)) return { ok: false, code: 403, msg: 'host not permitted' };
    if (!tokenOk(req)) return { ok: false, code: 401, msg: 'unauthorized — check pairing secret' };
    return { ok: true, code: 200, msg: 'ok' };
  };

  const json = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/health-cache') {
      const g = gate(req); if (!g.ok) return json(res, g.code, { ok: false, hae: true, error: g.msg });
      let body = '', tooBig = false;
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY && !tooBig) { tooBig = true; json(res, 413, { ok: false, hae: true, error: 'payload too large' }); req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig || res.writableEnded) return;
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return json(res, 400, { ok: false, hae: true, error: 'invalid JSON' }); }   // 400 = parse only
        if (parsed && parsed._test === true) return json(res, 200, { ok: true, hae: true, test: true }); // probe: never touch the cache
        try { const n = onCache(parsed); json(res, 200, { ok: true, hae: true, metrics: n }); }
        catch (e) { log('write failed', e.message); json(res, 500, { ok: false, hae: true, error: 'write failed: ' + (e.code || e.message) }); } // 500 = disk/write
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') { return json(res, 200, { ok: true, hae: true, port }); }
    json(res, 404, { ok: false, hae: true, error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const up = String(req.headers['upgrade'] || '').toLowerCase() === 'websocket';
    if (!up || !key || !req.url.startsWith('/health-cache-ws')) { socket.destroy(); return; }
    const g = gate(req); if (!g.ok) { socket.write(`HTTP/1.1 ${g.code} ${g.msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + WS_GUID, 'binary').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let buf = Buffer.alloc(0);
    socket.setTimeout(30_000, () => socket.destroy());          // drop idle/slowloris sockets
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_WS_BUF) { log('ws buffer cap exceeded'); socket.destroy(); return; }
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) { socket.end(); return; }             // close
      if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x00])); buf = Buffer.alloc(0); return; } // ping → pong
      if (opcode === 0xa) { buf = Buffer.alloc(0); return; }     // pong → ignore
      const msg = decodeTextFrame(buf);
      if (msg === null) return;                                  // incomplete or unsupported → wait
      try { const n = onCache(JSON.parse(msg)); socket.write(encodeTextFrame(JSON.stringify({ ok: true, metrics: n }))); }
      catch (e) { log('bad WS json', e.message); socket.write(encodeTextFrame(JSON.stringify({ ok: false }))); }
      socket.end();
    });
    socket.on('error', (e) => log('ws socket error', e.message));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log(`PORT ${port} IN USE — stop the other process, or set HEALTH_LISTEN_PORT to a free port (e.g. ${port + 1}).`);
    else if (e.code === 'EACCES') log(`PERMISSION DENIED binding ${host}:${port} — use a port >= 1024.`);
    else if (e.code === 'EADDRNOTAVAIL') log(`ADDRESS ${host} NOT AVAILABLE here — use 0.0.0.0 or a local IP.`);
    else log('server error', e.message);
  });
  server.listen(port, host, () => {
    log(`listening on ${host}:${port}${token ? ' (token required)' : ' (loopback only)'}`);
    if (!isLoopback(host)) {                        // print the exact address(es) to type on the iPhone
      const addrs = [];
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
      }
      const hn = os.hostname(); addrs.push(hn.includes('.') ? hn : `${hn}.local`);
      for (const a of addrs) log(`  -> on your iPhone, enter:  ${a}:${port}`);
    }
  });
  return server;
}

// ---- minimal RFC 6455 (single masked text frame in; unmasked text frame out) ----

function decodeTextFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
  if (!fin || opcode !== 0x1 || !masked) return null;        // require a single masked text frame
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (len > MAX_WS_BUF) return null;
  if (buf.length < off + 4 + len) return null;               // wait for the rest
  const mask = buf.subarray(off, off + 4), payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return payload.toString('utf8');
}

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8'), len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

// Standalone run (also importable by server.mjs). pathToFileURL handles spaces in the path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startReceiver();
}

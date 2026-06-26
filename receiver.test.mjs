// Zero-dependency test for receiver.mjs: HTTP POST (token-gated) + a hand-rolled WebSocket client.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { startReceiver } from './receiver.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recv-'));
const TOKEN = 'PAIR-CODE-123';
const PORT = 27199;
const server = startReceiver({ dir, host: '127.0.0.1', port: PORT, token: TOKEN });
const cacheFile = path.join(dir, '.health-cache.json');
const ok = (m) => console.log('  ✓', m);

function post(pathname, body, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.end(JSON.stringify(body));
  });
}

function wsPush(payload, token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET /health-cache-ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Health-Token: ${token}\r\n\r\n`);
    });
    let phase = 'handshake', acc = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (phase === 'handshake' && acc.toString().includes('\r\n\r\n')) {
        assert.ok(acc.toString().startsWith('HTTP/1.1 101'), 'expected 101 switching protocols');
        // send a masked text frame
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(body); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        let hdr;
        if (body.length < 126) hdr = Buffer.from([0x81, 0x80 | body.length]);
        else { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(body.length, 2); }
        sock.write(Buffer.concat([hdr, mask, masked]));
        phase = 'ack'; acc = Buffer.alloc(0);
      } else if (phase === 'ack' && acc.length >= 2) {
        const len = acc[1] & 0x7f; // server frames are unmasked
        const text = acc.subarray(2, 2 + len).toString('utf8');
        sock.end(); resolve(JSON.parse(text));
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 4000);
  });
}

const CACHE = { step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-06-25', v: 9500 }] } };

const r1 = await post('/health-cache', CACHE, { 'x-health-token': TOKEN });
assert.equal(r1.status, 200); assert.ok(JSON.parse(r1.body).ok); ok('HTTP POST (valid token) → 200 + ok');
assert.ok(fs.existsSync(cacheFile)); ok('HTTP POST wrote .health-cache.json');
assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).step_count.daily[0], { d: '2026-06-25', v: 9500 });
ok('cache file content matches pushed payload');

const r2 = await post('/health-cache', CACHE, { 'x-health-token': 'WRONG' });
assert.equal(r2.status, 401); ok('HTTP POST (bad token) → 401');

fs.rmSync(cacheFile);
const ack = await wsPush({ heart_rate: { unit: 'count/min', cumulative: false, daily: [{ d: '2026-06-25', v: 64 }] } }, TOKEN);
assert.ok(ack.ok); ok('WebSocket push → ack ok');
assert.ok(fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).heart_rate);
ok('WebSocket push wrote .health-cache.json');

// --- Host-header / DNS-rebinding defense (the Host header is checked, not the TCP peer) ---
const rb = await post('/health-cache', CACHE, { 'x-health-token': TOKEN, host: `[::1]:${PORT}` });
assert.equal(rb.status, 200); ok('Host [::1]:port (IPv6 loopback literal) → 200');

const rc = await post('/health-cache', CACHE, { 'x-health-token': TOKEN, host: `127.0.0.1:${PORT}` });
assert.equal(rc.status, 200); ok('Host 127.0.0.1:port (IPv4 literal) → 200');

const rd = await post('/health-cache', CACHE, { 'x-health-token': TOKEN, host: `1.2.3.4.5:${PORT}` });
assert.equal(rd.status, 401); ok('malformed-IP Host (1.2.3.4.5) → 401');

const re = await post('/health-cache', CACHE, { 'x-health-token': TOKEN, host: `attacker.example.com:${PORT}` });
assert.equal(re.status, 401); ok('domain-name Host (DNS-rebinding vector) → 401');

const rf = await post('/health-cache', CACHE, { 'x-health-token': TOKEN, host: `localhost:${PORT}`, origin: 'http://evil.example.com' });
assert.equal(rf.status, 401); ok('any Origin header present (browser/rebinding) → 401');

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ receiver: ALL PASSED');

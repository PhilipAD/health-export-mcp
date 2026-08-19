// The bin-symlink regression. `npx pkg` and `npm i -g pkg` both invoke the binary through a
// symlink in node_modules/.bin, so process.argv[1] is the LINK while import.meta.url is the real
// file. v1.4.0 compared the two directly: the check was false under npx, the protocol loop never
// started, and the process exited 0 with no output. Every MCP client reported only
// "connection closed" a second in, and the server looked fine when run directly with `node`.
//
// This runs the server the way npx does and asserts it actually speaks the protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function initializeVia(cmdPath) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cmdPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', done = false;
    const finish = (r) => { if (!done) { done = true; try { p.kill(); } catch {} resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), 15000);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"result"')) { clearTimeout(timer); finish({ ok: true, out }); }
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (!out.includes('"result"')) finish({ ok: false, why: `exited ${code} with no response` });
    });
    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n');
  });
}

test('server answers initialize when launched through a bin SYMLINK (the npx path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-binlink-'));
  const link = path.join(dir, 'health-export-mcp');
  fs.symlinkSync(path.join(HERE, 'server.mjs'), link);
  const r = await initializeVia(link);
  assert.ok(r.ok, `server must run through a symlink, got: ${r.why}`);
});

test('server still answers initialize when launched by its real path', async () => {
  const r = await initializeVia(path.join(HERE, 'server.mjs'));
  assert.ok(r.ok, `direct launch must keep working, got: ${r.why}`);
});

test('receiver starts through a symlink too (same guard, same trap)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-rxlink-'));
  const link = path.join(dir, 'receiver');
  fs.symlinkSync(path.join(HERE, 'receiver.mjs'), link);
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [link], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HEALTH_LISTEN_PORT: '0' },
    });
    let s = '';
    const fin = (v) => { try { p.kill(); } catch {} resolve(v); };
    const t = setTimeout(() => fin(s), 6000);
    const grab = (d) => { s += d; if (s.length) { clearTimeout(t); setTimeout(() => fin(s), 400); } };
    p.stdout.on('data', grab); p.stderr.on('data', grab);
    p.on('exit', () => { clearTimeout(t); fin(s); });
  });
  assert.notEqual(out.trim(), '', 'receiver produced no output at all through a symlink');
});

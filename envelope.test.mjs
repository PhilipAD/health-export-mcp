// Tests for encrypted exports (envelope.mjs) and their readers: the MCP server and the LAN receiver.
//
// Three groups:
//   1. The envelope: round trip, wrong passphrase, tampering, AAD binding, version, strict parsing,
//      passphrase sources, plaintext passthrough, and that no error message carries the passphrase.
//   2. Cross-language: the fixture produced by the Swift encoder (Tests/Fixtures/
//      encrypted-envelope-swift.json) opens here AND is reproduced byte-for-byte by this module; the
//      Node fixture is regenerated exactly (the Swift test opens and reproduces it in turn).
//   3. Pipeline: the directory the iOS export pipeline wrote with encryption on (Tests/Fixtures/
//      encrypted-export, produced by ExportEncryptionTests.testPipelineWritesOnlySealedDataToEncryptedDestinations)
//      is served by the real server.mjs over stdio; plus the receiver's encrypted push path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sealEnvelope, openEnvelope, openEnvelopeJSON, maybeOpen, isEnvelope, parseHeader, deriveKeys,
  associatedData, configuredPassphrase, EnvelopeError,
} from './envelope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASS = 'correct horse battery staple';
const FAST = 100_000;   // inside the accepted window; full strength is exercised by the fixtures

// The fixtures live in the app repo's Tests/Fixtures; the public server repo carries copies in
// test/fixtures. Either location works.
function fixturePath(name) {
  for (const p of [path.join(HERE, '..', 'Tests', 'Fixtures', name), path.join(HERE, 'test', 'fixtures', name)]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`fixture ${name} not found`);
}
const loadFixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));

// ---- 1. the envelope -------------------------------------------------------

test('round trip', () => {
  const env = sealEnvelope('{"step_count":8432}', PASS, { iter: FAST });
  assert.equal(env.format, 'metricbridge.enc');
  assert.equal(env.v, 1);
  assert.ok(isEnvelope(env));
  assert.equal(openEnvelope(env, PASS).toString('utf8'), '{"step_count":8432}');
  assert.deepEqual(openEnvelopeJSON(env, PASS), { step_count: 8432 });
});

test('a fresh nonce per seal', () => {
  const salt = crypto.randomBytes(16);
  const a = sealEnvelope('same', PASS, { iter: FAST, salt });
  const b = sealEnvelope('same', PASS, { iter: FAST, salt });
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ct, b.ct);
});

test('wrong passphrase is reported as a mismatch, never garbage', () => {
  const env = sealEnvelope('secret', PASS, { iter: FAST });
  assert.throws(() => openEnvelope(env, 'correct horse battery stapler'),
    (e) => e instanceof EnvelopeError && e.code === 'passphrase_mismatch');
});

test('missing passphrase says exactly what to set', () => {
  const env = sealEnvelope('secret', PASS, { iter: FAST });
  assert.throws(() => openEnvelope(env, null),
    (e) => e.code === 'passphrase_missing' && /HEALTH_EXPORT_PASSPHRASE/.test(e.message));
});

test('tampered ciphertext, tag or nonce fails the integrity check', () => {
  const env = sealEnvelope('heart rate 61', PASS, { iter: FAST });
  const flip = (b64, i) => { const b = Buffer.from(b64, 'base64'); b[i < 0 ? b.length + i : i] ^= 1; return b.toString('base64'); };
  for (const bad of [{ ...env, ct: flip(env.ct, 0) }, { ...env, ct: flip(env.ct, -1) }, { ...env, nonce: flip(env.nonce, 3) }]) {
    assert.throws(() => openEnvelope(bad, PASS), (e) => e.code === 'tampered');
  }
});

test('the header is bound as AAD: right key and nonce without the header AAD is refused', () => {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const { encKey, kcv } = deriveKeys(PASS, salt, FAST);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([c.update('bound to its header'), c.final(), c.getAuthTag()]);
  const env = { alg: 'A256GCM', ct: ct.toString('base64'), format: 'metricbridge.enc', iter: FAST,
    kcv: kcv.toString('base64'), kdf: 'PBKDF2-HMAC-SHA256', nonce: nonce.toString('base64'),
    salt: salt.toString('base64'), v: 1 };
  assert.throws(() => openEnvelope(env, PASS), (e) => e.code === 'tampered');
  // ...and with the AAD it opens, so the only difference above was the AAD.
  const c2 = crypto.createCipheriv('aes-256-gcm', encKey, nonce, { authTagLength: 16 });
  c2.setAAD(associatedData({ v: 1, iter: FAST, salt, kcv, nonce }));
  const ct2 = Buffer.concat([c2.update('bound to its header'), c2.final(), c2.getAuthTag()]);
  assert.equal(openEnvelope({ ...env, ct: ct2.toString('base64') }, PASS).toString(), 'bound to its header');
});

test('a newer envelope version is refused with an upgrade hint', () => {
  const env = { ...sealEnvelope('x', PASS, { iter: FAST }), v: 2 };
  assert.ok(isEnvelope(env), 'still recognised as encrypted');
  assert.throws(() => openEnvelope(env, PASS), (e) => e.code === 'unsupported_version' && /Update/.test(e.message));
});

test('strict header parsing', () => {
  const good = sealEnvelope('x', PASS, { iter: FAST });
  const bads = [
    { v: true }, { v: 1.5 }, { alg: 'A128GCM' }, { kdf: 'scrypt' }, { iter: 1000 }, { iter: 50_000_000 },
    { iter: '600000' }, { salt: Buffer.alloc(8).toString('base64') }, { nonce: Buffer.alloc(16).toString('base64') },
    { kcv: 'not base64!' }, { ct: Buffer.alloc(4).toString('base64') }, { ct: undefined },
    { salt: good.salt.replace(/=/g, '') }, { ct: good.ct + '\n' },   // non-canonical base64, as Swift refuses
  ];
  for (const patch of bads) {
    assert.throws(() => openEnvelope({ ...good, ...patch }, PASS), EnvelopeError, JSON.stringify(patch));
  }
});

test('NFC: composed and decomposed spellings of a passphrase derive the same key', () => {
  const composed = 'crème brûlée passphrase';
  const decomposed = composed.normalize('NFD');
  assert.notEqual(composed, decomposed);
  const env = sealEnvelope('x', composed, { iter: FAST });
  assert.equal(openEnvelope(env, decomposed).toString(), 'x');
});

test('plaintext passes straight through maybeOpen', () => {
  const plain = { step_count: { daily: [] } };
  assert.equal(maybeOpen(plain, null), plain);
  assert.equal(isEnvelope([1, 2]), false);
  assert.equal(isEnvelope(null), false);
});

test('passphrase sources: env var, then a file with one trailing newline stripped; empty is unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pass-'));
  const f = path.join(dir, 'pass.txt');
  fs.writeFileSync(f, 'from a file\n');
  assert.equal(configuredPassphrase({ HEALTH_EXPORT_PASSPHRASE: 'direct' }), 'direct');
  assert.equal(configuredPassphrase({ HEALTH_EXPORT_PASSPHRASE_FILE: f }), 'from a file');
  assert.equal(configuredPassphrase({ HEALTH_EXPORT_PASSPHRASE: '', HEALTH_EXPORT_PASSPHRASE_FILE: f }), 'from a file');
  assert.equal(configuredPassphrase({ HEALTH_EXPORT_PASSPHRASE: '' }), null, 'the .mcpb maps a blank field to ""');
  assert.throws(() => configuredPassphrase({ HEALTH_EXPORT_PASSPHRASE_FILE: path.join(dir, 'nope') }),
    (e) => e.code === 'passphrase_file_unreadable');
});

test('no error message ever contains the passphrase', () => {
  const secret = 'distinctive-passphrase-7741';
  const env = sealEnvelope('x', secret, { iter: FAST });
  const msgs = [];
  for (const [e, p] of [[env, 'distinctive-passphrase-7742'], [{ ...env, ct: Buffer.alloc(20).toString('base64') }, secret], [{ ...env, v: 9 }, secret]]) {
    try { openEnvelope(e, p); } catch (err) { msgs.push(err.message); }
  }
  assert.equal(msgs.length, 3);
  for (const m of msgs) assert.ok(!m.includes('distinctive-passphrase'), m);
});

// ---- 2. cross-language fixtures --------------------------------------------

test('the Swift-produced envelope opens here and this module reproduces it byte-for-byte', () => {
  const f = loadFixture('encrypted-envelope-swift.json');
  assert.equal(openEnvelope(f.envelope, f.passphrase).toString('utf8'), f.plaintext);
  const mine = sealEnvelope(f.plaintext, f.passphrase, {
    salt: Buffer.from(f.saltHex, 'hex'), nonce: Buffer.from(f.nonceHex, 'hex'), iter: f.iter });
  assert.deepEqual(mine, f.envelope, 'same KDF, HKDF labels, AAD and ciphertext as CryptoKit');
});

test('the committed Node fixture is exactly what this module produces', () => {
  const f = loadFixture('encrypted-envelope-node.json');
  const mine = sealEnvelope(f.plaintext, f.passphrase, {
    salt: Buffer.from(f.saltHex, 'hex'), nonce: Buffer.from(f.nonceHex, 'hex'), iter: f.iter });
  assert.deepEqual(mine, f.envelope);
  assert.equal(openEnvelope(f.envelope, f.passphrase).toString('utf8'), f.plaintext);
});

// ---- 3. readers: the MCP server over stdio, doctor, and the receiver --------

const PIPE_PASS = 'correct horse battery staple';   // ExportEncryptionTests.passphrase

function startServer(env) {
  const proc = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', stderr = ''; const pending = new Map(); let id = 0;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr += c; });
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
    async init() {
      await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'enc-test', version: '1' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    call,
    stderr: () => stderr,
    stop: () => proc.kill(),
  };
}

// The pipeline fixture is copied to a temp dir so nothing the server does can touch the committed copy.
function pipelineDir() {
  const src = path.dirname(fixturePath(path.join('encrypted-export', '.health-cache.json')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-enc-pipe-'));
  for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(dir, n));
  return dir;
}

test('pipeline fixture: every data file the iOS pipeline wrote is sealed (nothing readable on disk)', () => {
  const dir = pipelineDir();
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.json')) continue;
    const text = fs.readFileSync(path.join(dir, n), 'utf8');
    assert.ok(isEnvelope(JSON.parse(text)), `${n} is an envelope`);
    assert.ok(!text.includes('step_count'), `${n} leaks nothing`);
  }
  assert.equal(parseHeader(JSON.parse(fs.readFileSync(path.join(dir, '.health-cache.json'), 'utf8'))).iter, 600000,
    'the app seals at full OWASP strength');
});

test('pipeline fixture: the MCP server decrypts the iOS export transparently with the passphrase', async () => {
  const s = startServer({ HEALTH_DATA_DIR: pipelineDir(), HEALTH_EXPORT_PASSPHRASE: PIPE_PASS });
  try {
    await s.init();
    const st = await s.call('get_mcp_status');
    assert.equal(st.isError, false);
    assert.equal(st.data.ok, true);
    assert.equal(st.data.encrypted, true);
    assert.ok(st.data.metrics.includes('step_count'));
    const m = await s.call('get_health_metrics', { metric: 'step_count' });
    assert.equal(m.isError, false, m.text);
    const values = JSON.stringify(m.data);
    assert.ok(values.includes('8432') && values.includes('7001'), 'the values the Swift pipeline exported');
    const hr = await s.call('get_health_metrics', { metric: 'heart_rate' });
    assert.ok(JSON.stringify(hr.data).includes('61'));
    const ev = await s.call('list_events');
    assert.equal(ev.isError, false, 'the sealed context files open too');
    assert.ok(!s.stderr().includes(PIPE_PASS), 'the passphrase is never logged');
  } finally { s.stop(); }
});

test('pipeline fixture: without a passphrase the server explains instead of reporting "no data"', async () => {
  const s = startServer({ HEALTH_DATA_DIR: pipelineDir() });
  try {
    await s.init();
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.ok, false);
    assert.equal(st.data.encrypted, true);
    assert.equal(st.data.encryptionError, 'passphrase_missing');
    assert.match(st.data.note, /HEALTH_EXPORT_PASSPHRASE/);
    const m = await s.call('get_health_metrics', { metric: 'step_count' });
    assert.equal(m.isError, true);
    assert.match(m.text, /encrypted/);
  } finally { s.stop(); }
});

test('pipeline fixture: a wrong passphrase is named as such', async () => {
  const s = startServer({ HEALTH_DATA_DIR: pipelineDir(), HEALTH_EXPORT_PASSPHRASE: 'not the passphrase' });
  try {
    await s.init();
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.encryptionError, 'passphrase_mismatch');
    assert.ok(!JSON.stringify(st.data).includes('not the passphrase'));
  } finally { s.stop(); }
});

test('doctor reports encryption state and never prints the passphrase', () => {
  const dir = pipelineDir();
  const run = (env) => execFileSync(process.execPath, [path.join(HERE, 'server.mjs'), '--doctor'],
    { env: { PATH: process.env.PATH, HEALTH_DATA_DIR: dir, ...env }, encoding: 'utf8' });
  const without = run({});
  assert.match(without, /encryption:\s+on, NO PASSPHRASE/);
  const withPass = run({ HEALTH_EXPORT_PASSPHRASE: PIPE_PASS });
  assert.match(withPass, /encryption:\s+on, passphrase configured/);
  assert.ok(!withPass.includes(PIPE_PASS));
});

test('an envelope that opens to non-JSON is reported as a damaged export, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-enc-corrupt-'));
  // Authenticates under the passphrase, but the plaintext is a truncated write (the app seals such
  // leftovers as raw bytes rather than leave them readable).
  fs.writeFileSync(path.join(dir, '.health-cache.json'),
    JSON.stringify(sealEnvelope('{"step_count": {"unit": "count", "dai', PIPE_PASS, { iter: FAST })));
  const s = startServer({ HEALTH_DATA_DIR: dir, HEALTH_EXPORT_PASSPHRASE: PIPE_PASS });
  try {
    await s.init();
    const st = await s.call('get_mcp_status');
    assert.equal(st.isError, false, st.text);
    assert.equal(st.data.ok, false);
    assert.equal(st.data.encrypted, true);
    assert.equal(st.data.encryptionError, 'corrupt');
    assert.match(st.data.note, /damaged/);
    assert.ok(!JSON.stringify(st.data).includes(PIPE_PASS));
  } finally { s.stop(); }
});

test('a plaintext export still reads exactly as before with a passphrase configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-plain-'));
  fs.writeFileSync(path.join(dir, '.health-cache.json'),
    JSON.stringify({ step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-10-01', v: 1234 }] } }));
  const s = startServer({ HEALTH_DATA_DIR: dir, HEALTH_EXPORT_PASSPHRASE: PIPE_PASS });
  try {
    await s.init();
    const st = await s.call('get_mcp_status');
    assert.equal(st.data.ok, true);
    assert.equal(st.data.encrypted, false);
    assert.ok(JSON.stringify((await s.call('get_health_metrics', { metric: 'step_count' })).data).includes('1234'));
  } finally { s.stop(); }
});

// ---- receiver -----------------------------------------------------------------

const { startReceiver } = await import('./receiver.mjs');

function post(port, body, token) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health-cache', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-health-token': token } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

function receiver(dir, port, passphrase) {
  return new Promise((resolve) => {
    const srv = startReceiver({ dir, host: '127.0.0.1', port, token: 'TOK', passphrase: () => passphrase,
      onCache: undefined });
    srv.on('listening', () => resolve(srv));
  });
}

const summary = { step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-10-01', v: 8432 }] } };

test('receiver: an encrypted LAN push is decrypted and merged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recv-enc-'));
  const prev = process.env.HEALTH_EXPORT_PASSPHRASE;
  process.env.HEALTH_EXPORT_PASSPHRASE = PASS;   // the default onCache path reads it for the merge base
  const srv = await receiver(dir, 27211, PASS);
  try {
    const r = await post(27211, sealEnvelope(JSON.stringify(summary), PASS, { iter: FAST }), 'TOK');
    assert.equal(r.status, 200, r.body);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.health-cache.json'), 'utf8'));
    assert.equal(cache.step_count.daily[0].v, 8432, 'stored as plaintext on this computer (the local end)');
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.HEALTH_EXPORT_PASSPHRASE; else process.env.HEALTH_EXPORT_PASSPHRASE = prev;
  }
});

test('receiver: no passphrase or the wrong one is a 422 with a machine reason the app explains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recv-enc-'));
  const none = await receiver(dir, 27212, null);
  try {
    const r = await post(27212, sealEnvelope(JSON.stringify(summary), PASS, { iter: FAST }), 'TOK');
    assert.equal(r.status, 422);
    assert.equal(JSON.parse(r.body).reason, 'passphrase_missing');
    assert.ok(!fs.existsSync(path.join(dir, '.health-cache.json')), 'nothing written');
  } finally { none.close(); }
  const wrong = await receiver(dir, 27213, 'the wrong passphrase');
  try {
    const r = await post(27213, sealEnvelope(JSON.stringify(summary), PASS, { iter: FAST }), 'TOK');
    assert.equal(r.status, 422);
    assert.equal(JSON.parse(r.body).reason, 'passphrase_mismatch');
    assert.ok(!r.body.includes('the wrong passphrase'));
  } finally { wrong.close(); }
});

test('receiver: a sealed merge base stays sealed under the same salt (no plaintext left behind)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recv-enc-'));
  const base = sealEnvelope(JSON.stringify({ heart_rate: { unit: 'count/min', cumulative: false, daily: [{ d: '2026-09-30', v: 60 }] } }),
    PASS, { iter: FAST });
  fs.writeFileSync(path.join(dir, '.health-cache.json'), JSON.stringify(base));
  const prev = process.env.HEALTH_EXPORT_PASSPHRASE;
  process.env.HEALTH_EXPORT_PASSPHRASE = PASS;
  const srv = await receiver(dir, 27214, PASS);
  try {
    const r = await post(27214, summary, 'TOK');   // a plaintext push, merged into the sealed base
    assert.equal(r.status, 200, r.body);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.health-cache.json'), 'utf8'));
    assert.ok(isEnvelope(onDisk));
    assert.equal(onDisk.salt, base.salt, 'same salt, so the app (which holds only that key) can still read it');
    const merged = openEnvelopeJSON(onDisk, PASS);
    assert.ok(merged.heart_rate && merged.step_count);
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.HEALTH_EXPORT_PASSPHRASE; else process.env.HEALTH_EXPORT_PASSPHRASE = prev;
  }
});

test('CLI: node envelope.mjs open prints the plaintext, and refuses cleanly without a passphrase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-cli-'));
  const f = path.join(dir, 'body.json');
  fs.writeFileSync(f, JSON.stringify(sealEnvelope('{"ok":1}', PASS, { iter: FAST })));
  const out = execFileSync(process.execPath, [path.join(HERE, 'envelope.mjs'), 'open', f],
    { env: { PATH: process.env.PATH, HEALTH_EXPORT_PASSPHRASE: PASS }, encoding: 'utf8' });
  assert.equal(out, '{"ok":1}');
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'envelope.mjs'), 'open', f],
    { env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: 'pipe' }), /encrypted/);
});

test('receiver: HEALTH_REQUIRE_ENCRYPTED refuses plaintext pushes but still takes sealed ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-recv-req-'));
  const srv = await new Promise((resolve) => {
    const s = startReceiver({ dir, host: '127.0.0.1', port: 27215, token: 'TOK', passphrase: () => PASS, requireEncrypted: () => true });
    s.on('listening', () => resolve(s));
  });
  try {
    const plain = await post(27215, summary, 'TOK');
    assert.equal(plain.status, 422);
    assert.equal(JSON.parse(plain.body).reason, 'encryption_required');
    const probe = await post(27215, { _test: true }, 'TOK');
    assert.equal(probe.status, 200, 'the connection test probe still works');
    const sealed = await post(27215, sealEnvelope(JSON.stringify(summary), PASS, { iter: FAST }), 'TOK');
    assert.equal(sealed.status, 200, sealed.body);
  } finally { srv.close(); }
});

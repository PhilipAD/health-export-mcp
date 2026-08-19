// Tests for the prompt library and the house typography rule: NO EM DASHES (U+2014) OR EN DASHES
// (U+2013) in anything user-visible. The rule exists because these strings end up in agent answers
// and PDFs where the dash is the single most reliable "a model wrote this" tell; the contract bans
// it from every payload. Checked three ways: the prompt objects, every string the tool surface
// declares, and a source scan of every string literal in the shipped modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEALTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-prompts-'));

const { PROMPTS } = await import('./prompts.mjs');
const { TOOLS, SERVER } = await import('./server.mjs');

const DASH = /[–—]/;

test('at least 22 prompts, each with a unique snake_case name, description and text', () => {
  assert.ok(PROMPTS.length >= 22, `expected >= 22 prompts, got ${PROMPTS.length}`);
  const names = PROMPTS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'prompt names must be unique');
  for (const p of PROMPTS) {
    assert.match(p.name, /^[a-z0-9_]+$/, `${p.name}: snake_case names only`);
    assert.ok(typeof p.description === 'string' && p.description.length > 10, `${p.name}: description`);
    assert.ok(typeof p.text === 'string' && p.text.length > 100, `${p.name}: substantial text`);
  }
});

test('the library is plain JSON, vendorable by the iOS app', () => {
  // A function or class instance anywhere would silently drop on JSON.stringify; a round-trip
  // must reproduce the array exactly.
  assert.deepEqual(JSON.parse(JSON.stringify(PROMPTS)), PROMPTS);
});

test('every declared {{placeholder}} corresponds to a declared argument', () => {
  for (const p of PROMPTS) {
    const placeholders = [...p.text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const declared = (p.arguments || []).map((a) => a.name);
    for (const ph of placeholders) {
      assert.ok(declared.includes(ph), `${p.name}: placeholder {{${ph}}} has no declared argument`);
    }
    for (const d of declared) {
      assert.ok(placeholders.includes(d), `${p.name}: argument ${d} never appears in the text`);
    }
  }
});

test('no prompt contains an em dash, an en dash, or prescriptive vocabulary', () => {
  for (const p of PROMPTS) {
    const all = JSON.stringify(p);
    assert.doesNotMatch(all, DASH, `${p.name}: em/en dash found`);
    assert.doesNotMatch(p.text, /\bshould\b/i, `${p.name}: prompts describe, they do not "should"`);
    assert.doesNotMatch(p.text, /\breadiness\b|\brisk score\b/i, `${p.name}: banned verdict vocabulary`);
  }
});

test('every tool description and schema string is dash-free too', () => {
  assert.equal(TOOLS.length, 14);
  assert.equal(SERVER.version, '1.4.3');
  const scan = (val, where) => {
    if (typeof val === 'string') assert.doesNotMatch(val, DASH, `em/en dash in ${where}: ${val.slice(0, 60)}`);
    else if (Array.isArray(val)) val.forEach((v, i) => scan(v, `${where}[${i}]`));
    else if (val && typeof val === 'object') for (const [k, v] of Object.entries(val)) scan(v, `${where}.${k}`);
  };
  for (const t of TOOLS) {
    scan(t.description, `${t.name}.description`);
    scan(t.inputSchema, `${t.name}.inputSchema`);
  }
});

test('no string literal in any shipped module carries an em/en dash', () => {
  // Source-level check: dashes may survive only inside comments (the historical "why" comments
  // keep theirs). A line fails when a dash appears before any // marker, which catches every
  // string literal without needing a JS parser.
  for (const file of ['server.mjs', 'healthstore.mjs', 'events.mjs', 'prompts.mjs', 'demo.mjs', 'receiver.mjs']) {
    const lines = fs.readFileSync(path.join(HERE, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const di = line.search(DASH);
      if (di < 0) return;
      const ci = line.indexOf('//');
      assert.ok(ci >= 0 && ci < di, `${file}:${i + 1}: em/en dash outside a comment: ${line.trim().slice(0, 80)}`);
    });
  }
});

test('prompts/get renders every prompt into messages, dash-free, over real stdio', async () => {
  const proc = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env },
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
  try {
    await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const list = await req('prompts/list');
    assert.equal(list.result.prompts.length, PROMPTS.length);
    for (const p of list.result.prompts) {
      const got = await req('prompts/get', { name: p.name });
      const msgs = got.result?.messages;
      assert.ok(Array.isArray(msgs) && msgs.length === 1, `${p.name}: one message`);
      assert.equal(msgs[0].role, 'user');
      assert.ok(msgs[0].content?.text?.length > 100, `${p.name}: rendered text`);
      assert.doesNotMatch(msgs[0].content.text, DASH, `${p.name}: rendered text carries a dash`);
      // With no arguments supplied, placeholders resolve to an instruction, never a raw {{hole}}.
      assert.doesNotMatch(msgs[0].content.text, /\{\{\w+\}\}/, `${p.name}: unresolved placeholder`);
    }
    const missing = await req('prompts/get', { name: 'does_not_exist' });
    assert.ok(missing.error, 'unknown prompt is a protocol error');
  } finally {
    proc.kill();
  }
});

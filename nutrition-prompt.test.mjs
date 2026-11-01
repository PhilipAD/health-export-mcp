// nutrition_week_summary (#401, Bevel parity item 10a): the agent-side counterpart of the nutrition
// aliases in Ask. MetricBridge logs no food; it reads what a food app wrote to Apple Health. The
// rules this prompt carries are the ones a generated answer most easily gets wrong, so each one is
// pinned here: means over LOGGED days only, an unlogged day is absent rather than zero, sodium is
// stored in grams, and the answer describes the numbers without advising on diet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEALTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-nutrition-prompt-'));

const { PROMPTS } = await import('./prompts.mjs');
const { METRIC_CATALOG } = await import('./metric-catalog.mjs');
const prompt = PROMPTS.find((p) => p.name === 'nutrition_week_summary');
const DASH = /[–—]/;

test('nutrition_week_summary is served and names only metrics the catalog ships', () => {
  assert.ok(prompt, 'nutrition_week_summary is in the prompt library');
  assert.ok(prompt.description.length > 10);
  const known = new Set(METRIC_CATALOG.map((m) => m[0]));
  const named = [...prompt.text.matchAll(/\b(dietary_[a-z_]+|active_energy|basal_energy_burned)\b/g)].map((m) => m[1]);
  for (const m of ['dietary_energy', 'dietary_protein', 'dietary_carbohydrates', 'dietary_fat_total',
                   'dietary_fiber', 'dietary_sugar', 'dietary_sodium']) {
    assert.ok(named.includes(m), `reads ${m}`);
  }
  for (const m of named) assert.ok(known.has(m), `${m} is a real catalog metric`);
});

test('means are over logged days only, and an unlogged day is absent, never zero', () => {
  const t = prompt.text;
  assert.match(t, /logged only when dietary_energy is above 0/);
  assert.match(t, /mean per logged day/);
  assert.match(t, /absent, never zero/);
  // Coverage before conclusions, like every prompt in the library.
  assert.ok(t.indexOf('Coverage comes first') < t.indexOf('mean per logged day'));
});

test('sodium is converted from grams with its salt equivalent, and nothing prescribes', () => {
  const t = prompt.text;
  assert.match(t, /Sodium is stored in grams/);
  assert.match(t, /2\.5 times sodium/);
  assert.match(t, /no advice on what to eat/);
  assert.doesNotMatch(t, /\bshould\b|\brecommend|\bdeficit\b|\bTDEE\b|\bhealthy\b/i);
  assert.doesNotMatch(JSON.stringify(prompt), DASH, 'no em or en dashes');
  assert.deepEqual(JSON.parse(JSON.stringify(prompt)), prompt, 'plain JSON, vendorable');
});

test('prompts/get renders nutrition_week_summary over real stdio', async () => {
  const proc = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env }, stdio: ['pipe', 'pipe', 'ignore'],
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
    const listed = list.result.prompts.find((p) => p.name === 'nutrition_week_summary');
    assert.ok(listed, 'listed by prompts/list');
    assert.equal(listed.arguments, undefined, 'takes no arguments');
    const got = await req('prompts/get', { name: 'nutrition_week_summary' });
    const msg = got.result?.messages?.[0];
    assert.equal(msg?.role, 'user');
    assert.match(msg.content.text, /absent, never zero/);
    assert.doesNotMatch(msg.content.text, /\{\{\w+\}\}/, 'no unresolved placeholder');
    assert.doesNotMatch(msg.content.text, DASH);
  } finally {
    proc.kill();
  }
});

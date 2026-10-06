// Release integrity: every published version string agrees, and the .mcpb bundle is complete and boots.
// Runs in `npm test`, so a release can never ship with one manifest left behind or a bundle that
// crashes on a missing import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));

test('package.json, server.json, manifest.json, lhm.plugin.json and the server agree on the version', async () => {
  const v = json('package.json').version;
  const server = json('server.json');
  assert.equal(server.version, v, 'server.json version');
  for (const p of server.packages) assert.equal(p.version, v, `server.json packages[${p.identifier}]`);
  assert.equal(json('manifest.json').version, v, 'manifest.json version');
  assert.equal(json('lhm.plugin.json').version, v, 'lhm.plugin.json version');
  const src = fs.readFileSync(path.join(here, 'server.mjs'), 'utf8');
  assert.match(src, new RegExp(`version: '${v.replace(/\./g, '\\.')}'`), 'server.mjs SERVER.version');
  assert.equal(json('package.json').mcpName, server.name, 'mcpName must equal server.json name (MCP registry)');
});

test('manifest.json and lhm.plugin.json list exactly the tools the server registers', async () => {
  process.env.HEALTH_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'hx-rel-'));
  const { TOOLS } = await import('./server.mjs');
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(json('manifest.json').tools.map((t) => t.name).sort(), names);
  assert.deepEqual(json('lhm.plugin.json').tools.map((t) => t.name).sort(), names);
  assert.match(json('manifest.json').long_description, new RegExp(`\\b${names.length} tools\\b`));
});

/** Every relative module reachable from server.mjs. */
function localImports(entry) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]\.\/([^'"]+)['"]|import\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
      visit(m[1] || m[2]);
    }
  };
  visit(entry);
  return seen;
}

test('health-export.mcpb holds manifest.json and every module server.mjs imports, and boots', async () => {
  const listing = execFileSync('unzip', ['-Z1', path.join(here, 'health-export.mcpb')], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(listing.includes('manifest.json'), 'manifest.json at the archive root');
  for (const f of localImports('server.mjs')) assert.ok(listing.includes(f), `${f} is imported but missing from the .mcpb`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-mcpb-'));
  execFileSync('unzip', ['-q', path.join(here, 'health-export.mcpb'), '-d', dir]);
  const bundled = json('package.json').version;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, bundled, 'the bundle is not stale');
  const proc = spawn(process.execPath, [path.join(dir, 'server.mjs'), '--demo'], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const out = [];
    proc.stdout.on('data', (d) => out.push(d.toString()));
    const send = (id, method, params = {}) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    send(2, 'tools/list');
    const deadline = Date.now() + 10000;
    let tools;
    while (Date.now() < deadline && !tools) {
      await new Promise((r) => setTimeout(r, 100));
      for (const line of out.join('').split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id === 2) tools = m.result?.tools;
      }
    }
    const { TOOLS } = await import('./server.mjs');
    assert.equal(tools?.length, TOOLS.length, 'the unzipped bundle answers tools/list with every tool');
  } finally { proc.kill(); }
});

#!/usr/bin/env node
// Tests for apply-mcp-config.mjs — runs the helper as a child process against a
// temp HOME/cwd and asserts the right schema, idempotency, and secret handling.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'apply-mcp-config.mjs');
const SERVER = '/abs/health-export-mcp/server.mjs';
const DATA = '/abs/icloud/Health Export Documents'; // note the space
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ ' + m); } };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-cfg-'));
  return { dir, env: { ...process.env, HOME: dir }, cwd: dir };
}
function run(sb, args, extraEnv = {}) {
  return execFileSync('node', [HELPER, ...args], { cwd: sb.cwd, env: { ...sb.env, ...extraEnv }, encoding: 'utf8' });
}
function fileFrom(out) {
  return out.split('\n').find((l) => l.startsWith('config file:'))
    .replace('config file:', '').replace('(will be created)', '').trim();
}

// --- standard clients: claude-desktop / cursor / claude-code ---
for (const client of ['claude-desktop', 'cursor', 'claude-code']) {
  const sb = sandbox();
  const out = run(sb, ['--client', client, '--server-path', SERVER, '--data-dir', DATA]);
  // find the written file from the output
  const file = fileFrom(out);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers && cfg.mcpServers['health-export'], `${client}: mcpServers.health-export present`);
  ok(cfg.mcpServers['health-export'].command === 'node', `${client}: command=node`);
  ok(cfg.mcpServers['health-export'].args[0] === SERVER, `${client}: server path`);
  ok(cfg.mcpServers['health-export'].env.HEALTH_DATA_DIR === DATA, `${client}: data dir`);
  ok(!('PAIRING_SECRET' in cfg.mcpServers['health-export'].env), `${client}: no secret when none given`);

  // idempotency + preserves other servers + adds secret on re-run
  cfg.mcpServers['other'] = { command: 'x' };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  run(sb, ['--client', client, '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'SEKRIT' });
  const cfg2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(Object.keys(cfg2.mcpServers).length === 2, `${client}: idempotent — still 2 servers, no dup`);
  ok(cfg2.mcpServers['other'].command === 'x', `${client}: preserved unrelated server`);
  ok(cfg2.mcpServers['health-export'].env.PAIRING_SECRET === 'SEKRIT', `${client}: secret written from env`);
  ok(fs.existsSync(file + '.bak'), `${client}: backup created`);
}

// --- vscode: different shape; secret must NOT be written to disk ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'SEKRIT' });
  const file = fileFrom(out);
  const raw = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  ok(cfg.servers && cfg.servers['health-export'], 'vscode: top key is "servers"');
  ok(cfg.servers['health-export'].type === 'stdio', 'vscode: type=stdio');
  ok(cfg.servers['health-export'].env.PAIRING_SECRET === '${input:health_pairing_secret}', 'vscode: secret is an input ref');
  ok(!raw.includes('SEKRIT'), 'vscode: real secret never written to disk');
  ok(cfg.inputs.some((i) => i.id === 'health_pairing_secret' && i.password === true), 'vscode: password input declared');
  // re-run: input not duplicated
  run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'SEKRIT' });
  const cfg2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg2.inputs.filter((i) => i.id === 'health_pairing_secret').length === 1, 'vscode: input not duplicated on re-run');
}

// --- opencode: array command, environment key, mcp top key ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'opencode', '--server-path', SERVER, '--data-dir', DATA]);
  const file = fileFrom(out);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcp && cfg.mcp['health-export'], 'opencode: top key is "mcp"');
  ok(Array.isArray(cfg.mcp['health-export'].command), 'opencode: command is array');
  ok(cfg.mcp['health-export'].command[1] === SERVER, 'opencode: server in command array');
  ok(cfg.mcp['health-export'].environment.HEALTH_DATA_DIR === DATA, 'opencode: environment key (not env)');
  ok(cfg.mcp['health-export'].enabled === true, 'opencode: enabled true');
  ok(cfg.$schema === 'https://opencode.ai/config.json', 'opencode: $schema added');
}

// --- dry-run writes nothing, and never prints the secret ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env', '--dry-run'], { HEALTH_EXPORT_PAIRING_SECRET: 'TOPSECRET' });
  ok(out.includes('dry run'), 'dry-run: announced');
  ok(!out.includes('TOPSECRET'), 'dry-run: secret never printed');
  ok(!fs.existsSync(path.join(sb.dir, '.cursor', 'mcp.json')), 'dry-run: no file written');
}

// --- non-absolute paths rejected ---
{
  const sb = sandbox();
  let threw = false;
  try { run(sb, ['--client', 'cursor', '--server-path', 'rel/server.mjs', '--data-dir', DATA]); } catch { threw = true; }
  ok(threw, 'rejects non-absolute --server-path');
}

// --- re-run WITHOUT the secret must PRESERVE it (idempotency), and --clear removes it ---
{
  const sb = sandbox();
  // 1) write with a secret
  let out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'KEEPME' });
  const file = fileFrom(out);
  // 2) re-run to change ONLY the data dir, no secret flag — secret must survive
  const NEWDATA = '/abs/icloud/Health Export Documents 2';
  run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', NEWDATA]);
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.PAIRING_SECRET === 'KEEPME', 'preserve: secret survives a re-run without the flag');
  ok(cfg.mcpServers['health-export'].env.HEALTH_DATA_DIR === NEWDATA, 'preserve: data dir still updated');
  // 3) explicitly clear it
  run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', NEWDATA, '--clear-pairing-secret']);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(!('PAIRING_SECRET' in cfg.mcpServers['health-export'].env), 'clear: --clear-pairing-secret removes it');
}

// --- vscode: re-run without flag preserves the input ref + the inputs entry ---
{
  const sb = sandbox();
  let out = run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'X' });
  const file = fileFrom(out);
  run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA]); // no flag
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.servers['health-export'].env.PAIRING_SECRET === '${input:health_pairing_secret}', 'vscode preserve: input ref survives');
  ok(cfg.inputs && cfg.inputs.some((i) => i.id === 'health_pairing_secret'), 'vscode preserve: inputs entry survives');
  // clear removes both the ref and the inputs entry
  run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA, '--clear-pairing-secret']);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(!('PAIRING_SECRET' in cfg.servers['health-export'].env), 'vscode clear: input ref removed');
  ok(!cfg.inputs || !cfg.inputs.some((i) => i.id === 'health_pairing_secret'), 'vscode clear: inputs entry removed');
}

// --- --pairing-secret-env with an EMPTY env var must NOT wipe an existing secret ---
{
  const sb = sandbox();
  let out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: 'KEEP2' });
  const file = fileFrom(out);
  // re-run with the flag but env var unset/empty
  run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--pairing-secret-env'], { HEALTH_EXPORT_PAIRING_SECRET: '' });
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.PAIRING_SECRET === 'KEEP2', 'empty-env: existing secret preserved, not wiped');
}

// --- --env passthrough (LAN listen keys) is written + preserved on re-run ---
{
  const sb = sandbox();
  let out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA,
    '--env', 'HEALTH_LISTEN=1', '--env', 'HEALTH_LISTEN_HOST=0.0.0.0']);
  const file = fileFrom(out);
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN === '1', '--env: HEALTH_LISTEN written');
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN_HOST === '0.0.0.0', '--env: HEALTH_LISTEN_HOST written');
  // re-run changing only the data dir — prior --env keys must survive
  const NEW = '/abs/data2';
  run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', NEW]);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN === '1', '--env: prior key preserved across re-run');
  ok(cfg.mcpServers['health-export'].env.HEALTH_DATA_DIR === NEW, '--env: data dir still updates');
}

// --- token-bearing --env value is redacted in the printed summary ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA,
    '--env', 'HEALTH_LISTEN_TOKEN=hunter2', '--dry-run']);
  ok(!out.includes('hunter2'), 'summary: token --env value redacted');
}

// --- --listen-token-env sets HEALTH_LISTEN_TOKEN off-argv, redacts it, preserves on re-run ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA,
    '--env', 'HEALTH_LISTEN=1', '--listen-token-env'], { HEALTH_EXPORT_LISTEN_TOKEN: 'TOK99' });
  const file = fileFrom(out);
  ok(!out.includes('TOK99'), 'listen-token: value redacted in summary');
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN_TOKEN === 'TOK99', 'listen-token: written from env');
  // re-run without the flag preserves it
  run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--env', 'HEALTH_LISTEN=1']);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN_TOKEN === 'TOK99', 'listen-token: preserved on re-run');
}

// --- VS Code + LAN token must become an ${input:…}, never a plaintext literal on disk ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'vscode', '--server-path', SERVER, '--data-dir', DATA,
    '--env', 'HEALTH_LISTEN=1', '--listen-token-env'], { HEALTH_EXPORT_LISTEN_TOKEN: 'LEAKME' });
  const file = fileFrom(out);
  const raw = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  ok(!raw.includes('LEAKME'), 'vscode LAN: token never written to disk');
  ok(cfg.servers['health-export'].env.HEALTH_LISTEN_TOKEN === '${input:health_listen_token}', 'vscode LAN: token is an input ref');
  ok(cfg.servers['health-export'].env.HEALTH_LISTEN === '1', 'vscode LAN: non-secret env still literal');
  ok(cfg.inputs.some((i) => i.id === 'health_listen_token' && i.password === true), 'vscode LAN: password input declared for token');
}

// --- listen-token-env falls back to the pairing secret env var (same iOS code) ---
{
  const sb = sandbox();
  const out = run(sb, ['--client', 'cursor', '--server-path', SERVER, '--data-dir', DATA, '--listen-token-env'],
    { HEALTH_EXPORT_PAIRING_SECRET: 'SHARED', HEALTH_EXPORT_LISTEN_TOKEN: '' });
  const file = fileFrom(out);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(cfg.mcpServers['health-export'].env.HEALTH_LISTEN_TOKEN === 'SHARED', 'listen-token falls back to $HEALTH_EXPORT_PAIRING_SECRET');
}

console.log(`\napply-mcp-config: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

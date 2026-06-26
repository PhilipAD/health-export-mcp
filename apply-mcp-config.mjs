#!/usr/bin/env node
// Health Export AI — safe, idempotent MCP config writer.
//
// Adds (or updates) ONE "health-export" server entry in the config file of a
// given MCP client, preserving everything else. Backs up the file first, writes
// atomically, and NEVER prints the pairing secret.
//
//   node apply-mcp-config.mjs --client <id> --server-path <abs> --data-dir <abs> [opts]
//
//   --client   claude-desktop | claude-code | cursor | vscode | opencode   (required)
//   --server-path  absolute path to server.mjs                              (required)
//   --data-dir     absolute path to the folder holding .health-cache.json   (required)
//   --pairing-secret-env   read the secret from $HEALTH_EXPORT_PAIRING_SECRET
//   --clear-pairing-secret remove any existing pairing secret from the entry
//   --env KEY=VALUE        extra env var for the entry (repeatable). For the LAN
//                          listen path: --env HEALTH_LISTEN=1 --env HEALTH_LISTEN_HOST=0.0.0.0
//   --listen-token-env     set HEALTH_LISTEN_TOKEN from $HEALTH_EXPORT_LISTEN_TOKEN
//                          (the iOS pairing code) — keeps it off argv, like the secret.
//   --name <id>            server entry name (default: health-export)
//   --config-path <path>   override the client's default config file
//   --dry-run             show what would change; write nothing
//
// Idempotent re-runs: if you don't pass --pairing-secret-env, an existing secret
// (or VS Code ${input:…} reference) is PRESERVED, not dropped. Use
// --clear-pairing-secret to remove it on purpose.
//
// Secrets: pass the pairing code via the env var, never on argv (argv is visible
// to other processes). For VS Code the secret is NEVER written to disk — the
// config references ${input:...} so VS Code prompts for it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k) => argv.includes(k);

const client = opt('--client');
const name = opt('--name') || 'health-export';
const dryRun = flag('--dry-run');
const useSecretEnv = flag('--pairing-secret-env');
const clearSecret = flag('--clear-pairing-secret');

const expand = (p) => (p && p.startsWith('~')) ? path.join(os.homedir(), p.slice(1)) : p;
const serverPath = expand(opt('--server-path'));
const dataDir = expand(opt('--data-dir'));
const secret = useSecretEnv ? (process.env.HEALTH_EXPORT_PAIRING_SECRET || '') : '';
const VSCODE_INPUT = '${input:health_pairing_secret}';

// repeatable --env KEY=VALUE (e.g. the LAN listen keys)
const extraEnv = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--env' && argv[i + 1]) {
    const kv = argv[i + 1]; const eq = kv.indexOf('=');
    if (eq > 0) extraEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
}
// LAN token via env (keeps it off argv, like the pairing secret). The listen token
// and the pairing secret are the same iOS code, so fall back to the secret's env var —
// one `read -rs HEALTH_EXPORT_PAIRING_SECRET` capture then covers both roles.
const useListenTokenEnv = flag('--listen-token-env');
const listenToken = useListenTokenEnv
  ? (process.env.HEALTH_EXPORT_LISTEN_TOKEN || process.env.HEALTH_EXPORT_PAIRING_SECRET || '')
  : '';

const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

const CLIENTS = {
  'claude-desktop': { topKey: 'mcpServers', shape: 'standard', def: claudeDesktopPath },
  'claude-code':    { topKey: 'mcpServers', shape: 'standard', def: () => path.join(process.cwd(), '.mcp.json') },
  'cursor':         { topKey: 'mcpServers', shape: 'standard', def: () => path.join(os.homedir(), '.cursor', 'mcp.json') },
  'vscode':         { topKey: 'servers',    shape: 'vscode',   def: () => path.join(process.cwd(), '.vscode', 'mcp.json') },
  'opencode':       { topKey: 'mcp',        shape: 'opencode', def: opencodePath },
};

if (!client || !CLIENTS[client]) die(`--client must be one of: ${Object.keys(CLIENTS).join(', ')}`);
if (!serverPath) die('--server-path is required (absolute path to server.mjs)');
if (!dataDir) die('--data-dir is required (absolute path to the export folder)');
if (!path.isAbsolute(serverPath)) die('--server-path must be absolute: ' + serverPath);
if (!path.isAbsolute(dataDir)) die('--data-dir must be absolute: ' + dataDir);

function claudeDesktopPath() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config/Claude/claude_desktop_config.json');
}
function opencodePath() {
  const local = path.join(process.cwd(), 'opencode.json');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), '.config/opencode/opencode.json');
}

const spec = CLIENTS[client];
const file = expand(opt('--config-path')) || spec.def();

// ---- read existing config first (so we can preserve secrets + other keys) -
let root = {};
let existed = false;
if (fs.existsSync(file)) {
  existed = true;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw) {
    try { root = JSON.parse(raw); }
    catch { die(`${file} is not plain JSON (it may use comments). Edit it by hand using the recipe in SKILL.md.`); }
  }
  if (typeof root !== 'object' || Array.isArray(root)) die(`${file} is not a JSON object.`);
}
const prev = (root[spec.topKey] && root[spec.topKey][name]) || null;
const prevEnv = prev ? (prev.env || prev.environment) : null;
const prevSecret = prevEnv ? prevEnv.PAIRING_SECRET : undefined;

// ---- decide what the secret should be after this run ----------------------
// kinds: {kind:'value',value} write a literal · {kind:'input'} VS Code ref · {kind:'none'}
function resolveSecret() {
  if (clearSecret) return { kind: 'none', why: 'cleared' };
  if (spec.shape === 'vscode') {
    if (useSecretEnv) return { kind: 'input', why: 'prompted by VS Code (${input:…}), not stored' };
    if (prevSecret === VSCODE_INPUT) return { kind: 'input', why: 'preserved existing input ref' };
    return { kind: 'none', why: 'none' };
  }
  if (useSecretEnv && secret) return { kind: 'value', value: secret, why: 'set from $HEALTH_EXPORT_PAIRING_SECRET' };
  // --pairing-secret-env but the env var is empty: don't wipe an existing secret.
  if (useSecretEnv && !secret) {
    if (prevSecret !== undefined && prevSecret !== '') return { kind: 'value', value: prevSecret, why: '$HEALTH_EXPORT_PAIRING_SECRET empty — preserved existing' };
    return { kind: 'none', why: '$HEALTH_EXPORT_PAIRING_SECRET empty — left unset' };
  }
  if (prevSecret !== undefined && prevSecret !== '') return { kind: 'value', value: prevSecret, why: 'preserved existing' };
  return { kind: 'none', why: 'none' };
}
const sec = resolveSecret();

// ---- build the server entry for this client's shape ----------------------
// Preserve any prior env keys (e.g. HEALTH_LISTEN*), update HEALTH_DATA_DIR, merge
// --env passthrough, then resolve the secret.
function mergedEnv() {
  const env = { ...(prevEnv || {}) };
  env.HEALTH_DATA_DIR = dataDir;
  Object.assign(env, extraEnv);
  if (listenToken) env.HEALTH_LISTEN_TOKEN = listenToken; // empty → prior value preserved
  delete env.PAIRING_SECRET;
  if (sec.kind === 'value') env.PAIRING_SECRET = sec.value;
  else if (sec.kind === 'input') env.PAIRING_SECRET = VSCODE_INPUT;
  // VS Code: never persist a secret/token literal — route it through a prompted ${input:…}.
  // (.vscode/mcp.json is often committed; literals would leak the pairing code at rest.)
  if (spec.shape === 'vscode') {
    for (const k of Object.keys(env)) {
      if (/secret|token/i.test(k) && typeof env[k] === 'string' && env[k] && !env[k].startsWith('${')) {
        env[k] = '${input:' + k.toLowerCase() + '}';
      }
    }
  }
  return env;
}
function buildEntry() {
  if (spec.shape === 'opencode') return { type: 'local', command: ['node', serverPath], enabled: true, environment: mergedEnv() };
  if (spec.shape === 'vscode') return { type: 'stdio', command: 'node', args: [serverPath], env: mergedEnv() };
  // standard (Claude Desktop / Claude Code / Cursor)
  return { command: 'node', args: [serverPath], env: mergedEnv() };
}

const wasPresent = !!prev;
root[spec.topKey] = root[spec.topKey] || {};
root[spec.topKey][name] = buildEntry();

// VS Code: declare a password promptString for every ${input:id} the entry references,
// and drop our managed inputs no longer referenced. Secrets stay off disk.
if (spec.shape === 'vscode') {
  const entryEnv = root[spec.topKey][name].env || {};
  const used = new Set();
  for (const v of Object.values(entryEnv)) {
    const m = typeof v === 'string' && v.match(/^\$\{input:([A-Za-z0-9_]+)\}$/);
    if (m) used.add(m[1]);
  }
  const DESC = { health_pairing_secret: 'Health Export pairing code', health_listen_token: 'Health Export LAN token (iOS pairing code)' };
  root.inputs = Array.isArray(root.inputs) ? root.inputs : [];
  for (const id of used) {
    if (!root.inputs.some((i) => i && i.id === id)) {
      root.inputs.push({ type: 'promptString', id, description: DESC[id] || 'Health Export secret', password: true });
    }
  }
  root.inputs = root.inputs.filter((i) => !(i && /^health_(pairing_secret|listen_token)$/.test(i.id) && !used.has(i.id)));
  if (root.inputs.length === 0) delete root.inputs;
}
if (spec.shape === 'opencode' && !root.$schema) root.$schema = 'https://opencode.ai/config.json';

// ---- redacted summary (never print the secret) ---------------------------
const redacted = JSON.parse(JSON.stringify(root[spec.topKey][name]));
const scrub = (o) => { for (const k of Object.keys(o || {})) { if (/secret|token/i.test(k) && o[k] && !String(o[k]).startsWith('${')) o[k] = '********'; } };
scrub(redacted.env); scrub(redacted.environment);

console.log(`client:      ${client}`);
console.log(`config file: ${file}${existed ? '' : '  (will be created)'}`);
console.log(`action:      ${wasPresent ? 'UPDATE existing' : 'ADD'} "${name}" under "${spec.topKey}"`);
console.log(`secret:      ${sec.why}`);
console.log(`entry:       ${JSON.stringify(redacted)}`);

if (dryRun) { console.log('\ndry run — nothing written.'); process.exit(0); }

// ---- back up + atomic write ----------------------------------------------
// If a literal secret is being written (non-VS-Code clients), lock files to owner-only 0600.
const hasLiteralSecret = sec.kind === 'value';
const mode = hasLiteralSecret ? 0o600 : 0o644;
fs.mkdirSync(path.dirname(file), { recursive: true });
if (existed && !fs.existsSync(file + '.bak')) {            // don't clobber an existing backup
  fs.copyFileSync(file, file + '.bak');
  if (hasLiteralSecret) { try { fs.chmodSync(file + '.bak', 0o600); } catch {} }
  console.log(`backup:      ${file}.bak`);
}
const tmp = file + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + '\n', { mode });
fs.renameSync(tmp, file);
try { fs.chmodSync(file, mode); } catch {}
console.log('\nwritten. Restart/reload the client, then call get_mcp_status to verify.');

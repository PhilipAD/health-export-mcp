#!/usr/bin/env node
// Generate one-click MCP install deeplinks for Cursor and VS Code that point at
// the local Health Export stdio server. No bridge, no Docker — just node + stdio.
//
//   node gen-deeplinks.mjs [serverPath] [healthDataDir]
//
// Defaults assume the installed bundle layout + the iCloud Drive export folder.
//
// NOTE the two clients use DIFFERENT config encodings (verified 2026):
//   • Cursor  — config = base64(JSON of the inner server object)
//   • VS Code — the whole server JSON is URL-encoded (NOT base64), and it
//     includes "name" + "type" inline.
import path from 'node:path';
import os from 'node:os';

const serverPath = process.argv[2] || path.join(process.cwd(), 'server.mjs');
const dataDir = process.argv[3] ||
  path.join(os.homedir(), 'Library/Mobile Documents/iCloud~ai~healthexport~app/Documents');

const name = 'health-export';
const env = { HEALTH_DATA_DIR: dataDir };

// Cursor: inner server object, base64-encoded, passed as ?config=
const cursorCfg = { command: 'node', args: [serverPath], env };
const cursorB64 = encodeURIComponent(Buffer.from(JSON.stringify(cursorCfg)).toString('base64'));

// VS Code: full server object (with name + type), URL-encoded JSON — no base64.
const vscodeCfg = { name, type: 'stdio', command: 'node', args: [serverPath], env };
const vscodeEnc = encodeURIComponent(JSON.stringify(vscodeCfg));
// Web redirect form takes name + config separately (config = URL-encoded JSON of the inner object).
const vscodeWebCfg = encodeURIComponent(JSON.stringify({ type: 'stdio', command: 'node', args: [serverPath], env }));

console.log('Cursor config:', JSON.stringify(cursorCfg));
console.log('VS Code config:', JSON.stringify(vscodeCfg));
console.log('\nCursor:      cursor://anysphere.cursor-deeplink/mcp/install?name=' + name + '&config=' + cursorB64);
console.log('VS Code:     vscode:mcp/install?' + vscodeEnc);
console.log('VS Code web: https://insiders.vscode.dev/redirect/mcp/install?name=' + name + '&config=' + vscodeWebCfg);

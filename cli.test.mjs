// Tests for the CLI surface: --doctor, status --max-age (the cron freshness gate, where the EXIT
// CODE is the contract), --help, and the receiver's default bind. All run against a fixture dir
// by spawning the real entry point, because argv handling is exactly what is under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-cli-'));
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-cli-empty-'));

fs.writeFileSync(path.join(DIR, '.health-cache.json'), JSON.stringify({
  _meta: { schema: 1, app: '1.5' },
  step_count: { unit: 'count', cumulative: true, daily: [
    { d: '2026-08-17', v: 9000 }, { d: '2026-08-18', v: 10000 },
  ] },
}));
fs.writeFileSync(path.join(DIR, 'health-events.json'), JSON.stringify({
  schema: 1, writtenAt: '2026-08-18T21:00:00Z', events: [],
}));

const run = (args, dir = DIR) => spawnSync(process.execPath, [SERVER, ...args], {
  env: { ...process.env, HEALTH_DATA_DIR: dir },
  encoding: 'utf8',
  timeout: 15000,
});

test('--doctor prints a human-readable report and exits 0', () => {
  const r = run(['--doctor']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /data dir:\s+/);
  assert.match(r.stdout, /\.health-cache\.json/);
  assert.match(r.stdout, /health-events\.json/);
  assert.match(r.stdout, /cache schema:\s+1 \(app 1\.5\)/);
  assert.match(r.stdout, /metrics:\s+1\b/);
  assert.match(r.stdout, /last data date:\s+2026-08-18/);
  assert.match(r.stdout, /pairing:\s+not required/);
  assert.match(r.stdout, /freshness:\s+[\d.]+ hours/);
  assert.match(r.stdout, new RegExp(process.version.replace(/\./g, '\\.')));
  assert.doesNotMatch(r.stdout, /[{}]"/, 'human-readable lines, not JSON');
});

test('--doctor reports absent files as absent rather than skipping them', () => {
  const r = run(['--doctor']);
  assert.match(r.stdout, /health-cycles\.json\s+absent/);
});

test('status --max-age exits 0 while the newest write is fresh', () => {
  // The fixture was written moments ago, so any sane max-age passes.
  const r = run(['status', '--max-age', '24']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^fresh: newest write /);
  assert.match(r.stdout, /within --max-age 24h/);
});

test('status --max-age exits 1 when the newest write is too old', () => {
  // Age every file two days into the past; the gate must flip to stale/1.
  const old = Date.now() / 1000 - 48 * 3600;
  for (const f of fs.readdirSync(DIR)) fs.utimesSync(path.join(DIR, f), old, old);
  const r = run(['status', '--max-age', '24']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^stale: newest write /);
  assert.match(r.stdout, /exceeds --max-age 24h/);
  // And a generous max-age accepts the same files again: the state is in the files, not the flag.
  const ok = run(['status', '--max-age', '96']);
  assert.equal(ok.status, 0);
});

test('status against an empty dir exits 1 and says no files exist', () => {
  const r = run(['status', '--max-age', '24'], EMPTY);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stale: no data files found/);
});

test('status without a usable --max-age exits 2 with usage', () => {
  for (const args of [['status'], ['status', '--max-age'], ['status', '--max-age', 'soon'], ['status', '--max-age', '-1']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stdout, /usage:/);
  }
});

test('--help documents every mode, including --demo, and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  for (const needle of ['--demo', '--doctor', 'status --max-age', 'receive', 'HEALTH_DATA_DIR', 'PAIRING_SECRET']) {
    assert.ok(r.stdout.includes(needle), `--help must mention ${needle}`);
  }
});

test('the receiver binds loopback by default (the exposure default under `receive`)', async () => {
  // Asserted at the source of truth rather than by spawning a listener: receive mode delegates to
  // startReceiver, whose default host is what decides network exposure.
  const src = fs.readFileSync(path.join(HERE, 'receiver.mjs'), 'utf8');
  assert.match(src, /HEALTH_LISTEN_HOST \|\| '127\.0\.0\.1'/);
  assert.match(src, /REFUSING to listen on non-loopback/);
});

test('--doctor exits 0 even when the dir does not exist (diagnostics never gate)', () => {
  const r = run(['--doctor'], path.join(EMPTY, 'nope'));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DOES NOT EXIST/);
  assert.match(r.stdout, /no data files present/);
});

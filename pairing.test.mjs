// Zero-dependency tests for the pairing gate fail-closed behaviour: once the operator has set
// PAIRING_SECRET, a MISSING .health-pair.json must lock the data (protection by identity, not by
// presence), and a present file must match.
//
// The module computes DATA_DIR at load time, so each scenario runs the REAL entry point in a
// child process with its own env — the same way cli.test.mjs exercises argv/--doctor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

// `--doctor` prints the pairing status line. Runs the server as a child so DATA_DIR / PAIRING_SECRET
// are read correctly at load.
function status(env) {
  const r = spawnSync(process.execPath, [SERVER, '--doctor'], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, `--doctor exited ${r.status}: ${r.stderr}`);
  const m = r.stdout.match(/pairing:\s+([^\n]+)/);
  return m ? m[1].trim() : null;
}

test('no secret and no gate file stays OPEN (unchanged behaviour)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pairing-'));
  const line = status({ HEALTH_DATA_DIR: dir });
  assert.match(line, /not required/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PAIRING_SECRET set + no .health-pair.json => LOCKED (fail-closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pairing-'));
  const line = status({ HEALTH_DATA_DIR: dir, PAIRING_SECRET: 'AB3CD-EFGHJ-K2MNP-QRST4' });
  assert.match(line, /LOCKED/);
  assert.match(line, /no \.health-pair\.json exists here/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('matching gate file => unlocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pairing-'));
  const secret = 'AB3CD-EFGHJ-K2MNP-QRST4';
  const hash = createHash('sha256').update(secret).digest('hex');
  fs.writeFileSync(path.join(dir, '.health-pair.json'), JSON.stringify({ v: 1, alg: 'sha256', hash }));
  const line = status({ HEALTH_DATA_DIR: dir, PAIRING_SECRET: secret });
  assert.match(line, /unlocked/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrong secret => locked with a mismatch reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pairing-'));
  const secret = 'AB3CD-EFGHJ-K2MNP-QRST4';
  const hash = createHash('sha256').update(secret).digest('hex');
  fs.writeFileSync(path.join(dir, '.health-pair.json'), JSON.stringify({ v: 1, alg: 'sha256', hash }));
  const line = status({ HEALTH_DATA_DIR: dir, PAIRING_SECRET: 'wrong-secret' });
  assert.match(line, /LOCKED/);
  assert.match(line, /mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate file absent but secret absent => open again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pairing-'));
  const line = status({ HEALTH_DATA_DIR: dir });
  assert.match(line, /not required/);
  fs.rmSync(dir, { recursive: true, force: true });
});
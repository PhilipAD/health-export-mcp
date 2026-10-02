// envelope.mjs: reads (and, for tests and tooling, writes) the MetricBridge encrypted export
// envelope, format "metricbridge.enc" version 1. Zero dependencies: node:crypto only.
//
// The iOS app can seal what it exports (iCloud Drive / folder files, webhook and local-network
// bodies) under a passphrase the user chose. This module is the matching decrypt step, so the MCP
// server and the LAN receiver read encrypted exports transparently once they know the passphrase.
//
// Envelope (UTF-8 JSON, keys sorted):
//   { "alg":"A256GCM", "ct":"<b64 ciphertext||16-byte tag>", "format":"metricbridge.enc",
//     "iter":600000, "kcv":"<b64 8 bytes>", "kdf":"PBKDF2-HMAC-SHA256",
//     "nonce":"<b64 12 bytes>", "salt":"<b64 16 bytes>", "v":1 }
//
//   master = PBKDF2-HMAC-SHA256(NFC(passphrase), salt, iter, 32)
//   encKey = HKDF-SHA256(master, salt = empty, info = "metricbridge.enc/v1/aes-256-gcm", 32)
//   kcv    = HKDF-SHA256(master, salt = empty, info = "metricbridge.enc/v1/key-check", 8)
//   AAD    = "metricbridge.enc|v=1|alg=A256GCM|kdf=PBKDF2-HMAC-SHA256|iter=<n>|salt=<b64>|kcv=<b64>|nonce=<b64>"
//            (base64 re-encoded from the decoded bytes, canonical with padding)
//
// Full specification and threat model: docs/ENCRYPTED-EXPORTS.md in the app repo, and the
// "Encrypted exports" section of README.md.
//
// Passphrase source, in order: HEALTH_EXPORT_PASSPHRASE, then the file named by
// HEALTH_EXPORT_PASSPHRASE_FILE (one trailing newline is stripped). The passphrase is never logged,
// never echoed in an error and never written anywhere.
//
// CLI (for webhook receivers and scripts that want the plaintext of one envelope):
//   HEALTH_EXPORT_PASSPHRASE=... node envelope.mjs open <file|->      # prints the decrypted JSON

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'metricbridge.enc';
export const VERSION = 1;
export const ALG = 'A256GCM';
export const KDF = 'PBKDF2-HMAC-SHA256';
export const DEFAULT_ITERATIONS = 600_000;   // OWASP Password Storage Cheat Sheet, PBKDF2-HMAC-SHA256
export const MIN_ITERATIONS = 100_000;       // a forged header cannot steer us into a cheap derivation
export const MAX_ITERATIONS = 10_000_000;    // ...or pin the CPU for minutes
const SALT_LEN = 16, NONCE_LEN = 12, KCV_LEN = 8, TAG_LEN = 16, KEY_LEN = 32;
const ENC_INFO = Buffer.from('metricbridge.enc/v1/aes-256-gcm', 'utf8');
const KCV_INFO = Buffer.from('metricbridge.enc/v1/key-check', 'utf8');

/** Machine-readable failure. `code` is stable; `message` never contains the passphrase. */
export class EnvelopeError extends Error {
  constructor(code, message) { super(message); this.name = 'EnvelopeError'; this.code = code; }
}

export const isEnvelope = (obj) =>
  !!obj && typeof obj === 'object' && !Array.isArray(obj) && obj.format === FORMAT;

/** The configured passphrase, or null. Read on every call so tests (and a restarted config) see
 *  the current environment; it is cheap. Empty means unset: the .mcpb manifest maps an empty
 *  optional field to an empty string. */
export function configuredPassphrase(env = process.env) {
  const direct = env.HEALTH_EXPORT_PASSPHRASE;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const file = env.HEALTH_EXPORT_PASSPHRASE_FILE;
  if (typeof file === 'string' && file.length > 0) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      throw new EnvelopeError('passphrase_file_unreadable',
        `HEALTH_EXPORT_PASSPHRASE_FILE points at a file that could not be read (${e.code || 'error'}).`);
    }
    const p = text.replace(/\r?\n$/, '');
    return p.length > 0 ? p : null;
  }
  return null;
}

// PBKDF2 at 600,000 rounds is ~0.3 s; every file the app writes shares one salt, so derive once per
// (passphrase, salt, iter). Keyed by an HMAC of the passphrase under a per-process random key, so the
// map holds neither a second copy of the passphrase nor a fast unsalted hash of it.
// Bounded (LRU): the app uses one salt per passphrase, so a handful of entries is plenty, and an
// unbounded map would let a stream of fresh-salt envelopes grow memory without limit.
const keyCache = new Map();
const KEY_CACHE_MAX = 16;
const CACHE_ID_KEY = crypto.randomBytes(32);

function b64(buf) { return Buffer.from(buf).toString('base64'); }

function decodeField(env, name, len) {
  const s = env[name];
  // Canonical padded base64 only: Buffer.from is lenient (drops padding, ignores stray characters)
  // and the Swift reader is not, so both apply the same rule and accept exactly the same envelopes.
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new EnvelopeError('malformed', `encrypted export is malformed (field "${name}")`);
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) {
    throw new EnvelopeError('malformed', `encrypted export is malformed (field "${name}")`);
  }
  if (len !== undefined && buf.length !== len) {
    throw new EnvelopeError('malformed', `encrypted export is malformed (field "${name}" length)`);
  }
  return buf;
}

function exactInt(v) { return Number.isInteger(v) ? v : null; }

/** Parse and validate the header of an envelope object. */
export function parseHeader(env) {
  if (!isEnvelope(env)) throw new EnvelopeError('malformed', 'not an encrypted export');
  const v = exactInt(env.v);
  if (v === null) throw new EnvelopeError('malformed', 'encrypted export is malformed (field "v")');
  if (v !== VERSION) {
    throw new EnvelopeError('unsupported_version',
      `This export was encrypted with envelope version ${v}, but this server only reads version ${VERSION}. ` +
      'Update the MetricBridge MCP server.');
  }
  if (env.alg !== ALG) throw new EnvelopeError('malformed', 'encrypted export is malformed (field "alg")');
  if (env.kdf !== KDF) throw new EnvelopeError('malformed', 'encrypted export is malformed (field "kdf")');
  const iter = exactInt(env.iter);
  if (iter === null || iter < MIN_ITERATIONS || iter > MAX_ITERATIONS) {
    throw new EnvelopeError('malformed', 'encrypted export is malformed (field "iter")');
  }
  const salt = decodeField(env, 'salt', SALT_LEN);
  const kcv = decodeField(env, 'kcv', KCV_LEN);
  const nonce = decodeField(env, 'nonce', NONCE_LEN);
  const sealed = decodeField(env, 'ct');
  if (sealed.length < TAG_LEN) throw new EnvelopeError('malformed', 'encrypted export is malformed (field "ct")');
  return { v, iter, salt, kcv, nonce, sealed };
}

export function associatedData({ v, iter, salt, kcv, nonce }) {
  return Buffer.from(
    `${FORMAT}|v=${v}|alg=${ALG}|kdf=${KDF}|iter=${iter}|salt=${b64(salt)}|kcv=${b64(kcv)}|nonce=${b64(nonce)}`,
    'utf8');
}

/** Derive { encKey, kcv } for a passphrase + salt + iteration count (memoized). */
export function deriveKeys(passphrase, salt, iter) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new EnvelopeError('passphrase_missing', 'no passphrase');
  }
  const pw = Buffer.from(passphrase.normalize('NFC'), 'utf8');
  const id = crypto.createHmac('sha256', CACHE_ID_KEY).update(pw).digest('hex') + '|' + b64(salt) + '|' + iter;
  const hit = keyCache.get(id);
  if (hit) { keyCache.delete(id); keyCache.set(id, hit); return hit; }
  const master = crypto.pbkdf2Sync(pw, salt, iter, KEY_LEN, 'sha256');
  const keys = {
    encKey: Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), ENC_INFO, KEY_LEN)),
    kcv: Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), KCV_INFO, KCV_LEN)),
  };
  master.fill(0);
  pw.fill(0);
  keyCache.set(id, keys);
  while (keyCache.size > KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  return keys;
}

/** Decrypt an envelope object to a Buffer of plaintext. Throws EnvelopeError with code
 *  'passphrase_missing' | 'passphrase_mismatch' | 'tampered' | 'malformed' | 'unsupported_version'. */
export function openEnvelope(env, passphrase = configuredPassphrase()) {
  const h = parseHeader(env);
  if (!passphrase) {
    throw new EnvelopeError('passphrase_missing',
      'This health export is encrypted. Set HEALTH_EXPORT_PASSPHRASE (or HEALTH_EXPORT_PASSPHRASE_FILE) ' +
      'to the passphrase you chose in the MetricBridge app (Settings > Export encryption), then restart the server.');
  }
  const { encKey, kcv } = deriveKeys(passphrase, h.salt, h.iter);
  if (!crypto.timingSafeEqual(kcv, h.kcv)) {
    throw new EnvelopeError('passphrase_mismatch',
      'This health export is encrypted with a different passphrase than HEALTH_EXPORT_PASSPHRASE. ' +
      'Use the passphrase set in the MetricBridge app (Settings > Export encryption).');
  }
  const ct = h.sealed.subarray(0, h.sealed.length - TAG_LEN);
  const tag = h.sealed.subarray(h.sealed.length - TAG_LEN);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, h.nonce, { authTagLength: TAG_LEN });
    d.setAAD(associatedData(h));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new EnvelopeError('tampered',
      'An encrypted health export failed its integrity check: the file is damaged or was modified. ' +
      'Run an export from the MetricBridge app to rewrite it.');
  }
}

/** Decrypt and JSON.parse. */
export function openEnvelopeJSON(env, passphrase) {
  return JSON.parse(openEnvelope(env, passphrase).toString('utf8'));
}

/** If `obj` is an envelope, return its decrypted JSON; otherwise return it unchanged. */
export function maybeOpen(obj, passphrase) {
  return isEnvelope(obj) ? openEnvelopeJSON(obj, passphrase === undefined ? configuredPassphrase() : passphrase) : obj;
}

/** Seal plaintext (Buffer or string) into an envelope object. Used by tests, by the cross-language
 *  fixture and by the receiver when it rewrites a cache that was already sealed. `nonce` and `salt`
 *  are injectable for deterministic fixtures ONLY: production use must leave both to the CSPRNG. */
export function sealEnvelope(plaintext, passphrase, { salt, iter = DEFAULT_ITERATIONS, nonce } = {}) {
  const s = salt ? Buffer.from(salt) : crypto.randomBytes(SALT_LEN);
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(NONCE_LEN);
  if (s.length !== SALT_LEN || n.length !== NONCE_LEN) throw new EnvelopeError('malformed', 'bad salt or nonce length');
  const { encKey, kcv } = deriveKeys(passphrase, s, iter);
  const header = { v: VERSION, iter, salt: s, kcv, nonce: n };
  const c = crypto.createCipheriv('aes-256-gcm', encKey, n, { authTagLength: TAG_LEN });
  c.setAAD(associatedData(header));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')), c.final()]);
  // Same key order the app writes (sorted), so a fixture regenerates byte-for-byte.
  return {
    alg: ALG,
    ct: b64(Buffer.concat([ct, c.getAuthTag()])),
    format: FORMAT,
    iter,
    kcv: b64(kcv),
    kdf: KDF,
    nonce: b64(n),
    salt: b64(s),
    v: VERSION,
  };
}

// ---- CLI ----
const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isEntryPoint) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'open' || !file) {
    process.stderr.write('usage: HEALTH_EXPORT_PASSPHRASE=... node envelope.mjs open <file|->\n');
    process.exit(2);
  }
  try {
    const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    const obj = JSON.parse(text);
    if (!isEnvelope(obj)) { process.stdout.write(text); process.exit(0); }
    process.stdout.write(openEnvelope(obj).toString('utf8'));
  } catch (e) {
    process.stderr.write(`envelope: ${e instanceof EnvelopeError ? e.message : 'could not read input (' + (e.code || e.name) + ')'}\n`);
    process.exit(1);
  }
}

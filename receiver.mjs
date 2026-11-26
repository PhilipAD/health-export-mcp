// receiver.mjs — optional, ZERO-DEPENDENCY LAN push listener for MetricBridge.
//
// Lets the iOS app push the health cache directly to this machine over the local network —
// the "WebSocket" path marketed alongside MCP — when the user can't/doesn't use a synced folder.
// It runs INSIDE the same Node process as the stdio MCP server (no separate daemon/bridge), so it
// MUST log only to stderr (stdout belongs to the MCP JSON-RPC stream).
//
//   POST /health-cache          (HTTP — reliable, works from iOS background uploads)
//   GET  /health-cache-ws       (WebSocket upgrade — foreground real-time push)
//   Both write <HEALTH_DATA_DIR>/.health-cache.json, which the MCP server then reads.
//   Both also accept ONE typed document, `strength.log` (the app's opt-in "Strength log" switch for
//   this destination): it is validated and written whole to <HEALTH_DATA_DIR>/health-strength.json,
//   the file `get_strength_log` reads. And `workouts`, merged by id into
//   <HEALTH_DATA_DIR>/.health-workouts-cache.json (what `get_workouts` reads). Any other `type` is
//   still treated as the daily summary (an
//   unknown key is not a metric and is skipped), so a newer app never breaks an older receiver and
//   the other way round.
//
// Security:
//   - Binds 127.0.0.1 by default; HEALTH_LISTEN_HOST=0.0.0.0 for LAN.
//   - On a NON-loopback bind a token is MANDATORY — we fail closed (refuse to listen) without one.
//   - X-Health-Token is compared in constant time (HEALTH_LISTEN_TOKEN = the iOS pairing code).
//   - DNS-rebinding defense: reject any request carrying an Origin header (the native app sends none)
//     and require the Host header to be loopback, an IP literal, or a private name (*.ts.net, *.local).
//   - WS frame reader caps buffered bytes, honours close/ping control frames, and times out idle sockets.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isEnvelope, openEnvelopeJSON, sealEnvelope, parseHeader, configuredPassphrase, EnvelopeError } from './envelope.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BODY = 64 * 1024 * 1024;
const MAX_WS_BUF = 70 * 1024 * 1024;
const MAX_METRICS = 2000, MAX_DAYS = 8000;
// The cache file accumulates across pushes (union, last-write-wins) and is never trimmed by a push,
// so a token holder could grow it without bound and fill the disk. A full 190-metric, multi-year
// cache is a few MB; 64 MB is far beyond any real dataset and a firm ceiling for hostile growth.
const MAX_CACHE_FILE = 64 * 1024 * 1024;
const log = (...a) => process.stderr.write('[receiver] ' + a.map(String).join(' ') + '\n');

function expandTilde(p) {
  return (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;
}
// The merge base for an accumulated cache. ABSENT means start fresh; PRESENT-BUT-CORRUPT
// must never become {} and overwrite the whole history — quarantine it, then start fresh.
//
// Returns { value, sealedLike } where sealedLike is the envelope header when the existing cache was
// encrypted (the receiver's directory can be the same iCloud folder the app seals into): the merged
// result is then written back sealed under the SAME salt, so the app (which holds only the key for
// that salt) can still read it and nothing is left behind in plaintext. An envelope this receiver
// cannot open THROWS: quarantining it would restart a perfectly good history from one push.
function readMergeBase(file, fb, passphrase) {
  if (!fs.existsSync(file)) return { value: fb, sealedLike: null };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { try { const bak = `${file}.corrupt-${process.pid}`; fs.renameSync(file, bak); log(`quarantined unreadable ${file} -> ${bak}`); } catch {} return { value: fb, sealedLike: null }; }
  if (!isEnvelope(parsed)) return { value: parsed, sealedLike: null };
  return { value: openEnvelopeJSON(parsed, passphrase), sealedLike: parseHeader(parsed) };
}
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Source attribution (cache schema minor 2, whole-person reconciliation layer 1): `src` is the
// label of the source the day's value came from; `by` maps every source that recorded that day to
// its value. The app stamps these onto daily points and the MCP server reads them back verbatim
// (healthstore.mjs rollUp → `src`/`by`), so a LAN push MUST carry them through untouched — dropping
// them here silently strips the provenance every agent answer cites. They are still untrusted from a
// client and validated like everything else: a short non-empty label, and a flat map of short
// non-empty labels to finite numbers.
const SRC_LABEL_MAX = 64, BY_SOURCES_MAX = 64;
function sanitizeSrc(src) {
  if (typeof src !== 'string') return null;
  if (src.length === 0 || src.length > SRC_LABEL_MAX) return null;
  return src;
}
function sanitizeBy(by) {
  if (!by || typeof by !== 'object' || Array.isArray(by)) return null;
  const entries = Object.entries(by);
  if (entries.length === 0 || entries.length > BY_SOURCES_MAX) return null;
  const out = {};
  for (const [label, v] of entries) {
    if (typeof label !== 'string' || label.length === 0 || label.length > SRC_LABEL_MAX) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    out[label] = n;
  }
  return out;
}

// Validate/sanitise a pushed summary so a malicious LAN client can't poison the agent's context.
function sanitize(incoming) {
  const out = {};
  if (!incoming || typeof incoming !== 'object') return out;
  let metrics = 0;
  for (const [name, m] of Object.entries(incoming)) {
    if (metrics >= MAX_METRICS) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) continue;          // strict metric-name allowlist
    if (!m || !Array.isArray(m.daily)) continue;
    const daily = [];
    for (const p of m.daily.slice(0, MAX_DAYS)) {
      if (!p || typeof p.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.d)) continue;
      const v = Number(p.v);
      if (!Number.isFinite(v)) continue;
      // `r`: the app rebuilt this past day after late-arriving samples (cache schema minor 1).
      // Kept only when it is a plain ISO 8601 instant, so a pushed payload cannot smuggle anything
      // else through to what the MCP server reads.
      const r = typeof p.r === 'string' && ISO_INSTANT.test(p.r) ? p.r : null;
      const point = { d: p.d, v };
      if (r) point.r = r;
      const src = sanitizeSrc(p.src);
      if (src !== null) point.src = src;
      const by = sanitizeBy(p.by);
      if (by !== null) point.by = by;
      daily.push(point);
    }
    if (!daily.length) continue;
    out[name] = { unit: typeof m.unit === 'string' ? m.unit.slice(0, 32) : '', cumulative: !!m.cumulative, daily };
    metrics++;
  }
  return out;
}

// Validate the `_authoritative` window the app sends alongside a push (AppModel LAN branch).
// Same distrust as `sanitize`: strict day format, ordered range, allowlisted metric names.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeAuthoritative(incoming) {
  const a = incoming && typeof incoming === 'object' ? incoming._authoritative : null;
  if (!a || typeof a !== 'object') return null;
  const { start, end } = a;
  if (typeof start !== 'string' || typeof end !== 'string' || !DAY_RE.test(start) || !DAY_RE.test(end) || start > end) return null;
  if (!Array.isArray(a.metrics)) return null;
  const metrics = new Set(a.metrics.slice(0, MAX_METRICS).filter((n) => typeof n === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(n)));
  return { start, end, metrics };
}

// Merge a pushed (sanitised) summary into the cache — union by metric+day, last-write-wins.
// When the push carries `_authoritative` {start, end, metrics}, the app just re-read those days for
// those metrics, so inside that window the push IS the truth: any cached day it did not produce was
// deleted in Apple Health (or is a ghost key from a previous time zone) and is pruned. Mirrors
// `HealthCache.merge(_:_:authoritativeDays:authoritativeMetrics:)`; without it a LAN-only cache
// kept deletions and TZ ghost days forever. Metrics not listed (e.g. sensitive types excluded from
// the run) are never pruned. `yyyy-MM-dd` is fixed-width, so string order IS chronological.
export function mergeCache(existing, incoming) {
  const merged = { ...(existing || {}) };
  const cleaned = sanitize(incoming);
  const auth = sanitizeAuthoritative(incoming);
  const inRange = (d) => !!auth && d >= auth.start && d <= auth.end;

  if (auth) {
    for (const name of auth.metrics) {
      if (cleaned[name] || !Object.hasOwn(merged, name)) continue;
      const prev = Array.isArray(merged[name]?.daily) ? merged[name].daily : [];
      const kept = prev.filter((p) => !inRange(p?.d));
      if (kept.length === prev.length) continue;
      // A full wipe removes the metric, not a present-but-empty shell agents read as "known".
      if (kept.length === 0) delete merged[name];
      else merged[name] = { ...merged[name], daily: kept };
    }
  }

  for (const [name, m] of Object.entries(cleaned)) {
    // A day keeps its recompute stamp (`r`) across later pushes that re-send the same value without
    // one, matching HealthCache.merge on the app side; a newer stamp replaces it.
    const byDay = new Map((merged[name]?.daily || []).map((p) => [p.d, p]));
    if (auth && auth.metrics.has(name)) {
      const incomingDays = new Set(m.daily.map((p) => p.d));
      for (const d of [...byDay.keys()]) if (inRange(d) && !incomingDays.has(d)) byDay.delete(d);
    }
    for (const p of m.daily) {
      const prev = byDay.get(p.d);
      // A day keeps its recompute stamp (`r`) and source attribution (`src`/`by`) across a later
      // push that re-sends the same value without them, matching HealthCache.merge on the app side;
      // a changed value makes both stale, so they are replaced by the incoming point's own (or none).
      const same = prev && prev.v === p.v;
      const keep = same && !p.r && typeof prev.r === 'string';
      const mergedPoint = { ...p };
      if (keep) mergedPoint.r = prev.r;
      if (same && !('src' in mergedPoint) && typeof prev.src === 'string') mergedPoint.src = prev.src;
      if (same && !('by' in mergedPoint) && prev.by && typeof prev.by === 'object' && !Array.isArray(prev.by)) mergedPoint.by = prev.by;
      byDay.set(p.d, mergedPoint);
    }
    merged[name] = { unit: m.unit || merged[name]?.unit || '', cumulative: !!m.cumulative,
      daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, p]) => {
          const out = { d, v: p.v };
          if (typeof p.r === 'string') out.r = p.r;
          if (typeof p.src === 'string') out.src = p.src;
          if (p.by && typeof p.by === 'object' && !Array.isArray(p.by)) out.by = p.by;
          return out;
        }) };
  }
  return merged;
}


// ---- strength.log (typed document, docs/SCHEMA-CONTRACTS.md sections 10 and 14) ----------------
//
// The app sends the SAME body the webhook gets: {type:"strength.log", schema:1, id, app, sentAt,
// data:{metrics:[], strengthLog:{mode:"replace", unit, formula, sessions, records, routines}}}.
// It is a whole-state replace, so this writes health-strength.json (the exact shape the file export
// writes: schema, app, writtenAt, unit, formula, sessions, records, routines) and never merges.
// Everything is rebuilt field by field from an allowlist: the body comes from a LAN client and ends
// up in an agent's context, so unknown keys are dropped, strings are length-capped, numbers must be
// finite and the sizes are bounded.
export const STRENGTH_TYPE = 'strength.log';
export const STRENGTH_FILE = 'health-strength.json';
const MAX_SESSIONS = 20000, MAX_EXERCISES = 100, MAX_SETS = 300, MAX_RECORDS = 2000, MAX_ROUTINES = 500, MAX_REP_BESTS = 10;
const str = (v, max) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const dayStr = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : undefined);
const pick = (src, spec) => {
  const out = {};
  for (const [k, f] of Object.entries(spec)) { const v = f(src?.[k]); if (v !== undefined) out[k] = v; }
  return out;
};
const sName = (v) => str(v, 120);
const setSpec = {
  reps: num, kg: num, rpe: num,
  kind: (v) => (v === 'warmup' || v === 'working' ? v : undefined),
};
const cleanSets = (a) => (Array.isArray(a) ? a.slice(0, MAX_SETS).filter((x) => x && typeof x === 'object')
  .map((x) => pick(x, setSpec)).filter((x) => x.reps !== undefined && x.kind) : []);
const cleanExercises = (a, extra) => (Array.isArray(a) ? a.slice(0, MAX_EXERCISES).map((e) => {
  const name = sName(e?.name);
  return name ? { name, ...pick(e, extra), sets: cleanSets(e.sets) } : null;
}).filter(Boolean) : []);
const sessionSpec = {
  id: (v) => str(v, 64), start: (v) => str(v, 40), day: dayStr, minutes: num, effort: num,
  workoutId: (v) => str(v, 64), routineId: (v) => str(v, 64), notes: (v) => str(v, 2000),
  volumeKg: num, workingSets: num,
};
const recordSpec = {
  exercise: sName, bestEstimateKg: num, bestEstimateDay: dayStr, heaviestKg: num, sessions: num, lastDay: dayStr,
  bestSetVolumeKg: num, bestSetVolumeDay: dayStr, bestSessionVolumeKg: num, bestSessionVolumeDay: dayStr,
};
const routineSpec = { id: (v) => str(v, 64), name: (v) => str(v, 120), createdAt: (v) => str(v, 40), lastUsedDay: dayStr };

/// Rebuild the strength log from a pushed `strength.log` document, or throw if it has no sessions list.
export function sanitizeStrengthLog(doc, now = new Date()) {
  const log = doc?.data?.strengthLog;
  if (!log || typeof log !== 'object' || !Array.isArray(log.sessions)) {
    throw Object.assign(new Error('strength.log without data.strengthLog.sessions'), { status: 400 });
  }
  const sessions = log.sessions.slice(0, MAX_SESSIONS).filter((s) => s && typeof s === 'object' && dayStr(s.day)).map((s) => ({
    ...pick(s, sessionSpec),
    exercises: cleanExercises(s.exercises, { volumeKg: num, bestEstimateKg: num }),
  }));
  const records = (Array.isArray(log.records) ? log.records.slice(0, MAX_RECORDS) : []).filter((r) => r && sName(r.exercise)).map((r) => {
    const o = pick(r, recordSpec);
    const reps = (Array.isArray(r.repBests) ? r.repBests.slice(0, MAX_REP_BESTS) : [])
      .map((b) => pick(b, { reps: num, kg: num, day: dayStr })).filter((b) => b.reps !== undefined && b.kg !== undefined && b.day);
    if (reps.length) o.repBests = reps;
    return o;
  });
  const routines = (Array.isArray(log.routines) ? log.routines.slice(0, MAX_ROUTINES) : []).filter((r) => r && sName(r.name)).map((r) => ({
    ...pick(r, routineSpec), exercises: cleanExercises(r.exercises, {}),
  }));
  const sent = typeof doc.sentAt === 'string' && ISO_INSTANT.test(doc.sentAt) ? doc.sentAt : null;
  return {
    schema: 1,
    app: str(doc.app, 32) ?? '',
    writtenAt: sent ?? now.toISOString().replace(/\.\d+Z$/, 'Z'),
    unit: 'kg',
    ...(str(log.formula, 32) && { formula: str(log.formula, 32) }),
    sessions, records, routines,
  };
}

// ---- workouts (typed document, the same body the webhook gets as `workouts`) -------------------
//
// {type:"workouts", schema:1, id, app, sentAt, data:{workouts:[...]}}: the records the app writes to
// .health-workouts-cache.json for iCloud and a folder (HealthKitProvider.readWorkouts), which the MCP
// server's get_workouts reads. Until now the LAN path never carried workouts, so an agent fed only by
// this receiver could not see a single run. Records ACCUMULATE: merged by HealthKit id (start|type
// for records written before ids), so a history export in pieces, a resend and a daily push all land
// once. Every record is rebuilt from scalar fields only (keys allowlisted, strings capped), because
// the body comes from a LAN client and ends up in an agent's context.
export const WORKOUTS_TYPE = 'workouts';
export const WORKOUTS_FILE = '.health-workouts-cache.json';
const MAX_WORKOUTS_PUSH = 20000, MAX_WORKOUTS_FILE = 100000, MAX_WORKOUT_FIELDS = 60, MAX_ALSO_RECORDED = 10;
const W_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

function cleanWorkout(w, nested) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(w)) {
    if (n >= MAX_WORKOUT_FIELDS || !W_FIELD.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    // The same session recorded by another source (a Watch run Strava re-wrote): one level only.
    else if (!nested && k === 'alsoRecordedBy' && Array.isArray(v)) {
      out[k] = v.slice(0, MAX_ALSO_RECORDED).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => cleanWorkout(x, true));
    } else continue;
    n++;
  }
  return out;
}

export function sanitizeWorkouts(doc) {
  const list = doc?.data?.workouts;
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_WORKOUTS_PUSH)
    .filter((w) => w && typeof w === 'object' && !Array.isArray(w))
    .map((w) => cleanWorkout(w, false))
    .filter((w) => typeof w.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(w.start));
}

/// Same identity as the app (ICloudExporter.workoutKey): the HealthKit UUID, else start|type.
export function workoutKey(w) {
  if (typeof w?.id === 'string' && w.id) return w.id;
  return `${w?.start ?? ''}|${w?.type ?? w?.workoutActivityType ?? w?.name ?? ''}`;
}

export function mergeWorkouts(existing, incoming) {
  const byKey = new Map();
  for (const w of Array.isArray(existing) ? existing : []) if (w && typeof w === 'object') byKey.set(workoutKey(w), w);
  for (const w of incoming) byKey.set(workoutKey(w), w);
  return [...byKey.values()].sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(-MAX_WORKOUTS_FILE);
}

function writeWorkouts(dir, doc, passphrase = configuredPassphrase(), sealFresh = false) {
  const file = path.join(dir, WORKOUTS_FILE);
  const incoming = sanitizeWorkouts(doc);
  fs.mkdirSync(dir, { recursive: true });
  const base = readMergeBase(file, [], passphrase);
  const merged = mergeWorkouts(base.value, incoming);
  const out = sealOutput(base.sealedLike, JSON.stringify(merged), passphrase, sealFresh);
  if (Buffer.byteLength(out) > MAX_CACHE_FILE) throw new Error('workouts file would exceed the size ceiling');
  atomicWrite(file, out);
  log(`workouts: ${incoming.length} received -> ${merged.length} in ${file}`);
  return merged.length;
}

// ---- context documents: sleep.sessions, timezone.changes, events (the webhook's typed documents) --
//
// Same bodies the app sends a webhook (docs/SCHEMA-CONTRACTS.md section 10), turned back into the
// exact files the app writes for iCloud and a folder, which the MCP server already reads:
//   events            -> health-events.json   whole-state replace {schema, app, writtenAt, events}
//   timezone.changes  -> health-days.json     whole-state replace {schema, writtenAt, currentTz, changes, note}
//   sleep.sessions    -> health-sessions.json replace exactly the waking days in data.coverage
// Before 1.12 a LAN user had none of these, whatever the app's switches said.
export const EVENTS_TYPE = 'events', TIMEZONES_TYPE = 'timezone.changes', SESSIONS_TYPE = 'sleep.sessions';
export const EVENTS_FILE = 'health-events.json', DAYS_FILE = 'health-days.json', SESSIONS_FILE = 'health-sessions.json';
const CTX_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_CTX_ITEMS = 50000, MAX_CTX_DEPTH = 5, MAX_CTX_STRING = 500;

/// A JSON value rebuilt from allowlisted keys, finite numbers, capped strings and bounded arrays and
/// depth. The body comes from a LAN client and ends up in an agent's context.
export function cleanContext(v, depth = 0) {
  if (typeof v === 'string') return v.slice(0, MAX_CTX_STRING);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (depth >= MAX_CTX_DEPTH || v === null || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) return v.slice(0, MAX_CTX_ITEMS).map((x) => cleanContext(x, depth + 1)).filter((x) => x !== undefined);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!CTX_KEY.test(k)) continue;
    const c = cleanContext(x, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const appOf = (doc) => (typeof doc?.app === 'string' ? doc.app.slice(0, 40) : 'MetricBridge');

/// events -> the health-events.json payload.
export function eventsFile(doc) {
  const list = doc?.data?.events?.events;
  if (!Array.isArray(list)) return null;
  const events = cleanContext(list, 1).filter((e) => e && typeof e === 'object' && typeof e.date === 'string');
  return { schema: 1, app: appOf(doc), writtenAt: isoNow(), events };
}

/// timezone.changes -> the health-days.json payload.
export function daysFile(doc) {
  const tz = doc?.data?.timeZones;
  if (!tz || typeof tz !== 'object' || !Array.isArray(tz.changes)) return null;
  const clean = cleanContext(tz, 1);
  delete clean.mode;
  return { schema: 1, writtenAt: isoNow(), ...clean };
}

/// sleep.sessions merged into the existing health-sessions.json payload: every stored session whose
/// waking `day` is inside coverage.fromDay..toDay is replaced by the incoming ones for those days.
export function sessionsFile(existing, doc) {
  const cov = doc?.data?.coverage;
  const list = doc?.data?.sleepSessions;
  if (!cov || !DAY_RE.test(cov.fromDay ?? '') || !DAY_RE.test(cov.toDay ?? '') || cov.fromDay > cov.toDay || !Array.isArray(list)) return null;
  const inRange = (d) => typeof d === 'string' && d >= cov.fromDay && d <= cov.toDay;
  const incoming = cleanContext(list, 1).filter((x) => x && typeof x.start === 'string' && inRange(x.day));
  const kept = (Array.isArray(existing?.sessions) ? existing.sessions : []).filter((x) => x && !inRange(x.day));
  const sessions = [...kept, ...incoming].sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(-MAX_CTX_ITEMS);
  return { schema: 1, app: appOf(doc), writtenAt: isoNow(), sessions };
}

/// Write one context document. Returns the count stored, or throws a 400 for a body of the right type
/// but the wrong shape.
function writeContext(dir, doc, passphrase = configuredPassphrase(), sealFresh = false) {
  const file = path.join(dir, doc.type === EVENTS_TYPE ? EVENTS_FILE : doc.type === TIMEZONES_TYPE ? DAYS_FILE : SESSIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const base = readMergeBase(file, null, passphrase);
  const out = doc.type === EVENTS_TYPE ? eventsFile(doc) : doc.type === TIMEZONES_TYPE ? daysFile(doc) : sessionsFile(base.value, doc);
  if (!out) { const e = new Error(`${doc.type}: unexpected body`); e.status = 400; throw e; }
  const text = sealOutput(base.sealedLike, JSON.stringify(out, null, 2), passphrase, sealFresh);
  if (Buffer.byteLength(text) > MAX_CACHE_FILE) throw new Error(`${doc.type} would exceed the size ceiling`);
  atomicWrite(file, text);
  const n = (out.events || out.changes || out.sessions || []).length;
  log(`${doc.type} -> ${n} in ${file}`);
  return n;
}
const CONTEXT_TYPES = new Set([EVENTS_TYPE, TIMEZONES_TYPE, SESSIONS_TYPE]);

function writeStrength(dir, doc, passphrase = configuredPassphrase(), sealFresh = false) {
  const file = path.join(dir, STRENGTH_FILE);
  const clean = sanitizeStrengthLog(doc);
  fs.mkdirSync(dir, { recursive: true });
  // Same at-rest rule as the cache: an existing envelope keeps its salt (the app and this server
  // hold the key for that salt), a fresh file is sealed when encryption is required.
  const base = readMergeBase(file, null, passphrase);
  const text = JSON.stringify(clean, null, 2);
  const out = sealOutput(base.sealedLike, text, passphrase, sealFresh);
  if (Buffer.byteLength(out) > MAX_CACHE_FILE) throw new Error('strength log would exceed the size ceiling');
  atomicWrite(file, out);
  log(`strength.log -> ${clean.sessions.length} sessions in ${file}`);
  return clean.sessions.length;
}

function sealOutput(sealedLike, text, passphrase, sealFresh) {
  if (sealedLike || (sealFresh && passphrase)) {
    return JSON.stringify(sealEnvelope(text, passphrase, { salt: sealedLike?.salt, iter: sealedLike?.iter }));
  }
  if (sealFresh) throw new Error('encryption required but no passphrase configured - refusing to store plaintext');
  return text;
}

function atomicWrite(file, out) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;  // unique → no concurrent-write race
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeCache(dir, json, passphrase = configuredPassphrase(), sealFresh = false) {
  const file = path.join(dir, '.health-cache.json');
  fs.mkdirSync(dir, { recursive: true });
  const base = readMergeBase(file, {}, passphrase);
  const merged = mergeCache(base.value, json);
  const text = JSON.stringify(merged, null, 2);
  // Seal when the existing file is already an envelope (preserve its salt/iter so the app's key
  // still matches), OR when fresh-sealing is requested (HEALTH_REQUIRE_ENCRYPTED=1 on a directory
  // whose cache file is not yet an envelope). Previously a fresh dir stored decrypted even though
  // every incoming push was encrypted — the flag promised full at-rest encryption and silently
  // delivered plaintext. Refuse to store plaintext when encryption is required but no passphrase
  // is configured: a misconfiguration, not a downgrade path.
  const out = sealOutput(base.sealedLike, text, passphrase, sealFresh);
  if (Buffer.byteLength(out) > MAX_CACHE_FILE) {
    throw new Error('cache would exceed the size ceiling; refusing to grow it further');
  }
  atomicWrite(file, out);
  log(`merged ${Object.keys(sanitize(json)).length} -> ${Object.keys(merged).length} metrics in ${file}`);
  return Object.keys(merged).length;
}

// ---- what to tell the person at the terminal ----------------------------------------------------
//
// The startup banner is the whole user interface of this file: the iOS app's setup step says "type
// the address it prints". It used to print every non-internal IPv4 address. On a Linux server that
// was the public IP (firewalled), six Docker bridges and the Tailscale 100.x IP (iOS refuses plain
// http to it), and the one name that works, <machine>.<tailnet>.ts.net, was not printed at all.
// So: the Tailscale MagicDNS name first, then private LAN addresses and <host>.local labelled
// "same Wi-Fi only", and nothing an iPhone cannot reach. Every name printed also passes `hostOk`.

// Virtual and VPN interfaces: Docker/Podman/k8s bridges, VMs, and Tailscale's own (its IP is useless
// to an iPhone; its NAME is printed instead).
const SKIP_IFACE = /^(docker\d*|br-|veth|virbr|cni|flannel|cali|vmnet|vboxnet|bridge\d+|podman|tailscale|utun|ts\d|zt|wg|lo)/i;

/// 10/8, 172.16/12, 192.168/16: what a phone on the same Wi-Fi can reach. A public IP is left out on
/// purpose (on a server it is firewalled, and iOS will not send plain http to it anyway).
export function isPrivateLAN(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/// The addresses worth typing on the iPhone, best first. Pure: the caller passes os.networkInterfaces(),
/// os.hostname() and the Tailscale DNS name (or '').
export function phoneAddresses({ nets = {}, hostname = '', tailscaleName = '' } = {}) {
  const ts = String(tailscaleName || '').replace(/\.$/, '').toLowerCase();
  const tailscale = ts.endsWith('.ts.net') ? [ts] : [];
  const lan = [];
  for (const [name, list] of Object.entries(nets || {})) {
    if (SKIP_IFACE.test(name)) continue;
    for (const ni of list || []) {
      if (!ni || ni.internal) continue;
      if ((ni.family === 'IPv4' || ni.family === 4) && isPrivateLAN(ni.address)) lan.push(ni.address);
    }
  }
  const hn = String(hostname || '').toLowerCase();
  if (hn && !hn.includes('.')) lan.push(`${hn}.local`);
  else if (hn.endsWith('.local')) lan.push(hn);
  return { tailscale, lan: [...new Set(lan)] };
}

/// This machine's Tailscale MagicDNS name, or '' when Tailscale is not installed or not connected.
/// Never throws and never waits long: the banner must not hold up the listener.
export function tailscaleDNSName(run = (cmd, args) => execFileSync(cmd, args, { timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }).toString()) {
  for (const cmd of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const st = JSON.parse(run(cmd, ['status', '--json']));
      if (st?.BackendState === 'Running' && typeof st?.Self?.DNSName === 'string') return st.Self.DNSName.replace(/\.$/, '');
    } catch { /* not installed here, not running, or not JSON: try the next one */ }
  }
  return '';
}

/// The startup banner, as lines. Pure, so the wording is tested.
export function startupLines({ host, port, dir, token, addrs }) {
  const out = [`listening on ${host}:${port}${token ? ' (token required)' : ' (loopback only)'}`];
  if (!isLoopback(host)) {
    const { tailscale = [], lan = [] } = addrs || {};
    if (tailscale.length || lan.length) {
      out.push('On your iPhone, in MetricBridge > My local network, type one of these:');
      for (const a of tailscale) out.push(`  ${a}:${port}   (Tailscale: works wherever your iPhone has Tailscale on)`);
      for (const a of lan) out.push(`  ${a}:${port}   (same Wi-Fi only)`);
      if (!tailscale.length) out.push('Away from this Wi-Fi? Install Tailscale here and on the iPhone, then restart this: its .ts.net name will be listed first.');
    } else {
      out.push('No address an iPhone can reach was found. On the same Wi-Fi, use this computer\'s LAN IP; anywhere else, install Tailscale and use its .ts.net name.');
    }
  }
  out.push(`Agent: set HEALTH_DATA_DIR=${dir} in your agent's MetricBridge (health-export) server settings.`);
  out.push('Waiting for the first export from the iPhone (tap Sync Now in the app)...');
  return out;
}

/// `receive --print-systemd`: a systemd user service that keeps the receiver running on a Linux box
/// (survives logout and reboot). Printed, never installed: the person reads it and runs it. The token
/// goes in a 0600 EnvironmentFile, not the command line, so it is not in `ps` or shell history.
export function systemdSetup({ env = process.env, nodeDir = path.dirname(process.execPath) } = {}) {
  const dir = path.resolve(expandTilde(env.HEALTH_DATA_DIR || '~/MetricBridge'));
  const settings = [
    `HEALTH_LISTEN_HOST=${env.HEALTH_LISTEN_HOST && !isLoopback(env.HEALTH_LISTEN_HOST) ? env.HEALTH_LISTEN_HOST : '0.0.0.0'}`,
    `HEALTH_LISTEN_TOKEN=${env.HEALTH_LISTEN_TOKEN || 'PASTE-THE-PAIRING-CODE-FROM-THE-APP'}`,
    `HEALTH_DATA_DIR=${dir}`,
  ];
  if (env.HEALTH_LISTEN_PORT) settings.push(`HEALTH_LISTEN_PORT=${env.HEALTH_LISTEN_PORT}`);
  return [
    '# Keep the MetricBridge receiver running (Linux, systemd user service). Run these lines as the',
    '# user who should own the data. Nothing here needs root.',
    '',
    '# 1) Settings. The pairing code lives here, readable only by you, not on the command line.',
    'mkdir -p ~/.config/metricbridge && chmod 700 ~/.config/metricbridge',
    "cat > ~/.config/metricbridge/receiver.env <<'EOF'",
    ...settings,
    'EOF',
    'chmod 600 ~/.config/metricbridge/receiver.env',
    '',
    '# 2) The service.',
    'mkdir -p ~/.config/systemd/user',
    "cat > ~/.config/systemd/user/metricbridge-receiver.service <<'EOF'",
    '[Unit]',
    'Description=MetricBridge receiver (iPhone exports into HEALTH_DATA_DIR)',
    'After=network-online.target',
    '',
    '[Service]',
    'EnvironmentFile=%h/.config/metricbridge/receiver.env',
    `Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin`,
    `ExecStart=${path.join(nodeDir, 'npx')} -y health-export-mcp@latest receive`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    'EOF',
    '',
    '# 3) Start it now and at every boot, and keep it running after you log out.',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now metricbridge-receiver',
    'loginctl enable-linger "$USER"',
    '',
    '# Its output (the address to type on the iPhone is at the top):',
    'journalctl --user -u metricbridge-receiver -e',
    '',
    `# Your agent reads ${dir}: set HEALTH_DATA_DIR to it in the agent's MetricBridge server settings.`,
  ].join('\n');
}

/// Start the HTTP + WebSocket listener. Returns the http.Server, or null if it refused to start.
export function startReceiver({
  dir = expandTilde(process.env.HEALTH_DATA_DIR || '.'),
  host = process.env.HEALTH_LISTEN_HOST || '127.0.0.1',
  port = Number(process.env.HEALTH_LISTEN_PORT || 27184),
  token = process.env.HEALTH_LISTEN_TOKEN || '',
  // The default merge uses the same passphrase source as the push decrypt below (the merge base
  // can itself be sealed when this directory is the folder the app encrypts into). `sealFresh`
  // passes HEALTH_REQUIRE_ENCRYPTED through to first-write sealing, closing the fresh-dir
  // plaintext-at-rest gap.
  onCache = (json) => writeCache(dir, json, passphrase(), requireEncrypted()),
  // The `strength.log` typed document (whole-state replace into health-strength.json). Tests inject one.
  onStrength = (doc) => writeStrength(dir, doc, passphrase(), requireEncrypted()),
  // The `workouts` typed document (accumulating merge into .health-workouts-cache.json). Tests inject one.
  onWorkouts = (doc) => writeWorkouts(dir, doc, passphrase(), requireEncrypted()),
  // sleep.sessions / timezone.changes / events (context files). Tests inject one.
  onContext = (doc) => writeContext(dir, doc, passphrase(), requireEncrypted()),
  // A function, read per request: the environment is the source in production, tests inject one.
  passphrase = () => configuredPassphrase(),
  requireEncrypted = () => process.env.HEALTH_REQUIRE_ENCRYPTED === '1',
} = {}) {
  // The banner ends with "waiting for the first export"; say when it arrives, once.
  let firstExport = true;
  const takeCache = (json) => {
    const n = onCache(json);
    if (firstExport) {
      firstExport = false;
      log(n > 0 ? `First export received (${n} metrics). Your agent can read it now.`
                : 'An export arrived with no metrics in it: check the app has Apple Health access, then Sync Now.');
    }
    return n;
  };
  // Fail closed: never expose an unauthenticated write endpoint on the network.
  if (!isLoopback(host) && !token) {
    log(`REFUSING to listen on non-loopback ${host} without HEALTH_LISTEN_TOKEN: set the iOS pairing code as the token.`);
    return null;
  }

  const tokenOk = (req) => {
    if (!token) return true;                                    // loopback-only, token optional
    const got = Buffer.from(String(req.headers['x-health-token'] || ''));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  // Reject browser-originated / DNS-rebinding requests; native iOS sends no Origin and an IP-literal Host.
  // A Host that is a domain name (not localhost / not an IP literal) is the rebinding vector → reject it.
  const hostOk = (req) => {
    if (req.headers['origin'] !== undefined) return false;
    const raw = String(req.headers['host'] || '');
    const v6 = raw.match(/^\[([^\]]+)\]/);                 // "[::1]:27184" → "::1"  (strip brackets BEFORE the colon split)
    const hn = (v6 ? v6[1] : raw.split(':')[0]).toLowerCase().replace(/%.*$/, ''); // strip port; strip IPv6 zone (%en0)
    if (!hn) return false;
    // loopback name, valid IPv4/IPv6 literal, or a private DNS name (Tailscale MagicDNS / mDNS). Browser
    // DNS-rebinding still can't pass: browsers always send an Origin header (rejected above) and a token is
    // mandatory on a non-loopback bind.
    return hn === 'localhost' || hn.endsWith('.ts.net') || hn.endsWith('.local') || net.isIP(hn) !== 0;
  };
  // Distinguish "wrong/blocked host" (403) from "bad token" (401) so the app can tell the user the real reason.
  const gate = (req) => {
    if (!hostOk(req)) return { ok: false, code: 403, msg: 'host not permitted' };
    if (!tokenOk(req)) return { ok: false, code: 401, msg: 'unauthorized: check pairing secret' };
    return { ok: true, code: 200, msg: 'ok' };
  };

  const json = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  // Slowloris / partial-trickle defense for the POST path: the request body accumulates in
  // memory per connection, so a client that dribbles bytes can hold sockets open forever.
  // Cap idle time while reading a body; a legit export finishes well inside this.
  const BODY_READ_TIMEOUT = 30_000;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/health-cache') {
      const g = gate(req); if (!g.ok) return json(res, g.code, { ok: false, hae: true, error: g.msg });
      let body = '', tooBig = false, done = false;
      const finish = (code, obj) => { if (done) return; done = true; clearTimeout(idle); json(res, code, obj); };
      const idle = setTimeout(() => { finish(408, { ok: false, hae: true, error: 'request read timeout' }); req.destroy(); }, BODY_READ_TIMEOUT);
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY && !tooBig) { tooBig = true; finish(413, { ok: false, hae: true, error: 'payload too large' }); req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig || res.writableEnded) return;
        clearTimeout(idle);
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return finish(400, { ok: false, hae: true, error: 'invalid JSON' }); }   // 400 = parse only
        if (parsed && parsed._test === true) return finish(200, { ok: true, hae: true, test: true }); // probe: never touch the cache
        // HEALTH_REQUIRE_ENCRYPTED=1: refuse plaintext pushes. The pairing token travels in a plain
        // http header on this leg, so anyone who sniffed one push could otherwise forge plaintext
        // data with it; requiring envelopes means a forger also needs the passphrase.
        if (requireEncrypted() && !isEnvelope(parsed)) {
          return finish(422, { ok: false, hae: true, reason: 'encryption_required', error: 'this receiver only accepts encrypted pushes' });
        }
        // Encrypted push (the app's "Local network" encryption switch). 422 + a machine `reason`
        // the app turns into a sentence that says where to fix it. Never echoes the passphrase.
        if (isEnvelope(parsed)) {
          try { parsed = openEnvelopeJSON(parsed, passphrase()); }
          catch (e) {
            const reason = e instanceof EnvelopeError ? e.code : 'malformed';
            log('encrypted push refused:', reason);
            return finish(422, { ok: false, hae: true, reason, error: e instanceof EnvelopeError ? e.message : 'could not decrypt' });
          }
        }
        if (CONTEXT_TYPES.has(parsed?.type)) {
          try { const n = onContext(parsed); finish(200, { ok: true, hae: true, type: parsed.type, count: n }); }
          catch (e) { log(`${parsed.type} refused`, e.message); finish(e.status || 500, { ok: false, hae: true, error: `${parsed.type}: ` + (e.code || e.message) }); }
          return;
        }
        if (parsed?.type === WORKOUTS_TYPE) {
          try { const n = onWorkouts(parsed); finish(200, { ok: true, hae: true, type: WORKOUTS_TYPE, workouts: n }); }
          catch (e) { log('workouts refused', e.message); finish(e.status || 500, { ok: false, hae: true, error: 'workouts: ' + (e.code || e.message) }); }
          return;
        }
        if (parsed?.type === STRENGTH_TYPE) {
          try { const n = onStrength(parsed); finish(200, { ok: true, hae: true, type: STRENGTH_TYPE, sessions: n }); }
          catch (e) { log('strength.log refused', e.message); finish(e.status || 500, { ok: false, hae: true, error: 'strength.log: ' + (e.code || e.message) }); }
          return;
        }
        try { const n = takeCache(parsed); finish(200, { ok: true, hae: true, metrics: n }); }
        catch (e) { log('write failed', e.message); finish(500, { ok: false, hae: true, error: 'write failed: ' + (e.code || e.message) }); } // 500 = disk/write
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') { return json(res, 200, { ok: true, hae: true, port }); }
    json(res, 404, { ok: false, hae: true, error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const up = String(req.headers['upgrade'] || '').toLowerCase() === 'websocket';
    if (!up || !key || !req.url.startsWith('/health-cache-ws')) { socket.destroy(); return; }
    const g = gate(req); if (!g.ok) { socket.write(`HTTP/1.1 ${g.code} ${g.msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + WS_GUID, 'binary').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let buf = Buffer.alloc(0);
    socket.setTimeout(30_000, () => socket.destroy());          // drop idle/slowloris sockets
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_WS_BUF) { log('ws buffer cap exceeded'); socket.destroy(); return; }
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) { socket.end(); return; }             // close
      if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x00])); buf = Buffer.alloc(0); return; } // ping → pong
      if (opcode === 0xa) { buf = Buffer.alloc(0); return; }     // pong → ignore
      const msg = decodeTextFrame(buf);
      if (msg === null) return;                                  // incomplete or unsupported → wait
      try {
        let parsedMsg = JSON.parse(msg);
        if (requireEncrypted() && !isEnvelope(parsedMsg)) throw new Error('plaintext push refused (HEALTH_REQUIRE_ENCRYPTED)');
        if (isEnvelope(parsedMsg)) parsedMsg = openEnvelopeJSON(parsedMsg, passphrase());
        if (CONTEXT_TYPES.has(parsedMsg?.type)) {
          const n = onContext(parsedMsg);
          socket.write(encodeTextFrame(JSON.stringify({ ok: true, type: parsedMsg.type, count: n })));
        } else if (parsedMsg?.type === WORKOUTS_TYPE) {
          const n = onWorkouts(parsedMsg);
          socket.write(encodeTextFrame(JSON.stringify({ ok: true, type: WORKOUTS_TYPE, workouts: n })));
        } else if (parsedMsg?.type === STRENGTH_TYPE) {
          const n = onStrength(parsedMsg);
          socket.write(encodeTextFrame(JSON.stringify({ ok: true, type: STRENGTH_TYPE, sessions: n })));
        } else {
          const n = takeCache(parsedMsg);
          socket.write(encodeTextFrame(JSON.stringify({ ok: true, metrics: n })));
        }
      }
      catch (e) { log('bad WS json', e.message); socket.write(encodeTextFrame(JSON.stringify({ ok: false }))); }
      socket.end();
    });
    socket.on('error', (e) => log('ws socket error', e.message));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log(`PORT ${port} IN USE: stop the other process, or set HEALTH_LISTEN_PORT to a free port (e.g. ${port + 1}).`);
    else if (e.code === 'EACCES') log(`PERMISSION DENIED binding ${host}:${port}: use a port >= 1024.`);
    else if (e.code === 'EADDRNOTAVAIL') log(`ADDRESS ${host} NOT AVAILABLE here: use 0.0.0.0 or a local IP.`);
    else log('server error', e.message);
  });
  server.listen(port, host, () => {
    const addrs = isLoopback(host) ? null
      : phoneAddresses({ nets: os.networkInterfaces(), hostname: os.hostname(), tailscaleName: tailscaleDNSName() });
    for (const line of startupLines({ host, port, dir: path.resolve(dir), token, addrs })) log(line);
  });
  return server;
}

// ---- minimal RFC 6455 (single masked text frame in; unmasked text frame out) ----

function decodeTextFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
  if (!fin || opcode !== 0x1 || !masked) return null;        // require a single masked text frame
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (len > MAX_WS_BUF) return null;
  if (buf.length < off + 4 + len) return null;               // wait for the rest
  const mask = buf.subarray(off, off + 4), payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return payload.toString('utf8');
}

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8'), len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

// Standalone run (also importable by server.mjs). Both sides are resolved to REAL paths: a bin
// symlink (npx, npm i -g) otherwise makes this false and the receiver silently never starts.
const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  startReceiver();
}

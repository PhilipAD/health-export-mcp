// healthstore.mjs — reads the health data the iOS app exported to iCloud Drive.
//
// The Health Export AI iOS app writes the cache directly into its iCloud Drive
// container; this server reads it locally. No receiver, no Docker, no HTTP bridge.
//
//   HEALTH_DATA_DIR=/path  → read <dir>/.health-cache.json (+ .health-workouts-cache.json)
//   (default on macOS: ~/Library/Mobile Documents/iCloud~ai~healthexport~app/Documents)
//
// Cache shape (written by the iOS app's ICloudExporter / HealthCache):
//   { "<metric>": { unit, cumulative, daily: [ { d:"YYYY-MM-DD", v:Number } ] }, ... }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// Expand a leading ~ (Node, unlike the shell, does not) so manual configs resolve correctly.
const RAW_DIR = process.env.HEALTH_DATA_DIR || '.';
const DATA_DIR = (RAW_DIR === '~' || RAW_DIR.startsWith('~/'))
  ? path.join(os.homedir(), RAW_DIR.slice(1))
  : RAW_DIR;

const MAX_BYTES = 64 * 1024 * 1024; // cap cache reads to guard against resource exhaustion

function readJSON(file, fallback) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

// Pairing gate: if the iOS app wrote `.health-pair.json`, the configured PAIRING_SECRET must
// hash (sha256) to the stored value before any data is served. No pair file ⇒ open (the data is
// already local-only). So a copied bundle / another iCloud user can't read without the secret.
export function pairing() {
  const pair = readJSON(path.join(DATA_DIR, '.health-pair.json'), null);
  if (!pair || !pair.hash) return { required: false, ok: true };
  const secret = process.env.PAIRING_SECRET || '';
  const h = crypto.createHash('sha256').update(secret).digest('hex');
  let ok = false;
  if (secret.length > 0 && typeof pair.hash === 'string' && pair.hash.length === h.length) {
    ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(pair.hash)); // constant-time
  }
  return { required: true, ok };
}

// Throw a clear "locked" error from the data tools when pairing is required but not satisfied,
// so an agent sees the real reason instead of a misleading "unknown metric".
function assertUnlocked() {
  const p = pairing();
  if (p.required && !p.ok) throw new Error('Locked: set PAIRING_SECRET to the code shown in the iOS app (Settings → Agent pairing).');
}

export async function loadMetrics() {
  if (!pairing().ok) return {};
  return readJSON(path.join(DATA_DIR, '.health-cache.json'), {});
}

export async function loadWorkouts() {
  if (!pairing().ok) return [];
  return readJSON(path.join(DATA_DIR, '.health-workouts-cache.json'), []);
}

export function sourceLabel() {
  return `file ${path.resolve(DATA_DIR, '.health-cache.json')}`;
}

// ---- helpers ----
const inRange = (d, start, end) => (!start || d >= start) && (!end || d <= end);

function aggregate(values, how, cumulative) {
  if (!values.length) return null;
  switch (how) {
    case 'sum':   return round(values.reduce((a, b) => a + b, 0));
    case 'min':   return round(Math.min(...values));
    case 'max':   return round(Math.max(...values));
    case 'avg':   return round(values.reduce((a, b) => a + b, 0) / values.length);
    case 'latest':return round(values[values.length - 1]);
    default:      return round(cumulative
                    ? values.reduce((a, b) => a + b, 0)
                    : values.reduce((a, b) => a + b, 0) / values.length);
  }
}
const round = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

// ---- query API used by the MCP tools ----

export async function status() {
  const p = pairing();
  const metrics = await loadMetrics();
  const workouts = await loadWorkouts();
  const names = Object.keys(metrics);
  let lastDate = null;
  for (const m of Object.values(metrics)) {
    const d = m?.daily?.[m.daily.length - 1]?.d;
    if (d && (!lastDate || d > lastDate)) lastDate = d;
  }
  return {
    ok: names.length > 0 && p.ok,
    source: sourceLabel(),
    paired: p.required,
    locked: p.required && !p.ok,
    note: (p.required && !p.ok)
      ? 'Locked: set PAIRING_SECRET to the code shown in the iOS app (Settings → Agent pairing → scan/paste).'
      : names.length === 0
      ? 'No health data found yet. Open the Health Export AI iOS app and run an export to iCloud Drive (its data feeds this server). Don\'t have it? Get it on the App Store: https://apps.apple.com/app/id6784185201'
      : undefined,
    metricCount: names.length,
    workoutCount: Array.isArray(workouts) ? workouts.length : 0,
    lastDataDate: lastDate,
    metrics: names.sort(),
  };
}

export async function listMetrics() {
  const metrics = await loadMetrics();
  return Object.entries(metrics).map(([name, m]) => ({
    name,
    unit: m.unit || '',
    cumulative: !!m.cumulative,
    days: m.daily?.length || 0,
    firstDate: m.daily?.[0]?.d || null,
    lastDate: m.daily?.[m.daily.length - 1]?.d || null,
    latest: m.daily?.[m.daily.length - 1]?.v ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getHealthMetrics({ metric, start, end, aggregation } = {}) {
  assertUnlocked();
  const metrics = await loadMetrics();
  const names = metric ? [metric] : Object.keys(metrics);
  const out = {};
  for (const name of names) {
    const m = metrics[name];
    if (!m) continue;
    const points = (m.daily || []).filter((p) => inRange(p.d, start, end));
    out[name] = {
      unit: m.unit || '',
      cumulative: !!m.cumulative,
      points: points.map((p) => ({ date: p.d, value: round(p.v) })),
      aggregate: aggregate(points.map((p) => p.v), aggregation, m.cumulative),
      aggregation: aggregation || (m.cumulative ? 'sum' : 'avg'),
    };
  }
  if (metric && !out[metric]) throw new Error(`unknown metric "${metric}". Use list_metrics to see available names.`);
  return out;
}

export async function getTrends({ metric, window = 7 } = {}) {
  if (!metric) throw new Error('metric is required');
  assertUnlocked();
  const metrics = await loadMetrics();
  const m = metrics[metric];
  if (!m) throw new Error(`unknown metric "${metric}"`);
  const daily = (m.daily || []).slice();
  const recent = daily.slice(-window).map((p) => p.v);
  const prior  = daily.slice(-window * 2, -window).map((p) => p.v);
  const agg = (vs) => aggregate(vs, m.cumulative ? 'sum' : 'avg', m.cumulative);
  const r = agg(recent), p = agg(prior);
  const changePct = (r != null && p != null && p !== 0) ? round(((r - p) / Math.abs(p)) * 100) : null;
  return {
    metric, unit: m.unit || '', window,
    recent: r, prior: p,
    change: r != null && p != null ? round(r - p) : null,
    changePercent: changePct,
    direction: changePct == null
      ? (r != null && p === 0 ? (r > 0 ? 'up' : 'flat') : 'unknown')   // rose from a 0 baseline
      : changePct > 1 ? 'up' : changePct < -1 ? 'down' : 'flat',
    recentRange: { from: daily.slice(-window)[0]?.d, to: daily[daily.length - 1]?.d },
  };
}

export async function comparePeriods({ metric, periodA, periodB } = {}) {
  if (!metric || !periodA || !periodB) throw new Error('metric, periodA {start,end}, periodB {start,end} required');
  const a = await getHealthMetrics({ metric, start: periodA.start, end: periodA.end });
  const b = await getHealthMetrics({ metric, start: periodB.start, end: periodB.end });
  const av = a[metric]?.aggregate, bv = b[metric]?.aggregate;
  const changePct = (av != null && bv != null && bv !== 0) ? round(((av - bv) / Math.abs(bv)) * 100) : null;
  return {
    metric, unit: a[metric]?.unit || '',
    periodA: { ...periodA, value: av }, periodB: { ...periodB, value: bv },
    change: av != null && bv != null ? round(av - bv) : null,
    changePercent: changePct,
  };
}

export async function getStructuredExport({ metrics: names, start, end } = {}) {
  const all = await loadMetrics();
  const pick = names && names.length ? names : Object.keys(all);
  const data = {};
  for (const name of pick) {
    const m = all[name];
    if (!m) continue;
    data[name] = {
      unit: m.unit || '', cumulative: !!m.cumulative,
      daily: (m.daily || []).filter((p) => inRange(p.d, start, end)).map((p) => ({ d: p.d, v: round(p.v) })),
    };
  }
  return { generatedAt: new Date().toISOString(), range: { start: start || null, end: end || null }, metrics: data };
}

// Lightweight NL router: detect metric + time range + intent from a question.
const ALIASES = {
  steps: 'step_count', step: 'step_count', 'heart rate': 'heart_rate', hr: 'heart_rate',
  hrv: 'heart_rate_variability', 'resting heart rate': 'resting_heart_rate', rhr: 'resting_heart_rate',
  sleep: 'sleep_analysis', 'vo2': 'vo2_max', 'vo2 max': 'vo2_max', weight: 'weight_body_mass',
  'blood oxygen': 'blood_oxygen_saturation', spo2: 'blood_oxygen_saturation', oxygen: 'blood_oxygen_saturation',
  'respiratory rate': 'respiratory_rate', distance: 'walking_running_distance',
  'active energy': 'active_energy', calories: 'active_energy', energy: 'active_energy',
};
export async function queryHealthData({ question } = {}) {
  if (!question) throw new Error('question is required');
  const q = question.toLowerCase();
  const all = await loadMetrics();
  let metric = null;
  // longest alias first so "hrv" beats the "hr" substring, etc.
  const aliases = Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, name] of aliases) if (q.includes(alias)) { metric = name; break; }
  if (!metric) for (const name of Object.keys(all)) if (q.includes(name.replace(/_/g, ' '))) { metric = name; break; }

  const wantsTrend = /(trend|compare|vs|versus|last month|this month|change|improv|better|worse)/.test(q);
  const wantsAvg = /(average|avg|mean|typical)/.test(q);
  if (!metric) return { interpreted: 'no specific metric detected', suggestion: 'Call list_metrics, then get_health_metrics.', available: Object.keys(all).sort() };
  if (wantsTrend) return { interpreted: `trend for ${metric}`, result: await getTrends({ metric, window: 30 }) };
  const agg = wantsAvg ? 'avg' : undefined;
  return { interpreted: `${agg || 'summary'} for ${metric}`, result: await getHealthMetrics({ metric, aggregation: agg }) };
}

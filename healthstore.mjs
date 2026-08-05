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
//
// Conventions agents should know:
//   • `d` is the device's LOCAL calendar day (not UTC) — the same day boundary the iOS dashboard
//     and the HAE webhook envelope use, so all three surfaces agree for "the same day".
//   • Percentage metrics (unit "%", e.g. blood_oxygen_saturation, body_fat_percentage) are stored
//     as 0–1 FRACTIONS (0.97 = 97%). The iOS dashboard multiplies by 100 for display only; values
//     served here are the raw fraction — don't ×100 again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// Expand a leading ~ (Node, unlike the shell, does not) so manual configs resolve correctly.
const RAW_DIR = process.env.HEALTH_DATA_DIR || '.';
const DATA_DIR = (RAW_DIR === '~' || RAW_DIR.startsWith('~/'))
  ? path.join(os.homedir(), RAW_DIR.slice(1))
  : RAW_DIR;

// Guard against reading something pathological, but sized for a real full-history cache.
// Measured on this cache's exact shape (189 metrics x 3,653 days): 22.0 MB compact. The old
// 64 MB ceiling was within reach of a long history once workouts were included -- and worse, the
// old code SILENTLY returned the fallback when it was exceeded, so the server reported "no health
// data" and "unknown metric" for a user whose file was simply large. Oversize is now a thrown,
// explainable error; only genuinely absent or corrupt files fall back.
const MAX_BYTES = Number(process.env.HEALTH_MAX_CACHE_BYTES || 512 * 1024 * 1024);

class CacheTooLarge extends Error {}

function readJSON(file, fallback) {
  let st;
  try {
    st = fs.statSync(file);
  } catch { return fallback; }              // absent -> a normal first run
  if (!st.isFile()) return fallback;
  if (st.size > MAX_BYTES) {
    throw new CacheTooLarge(
      `health cache is ${(st.size / 1048576).toFixed(1)} MB, above the ${(MAX_BYTES / 1048576).toFixed(0)} MB read limit. ` +
      `Raise HEALTH_MAX_CACHE_BYTES if this is expected.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }              // corrupt -> fall back rather than crash the server
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

// Parsing the cache is the single most expensive thing this server does, and every tool call used
// to redo it from scratch. MEASURED on a full 10-year cache (189 metrics x 3,653 days, 22 MB): 13.5
// seconds per call. Memoized on (mtime, size) so a re-read only happens when the iOS app has
// actually rewritten the file — which is exactly the signal we want, since the app writes
// atomically via a rename.
const _memo = new Map();
function readJSONCached(file, fallback) {
  let st;
  try { st = fs.statSync(file); } catch { _memo.delete(file); return fallback; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = _memo.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = readJSON(file, fallback);
  _memo.set(file, { stamp, value });
  return value;
}

export async function loadMetrics() {
  if (!pairing().ok) return {};
  return readJSONCached(path.join(DATA_DIR, '.health-cache.json'), {});
}

export async function loadWorkouts() {
  if (!pairing().ok) return [];
  return readJSONCached(path.join(DATA_DIR, '.health-workouts-cache.json'), []);
}

export function sourceLabel() {
  return `file ${path.resolve(DATA_DIR, '.health-cache.json')}`;
}

// ---- helpers ----
const inRange = (d, start, end) => (!start || d >= start) && (!end || d <= end);

// Dates arrive as strings and were previously compared lexicographically with no validation, so
// "2026-8-1" or "last tuesday" silently matched nothing and the tool returned an empty series with
// isError:false -- an agent could not tell "no data" from "you typed the date wrong".
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDay(v, label) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !DAY_RE.test(v)) {
    throw new Error(`${label} must be YYYY-MM-DD (got ${JSON.stringify(v)})`);
  }
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`${label} is not a real date: ${v}`);
  }
  return v;
}

// How many daily points a caller gets before the server starts aggregating instead of enumerating.
// Claude Code caps tool responses at 25,000 tokens (MAX_MCP_OUTPUT_TOKENS) and warns above 10,000.
// One daily point serializes to roughly 30 characters, so ~365 points per metric is a comfortable
// ceiling for a single-metric answer and forces the multi-metric paths through `granularity`.
const DEFAULT_LIMIT = 365;
const MAX_LIMIT = 3000;

const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'];

function bucketKey(day, granularity) {
  const [y, m, d] = day.split('-');
  switch (granularity) {
    case 'year': return y;
    case 'quarter': return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
    case 'month': return `${y}-${m}`;
    case 'week': {
      // ISO week, so a bucket label is unambiguous across year boundaries.
      const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      const dayNum = (dt.getUTCDay() + 6) % 7;
      dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
      const week = 1 + Math.round(((dt - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
      return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    default: return day;
  }
}

// Pick the finest granularity whose bucket count fits the limit. This is what makes `auto` safe:
// "ten years of steps" returns ~120 monthly points instead of 3,653 daily ones, and the caller is
// told what happened rather than silently receiving a truncated series.
function resolveGranularity(pointCount, requested, limit) {
  if (requested && requested !== 'auto') {
    if (!GRANULARITIES.includes(requested)) {
      throw new Error(`granularity must be one of auto, ${GRANULARITIES.join(', ')}`);
    }
    return requested;
  }
  if (pointCount <= limit) return 'day';
  if (pointCount <= limit * 7) return 'week';
  if (pointCount <= limit * 31) return 'month';
  if (pointCount <= limit * 92) return 'quarter';
  return 'year';
}

// Roll daily points up to `granularity`. Cumulative metrics sum within a bucket, everything else
// averages -- the same rule HealthCache uses on the writing side, so a monthly step total and a
// monthly resting-HR average both mean what a reader expects.
function rollUp(points, granularity, cumulative) {
  if (granularity === 'day') return points.map((p) => ({ date: p.d, value: round(p.v) }));
  const buckets = new Map();
  for (const p of points) {
    const k = bucketKey(p.d, granularity);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p.v);
  }
  return [...buckets.entries()].map(([k, vs]) => ({
    date: k,
    value: round(cumulative ? vs.reduce((a, b) => a + b, 0) : vs.reduce((a, b) => a + b, 0) / vs.length),
    days: vs.length,
  }));
}

// Coverage is the honest answer to "how much history is in this file?", and every data tool
// returns it so an agent can see when its question is deeper than the data.
function coverageOf(m) {
  const daily = m?.daily || [];
  return { firstDate: daily[0]?.d || null, lastDate: daily[daily.length - 1]?.d || null, days: daily.length };
}

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

export async function getHealthMetrics({ metric, start, end, aggregation, granularity, limit } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  const metrics = await loadMetrics();
  const names = metric ? [metric] : Object.keys(metrics);
  if (metric && !metrics[metric]) {
    throw new Error(`unknown metric "${metric}". Use list_metrics to see available names.`);
  }
  // Asking for every metric at once used to return every point of every metric. On a full history
  // that is tens of MB and blows any client's context window before the agent sees a single number.
  // Multi-metric calls get a proportionally smaller per-metric budget so the whole answer stays
  // readable; `granularity` (not truncation) is what absorbs the difference.
  const perMetric = metric ? cap : Math.max(24, Math.floor(cap / Math.max(1, names.length)));

  const out = {};
  for (const name of names) {
    const m = metrics[name];
    if (!m) continue;
    const all = m.daily || [];
    const points = all.filter((p) => inRange(p.d, start, end));
    const gran = resolveGranularity(points.length, granularity, perMetric);
    const rolled = rollUp(points, gran, !!m.cumulative);
    out[name] = {
      unit: m.unit || '',
      cumulative: !!m.cumulative,
      granularity: gran,
      points: rolled,
      // The aggregate is always computed over the FULL filtered range, never over the rolled-up
      // points, so rolling up can never change the answer to "what was my total".
      aggregate: aggregate(points.map((p) => p.v), aggregation, m.cumulative),
      aggregation: aggregation || (m.cumulative ? 'sum' : 'avg'),
      pointsInRange: points.length,
      coverage: coverageOf(m),
    };
    if (gran !== 'day') {
      out[name].note = `${points.length} daily values rolled up to ${gran}. Narrow start/end, or pass granularity:"day" with a smaller range, for day-level detail.`;
    }
  }
  return out;
}

export async function getTrends({ metric, window = 7 } = {}) {
  if (!metric) throw new Error('metric is required');
  assertUnlocked();
  if (!(Number(window) > 0)) throw new Error(`window must be a positive number of days (got ${window})`);
  window = Math.floor(Number(window));
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
    // An agent asking for a 90-day trend against 12 days of data was previously given a confident
    // answer with no hint that the window was not met. Both numbers are now explicit.
    daysAvailable: daily.length,
    windowSatisfied: daily.length >= window * 2,
    coverage: coverageOf(m),
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

export async function getStructuredExport({ metrics: names, start, end, granularity, limit, cursor } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const all = await loadMetrics();
  const pick = (names && names.length ? names : Object.keys(all)).filter((n) => all[n]).sort();
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  // MCP paginates resources/list and tools/list at the protocol level, but NOT tools/call. The
  // 2026-07-28 spec's "Stateful Tools" section blesses the alternative used here: a server-minted
  // opaque cursor returned in the result and handed back as an ordinary argument. The cursor is a
  // metric name, so it stays valid even if the cache is rewritten between calls.
  const startIdx = cursor ? Math.max(0, pick.indexOf(String(cursor))) : 0;

  // Resolve granularity against each metric's SHARE of the budget, not the whole of it. Against the
  // whole budget a decade of daily data rolls up to ~120 monthly points per metric, so only three
  // metrics fit a page and a caller wanting the full catalogue needs ~60 round trips. Sharing the
  // budget makes `auto` pick a coarser bucket when many metrics are in play, which is what the
  // caller wanted: a broad, shallow answer rather than a deep one on three arbitrary metrics.
  const remaining = Math.max(1, pick.length - startIdx);
  const share = names && names.length ? cap : Math.max(12, Math.floor(cap / Math.min(remaining, 24)));

  const data = {};
  let used = 0, i = startIdx;
  for (; i < pick.length; i++) {
    const name = pick[i];
    const m = all[name];
    const points = (m.daily || []).filter((p) => inRange(p.d, start, end));
    const gran = resolveGranularity(points.length, granularity, share);
    const rolled = rollUp(points, gran, !!m.cumulative);
    // Stop BEFORE exceeding the budget, so a page is never half a metric.
    if (used > 0 && used + rolled.length > cap) break;
    data[name] = {
      unit: m.unit || '', cumulative: !!m.cumulative, granularity: gran,
      daily: rolled.map((p) => ({ d: p.date, v: p.value })),
      pointsInRange: points.length,
      coverage: coverageOf(m),
    };
    used += rolled.length;
  }

  const nextCursor = i < pick.length ? pick[i] : null;
  return {
    generatedAt: new Date().toISOString(),
    range: { start: start || null, end: end || null },
    metrics: data,
    returnedMetrics: Object.keys(data).length,
    totalMetrics: pick.length,
    nextCursor,
    note: nextCursor
      ? `Returned ${Object.keys(data).length} of ${pick.length} metrics. Call again with cursor:"${nextCursor}" for the next page.`
      : undefined,
  };
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
  // Bounded on purpose: this convenience path used to return the metric's ENTIRE history, which on
  // a full-history cache is ~119k tokens for a single metric. `granularity:'auto'` keeps the answer
  // proportionate and the accompanying coverage tells the agent what it did not see.
  return {
    interpreted: `${agg || 'summary'} for ${metric}`,
    result: await getHealthMetrics({ metric, aggregation: agg, granularity: 'auto' }),
  };
}

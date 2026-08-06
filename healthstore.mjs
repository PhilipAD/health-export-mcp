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

/** Highest cache schema this server understands. The app writes `_meta.schema`; anything with a
 *  higher MAJOR is a newer app paired with an older `.mcpb`, which we refuse loudly rather than
 *  silently mis-reading. Absent `_meta` means a pre-1.2 cache, which is schema 1 by definition. */
export const SUPPORTED_SCHEMA = 1;

export async function loadMetrics() {
  if (!pairing().ok) return {};
  const raw = readJSONCached(path.join(DATA_DIR, '.health-cache.json'), {});
  const meta = raw._meta;
  if (meta && Number(meta.schema) > SUPPORTED_SCHEMA) {
    throw new Error(
      `This health cache was written by Health Export ${meta.app ?? 'a newer version'} using ` +
      `cache schema ${meta.schema}, but this MCP server only understands ${SUPPORTED_SCHEMA}. ` +
      // The package `@healthexport/mcp` does not exist — package.json is `private: true`.
      // These are the two channels the site and SKILL.md actually document.
      `Update the Health Export MCP server — reinstall the bundle from https://www.healthexport.dev/health-export.mcpb, or re-download https://www.healthexport.dev/mcp/healthstore.mjs — reading it anyway ` +
      `could report wrong numbers.`);
  }
  // NULL PROTOTYPE. Every existence check here is `metrics[name]`, so inherited keys answered for
  // metrics that do not exist: `get_health_metrics({metric:"constructor"})` returned a fabricated
  // entry with an empty unit instead of "unknown metric", and so did "toString" and
  // "hasOwnProperty". An agent probing names — or a user typo — got a plausible empty result rather
  // than an error. A prototype-less object makes the whole class unreachable in one line, rather
  // than requiring every call site to remember Object.hasOwn.
  //
  // Derived ONCE per parsed file and memoized alongside it. Rebuilding it per call would have
  // silently defeated the (mtime, size) memoization — every caller would get a fresh object and
  // pay a full copy of a cache that reaches tens of MB.
  if (viewCache.raw !== raw) {
    const { _meta, ...rest } = raw;
    viewCache = { raw, view: Object.assign(Object.create(null), meta === undefined ? raw : rest) };
  }
  return viewCache.view;
}

/// The prototype-less view of the last parsed cache, keyed on the parsed object's identity so it is
/// invalidated exactly when `readJSONCached` re-reads the file.
let viewCache = { raw: null, view: Object.create(null) };

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

/** True when `how` cannot be honoured for this metric and a different one was used instead. */
export function aggregationWasAdjusted(how, cumulative) {
  return how === 'sum' && !cumulative;
}

function aggregate(values, how, cumulative) {
  if (!values.length) return null;
  switch (how) {
    // Summing a NON-cumulative series is arithmetic on the wrong axis: 365 daily resting heart
    // rates add up to ~22,000 bpm, a number that means nothing but renders like any other. The
    // Swift twin (`AskEngine.aggregate`) already fell back to the mean here; this side did not, so
    // the same question asked through the MCP server and through Ask returned different answers.
    // Callers are told via `aggregationAdjusted` rather than being silently corrected.
    case 'sum':   return round(cumulative
                    ? values.reduce((a, b) => a + b, 0)
                    : values.reduce((a, b) => a + b, 0) / values.length);
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
  // Locked returns {} from loadMetrics, so without this the tool answered {metrics: []} with
  // isError:false — telling an agent the user simply has no health data. get_mcp_status already
  // reports the lock correctly, which made the inconsistency worse.
  assertUnlocked();
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

const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'latest']);

export async function getHealthMetrics({ metric, start, end, aggregation, granularity, limit } = {}) {
  assertUnlocked();
  // The tool schema declares an enum and nothing enforced it, so `aggregation:"median"` fell through
  // to the default branch, returned the MEAN, and echoed "median" back — a wrong number wearing a
  // label the caller chose.
  if (aggregation != null && !AGGREGATIONS.has(aggregation)) {
    throw new Error(`aggregation must be one of ${[...AGGREGATIONS].join(', ')} (got "${aggregation}")`);
  }
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
      // Report what was ACTUALLY computed, not what was asked for.
      aggregation: aggregationWasAdjusted(aggregation, m.cumulative)
        ? 'avg' : (aggregation || (m.cumulative ? 'sum' : 'avg')),
      ...(aggregationWasAdjusted(aggregation, m.cumulative) && {
        aggregationAdjusted: `"${name}" is not a cumulative metric, so summing it would add values on the wrong axis (365 daily resting heart rates total ~22,000 bpm). The mean was returned instead.`,
      }),
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
  // Floor FIRST, then validate. `window: 0.5` passed `> 0` and floored to 0, producing an empty
  // result with no error — an agent asking for half a day was told, in effect, that there is no
  // data. A window is a whole number of days or it is not a window.
  if (!Number.isFinite(Number(window))) throw new Error(`window must be a number of days (got ${window})`);
  window = Math.floor(Number(window));
  if (!(window >= 1)) throw new Error(`window must be at least 1 whole day (got ${arguments[0].window})`);
  const metrics = await loadMetrics();
  const m = metrics[metric];
  if (!m) throw new Error(`unknown metric "${metric}"`);
  const daily = (m.daily || []).slice();
  // Windows are CALENDAR days, not "the last N recorded points". Slicing by count meant a 7-day
  // window on a sparse metric — body mass, VO2 max, anything logged weekly — silently spanned two
  // months, and the comparison was then between two arbitrary and unequal stretches of time
  // labelled "7 days". Anchored to the newest recorded day rather than today, so a metric that
  // stopped updating a month ago still compares its own last two windows instead of two empty ones.
  const dayMs = 86400000;
  const anchor = daily.length ? Date.parse(daily[daily.length - 1].d) : NaN;
  const recentFrom = anchor - (window - 1) * dayMs;
  const priorFrom  = anchor - (window * 2 - 1) * dayMs;
  const inSpan = (p, from, to) => {
    const t = Date.parse(p.d);
    return Number.isFinite(t) && t >= from && t <= to;
  };
  const recent = Number.isFinite(anchor)
    ? daily.filter((p) => inSpan(p, recentFrom, anchor)).map((p) => p.v) : [];
  const prior = Number.isFinite(anchor)
    ? daily.filter((p) => inSpan(p, priorFrom, recentFrom - dayMs)).map((p) => p.v) : [];
  // NORMALISE BY THE NUMBER OF POINTS ACTUALLY IN EACH SIDE. `slice(-window*2, -window)` clamps
  // silently, so a series shorter than 2*window gave a prior side with fewer points than recent —
  // and for a cumulative metric both sides are SUMMED, so ten identical 10,000-step days with
  // window: 7 returned changePercent: +133.3, direction: "up" for a perfectly flat series. The only
  // hint was windowSatisfied: false, which an agent reading `direction` never sees.
  //
  // Comparing per-day rates makes unequal sides honest: a sum over 7 days against a sum over 3 is
  // meaningless, but 10,000/day against 10,000/day is exactly right.
  const agg = (vs) => aggregate(vs, m.cumulative ? 'sum' : 'avg', m.cumulative);
  const rate = (vs) => {
    const a = agg(vs);
    if (a == null || vs.length === 0) return null;
    return m.cumulative ? a / vs.length : a;   // discrete metrics are already per-day means
  };
  const r = agg(recent), p = agg(prior);
  const rRate = rate(recent), pRate = rate(prior);
  const changePct = (rRate != null && pRate != null && pRate !== 0)
    ? round(((rRate - pRate) / Math.abs(pRate)) * 100) : null;
  return {
    metric, unit: m.unit || '', window,
    recent: r, prior: p,
    // Point counts are part of the answer: without them a caller cannot tell a real change from an
    // artefact of one side being shorter.
    recentDays: recent.length, priorDays: prior.length,
    change: (r != null && p != null && recent.length === prior.length) ? round(r - p) : null,
    changePercent: changePct,
    direction: changePct == null
      ? (r != null && p === 0 ? (r > 0 ? 'up' : 'flat') : 'unknown')   // rose from a 0 baseline
      : changePct > 1 ? 'up' : changePct < -1 ? 'down' : 'flat',
    recentRange: Number.isFinite(anchor)
      ? { from: new Date(recentFrom).toISOString().slice(0, 10), to: daily[daily.length - 1]?.d }
      : { from: undefined, to: undefined },
    // An agent asking for a 90-day trend against 12 days of data was previously given a confident
    // answer with no hint that the window was not met. Both numbers are now explicit.
    daysAvailable: daily.length,
    // The SPAN must be satisfied, not merely non-empty on both sides. A previous revision of this
    // relaxed it to `recent.length > 0 && prior.length > 0`, which made a 365-day window against
    // 400 days of history report satisfied while comparing 365 days to 35 — and the tool
    // description tells agents that false means insufficient history.
    windowSatisfied: Number.isFinite(anchor)
      && Date.parse(daily[0].d) <= priorFrom
      && recent.length > 0 && prior.length > 0,
    ...(recent.length !== prior.length && {
      note: `Windows are unequal (${recent.length} vs ${prior.length} recorded days). changePercent compares per-day rates; the raw change is omitted because the totals cover different spans.`,
    }),
    coverage: coverageOf(m),
  };
}

export async function comparePeriods({ metric, periodA, periodB } = {}) {
  if (!metric || !periodA || !periodB) throw new Error('metric, periodA {start,end}, periodB {start,end} required');
  // Both bounds of both periods, explicitly. The old guard checked only truthiness, so `{}` or a
  // bare "2026-01" passed, start/end came out undefined, `inRange` then matched the ENTIRE history
  // for both sides, and the tool returned change: 0, changePercent: 0 with isError:false — an
  // agent cannot tell that from a genuine no-change result.
  for (const [label, p] of [['periodA', periodA], ['periodB', periodB]]) {
    if (typeof p !== 'object' || !p.start || !p.end) {
      throw new Error(`${label} must be an object with both start and end as YYYY-MM-DD dates`);
    }
  }
  const a = await getHealthMetrics({ metric, start: periodA.start, end: periodA.end });
  const b = await getHealthMetrics({ metric, start: periodB.start, end: periodB.end });
  const av = a[metric]?.aggregate, bv = b[metric]?.aggregate;
  const na = a[metric]?.pointsInRange ?? 0, nb = b[metric]?.pointsInRange ?? 0;
  // Span lengths ride along: comparing a 31-day month against a 28-day one is a legitimate thing to
  // ask for and an illegitimate thing to do silently, especially for a cumulative metric.
  const spanDays = (p) => Math.round((Date.parse(p.end) - Date.parse(p.start)) / 86400000) + 1;
  const daysA = spanDays(periodA), daysB = spanDays(periodB);
  // Per-day RATES, matching get_trends, WeeklyBrief and AskEngine. Summing both sides made two
  // periods with different amounts of DATA look different even when the daily figures were
  // identical: a 31-day span missing three days read as a 10% decline. `comparable` used to test
  // span equality, which does not imply the totals are comparable — a gap inside an equal span is
  // exactly the case it missed.
  const cumulative = a[metric]?.cumulative ?? false;
  const rate = (v, n) => (v == null || n === 0) ? null : (cumulative ? v / n : v);
  const ra = rate(av, na), rb = rate(bv, nb);
  const changePct = (ra != null && rb != null && rb !== 0) ? round(((ra - rb) / Math.abs(rb)) * 100) : null;
  return {
    metric, unit: a[metric]?.unit || '',
    // When coverage is UNEQUAL the reported value is the per-day rate, not the total — matching
    // `AskEngine.comparePeriods`, which switches to a daily average for exactly this case and says
    // so in its label. Reporting one side's total against the other's is the arithmetic that made a
    // 31-day span missing three days look like a 10% decline.
    periodA: { ...periodA, value: (na === nb ? av : ra), days: daysA, pointsInRange: na },
    periodB: { ...periodB, value: (na === nb ? bv : rb), days: daysB, pointsInRange: nb },
    // A non-cumulative metric's value is a MEAN whatever the coverage, so calling it a "total"
    // when the two spans happened to match was simply wrong for every such metric.
    valueBasis: !cumulative ? 'per-day average' : (na === nb ? 'total' : 'per-day average'),
    // The delta is stated on the SAME basis as the values above: totals when coverage matches,
    // per-day rates when it does not. Omitting it entirely was the more conservative choice and the
    // less useful one — "no difference in daily average" is a real answer, and it is what
    // AskEngine.comparePeriods has always given. What must never happen is a total minus a total
    // across different amounts of data.
    change: na === nb
      ? ((av != null && bv != null) ? round(av - bv) : null)      // same coverage ⇒ totals
      : ((ra != null && rb != null) ? round(ra - rb) : null),     // otherwise per-day, as above
    changePercent: changePct,
    comparable: daysA === daysB && na === nb,
    ...((daysA !== daysB || na !== nb) && {
      note: `Periods cover ${daysA} vs ${daysB} days and contain ${na} vs ${nb} recorded days. changePercent and change are both stated as PER-DAY rates, because the totals cover different amounts of data and are not comparable.`,
    }),
  };
}

export async function getStructuredExport({ metrics: names, start, end, granularity, limit, cursor } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const all = await loadMetrics();
  // Unknown names are an ERROR here too. `.filter((n) => all[n])` dropped them silently, so an
  // agent that asked for three metrics and got two had no way to tell which was missing — or that
  // anything had been dropped. `get_health_metrics` has always thrown for the same mistake.
  if (names && names.length) {
    const unknown = names.filter((n) => !all[n]);
    if (unknown.length) {
      throw new Error(`unknown metric${unknown.length > 1 ? 's' : ''} ` +
        `${unknown.map((n) => `"${n}"`).join(', ')}. Use list_metrics to see available names.`);
    }
  }
  const pick = (names && names.length ? names : Object.keys(all)).filter((n) => all[n]).sort();
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  // MCP paginates resources/list and tools/list at the protocol level, but NOT tools/call. The
  // 2026-07-28 spec's "Stateful Tools" section blesses the alternative used here: a server-minted
  // opaque cursor returned in the result and handed back as an ordinary argument. The cursor is a
  // metric name, so it stays valid even if the cache is rewritten between calls.
  // An unrecognised cursor must be an ERROR, not a silent restart. `indexOf` returns -1 for a
  // cursor whose metric is no longer in `pick` — because the caller narrowed `metrics` between
  // pages, or the cache was rewritten without it — and `Math.max(0, -1)` turned that into "start
  // from the beginning", so an agent paginating in a loop re-served page 1 forever and could never
  // finish. Failing loudly lets it restart deliberately instead of spinning.
  // Resume at the first metric AT OR AFTER the cursor, rather than requiring an exact hit.
  //
  // `indexOf` alone re-served page one for an unrecognised cursor (`-1` → `Math.max(0,-1)` → 0), so
  // an agent paginating in a loop could never finish. But rejecting an unrecognised cursor outright
  // has the opposite failure: `pick` is sorted, and the app syncing a new metric mid-pagination
  // inserts a name before the cursor — with a strict match the pages after it are fine, and the
  // newly inserted metric is skipped forever while the caller believes it received the full
  // catalogue. A successor search terminates in both cases and skips nothing.
  let startIdx = 0;
  if (cursor) {
    const c = String(cursor);
    const found = pick.findIndex((n) => n >= c);
    startIdx = found < 0 ? pick.length : found;   // cursor past the end ⇒ an empty final page
  }

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
  assertUnlocked();   // same reason as list_metrics: locked must not read as "no data"

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

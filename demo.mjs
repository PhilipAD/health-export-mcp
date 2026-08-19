// demo.mjs, the deterministic synthetic dataset behind --demo / HEALTH_DEMO=1.
//
// Purpose: let anyone exercise every tool with zero real data and zero iPhone. The dataset is
// SYNTHETIC and every answer the server gives in demo mode is watermarked (demo: true plus a
// [SYNTHETIC DEMO DATA] text prefix in server.mjs), so a screenshot or a pasted answer can never
// pass for a real export.
//
// Determinism rules, both load-bearing:
//   1. A seeded PRNG (mulberry32, fixed seed). Math.random would make every run a different
//      "person", so a bug reproduced in demo mode could vanish on the next spawn.
//   2. NO Date.now anywhere in generation. The date range is anchored to a FIXED end day
//      (2026-08-18), so demo answers are byte-identical across runs and across machines, which is
//      what makes them assertable in tests and comparable in bug reports.

export const DEMO = process.argv.includes('--demo') || process.env.HEALTH_DEMO === '1';

// Fixed anchor: the newest synthetic day. Never derived from the clock (see rule 2 above).
export const DEMO_END = '2026-08-18';
const DEMO_END_UTC = Date.UTC(2026, 7, 18);
const DAYS = 400;
const WRITTEN_AT = '2026-08-18T21:00:00Z';
const SEED = 0x5EED1E;

// mulberry32: tiny, fast, good-enough 32-bit PRNG. Cryptographic quality is irrelevant here;
// reproducibility is the whole point.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// back = how many days before DEMO_END. back 0 is the anchor day itself.
function day(back) {
  return new Date(DEMO_END_UTC - back * 86400000).toISOString().slice(0, 10);
}
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// The synthetic person has a few deliberate storylines so the segment/anchor/correlate tools have
// something honest to find: a medication start that lowers resting HR, a night-shift block and a
// migraine episode that dent HRV, and a trip that shortens sleep. Everything else is base + weekly
// rhythm + noise.
const MED_START_BACK = 200;      // medication event lands on day(back=200)
const SHIFT_BACK = [90, 84];     // night shift block, inclusive day range
const EPISODE_BACK = [60, 58];   // migraine episode
const TRAVEL_BACK = [39, 32];    // trip; the tz change entry lands on the RETURN day (back=32)

const inBack = (back, [hi, lo]) => back <= hi && back >= lo;

function buildMetrics(rng) {
  const m = {};
  const put = (name, unit, cumulative, fn) => {
    const daily = [];
    for (let back = DAYS - 1; back >= 0; back--) {
      const v = fn(back);
      if (v == null) continue;                    // sparse metrics skip days, like real ones do
      daily.push({ d: day(back), v });
    }
    m[name] = { unit, cumulative: !!cumulative, daily };
  };
  const week = (back) => Math.sin(((DAYS - back) % 7) / 7 * 2 * Math.PI);

  put('step_count', 'count', true, (b) => Math.round(8500 + week(b) * 2200 + (rng() - 0.5) * 3000));
  put('heart_rate', 'count/min', false, (b) => r2(68 + week(b) * 3 + (rng() - 0.5) * 6));
  put('resting_heart_rate', 'count/min', false, (b) =>
    r2((b <= MED_START_BACK ? 54 : 58) + (rng() - 0.5) * 3));
  put('heart_rate_variability', 'ms', false, (b) => {
    let base = 52 + week(b) * 4;
    if (inBack(b, SHIFT_BACK) || inBack(b, EPISODE_BACK)) base -= 9;
    return r2(base + (rng() - 0.5) * 10);
  });
  put('sleep_analysis', 'hr', false, (b) => {
    let base = 7.4 + week(b) * 0.4;
    if (inBack(b, TRAVEL_BACK)) base -= 1.1;
    return r2(base + (rng() - 0.5) * 1.0);
  });
  put('weight_body_mass', 'kg', false, (b) => r2(81.5 - (DAYS - b) * 0.008 + (rng() - 0.5) * 0.6));
  put('blood_oxygen_saturation', '%', false, () => r3(0.955 + rng() * 0.035));
  put('active_energy', 'kcal', true, (b) => Math.round(520 + week(b) * 140 + (rng() - 0.5) * 200));
  put('vo2_max', 'ml/kg*min', false, (b) => (b % 7 === 0 ? r2(44 + (DAYS - b) * 0.004 + (rng() - 0.5) * 0.8) : null));
  put('respiratory_rate', 'count/min', false, () => r2(14 + (rng() - 0.5) * 1.6));

  // Glucose plus the contract-7 derived metrics, present only on the "CGM period" (last 150 days),
  // because a real cache only carries them on days with at least 24 readings.
  const CGM_DAYS = 150;
  const glucoseMean = new Map();
  put('blood_glucose', 'mg/dL', false, (b) => {
    if (b >= CGM_DAYS) return null;
    const v = r2(112 + week(b) * 6 + (rng() - 0.5) * 14);
    glucoseMean.set(b, v);
    return v;
  });
  const gm = (b) => glucoseMean.get(b);
  put('glucose_time_in_range_pct', '%', false, (b) => (b >= CGM_DAYS ? null : r3(0.86 - Math.max(0, gm(b) - 100) * 0.004 - rng() * 0.04)));
  put('glucose_time_below_range_pct', '%', false, (b) => (b >= CGM_DAYS ? null : r3(rng() * 0.03)));
  put('glucose_time_above_range_pct', '%', false, (b) => {
    if (b >= CGM_DAYS) return null;
    const tir = m.glucose_time_in_range_pct.daily.find((p) => p.d === day(b))?.v ?? 0.8;
    const below = m.glucose_time_below_range_pct.daily.find((p) => p.d === day(b))?.v ?? 0.01;
    return r3(Math.max(0, 1 - tir - below));
  });
  put('glucose_cv_pct', '%', false, (b) => (b >= CGM_DAYS ? null : r3(0.24 + rng() * 0.08)));
  // GMI per Bergenstal 2018: 3.31 + 0.02392 x mean mg/dL, stored /100 like every % metric.
  put('glucose_gmi_pct', '%', false, (b) => (b >= CGM_DAYS ? null : r3((3.31 + 0.02392 * gm(b)) / 100)));

  put('exercise_time', 'min', true, (b) => Math.round(Math.max(0, 32 + week(b) * 18 + (rng() - 0.5) * 24)));
  put('walking_running_distance', 'km', true, (b) => r2(6.2 + week(b) * 2 + (rng() - 0.5) * 2.4));
  return m;
}

function buildWorkouts(rng) {
  const workouts = [];
  for (let n = 0; n < 30; n++) {
    const back = 393 - n * 13;                              // oldest first, newest ~1 week ago
    const d = day(back);
    const kinds = [
      { name: 'Running', activityType: 37 },
      { name: 'Cycling', activityType: 13 },
      { name: 'Walking', activityType: 52 },
    ];
    const k = kinds[n % 3];
    const durationMin = Math.round(40 + rng() * 35);
    const start = `${d}T07:30:00+01:00`;
    const endMs = Date.parse(start) + durationMin * 60000;
    // Render the end instant on the same +01:00 wall clock as the start: shift by the offset, then
    // relabel the Z. Rendering the raw instant with a +01:00 suffix would silently shift end times
    // an hour early.
    const end = new Date(endMs + 3600000).toISOString().replace(/\.\d{3}Z$/, '+01:00');
    const w = {
      id: `demo-w-${String(n + 1).padStart(2, '0')}`,
      name: k.name,
      activityType: k.activityType,
      start,
      end,
      duration: durationMin * 60,
      activeEnergyBurned: Math.round(durationMin * (5 + rng() * 6)),
      distanceMeters: Math.round(durationMin * (k.name === 'Cycling' ? 420 : 160) * (0.9 + rng() * 0.2)),
      distanceSource: 'watch',
      avgHeartRate: Math.round(128 + rng() * 22),
      maxHeartRate: Math.round(160 + rng() * 20),
      elevationAscendedMeters: Math.round(rng() * 220),
    };
    if (k.name === 'Running') {
      w.runningPowerAvgWatts = Math.round(255 + rng() * 40);
      w.strideLengthAvgMeters = r2(1.02 + rng() * 0.18);
      w.verticalOscillationAvgCm = r2(7.6 + rng() * 1.8);
      w.groundContactTimeAvgMs = Math.round(240 + rng() * 40);
      w.hasRoute = true;
      const lap = Math.floor((durationMin * 60) / 3);
      w.intervals = [0, 1, 2].map((i) => ({
        start: new Date(Date.parse(start) + i * lap * 1000).toISOString(),
        end: new Date(Date.parse(start) + (i + 1) * lap * 1000).toISOString(),
        duration: lap,
        kind: 'lap',
      }));
    }
    if (k.name === 'Cycling') {
      w.cyclingPowerAvgWatts = Math.round(180 + rng() * 60);
      w.cadenceAvg = Math.round(82 + rng() * 12);
      w.hasRoute = true;
    }
    workouts.push(w);
  }
  return workouts;
}

function buildEvents() {
  const events = [
    { id: 'demo-evt-med-1', date: day(MED_START_BACK), type: 'medication', title: 'Started propranolol 40mg', tags: ['propranolol'] },
    { id: 'demo-evt-visit-1', date: day(180), type: 'visit', title: 'GP review', tags: ['gp'] },
    { id: 'demo-evt-habit-1', date: day(150), type: 'habit', title: 'Stopped caffeine after midday', tags: ['caffeine'] },
    { id: 'demo-evt-life-1', date: day(120), type: 'life', title: 'Moved house' },
    { id: 'demo-evt-shift-1', date: day(SHIFT_BACK[0]), endDate: day(SHIFT_BACK[1]), type: 'shift', title: 'Night shift block', tags: ['nights'] },
    { id: 'demo-evt-episode-1', date: day(EPISODE_BACK[0]), endDate: day(EPISODE_BACK[1]), type: 'episode', title: 'Migraine episode', tags: ['migraine'] },
    { id: 'demo-evt-travel-1', date: day(TRAVEL_BACK[0]), endDate: day(TRAVEL_BACK[1]), type: 'travel', title: 'Trip to New York', tags: ['travel'] },
    { id: 'demo-evt-visit-2', date: day(40), type: 'visit', title: 'GP follow up', tags: ['gp'] },
  ].sort((a, b) => a.date.localeCompare(b.date));
  return { schema: 1, app: '1.5', writtenAt: WRITTEN_AT, events };
}

function buildSessions(rng) {
  const sessions = [];
  for (let back = 58; back >= 0; back--) {
    const hours = r2(inBack(back, TRAVEL_BACK) ? 5.4 + rng() * 0.8 : 6.9 + rng() * 1.4);
    const startH = 22 + Math.floor(rng() * 2);
    const startMin = Math.floor(rng() * 60);
    const endH = Math.floor((startH + hours) % 24);
    sessions.push({
      start: `${day(back + 1)}T${String(startH).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00+01:00`,
      end: `${day(back)}T${String(endH).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00+01:00`,
      day: day(back),
      hours,
      stages: { core: r2(hours * 0.55), deep: r2(hours * 0.16), rem: r2(hours * 0.24), awake: r2(hours * 0.05) },
    });
  }
  // One split night: the same waking day carries a second, short session (a 90 minute early wake
  // and a return to bed). Split nights are the exact case get_sleep_sessions must return as-is.
  sessions.push({
    start: `${day(3)}T05:40:00+01:00`,
    end: `${day(3)}T07:10:00+01:00`,
    day: day(3),
    hours: 1.5,
    stages: { core: 1.1, deep: 0.1, rem: 0.25, awake: 0.05 },
  });
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  return { schema: 1, writtenAt: WRITTEN_AT, sessions };
}

function buildCycles() {
  return { schema: 1, writtenAt: WRITTEN_AT, cycleStarts: [day(77), day(49), day(20)] };
}

function buildDaysFile() {
  return {
    schema: 1,
    writtenAt: WRITTEN_AT,
    currentTz: 'Europe/London',
    // One change entry: the return from the synthetic New York trip. The day a change lands on is
    // by definition not 24 hours long, which is what excludeTravelDays keys off.
    changes: [{ from: day(TRAVEL_BACK[1]), tz: 'Europe/London', utcOffsetMin: 60 }],
    note: 'Timezone history is recorded from 2026-07-17 onward. Days before the first change entry were bucketed in the timezone current at export time.',
  };
}

function buildProfile() {
  return {
    schema: 1,
    writtenAt: WRITTEN_AT,
    fields: {
      conditions: ['migraine'],
      medications: ['propranolol 40mg'],
      goals: ['average 7.5 hours of sleep', '10k steps most days'],
      notes: 'Training for an autumn half marathon.',
    },
  };
}

// Built once and cached: generation is cheap but the memoized loaders upstream key on object
// identity, so handing out a fresh object per call would defeat their caching.
let _demo = null;
export function demoData() {
  if (_demo) return _demo;
  const rng = mulberry32(SEED);
  _demo = {
    metrics: buildMetrics(rng),
    workouts: buildWorkouts(rng),
    events: buildEvents(),
    profile: buildProfile(),
    sessions: buildSessions(rng),
    cycles: buildCycles(),
    days: buildDaysFile(),
  };
  return _demo;
}

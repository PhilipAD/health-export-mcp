// normalize.mjs: canonical metric naming and unit table (zero-dependency).
//
// Different apps and people call the same measure different things ("steps", "StepCount",
// "HKQuantityTypeIdentifierStepCount", "Step Count") and report it in different units (lb vs kg,
// mmol/L vs mg/dL, a 0-100 percentage vs a 0-1 fraction). This module maps every such spelling to
// the ONE canonical name the iOS app writes into .health-cache.json, states that metric's canonical
// unit, and converts a value from a unit variant into it with the exact formula used.
//
// Honesty rules, each enforced below and pinned by normalize.test.mjs:
//   * An alias is only listed when it names the SAME measure. A related but different measure is
//     refused with the reason (RMSSD is not the SDNN that Apple Health stores as HRV).
//   * A generic word that could mean several metrics ("distance", "calories", "temperature") is
//     reported as ambiguous with its candidates. It is never silently resolved to one of them.
//   * A unit the table does not know is refused, never guessed. A conversion that depends on the
//     substance (glucose mmol/L to mg/dL) is offered only for that metric.
//   * The daily cache holds ONE value per metric per day, already merged across every source by
//     Apple Health. Per-source values are not in the export, so nothing here claims to detect or
//     reconcile a disagreement between sources: SOURCE_MERGE says so in every answer.
import { METRIC_CATALOG } from './metric-catalog.mjs';

/** Canonical rows keyed by id, prototype-less so "constructor" is not a metric. */
export const CANONICAL = Object.assign(Object.create(null), Object.fromEntries(
  METRIC_CATALOG.map(([id, hk, title, unit, cumulative, group]) => [id, { id, hk, title, unit, cumulative, group }])));

// Hand-curated aliases: common generic spellings for the SAME measure. Vendor-neutral on purpose.
const ALIASES = {
  step_count: ['steps', 'step', 'daily_steps', 'step_total', 'total_steps'],
  heart_rate: ['hr', 'pulse', 'pulse_rate', 'heartrate'],
  resting_heart_rate: ['rhr', 'resting_hr', 'restingheartrate', 'resting_pulse'],
  heart_rate_variability: ['hrv', 'hrv_sdnn', 'sdnn', 'heart_rate_variability_sdnn'],
  walking_heart_rate_average: ['walking_hr', 'walking_heart_rate'],
  weight_body_mass: ['weight', 'body_weight', 'bodyweight', 'body_mass', 'mass'],
  body_fat_percentage: ['body_fat', 'bodyfat', 'fat_percentage', 'body_fat_percent'],
  body_mass_index: ['bmi'],
  lean_body_mass: ['lean_mass'],
  blood_oxygen_saturation: ['spo2', 'sp_o2', 'oxygen_saturation', 'blood_oxygen', 'o2_saturation'],
  vo2_max: ['vo2max', 'vo2', 'cardio_fitness'],
  respiratory_rate: ['resp_rate', 'breathing_rate', 'respiration_rate', 'breaths_per_minute'],
  active_energy: ['active_calories', 'active_kcal', 'active_energy_burned', 'move_calories'],
  basal_energy_burned: ['resting_energy', 'resting_calories', 'basal_calories', 'basal_energy'],
  dietary_energy: ['dietary_calories', 'calories_consumed', 'calories_in', 'food_calories', 'energy_consumed'],
  dietary_water: ['water', 'water_intake', 'hydration'],
  dietary_protein: ['protein'],
  dietary_carbohydrates: ['carbs', 'carbohydrates'],
  dietary_fat_total: ['fat_total', 'total_fat'],
  dietary_sugar: ['sugar'],
  dietary_fiber: ['fiber', 'fibre', 'dietary_fibre'],
  dietary_caffeine: ['caffeine'],
  dietary_sodium: ['sodium'],
  walking_running_distance: ['walking_distance', 'running_distance', 'walk_run_distance', 'walking_and_running_distance'],
  cycling_distance: ['bike_distance', 'cycle_distance', 'distance_cycling'],
  swimming_distance: ['swim_distance', 'distance_swimming'],
  flights_climbed: ['floors', 'flights', 'floors_climbed', 'stairs_climbed'],
  sleep_analysis: ['sleep', 'sleep_duration', 'time_asleep', 'total_sleep', 'sleep_hours', 'asleep'],
  apple_exercise_time: ['exercise_minutes', 'exercise_time'],
  apple_stand_hour: ['stand_hours'],
  apple_stand_time: ['stand_minutes', 'stand_time'],
  blood_pressure_systolic: ['systolic', 'bp_systolic', 'systolic_blood_pressure'],
  blood_pressure_diastolic: ['diastolic', 'bp_diastolic', 'diastolic_blood_pressure'],
  blood_glucose: ['glucose', 'blood_sugar'],
  glucose_time_in_range_pct: ['time_in_range', 'tir', 'glucose_time_in_range'],
  glucose_time_below_range_pct: ['time_below_range', 'tbr', 'glucose_time_below_range'],
  glucose_time_above_range_pct: ['time_above_range', 'tar', 'glucose_time_above_range'],
  glucose_cv_pct: ['glucose_cv', 'glucose_variability', 'glucose_coefficient_of_variation'],
  glucose_gmi_pct: ['gmi', 'glucose_management_indicator', 'glucose_gmi'],
  apple_sleeping_wrist_temperature: ['wrist_temperature', 'sleeping_wrist_temperature'],
  mindful_minutes: ['mindfulness', 'mindful_session', 'meditation_minutes'],
};

// Generic words that name SEVERAL metrics. Resolving them would be a silent guess.
const AMBIGUOUS = {
  distance: ['walking_running_distance', 'cycling_distance', 'swimming_distance', 'distance_wheelchair'],
  calories: ['active_energy', 'basal_energy_burned', 'dietary_energy'],
  energy: ['active_energy', 'basal_energy_burned', 'dietary_energy'],
  kcal: ['active_energy', 'basal_energy_burned', 'dietary_energy'],
  temperature: ['body_temperature', 'basal_body_temperature', 'apple_sleeping_wrist_temperature', 'water_temperature'],
  blood_pressure: ['blood_pressure_systolic', 'blood_pressure_diastolic'],
  bp: ['blood_pressure_systolic', 'blood_pressure_diastolic'],
  fat: ['body_fat_percentage', 'dietary_fat_total'],
  speed: ['walking_speed', 'running_speed', 'cycling_speed'],
};

// Related measures that are NOT the same quantity. Refused with the reason instead of aliased.
const NOT_EQUIVALENT = {
  rmssd: { nearest: 'heart_rate_variability', reason: 'Apple Health stores heart rate variability as SDNN (ms). RMSSD is a different statistic over the same beats; the two are not interchangeable and no conversion exists.' },
  hrv_rmssd: { nearest: 'heart_rate_variability', reason: 'Apple Health stores heart rate variability as SDNN (ms). RMSSD is a different statistic over the same beats; the two are not interchangeable and no conversion exists.' },
  active_minutes: { nearest: 'apple_exercise_time', reason: 'Apple Exercise Time counts minutes at or above a brisk-walk intensity. Other "active minutes" definitions use different thresholds, so they are not the same measure.' },
  total_calories: { nearest: 'active_energy', reason: 'This export stores active energy and basal (resting) energy separately. A total is their sum per day, which you can compute from both metrics; it is not stored as one metric.' },
  total_energy: { nearest: 'active_energy', reason: 'This export stores active energy and basal (resting) energy separately. A total is their sum per day, which you can compute from both metrics; it is not stored as one metric.' },
};

/** Normalise a spelling to the index key: lowercase, HealthKit prefixes dropped, CamelCase split,
 *  any run of non-alphanumerics collapsed to one underscore. */
export function nameKey(s) {
  // No metric spelling is anywhere near this long; refusing early keeps the regexes below linear
  // on whatever an agent sends.
  const raw = String(s ?? '');
  if (raw.length > 120) return '';
  let t = raw.trim()
    .replace(/^HK(Quantity|Category|Characteristic)TypeIdentifier/, '')
    .replace(/₂/g, '2');
  t = t.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// key -> Set(canonical id), with how each key was produced (for `matchedBy`).
const INDEX = new Map();
function addKey(key, id, how) {
  if (!key) return;
  if (!INDEX.has(key)) INDEX.set(key, new Map());
  const m = INDEX.get(key);
  if (!m.has(id)) m.set(id, how);
}
for (const row of Object.values(CANONICAL)) {
  addKey(nameKey(row.id), row.id, 'canonical');
  addKey(nameKey(row.hk), row.id, 'healthkit_identifier');
  addKey(nameKey(row.title), row.id, 'title');
}
for (const [id, list] of Object.entries(ALIASES)) {
  if (!CANONICAL[id]) throw new Error(`normalize.mjs: alias target "${id}" is not in the metric catalog`);
  for (const a of list) addKey(nameKey(a), id, 'alias');
}
for (const [k, ids] of Object.entries(AMBIGUOUS)) {
  for (const id of ids) if (!CANONICAL[id]) throw new Error(`normalize.mjs: ambiguous candidate "${id}" is not in the metric catalog`);
  if (INDEX.has(nameKey(k)) && INDEX.get(nameKey(k)).size === 1) {
    throw new Error(`normalize.mjs: "${k}" is listed as ambiguous but also resolves to one metric`);
  }
}

/**
 * Look a spelling up in the canonical table. Pure: knows nothing about the export.
 *   { status: 'resolved', metric, matchedBy }
 *   { status: 'ambiguous', candidates: [id...] }
 *   { status: 'not_equivalent', nearest, reason }
 *   { status: 'unknown' }
 */
export function lookup(name) {
  const key = nameKey(name);
  if (!key) return { status: 'unknown' };
  if (Object.hasOwn(NOT_EQUIVALENT, key)) return { status: 'not_equivalent', ...NOT_EQUIVALENT[key] };
  if (Object.hasOwn(AMBIGUOUS, key)) return { status: 'ambiguous', candidates: AMBIGUOUS[key].slice() };
  const hit = INDEX.get(key);
  if (!hit) return { status: 'unknown' };
  if (hit.size > 1) return { status: 'ambiguous', candidates: [...hit.keys()].sort() };
  const [[metric, how]] = [...hit.entries()];
  return { status: 'resolved', metric, matchedBy: matchedByOf(String(name).trim(), CANONICAL[metric], how) };
}

// How a resolved spelling relates to its metric, judged from what the spelling actually matched
// (several derivations share one index key: "StepCount" and "step_count" both normalise to
// step_count). Most literal match first:
//   exact                 the canonical id itself
//   healthkit_identifier  the HealthKit identifier, with or without the HK...TypeIdentifier prefix
//   title                 the English display title (case-insensitive)
//   spelling              a case/separator variant of the canonical id
//   alias                 a curated alias
// A spelling that only normalises to the identifier or title key (e.g. "body-mass") reports the
// derivation whose key it shares; an alias is reported only when no derivation of the row matched.
const HK_PREFIX = /^HK(Quantity|Category|Characteristic)TypeIdentifier/;
function matchedByOf(input, row, how) {
  if (input === row.id) return 'exact';
  const stripped = input.replace(HK_PREFIX, '');
  if (row.hk && stripped === row.hk) return 'healthkit_identifier';
  if (input.toLowerCase() === row.title.toLowerCase()) return 'title';
  const key = nameKey(input);
  if (key === nameKey(row.id)) return 'spelling';
  if (row.hk && key === nameKey(row.hk)) return 'healthkit_identifier';
  if (key === nameKey(row.title)) return 'title';
  return how === 'alias' ? 'alias' : 'spelling';
}

/**
 * Resolve a requested name against the metrics actually present in an export (`present` is the
 * object loadMetrics returns). An exact key is returned untouched, so every existing call is
 * byte-for-byte unchanged. Otherwise the alias table is consulted; on success the caller gets
 * `{ name, resolved: {requested, metric, matchedBy} }` to report alongside its answer.
 * Returns null when the name cannot be resolved to ONE present metric, with `reason` explaining
 * why (ambiguous, not equivalent, or a canonical metric this export does not contain).
 */
export function resolvePresent(present, requested) {
  if (requested == null) return { name: requested, resolved: null };
  if (present[requested]) return { name: requested, resolved: null };
  const r = lookup(requested);
  if (r.status === 'resolved') {
    if (present[r.metric]) {
      return { name: r.metric, resolved: { requested: String(requested), metric: r.metric, matchedBy: r.matchedBy } };
    }
    return { name: null, reason: `"${requested}" is the canonical metric "${r.metric}", which this export does not contain` };
  }
  if (r.status === 'ambiguous') {
    const inExport = r.candidates.filter((c) => present[c]);
    return { name: null, reason: `"${requested}" could mean ${r.candidates.map((c) => `"${c}"`).join(', ')}; name one explicitly${inExport.length ? ` (present in this export: ${inExport.join(', ')})` : ''}` };
  }
  if (r.status === 'not_equivalent') {
    return { name: null, reason: `"${requested}" is not the same measure as "${r.nearest}": ${r.reason}` };
  }
  return { name: null, reason: null };
}

// ---- units ----------------------------------------------------------------------------------
// For each canonical unit the app writes: the variants that occur in other apps and devices, each
// with the spellings accepted for it and how to convert INTO the canonical unit. `f` multiplies;
// `fn` is used for an affine conversion (temperature). Spellings are matched exactly (after
// trimming), never case-folded, because case carries meaning here ("S" siemens vs "s" seconds).
const lin = (f, formula) => ({ f, formula });
const UNIT_VARIANTS = {
  kg: [
    { unit: 'lb', spellings: ['lb', 'lbs', 'pound', 'pounds'], ...lin(0.45359237, 'kg = lb x 0.45359237') },
    { unit: 'st', spellings: ['st', 'stone'], ...lin(6.35029318, 'kg = st x 6.35029318') },
    { unit: 'g', spellings: ['g', 'grams'], ...lin(0.001, 'kg = g / 1000') },
  ],
  m: [
    { unit: 'km', spellings: ['km', 'kilometers', 'kilometres'], ...lin(1000, 'm = km x 1000') },
    { unit: 'mi', spellings: ['mi', 'mile', 'miles'], ...lin(1609.344, 'm = mi x 1609.344') },
    { unit: 'ft', spellings: ['ft', 'feet'], ...lin(0.3048, 'm = ft x 0.3048') },
    { unit: 'yd', spellings: ['yd', 'yards'], ...lin(0.9144, 'm = yd x 0.9144') },
    { unit: 'cm', spellings: ['cm'], ...lin(0.01, 'm = cm / 100') },
    { unit: 'in', spellings: ['in', 'inch', 'inches'], ...lin(0.0254, 'm = in x 0.0254') },
  ],
  cm: [
    { unit: 'mm', spellings: ['mm'], ...lin(0.1, 'cm = mm / 10') },
    { unit: 'm', spellings: ['m'], ...lin(100, 'cm = m x 100') },
    { unit: 'in', spellings: ['in', 'inch', 'inches'], ...lin(2.54, 'cm = in x 2.54') },
  ],
  'm/s': [
    { unit: 'km/h', spellings: ['km/h', 'kph', 'kmh'], ...lin(1 / 3.6, 'm/s = km/h / 3.6') },
    { unit: 'mph', spellings: ['mph', 'mi/h'], ...lin(0.44704, 'm/s = mph x 0.44704') },
  ],
  degC: [
    { unit: 'degF', spellings: ['degF', '°F', 'F', 'fahrenheit'], fn: (v) => (v - 32) * 5 / 9, formula: 'degC = (degF - 32) x 5 / 9' },
    { unit: 'K', spellings: ['K', 'kelvin'], fn: (v) => v - 273.15, formula: 'degC = K - 273.15' },
    { unit: 'degC', spellings: ['°C', 'C', 'celsius'], ...lin(1, 'same unit, different spelling') },
  ],
  kcal: [
    { unit: 'kJ', spellings: ['kJ', 'kj', 'kilojoules'], ...lin(1 / 4.184, 'kcal = kJ / 4.184') },
    { unit: 'Cal', spellings: ['Cal', 'Calories', 'kilocalories'], ...lin(1, 'kcal = Cal (food Calorie, capital C)') },
  ],
  g: [
    { unit: 'mg', spellings: ['mg'], ...lin(0.001, 'g = mg / 1000') },
    { unit: 'mcg', spellings: ['mcg', 'µg', 'μg', 'ug'], ...lin(1e-6, 'g = mcg / 1,000,000') },
    { unit: 'kg', spellings: ['kg'], ...lin(1000, 'g = kg x 1000') },
    { unit: 'oz', spellings: ['oz'], ...lin(28.349523125, 'g = oz x 28.349523125 (mass ounce)') },
  ],
  mL: [
    { unit: 'L', spellings: ['L', 'l', 'liters', 'litres'], ...lin(1000, 'mL = L x 1000') },
    { unit: 'fl oz', spellings: ['fl oz', 'fl_oz', 'floz', 'fl. oz'], ...lin(29.5735295625, 'mL = US fl oz x 29.5735295625') },
    { unit: 'mL', spellings: ['ml'], ...lin(1, 'same unit, different spelling') },
  ],
  L: [
    { unit: 'mL', spellings: ['mL', 'ml'], ...lin(0.001, 'L = mL / 1000') },
    { unit: 'L', spellings: ['l', 'liters', 'litres'], ...lin(1, 'same unit, different spelling') },
  ],
  'L/min': [
    { unit: 'L/s', spellings: ['L/s'], ...lin(60, 'L/min = L/s x 60') },
    { unit: 'mL/min', spellings: ['mL/min', 'ml/min'], ...lin(0.001, 'L/min = mL/min / 1000') },
  ],
  min: [
    { unit: 's', spellings: ['s', 'sec', 'seconds'], ...lin(1 / 60, 'min = s / 60') },
    { unit: 'hr', spellings: ['hr', 'h', 'hours'], ...lin(60, 'min = hr x 60') },
    { unit: 'min', spellings: ['minutes', 'mins', 'minute'], ...lin(1, 'same unit, different spelling') },
  ],
  hr: [
    { unit: 'min', spellings: ['min', 'mins', 'minutes'], ...lin(1 / 60, 'hr = min / 60') },
    { unit: 's', spellings: ['s', 'sec', 'seconds'], ...lin(1 / 3600, 'hr = s / 3600') },
    { unit: 'hr', spellings: ['h', 'hours'], ...lin(1, 'same unit, different spelling') },
  ],
  ms: [
    { unit: 's', spellings: ['s', 'sec', 'seconds'], ...lin(1000, 'ms = s x 1000') },
  ],
  '%': [
    // The cache stores percentages as 0 to 1 fractions. A value given as "%" is read the way people
    // write it, on the 0 to 100 scale.
    { unit: '%', spellings: ['%', 'percent', 'pct'], ...lin(0.01, 'fraction = percent / 100') },
    { unit: 'fraction', spellings: ['fraction', 'ratio'], ...lin(1, 'already a 0 to 1 fraction') },
  ],
  'mg/dL': [
    { unit: 'mmol/L', spellings: ['mmol/L', 'mmol/l'], ...lin(18.0156, 'mg/dL = mmol/L x 18.0156 (glucose, molar mass 180.156 g/mol)'), only: 'blood_glucose' },
  ],
  'count/min': [
    { unit: 'count/min', spellings: ['bpm', 'beats/min', 'breaths/min', 'steps/min', 'spm', 'rpm', '/min', 'per minute'], ...lin(1, 'same unit, different spelling') },
    { unit: 'count/s', spellings: ['count/s', 'Hz'], ...lin(60, 'count/min = count/s x 60') },
  ],
  mmHg: [
    { unit: 'kPa', spellings: ['kPa'], ...lin(7.50061683, 'mmHg = kPa x 7.50061683') },
  ],
  W: [
    { unit: 'kW', spellings: ['kW'], ...lin(1000, 'W = kW x 1000') },
  ],
  'ml/kg*min': [
    { unit: 'ml/kg*min', spellings: ['mL/(kg*min)', 'ml/kg/min', 'mL/kg/min', 'mL/(kg·min)', 'ml/(kg*min)'], ...lin(1, 'same unit, different spelling') },
  ],
  'kcal/(kg*hr)': [
    { unit: 'MET', spellings: ['MET', 'METs', 'met'], ...lin(1, 'Apple Health defines 1 MET as 1 kcal/(kg*hr)') },
  ],
  dBASPL: [
    { unit: 'dBASPL', spellings: ['dBA', 'dB(A)', 'dB SPL'], ...lin(1, 'same unit, different spelling') },
  ],
  S: [
    { unit: 'µS', spellings: ['µS', 'μS', 'uS'], ...lin(1e-6, 'S = µS / 1,000,000') },
  ],
};

/** The unit variants accepted for metric `id`, as plain data (no functions). */
export function unitVariantsFor(id) {
  const row = CANONICAL[id];
  if (!row) return [];
  return (UNIT_VARIANTS[row.unit] || [])
    .filter((v) => !v.only || v.only === id)
    .map((v) => ({ unit: v.unit, spellings: v.spellings.slice(), toCanonical: v.formula }));
}

// Significant-figure rounding, NOT fixed decimals: canonical values span 1e-6 g (micronutrients) to
// 1e5 m, and rounding to N decimal places turned 2.4 mcg into 0.000002 g. Twelve significant
// figures only strips floating-point noise (98.6 degF -> 37, not 36.99999999999999).
const sig = (n) => Number(n.toPrecision(12));

/**
 * Convert `value` given in `unit` into metric `id`'s canonical unit.
 * Throws on an unknown metric, a non-finite value, or a unit not in the table: a guessed unit is
 * worse than a refusal, because the wrong number would read as a real one.
 */
export function convertToCanonical(id, value, unit) {
  const row = CANONICAL[id];
  if (!row) throw new Error(`unknown canonical metric "${id}"`);
  // Only a JSON number or a plain decimal string counts: Number() would also turn "  " into 0,
  // [5] into 5 and "0x10" into 16, which would read as real values.
  const numeric = typeof value === 'number' ||
    (typeof value === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(value));
  const v = numeric ? Number(value) : NaN;
  if (!numeric || !Number.isFinite(v)) {
    throw new Error(`value must be a finite number (got ${JSON.stringify(value)})`);
  }
  const u = String(unit ?? '').trim();
  const canonicalUnit = row.unit;
  const isPct = canonicalUnit === '%';
  if (u === canonicalUnit && !isPct) {
    return { value: v, unit: canonicalUnit, formula: 'already in the canonical unit' };
  }
  const variant = (UNIT_VARIANTS[canonicalUnit] || [])
    .filter((x) => !x.only || x.only === id)
    .find((x) => x.spellings.includes(u));
  if (!variant) {
    const accepted = unitVariantsFor(id).flatMap((x) => x.spellings);
    throw new Error(`unit "${u}" is not a known variant of "${canonicalUnit}" for ${id}. ` +
      `Accepted: ${[canonicalUnit, ...accepted].filter((x, i, a) => x && a.indexOf(x) === i).join(', ') || canonicalUnit || '(unitless)'}. ` +
      'Unknown units are refused rather than guessed.');
  }
  const rawOut = variant.fn ? variant.fn(v) : v * variant.f;
  if (!Number.isFinite(rawOut)) {
    throw new Error(`converting ${v} ${u} to ${canonicalUnit} does not give a finite number; the value is out of range`);
  }
  const out = sig(rawOut);
  const res = {
    value: out,
    unit: isPct ? 'fraction' : canonicalUnit,
    formula: variant.formula,
  };
  // A small number labelled "%" is very often already a 0 to 1 fraction. Say so, do not guess.
  if (isPct && variant.unit === '%' && Math.abs(v) <= 1) {
    res.warning = `A value of ${v} labelled "%" was read as ${v} percent (${out} as a fraction). If it was already a 0 to 1 fraction, pass unit "fraction" instead.`;
  } else if (isPct && variant.unit === '%' && (v > 100 || v < 0)) {
    res.warning = `A value of ${v} percent is outside 0 to 100. It was converted as given (${out} as a fraction); check the input before using it.`;
  } else if (isPct && variant.unit === 'fraction' && (v > 1 || v < 0)) {
    res.warning = `A fraction of ${v} is outside 0 to 1. If it was a 0 to 100 percentage, pass unit "%" instead.`;
  }
  return res;
}

/** Stated in every resolve_metric answer: what the export can and cannot say about sources. */
export const SOURCE_MERGE = {
  perSourceValuesInExport: false,
  disagreementDetection: 'not_available',
  note: 'Each daily value in this export is the single figure Apple Health produces after merging every source on the device (for example an iPhone and a Watch counting the same steps). The export holds one value per metric per day, not one per source, so it cannot show whether two sources disagreed, and nothing here adjusts values to make sources agree.',
};

// Tests for the canonical metric naming and unit table (FR-2026-10-05-cross-source-normalisation,
// first slice): one test group per acceptance criterion recorded in
// docs/feature-requests/fr-cross-source-normalisation.md ("Shipped in this PR").
//
//   AC1  the table describes exactly what the app writes (no drift from the Swift catalog)
//   AC2  every spelling of a metric resolves to ONE canonical name; ambiguity is never guessed
//   AC3  unit variants convert with a stated formula; unknown units are refused
//   AC4  the data tools accept aliases, report `resolvedFrom`, and exact names are unchanged
//   AC5  resolve_metric is honest about the export: presence, stored-unit mismatch, per-source limit
//   AC6  the pairing gate still applies to data; the static table does not leak data when locked
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-normalize-'));
process.env.HEALTH_DATA_DIR = DIR;
delete process.env.PAIRING_SECRET;

const days = (n, fn) => Array.from({ length: n }, (_, i) => ({
  d: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), v: fn(i),
}));
function writeCache(cache) {
  const p = path.join(DIR, '.health-cache.json');
  fs.writeFileSync(p, JSON.stringify(cache));
  const t = Date.now() / 1000 + Math.random() * 1000 + 1;   // defeat the (mtime, size) memo
  fs.utimesSync(p, t, t);
}
const CACHE = {
  step_count: { unit: 'count', cumulative: true, daily: days(30, (i) => 8000 + i * 10) },
  heart_rate_variability: { unit: 'ms', cumulative: false, daily: days(30, (i) => 50 + (i % 7)) },
  active_energy: { unit: 'kcal', cumulative: true, daily: days(30, (i) => 500 + i) },
  weight_body_mass: { unit: 'kg', cumulative: false, daily: days(30, () => 80) },
  // Stored in km rather than the catalog's metres: the mismatch must be reported, not converted.
  walking_running_distance: { unit: 'km', cumulative: true, daily: days(30, () => 5) },
  // A metric the canonical table does not know (newer app, or another tool's export).
  custom_score: { unit: 'count', cumulative: false, daily: days(30, () => 3) },
};
writeCache(CACHE);

const norm = await import('./normalize.mjs');
const store = await import('./healthstore.mjs');
const { TOOLS, ANNOTATIONS } = await import('./server.mjs');

// ---- AC1 ------------------------------------------------------------------------------------
// The generator and the Swift catalog live in the app repo (HermesHealthExport): this check runs
// there, and in the public health-export-mcp repo the generated file is the shipped source of truth.
const GENERATOR = new URL('../scripts/gen-mcp-metric-catalog.mjs', import.meta.url);
test('AC1: metric-catalog.mjs matches the Swift catalog it is generated from', {
  skip: !fs.existsSync(GENERATOR) && 'generator and Swift catalog live in the app repo',
}, async () => {
  const gen = await import(GENERATOR.href);
  const expected = gen.render(gen.readSwiftCatalog());
  const actual = fs.readFileSync(new URL('./metric-catalog.mjs', import.meta.url), 'utf8');
  assert.equal(actual, expected, 'mcp/metric-catalog.mjs is stale: run node scripts/gen-mcp-metric-catalog.mjs');
});

test('AC1: the table holds 189 HealthKit metrics plus the derived CGM metrics, ids unique', async () => {
  const rows = norm.CANONICAL;
  const ids = Object.keys(rows);
  // Uniqueness must be checked on the ARRAY: the keyed object would silently collapse duplicates.
  const { METRIC_CATALOG } = await import('./metric-catalog.mjs');
  const arrayIds = METRIC_CATALOG.map((r) => r[0]);
  assert.equal(new Set(arrayIds).size, arrayIds.length, 'duplicate ids in METRIC_CATALOG');
  assert.equal(arrayIds.length, ids.length);
  assert.equal(ids.filter((id) => rows[id].hk).length, 189);
  assert.ok(rows.glucose_time_in_range_pct && rows.glucose_time_in_range_pct.hk === '');
  assert.equal(rows.blood_oxygen_saturation.unit, '%');
  assert.equal(rows.walking_running_distance.unit, 'm');
  assert.equal(rows.AudioExposureEvent, undefined, 'deprecated types stay out of the table');
});

// ---- AC2 ------------------------------------------------------------------------------------
test('AC2: every canonical id, HealthKit identifier and title resolves to its own metric', () => {
  for (const row of Object.values(norm.CANONICAL)) {
    for (const spelling of [row.id, row.title, ...(row.hk ? [row.hk, `HKQuantityTypeIdentifier${row.hk}`] : [])]) {
      const r = norm.lookup(spelling);
      assert.equal(r.status, 'resolved', `${spelling} -> ${JSON.stringify(r)}`);
      assert.equal(r.metric, row.id, `${spelling} resolved to ${r.metric}, expected ${row.id}`);
    }
  }
});

test('AC2: common aliases resolve to the same measure', () => {
  const cases = {
    steps: 'step_count', StepCount: 'step_count', 'Step Count': 'step_count', hrv: 'heart_rate_variability',
    SDNN: 'heart_rate_variability', rhr: 'resting_heart_rate', spo2: 'blood_oxygen_saturation', 'SpO2': 'blood_oxygen_saturation',
    'VO2 max': 'vo2_max', 'VO₂ Max': 'vo2_max', weight: 'weight_body_mass', 'Body Weight': 'weight_body_mass',
    sleep: 'sleep_analysis', glucose: 'blood_glucose', 'time in range': 'glucose_time_in_range_pct',
    'HKCategoryTypeIdentifierMindfulSession': 'mindful_minutes', floors: 'flights_climbed',
  };
  for (const [spelling, id] of Object.entries(cases)) {
    const r = norm.lookup(spelling);
    assert.equal(r.status, 'resolved', spelling);
    assert.equal(r.metric, id, spelling);
  }
});

test('AC2: matchedBy reports what the spelling actually matched', () => {
  const m = (s) => norm.lookup(s).matchedBy;
  assert.equal(m('step_count'), 'exact');
  assert.equal(m('StepCount'), 'healthkit_identifier');
  assert.equal(m('HKQuantityTypeIdentifierStepCount'), 'healthkit_identifier');
  assert.equal(m('Step Count'), 'title');
  assert.equal(m('STEP_COUNT'), 'spelling');
  assert.equal(m('steps'), 'alias');
  // A prefixed alias is still an alias, not a HealthKit identifier.
  assert.equal(m('HKQuantityTypeIdentifierSteps'), 'alias');
  assert.equal(m('BodyMass'), 'healthkit_identifier');
  assert.equal(m('Sleep'), 'title');
});

test('AC2: a word naming several metrics is ambiguous and never resolved', () => {
  for (const w of ['distance', 'calories', 'Calories', 'energy', 'temperature', 'blood pressure', 'speed']) {
    const r = norm.lookup(w);
    assert.equal(r.status, 'ambiguous', w);
    assert.ok(r.candidates.length >= 2, w);
    for (const c of r.candidates) assert.ok(norm.CANONICAL[c], `${w}: candidate ${c} must be a real metric`);
  }
});

test('AC2: a different measure is refused with the reason, not aliased', () => {
  const r = norm.lookup('RMSSD');
  assert.equal(r.status, 'not_equivalent');
  assert.equal(r.nearest, 'heart_rate_variability');
  assert.match(r.reason, /SDNN/);
  assert.equal(norm.lookup('active minutes').status, 'not_equivalent');
});

test('AC2: prototype names and junk are unknown, never a fabricated match', () => {
  for (const w of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', '   ', 'zzz_not_a_metric']) {
    assert.equal(norm.lookup(w).status, 'unknown', JSON.stringify(w));
  }
});

// ---- AC3 ------------------------------------------------------------------------------------
test('AC3: unit variants convert into the canonical unit with the formula stated', () => {
  const c = (id, v, u) => norm.convertToCanonical(id, v, u);
  assert.deepEqual(c('weight_body_mass', 180, 'lb'), { value: 81.6466266, unit: 'kg', formula: 'kg = lb x 0.45359237' });
  assert.equal(c('weight_body_mass', 80, 'kg').value, 80);
  assert.equal(c('body_temperature', 98.6, 'degF').value, 37);
  assert.equal(c('body_temperature', 310.15, 'K').value, 37);
  assert.equal(c('walking_running_distance', 5, 'km').value, 5000);
  assert.equal(c('walking_running_distance', 1, 'mi').value, 1609.344);
  assert.equal(c('active_energy', 4184, 'kJ').value, 1000);
  assert.equal(c('blood_glucose', 5.5, 'mmol/L').value, 99.0858);
  assert.equal(c('dietary_caffeine', 95, 'mg').value, 0.095);
  assert.equal(c('heart_rate_variability', 0.042, 's').value, 42);
  assert.equal(c('sleep_analysis', 450, 'min').value, 7.5);
  assert.equal(c('heart_rate', 62, 'bpm').value, 62);
  assert.equal(c('dietary_water', 1, 'L').value, 1000);
});

test('AC3: small canonical values keep their precision (significant figures, not fixed decimals)', () => {
  const c = (id, v, u) => norm.convertToCanonical(id, v, u).value;
  assert.equal(c('dietary_vitamin_b12', 2.4, 'mcg'), 2.4e-6);
  assert.equal(c('dietary_vitamin_d', 0.5, 'mcg'), 5e-7);
  assert.equal(c('electrodermal_activity', 0.3, 'µS'), 3e-7);
  assert.equal(c('electrodermal_activity', 2.5, 'uS'), 2.5e-6);
  assert.equal(c('dietary_selenium', 55, 'µg'), 5.5e-5);
  // Floating-point noise is still removed.
  assert.equal(c('body_temperature', 98.6, 'degF'), 37);
  assert.equal(c('dietary_caffeine', 95, 'mg'), 0.095);
});

test('AC3: out-of-range percentages and fractions warn; non-finite results are refused', () => {
  assert.match(norm.convertToCanonical('blood_oxygen_saturation', 140, '%').warning, /outside 0 to 100/);
  assert.match(norm.convertToCanonical('blood_oxygen_saturation', 97, 'fraction').warning, /outside 0 to 1/);
  assert.equal(norm.convertToCanonical('blood_oxygen_saturation', 0.5, 'fraction').warning, undefined);
  assert.throws(() => norm.convertToCanonical('walking_running_distance', 1e308, 'km'), /finite/);
});

test('AC3: percentages convert to the 0 to 1 fraction the cache stores, with a warning when unclear', () => {
  const r = norm.convertToCanonical('blood_oxygen_saturation', 97, '%');
  assert.equal(r.value, 0.97);
  assert.equal(r.unit, 'fraction');
  assert.equal(r.warning, undefined);
  const small = norm.convertToCanonical('blood_oxygen_saturation', 0.97, '%');
  assert.equal(small.value, 0.0097);
  assert.match(small.warning, /fraction/);
  assert.equal(norm.convertToCanonical('blood_oxygen_saturation', 0.97, 'fraction').value, 0.97);
});

test('AC3: unknown, cross-dimension and substance-specific units are refused', () => {
  assert.throws(() => norm.convertToCanonical('weight_body_mass', 1, 'furlong'), /not a known variant/);
  assert.throws(() => norm.convertToCanonical('heart_rate', 5, 'mmol/L'), /not a known variant/);
  // mmol/L to mg/dL depends on the substance: only blood glucose gets it.
  assert.throws(() => norm.convertToCanonical('blood_pressure_systolic', 5, 'mmol/L'), /not a known variant/);
  // Case is meaningful: "s" is seconds, not siemens.
  assert.throws(() => norm.convertToCanonical('electrodermal_activity', 1, 's'), /not a known variant/);
  assert.throws(() => norm.convertToCanonical('weight_body_mass', 'abc', 'lb'), /finite number/);
  assert.throws(() => norm.convertToCanonical('weight_body_mass', null, 'lb'), /finite number/);
});

// ---- AC4 ------------------------------------------------------------------------------------
test('AC4: exact names answer exactly as before (no resolvedFrom anywhere)', async () => {
  const h = await store.getHealthMetrics({ metric: 'step_count', aggregation: 'sum' });
  assert.equal(h.step_count.resolvedFrom, undefined);
  assert.equal(JSON.stringify(h).includes('resolvedFrom'), false);
  const t = await store.getTrends({ metric: 'step_count', window: 7 });
  assert.equal(t.resolvedFrom, undefined);
  const x = await store.getStructuredExport({ metrics: ['step_count'] });
  assert.equal(x.resolvedFrom, undefined);
  const all = await store.getHealthMetrics({});
  assert.equal(JSON.stringify(all).includes('resolvedFrom'), false);
});

test('AC4: get_health_metrics accepts an alias and reports it; values are identical', async () => {
  const exact = await store.getHealthMetrics({ metric: 'step_count', aggregation: 'sum' });
  const alias = await store.getHealthMetrics({ metric: 'Steps', aggregation: 'sum' });
  assert.deepEqual(Object.keys(alias), ['step_count']);
  assert.deepEqual(alias.step_count.resolvedFrom, { requested: 'Steps', metric: 'step_count', matchedBy: 'alias' });
  const { resolvedFrom, ...rest } = alias.step_count;
  assert.deepEqual(rest, exact.step_count);
});

test('AC4: get_trends, compare_periods and correlate_metrics resolve aliases', async () => {
  const t = await store.getTrends({ metric: 'HRV', window: 7 });
  assert.equal(t.metric, 'heart_rate_variability');
  assert.equal(t.resolvedFrom.requested, 'HRV');
  const exactT = await store.getTrends({ metric: 'heart_rate_variability', window: 7 });
  assert.equal(t.recent, exactT.recent);
  const cp = await store.comparePeriods({ metric: 'HKQuantityTypeIdentifierStepCount',
    periodA: { start: '2026-01-01', end: '2026-01-07' }, periodB: { start: '2026-01-08', end: '2026-01-14' } });
  assert.equal(cp.metric, 'step_count');
  assert.equal(cp.resolvedFrom.matchedBy, 'healthkit_identifier');
  const co = await store.correlateMetrics({ metricA: 'steps', metricB: 'Active Calories' });
  assert.equal(co.metricA.name, 'step_count');
  assert.equal(co.metricB.name, 'active_energy');
  assert.equal(co.metricB.resolvedFrom.requested, 'Active Calories');
  assert.equal(co.alignedPairs, 30);
});

test('AC4: get_structured_export resolves aliases and collapses two spellings of one metric', async () => {
  const x = await store.getStructuredExport({ metrics: ['steps', 'step_count', 'Body Weight'] });
  assert.deepEqual(Object.keys(x.metrics).sort(), ['step_count', 'weight_body_mass']);
  assert.equal(x.totalMetrics, 2);
  assert.deepEqual(x.resolvedFrom.map((r) => r.requested), ['steps', 'Body Weight']);
  await assert.rejects(() => store.getStructuredExport({ metrics: 'step_count' }), /array/);
});

test('AC4: ambiguous, not-equivalent and absent names still fail as "unknown metric", with the reason', async () => {
  await assert.rejects(() => store.getHealthMetrics({ metric: 'calories' }), /unknown metric "calories" \("calories" could mean .*present in this export: active_energy/);
  await assert.rejects(() => store.getTrends({ metric: 'rmssd' }), /unknown metric "rmssd" .*SDNN/);
  await assert.rejects(() => store.getHealthMetrics({ metric: 'vo2max' }), /unknown metric "vo2max" .*"vo2_max", which this export does not contain/);
  await assert.rejects(() => store.getStructuredExport({ metrics: ['steps', 'distance'] }), /unknown metric "distance"/);
  await assert.rejects(() => store.correlateMetrics({ metricA: 'steps', metricB: 'nope' }), /unknown metricB "nope"/);
  await assert.rejects(() => store.getHealthMetrics({ metric: 'constructor' }), /unknown metric/);
});

// ---- AC5 ------------------------------------------------------------------------------------
test('AC5: resolve_metric reports the canonical entry, presence, coverage and a conversion', async () => {
  const r = await store.resolveMetric({ name: 'Body Weight', value: 180, unit: 'lb' });
  assert.equal(r.resolved, true);
  assert.equal(r.metric, 'weight_body_mass');
  assert.equal(r.healthkitIdentifier, 'BodyMass');
  assert.equal(r.unit, 'kg');
  assert.equal(r.inExport, true);
  assert.deepEqual(r.coverage, { firstDate: '2026-01-01', lastDate: '2026-01-30', days: 30 });
  assert.ok(r.unitVariants.some((v) => v.unit === 'lb'));
  assert.equal(r.conversion.value, 81.6466266);
  assert.equal(r.conversion.unit, 'kg');
  const absent = await store.resolveMetric({ name: 'vo2max' });
  assert.equal(absent.resolved, true);
  assert.equal(absent.inExport, false);
  assert.equal(absent.coverage, undefined);
  const pct = await store.resolveMetric({ name: 'spo2' });
  assert.equal(pct.unitScale, 'fraction');
  await assert.rejects(() => store.resolveMetric({ name: 'weight', value: 1 }), /together/);
  await assert.rejects(() => store.resolveMetric({}), /name is required/);
  await assert.rejects(() => store.resolveMetric({ name: 'weight', value: 1, unit: 'parsec' }), /not a known variant/);
});

test('AC5: a stored unit that differs from the canonical one is reported, never silently converted', async () => {
  const r = await store.resolveMetric({ name: 'walking distance' });
  assert.equal(r.metric, 'walking_running_distance');
  assert.match(r.unitMismatch, /"km", not the canonical "m"/);
  const h = await store.getHealthMetrics({ metric: 'walking_running_distance', aggregation: 'sum' });
  assert.equal(h.walking_running_distance.unit, 'km');
  assert.equal(h.walking_running_distance.aggregate, 150);
});

test('AC5: the per-source limit is stated on every resolved answer; nothing claims disagreement detection', async () => {
  for (const name of ['steps', 'custom_score', 'vo2max']) {
    const r = await store.resolveMetric({ name });
    assert.equal(r.sourceMerge.perSourceValuesInExport, false, name);
    assert.equal(r.sourceMerge.disagreementDetection, 'not_available', name);
  }
});

test('AC5: ambiguous, not-equivalent, unknown and export-only names answer honestly', async () => {
  const amb = await store.resolveMetric({ name: 'calories' });
  assert.equal(amb.resolved, false);
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.candidates.map((c) => [c.metric, c.inExport]),
    [['active_energy', true], ['basal_energy_burned', false], ['dietary_energy', false]]);
  const ne = await store.resolveMetric({ name: 'rmssd' });
  assert.equal(ne.status, 'not_equivalent');
  assert.equal(ne.inExport, true);   // the NEAREST metric (SDNN) is present; the measure asked for is not
  const unk = await store.resolveMetric({ name: 'stepz' });
  assert.equal(unk.status, 'unknown');
  const own = await store.resolveMetric({ name: 'custom_score' });
  assert.equal(own.resolved, true);
  assert.equal(own.inCatalog, false);
  assert.equal(own.inExport, true);
});

// ---- AC6 ------------------------------------------------------------------------------------
test('AC6: when pairing is locked, data tools stay locked and resolve_metric reveals nothing about the export', async () => {
  process.env.PAIRING_SECRET = 'AB3CD-EFGHJ-K2MNP-QRST4';   // set, with no .health-pair.json: locked
  try {
    await assert.rejects(() => store.getHealthMetrics({ metric: 'steps' }), /Locked/);
    await assert.rejects(() => store.getStructuredExport({ metrics: ['steps'] }), /Locked/);
    const r = await store.resolveMetric({ name: 'steps' });
    assert.equal(r.metric, 'step_count');
    assert.equal(r.inExport, null);
    assert.equal(r.coverage, undefined);
    assert.match(r.lockedNote, /locked/i);
    const own = await store.resolveMetric({ name: 'custom_score' });
    assert.equal(own.status, 'unknown', 'an export-only name must not be confirmed while locked');
    assert.match(own.lockedNote, /locked/i, 'the locked unknown answer says why it cannot check the export');
  } finally {
    delete process.env.PAIRING_SECRET;
  }
});

test('server registers resolve_metric as a read-only tool with name required', () => {
  const t = TOOLS.find((x) => x.name === 'resolve_metric');
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ['name']);
  assert.deepEqual(ANNOTATIONS, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
  assert.equal(TOOLS.length, 16);
  assert.ok(!/[\u2013\u2014]/.test(t.description), 'no en or em dashes');
});

test('unit spellings: minutes/mins for a min metric and lowercase l for an L metric', () => {
  const c = (id, v, u) => norm.convertToCanonical(id, v, u).value;
  assert.equal(c('mindful_minutes', 20, 'minutes'), 20);
  assert.equal(c('mindful_minutes', 20, 'mins'), 20);
  assert.equal(c('mindful_minutes', 1.5, 'hr'), 90);
  assert.equal(c('forced_vital_capacity', 4.2, 'l'), 4.2);
  assert.equal(c('forced_vital_capacity', 4200, 'mL'), 4.2);
});

test('only a JSON number or a plain decimal string is accepted as a value', () => {
  const c = (v) => norm.convertToCanonical('weight_body_mass', v, 'lb');
  assert.equal(c('180').value, c(180).value);
  assert.equal(c(' 1.5e2 ').value, c(150).value);
  for (const bad of ['  ', '', '0x10', '1,5', [5], {}, null, true, NaN, Infinity, '5 lb']) {
    assert.throws(() => c(bad), /finite number/, `should refuse ${JSON.stringify(bad)}`);
  }
});

// Pins LAN receiver prune parity with HealthCache.merge authoritativeDays.
// Standalone copy of the prune contract — receiver.mjs is not a testable module export.
import assert from 'node:assert/strict';

function sanitize(incoming, { maxMetrics = 512, maxDays = 4000 } = {}) {
  const out = {};
  if (!incoming || typeof incoming !== 'object') return out;
  let metrics = 0;
  for (const [name, m] of Object.entries(incoming)) {
    if (metrics >= maxMetrics) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) continue;
    if (!m || !Array.isArray(m.daily)) continue;
    const daily = [];
    for (const p of m.daily.slice(0, maxDays)) {
      if (!p || typeof p.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.d)) continue;
      const v = Number(p.v);
      if (!Number.isFinite(v)) continue;
      daily.push({ d: p.d, v });
    }
    if (!daily.length) continue;
    out[name] = { unit: typeof m.unit === 'string' ? m.unit.slice(0, 32) : '', cumulative: !!m.cumulative, daily };
    metrics++;
  }
  return out;
}

function mergeCache(existing, incoming) {
  const auth = incoming && typeof incoming === 'object' ? incoming._authoritative : null;
  const start = auth && typeof auth.start === 'string' ? auth.start : null;
  const end = auth && typeof auth.end === 'string' ? auth.end : null;
  const authMetrics = Array.isArray(auth?.metrics)
    ? new Set(auth.metrics.filter((n) => typeof n === 'string'))
    : null;
  const inRange = (d) => start && end && d >= start && d <= end;

  const cleaned = sanitize(incoming);
  const merged = { ...(existing || {}) };

  if (start && end && authMetrics) {
    for (const name of authMetrics) {
      if (cleaned[name]) continue;
      const prev = merged[name]?.daily || [];
      const kept = prev.filter((p) => !inRange(p.d));
      if (kept.length !== prev.length) {
        if (kept.length === 0) delete merged[name];
        else merged[name] = { ...(merged[name] || {}), daily: kept };
      }
    }
  }

  for (const [name, m] of Object.entries(cleaned)) {
    const byDay = new Map((merged[name]?.daily || []).map((p) => [p.d, p.v]));
    if (start && end && (!authMetrics || authMetrics.has(name))) {
      for (const d of [...byDay.keys()]) {
        if (inRange(d) && !m.daily.some((p) => p.d === d)) byDay.delete(d);
      }
    }
    for (const p of m.daily) byDay.set(p.d, p.v);
    if (byDay.size === 0) {
      delete merged[name];
      continue;
    }
    merged[name] = { unit: m.unit || merged[name]?.unit || '', cumulative: !!m.cumulative,
      daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ d, v })) };
  }
  return merged;
}

// Contract pin: source must still contain the _authoritative prune path.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'receiver.mjs'), 'utf8');
assert.match(src, /_authoritative/);
assert.match(src, /inRange/);

const existing = {
  step_count: {
    unit: 'count',
    cumulative: true,
    daily: [
      { d: '2026-07-01', v: 1000 },
      { d: '2026-07-02', v: 2000 },
      { d: '2026-07-10', v: 3000 },
    ],
  },
};

const incoming = {
  step_count: {
    unit: 'count',
    cumulative: true,
    daily: [{ d: '2026-07-01', v: 1100 }],
  },
  _authoritative: {
    start: '2026-07-01',
    end: '2026-07-03',
    metrics: ['step_count'],
  },
};

const merged = mergeCache(existing, incoming);
assert.deepEqual(merged.step_count.daily.map((p) => p.d), ['2026-07-01', '2026-07-10']);
assert.equal(merged.step_count.daily.find((p) => p.d === '2026-07-01').v, 1100);

const legacy = mergeCache(existing, {
  step_count: { unit: 'count', cumulative: true, daily: [{ d: '2026-07-01', v: 1100 }] },
});
assert.deepEqual(legacy.step_count.daily.map((p) => p.d),
  ['2026-07-01', '2026-07-02', '2026-07-10']);

// Partial wipe keeps days outside the window.
const wiped = mergeCache(existing, {
  _authoritative: {
    start: '2026-07-01',
    end: '2026-07-03',
    metrics: ['step_count'],
  },
});
assert.deepEqual(wiped.step_count.daily.map((p) => p.d), ['2026-07-10'],
  'authoritative metrics with no incoming daily must drop every day in range');

// Full wipe removes the metric entirely — no present-but-empty shell (HealthCache parity).
const gone = mergeCache(existing, {
  _authoritative: {
    start: '2026-07-01',
    end: '2026-07-31',
    metrics: ['step_count'],
  },
});
assert.equal(gone.step_count, undefined, 'full wipe must delete the metric key');

console.log('receiver-authoritative.test.mjs: ok');

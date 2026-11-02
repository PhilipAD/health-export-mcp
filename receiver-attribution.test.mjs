// Source attribution across a LAN push (cache schema minor 2, whole-person reconciliation).
//
// The app stamps `src` (the label of the source a day's value came from) and `by` (every source
// that recorded that day -> value) onto daily points. The receiver's `sanitize`/`mergeCache` must
// carry them through untouched — a push that drops them silently strips the provenance every agent
// answer cites — and must still reject junk a hostile LAN client could send. Pins GitHub issue #28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCache } from './receiver.mjs';

const day = (i) => new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);

// A metric where two sources (an Apple Watch and an Oura ring) both recorded day 40.
const attributed = {
  resting_heart_rate: {
    unit: 'bpm',
    cumulative: false,
    daily: [
      { d: day(39), v: 60, src: 'com.apple.health' },
      { d: day(40), v: 61, src: 'com.apple.health', by: { 'com.apple.health': 61, 'com.ouraring.app': 62 } },
    ],
  },
};

test('a pushed day keeps its src and by verbatim', () => {
  const m = mergeCache({}, attributed);
  assert.deepEqual(m.resting_heart_rate.daily[0], { d: day(39), v: 60, src: 'com.apple.health' });
  assert.deepEqual(m.resting_heart_rate.daily[1],
    { d: day(40), v: 61, src: 'com.apple.health', by: { 'com.apple.health': 61, 'com.ouraring.app': 62 } });
});

test('an ordinary later push re-sending the same value unstamped keeps prev attribution', () => {
  const first = mergeCache({}, attributed);
  const second = mergeCache(first, {
    resting_heart_rate: { unit: 'bpm', cumulative: false, daily: [{ d: day(40), v: 61 }] },
  });
  assert.deepEqual(second.resting_heart_rate.daily.find((p) => p.d === day(40)),
    { d: day(40), v: 61, src: 'com.apple.health', by: { 'com.apple.health': 61, 'com.ouraring.app': 62 } });
  // The untouched single-source day is also intact.
  assert.deepEqual(second.resting_heart_rate.daily.find((p) => p.d === day(39)),
    { d: day(39), v: 60, src: 'com.apple.health' });
});

test('a changed value with no new attribution drops the stale src/by (same rule as r)', () => {
  const first = mergeCache({}, attributed);
  const second = mergeCache(first, {
    resting_heart_rate: { unit: 'bpm', cumulative: false, daily: [{ d: day(40), v: 59 }] },
  });
  assert.deepEqual(second.resting_heart_rate.daily.find((p) => p.d === day(40)), { d: day(40), v: 59 });
});

test('incoming attribution replaces the cached attribution for that day whole', () => {
  const first = mergeCache({}, attributed);
  const second = mergeCache(first, {
    resting_heart_rate: {
      unit: 'bpm', cumulative: false,
      daily: [{ d: day(40), v: 61, src: 'com.ouraring.app', by: { 'com.ouraring.app': 61 } }],
    },
  });
  assert.deepEqual(second.resting_heart_rate.daily.find((p) => p.d === day(40)),
    { d: day(40), v: 61, src: 'com.ouraring.app', by: { 'com.ouraring.app': 61 } });
});

test('a re-pushed single-source day keeps its src when the value is unchanged and the push carries none', () => {
  const first = mergeCache({}, attributed);
  const second = mergeCache(first, {
    resting_heart_rate: { unit: 'bpm', cumulative: false, daily: [{ d: day(39), v: 60 }] },
  });
  assert.deepEqual(second.resting_heart_rate.daily.find((p) => p.d === day(39)),
    { d: day(39), v: 60, src: 'com.apple.health' });
});

test('junk attribution a hostile client could send is rejected, not smuggled through', () => {
  const m = mergeCache({}, {
    resting_heart_rate: {
      unit: 'bpm', cumulative: false,
      daily: [
        { d: day(41), v: 61, src: 'a'.repeat(65) },                          // overlong label -> dropped
        { d: day(42), v: 61, by: { ok: 1, bad: 'NaN' } },                     // non-finite value -> whole by dropped
        { d: day(43), v: 61, by: ['com.apple.health', 61] },                  // array by -> dropped
        { d: day(44), v: 61, src: 7 },                                        // non-string src -> dropped
        { d: day(45), v: 61, by: { ['x'.repeat(65)]: 1 } },                   // overlong by key -> whole by dropped
      ],
    },
  });
  const pts = m.resting_heart_rate.daily;
  assert.equal(pts.find((p) => p.d === day(41)).src, undefined);
  assert.equal(pts.find((p) => p.d === day(42)).by, undefined);
  assert.equal(pts.find((p) => p.d === day(43)).by, undefined);
  assert.equal(pts.find((p) => p.d === day(45)).by, undefined);
  assert.equal(pts.find((p) => p.d === day(44)).src, undefined);
  assert.equal(pts.every((p) => p.by === undefined || (typeof p.by === 'object' && !Array.isArray(p.by))), true);
});

console.log('receiver-attribution.test.mjs: loading');
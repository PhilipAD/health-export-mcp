// events.mjs, readers for the context files added by the 2026-08 feature wave
// (docs/SCHEMA-CONTRACTS.md is the authoritative contract):
//
//   health-events.json    the one logging surface (medication, habit, visit, life, shift, episode, travel, other)
//   health-profile.json   per-field opt-in context the user chose to share
//   health-sessions.json  clustered sleep sessions, attributed to the WAKING day
//   health-cycles.json    user-logged menstrual cycle starts (observed only, never predictive)
//   health-days.json      the timezone change log (the travel-day source)
//
// Every file is OPTIONAL. An absent file answers {available:false, note}, never "no data": a
// consumer must never read a missing file as "nothing happened". All reads share healthstore's
// (mtime, size) memo and sit behind the same pairing gate as the cache, because these files carry
// exactly the kind of context (medication, cycles) that the pairing gate exists to protect.
//
// This module and healthstore.mjs import each other. The cycle is deliberate and safe: both sides
// reference the other's bindings only INSIDE functions, never during module evaluation, so ESM's
// in-progress module record is fully initialized by the first call. Moving the shared low-level
// helpers out would mean relocating DATA_DIR resolution, which healthstore.test.mjs pins by
// setting HEALTH_DATA_DIR before import.

import { readJSONCached, assertUnlocked, assertDay, dataPath } from './healthstore.mjs';
import { DEMO, demoData } from './demo.mjs';

export const KNOWN_EVENT_TYPES = ['medication', 'habit', 'visit', 'life', 'shift', 'episode', 'travel', 'other'];
// Range events describe a STATE that covers days (a shift block, a trip, an episode). They are not
// segment boundaries: an average across a state is an average of that state, not a before/after mix.
const RANGE_TYPES = new Set(['shift', 'travel', 'episode']);

const EVENTS_FILE = 'health-events.json';
const PROFILE_FILE = 'health-profile.json';
const SESSIONS_FILE = 'health-sessions.json';
const CYCLES_FILE = 'health-cycles.json';
const DAYS_FILE = 'health-days.json';

// YYYY-MM-DD day arithmetic without timezones: date-only strings parse as UTC midnight, so adding
// whole days can never cross a DST boundary.
export function addDays(d, n) {
  return new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
}

function absent(file, what) {
  return {
    available: false,
    note: `No ${file} found. ${what} Absence of the file means it was never exported (or the app predates it), not that nothing happened.`,
  };
}

// ---- raw loaders (memoized via healthstore's readJSONCached) ---------------

/** The parsed events file, or null when absent/corrupt. Callers treat null as "unavailable". */
export function loadEventsFile() {
  if (DEMO) return demoData().events;
  const raw = readJSONCached(dataPath(EVENTS_FILE), null);
  return raw && Array.isArray(raw.events) ? raw : null;
}

export function loadDaysFile() {
  if (DEMO) return demoData().days;
  const raw = readJSONCached(dataPath(DAYS_FILE), null);
  return raw && Array.isArray(raw.changes) ? raw : null;
}

function loadProfileFile() {
  if (DEMO) return demoData().profile;
  const raw = readJSONCached(dataPath(PROFILE_FILE), null);
  return raw && raw.fields && typeof raw.fields === 'object' ? raw : null;
}

function loadSessionsFile() {
  if (DEMO) return demoData().sessions;
  const raw = readJSONCached(dataPath(SESSIONS_FILE), null);
  return raw && Array.isArray(raw.sessions) ? raw : null;
}

function loadCyclesFile() {
  if (DEMO) return demoData().cycles;
  const raw = readJSONCached(dataPath(CYCLES_FILE), null);
  return raw && Array.isArray(raw.cycleStarts) ? raw : null;
}

// ---- derived helpers shared with healthstore's segment honesty -------------

/** Every local day an event covers: endDate ranges inclusive, point events their single day. */
export function eventDays(e) {
  if (!e?.date) return [];
  if (!e.endDate || e.endDate < e.date) return [e.date];
  const days = [];
  for (let d = e.date; d <= e.endDate; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > 3700) break;   // a corrupt endDate must not spin a ten-year loop
  }
  return days;
}

/** The set of days covered by events matching {eventType, eventTag}. Null when the file is absent,
 *  which callers must surface honestly rather than treating as an empty match. */
export function matchingEventDaySet({ eventType, eventTag } = {}) {
  const file = loadEventsFile();
  if (!file) return null;
  const days = new Set();
  for (const e of file.events) {
    if (eventType && e.type !== eventType) continue;
    if (eventTag && !(Array.isArray(e.tags) && e.tags.includes(eventTag))) continue;
    for (const d of eventDays(e)) days.add(d);
  }
  return days;
}

/** Days on which a timezone change landed (day length was not 24h). Null when no log exists. */
export function travelDaySet() {
  const file = loadDaysFile();
  if (!file) return null;
  const days = new Set();
  for (const c of file.changes) {
    if (typeof c?.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.from)) days.add(c.from);
  }
  return days;
}

/** Segment boundaries inside [start, end]: POINT events (no endDate) of the boundary types.
 *  Range events (shift, travel, episode) are states, not boundaries, and are excluded; so are
 *  visits, which observe rather than change anything. Point events of a type this server does not
 *  know are INCLUDED: an unknown type written by a newer app is more likely an intervention we
 *  cannot classify than noise, and silently ignoring it would hide a real segment. */
export function boundariesIn(start, end) {
  const file = loadEventsFile();
  if (!file) return null;
  const boundaryType = (t) => t === 'medication' || t === 'habit' || t === 'life' || t === 'other'
    || !KNOWN_EVENT_TYPES.includes(t);
  return file.events
    .filter((e) => e?.date && !e.endDate && boundaryType(e.type)
      && (!start || e.date >= start) && (!end || e.date <= end))
    .map((e) => ({ date: e.date, type: e.type, title: e.title ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const SEGMENT_NOTE = (n) =>
  `The window spans ${n} logged event(s). An average across a boundary can be a number that was true on no actual day; consider compare_periods anchored at the event date.`;

/** Find one event by id. Returns {available:false} | {available:true, event|null}. */
export function findEvent(id) {
  const file = loadEventsFile();
  if (!file) return { available: false, event: null };
  return { available: true, event: file.events.find((e) => e?.id === id) ?? null };
}

// ---- tool-level answers ----------------------------------------------------

export async function listEvents({ type, tag, start, end } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const file = loadEventsFile();
  if (!file) {
    return absent(EVENTS_FILE, 'Events appear when the iOS app (1.5 or later) logs one (medication start, habit change, visit, shift block, trip) and exports.');
  }
  // Unknown types pass through unharmed: no allowlist here. A type filter matches the stored
  // string exactly, so a newer app's types remain reachable by name.
  let events = file.events.filter((e) => e && typeof e.date === 'string');
  if (type) events = events.filter((e) => e.type === type);
  if (tag) events = events.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  // A range event is "in" the window when it OVERLAPS it, matching how its days are counted.
  if (start || end) {
    events = events.filter((e) => {
      const last = e.endDate && e.endDate >= e.date ? e.endDate : e.date;
      return (!start || last >= start) && (!end || e.date <= end);
    });
  }
  events = [...events].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  return {
    available: true,
    count: events.length,
    knownTypes: KNOWN_EVENT_TYPES,
    events,
    ...(events.length === 0 && {
      note: 'No events matched. The file is present; nothing matching this filter has been logged.',
    }),
  };
}

export async function getProfile() {
  assertUnlocked();
  const file = loadProfileFile();
  const withheldNote =
    'Fields are per-field opt-in. An absent field was withheld by the user or never enabled; absence must not be read as "none". Age, sex, height and weight are HealthKit metrics in the daily cache, not profile fields.';
  if (!file) {
    return absent(PROFILE_FILE, 'The profile appears when the user opts in to sharing context fields in the iOS app (1.5 or later) and exports. ' + withheldNote);
  }
  const presentFields = Object.keys(file.fields);
  return {
    available: true,
    presentFields,
    fields: file.fields,
    writtenAt: file.writtenAt ?? null,
    note: withheldNote,
  };
}

export async function getSleepSessions({ start, end, day } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  day = assertDay(day, 'day');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const file = loadSessionsFile();
  if (!file) {
    return absent(SESSIONS_FILE, 'Sleep sessions appear when the iOS app (1.5 or later) exports its clustered sessions.');
  }
  let sessions = file.sessions.filter((s) => s && typeof s.day === 'string');
  if (day) sessions = sessions.filter((s) => s.day === day);
  if (start) sessions = sessions.filter((s) => s.day >= start);
  if (end) sessions = sessions.filter((s) => s.day <= end);
  sessions = [...sessions].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return {
    available: true,
    count: sessions.length,
    sessions,
    note: 'Sessions are attributed to the WAKING day: a night from 23:00 on the 18th to 06:50 on the 19th belongs to day 2026-08-19, matching the daily cache\'s sleep_analysis attribution. Multiple sessions on one day are a split night, returned as-is; union the hours, never sum overlapping sessions.',
  };
}

// ---- cycle context ---------------------------------------------------------

const CYCLE_BASIS = 'Derived from logged periods, not predictive. Phase labels are coarse: follicular from day 1 to the observed midpoint of that cycle (day 14 for the ongoing cycle, whose length is not yet observed), luteal for the remainder. No ovulation estimate is made.';

function cycleDayContext(date, starts) {
  // starts is ascending. Find the last start <= date.
  let idx = -1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= date) idx = i;
  if (idx < 0) return null;
  const start = starts[idx];
  const next = starts[idx + 1];   // undefined for the ongoing cycle
  const dayInCycle = Math.round((Date.parse(date) - Date.parse(start)) / 86400000) + 1;
  const observedLength = next ? Math.round((Date.parse(next) - Date.parse(start)) / 86400000) : null;
  const midpoint = observedLength ? Math.floor(observedLength / 2) : 14;
  return {
    date,
    cycleStart: start,
    dayInCycle,
    phase: dayInCycle <= midpoint ? 'follicular' : 'luteal',
    observedCycleLengthDays: observedLength,
    ongoing: !next,
  };
}

export async function getCycleContext({ date } = {}) {
  assertUnlocked();
  date = assertDay(date, 'date');
  const file = loadCyclesFile();
  // The derived-not-predictive basis rides on EVERY answer, the unavailable one included: an
  // agent that only ever sees the absent branch must still learn what this surface is and is not.
  const starts = file ? [...file.cycleStarts].filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  if (!starts.length) {
    return {
      ...absent(CYCLES_FILE, 'Cycle context appears when menstrual flow is logged in Apple Health and the iOS app (1.5 or later) exports the observed cycle starts.'),
      basis: CYCLE_BASIS,
    };
  }
  if (date) {
    const ctx = cycleDayContext(date, starts);
    if (!ctx) {
      return {
        available: true,
        date,
        context: null,
        cycleStarts: starts,
        note: `${date} is before the first logged cycle start (${starts[0]}), so no day-in-cycle can be derived for it. ` + CYCLE_BASIS,
      };
    }
    return { available: true, date, context: ctx, cycleStarts: starts, basis: CYCLE_BASIS };
  }
  // Default: per-day context for the last cycle, from its start through the current day (in demo
  // mode the fixed synthetic anchor, so demo answers stay deterministic).
  const lastStart = starts[starts.length - 1];
  const today = DEMO ? '2026-08-18' : new Date().toISOString().slice(0, 10);
  const until = today >= lastStart ? today : lastStart;
  const days = [];
  for (let d = lastStart; d <= until && days.length < 120; d = addDays(d, 1)) {
    days.push(cycleDayContext(d, starts));
  }
  return {
    available: true,
    cycleStarts: starts,
    lastCycle: { start: lastStart, days },
    basis: CYCLE_BASIS,
  };
}

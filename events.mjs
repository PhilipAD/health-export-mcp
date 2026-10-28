// events.mjs, readers for the context files added by the 2026-08 feature wave
// (docs/SCHEMA-CONTRACTS.md is the authoritative contract):
//
//   health-events.json    the one logging surface (medication, habit, visit, life, shift, episode, travel, other)
//   health-events-agent.json  events an agent logged with add_event (contract section 10.2); this is
//                         the ONE file this server writes, and only through add_event / remove_event
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

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJSONCached, assertUnlocked, assertDay, dataPath, encryptionStatus } from './healthstore.mjs';
import { DEMO, demoData } from './demo.mjs';
import { sealEnvelope, configuredPassphrase, EnvelopeError } from './envelope.mjs';

export const KNOWN_EVENT_TYPES = ['medication', 'habit', 'visit', 'life', 'shift', 'episode', 'travel', 'other'];
// Range events describe a STATE that covers days (a shift block, a trip, an episode). They are not
// segment boundaries: an average across a state is an average of that state, not a before/after mix.
const RANGE_TYPES = new Set(['shift', 'travel', 'episode']);

const EVENTS_FILE = 'health-events.json';
// The app owns health-events.json and replaces it whole on every export, so an agent writing into
// it would be overwritten (or, through iCloud, conflict per FILE, not per record). Agent events
// live in their own file with exactly one writer: this server.
export const AGENT_EVENTS_FILE = 'health-events-agent.json';
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

/** The parsed agent events file, or null when absent/corrupt. A sealed file without its passphrase
 *  throws the same explainable EnvelopeError every other reader does. */
export function loadAgentEventsFile() {
  if (DEMO) return null;
  const raw = readJSONCached(dataPath(AGENT_EVENTS_FILE), null);
  return raw && Array.isArray(raw.events) ? raw : null;
}

/** Every logged event from BOTH files, each labelled `source: "app" | "agent"`, or null when
 *  neither file exists (callers surface that as unavailable, never as an empty match). */
export function loadAllEvents() {
  const app = loadEventsFile();
  const agent = loadAgentEventsFile();
  if (!app && !agent) return null;
  const label = (source) => (e) => (e && typeof e === 'object' ? { ...e, source } : e);
  return [...(app?.events ?? []).map(label('app')), ...(agent?.events ?? []).map(label('agent'))];
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
  const events = loadAllEvents();
  if (!events) return null;
  const days = new Set();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
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
  const events = loadAllEvents();
  if (!events) return null;
  const boundaryType = (t) => t === 'medication' || t === 'habit' || t === 'life' || t === 'other'
    || !KNOWN_EVENT_TYPES.includes(t);
  return events
    .filter((e) => e?.date && !e.endDate && boundaryType(e.type)
      && (!start || e.date >= start) && (!end || e.date <= end))
    .map((e) => ({ date: e.date, type: e.type, title: e.title ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const SEGMENT_NOTE = (n) =>
  `The window spans ${n} logged event(s). An average across a boundary can be a number that was true on no actual day; consider compare_periods anchored at the event date.`;

/** Find one event by id, in either file. Returns {available:false} | {available:true, event|null}. */
export function findEvent(id) {
  const events = loadAllEvents();
  if (!events) return { available: false, event: null };
  return { available: true, event: events.find((e) => e?.id === id) ?? null };
}

// ---- tool-level answers ----------------------------------------------------

export async function listEvents({ type, tag, start, end } = {}) {
  assertUnlocked();
  start = assertDay(start, 'start');
  end = assertDay(end, 'end');
  if (start && end && start > end) throw new Error(`start (${start}) is after end (${end})`);
  const all = loadAllEvents();
  if (!all) {
    return absent(EVENTS_FILE, 'Events appear when the iOS app (1.5 or later) logs one (medication start, habit change, visit, shift block, trip) and exports, or when an agent logs one with add_event.');
  }
  // Unknown types pass through unharmed: no allowlist here. A type filter matches the stored
  // string exactly, so a newer app's types remain reachable by name.
  let events = all.filter((e) => e && typeof e.date === 'string');
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
    sourceNote: 'source "app" events were logged in the MetricBridge iOS app (edit them there); source "agent" events were logged with add_event and can be removed with remove_event.',
    ...(events.length === 0 && {
      note: 'No events matched. The file is present; nothing matching this filter has been logged.',
    }),
  };
}

// ---- agent-logged events: the server's only write path (contract section 10.2) -------------
// add_event / remove_event write health-events-agent.json and nothing else. Every write takes an
// exclusive lock file, writes a temp file in the same folder and renames it over the target, so a
// reader (this server, the iOS app, iCloud) only ever sees a whole file. Both temp and lock names
// end in ".nosync", which iCloud Drive does not upload: neither ever reaches the phone.

const LOCK_FILE = `.${AGENT_EVENTS_FILE}.lock.nosync`;
const LOCK_STALE_MS = 30000;      // a crashed writer's lock is reclaimed after this long
const LOCK_WAIT_MS = 3000;        // a live one is waited for at most this long
const TITLE_MAX = 200, NOTE_MAX = 2000, TAG_MAX = 64, TAGS_MAX = 20, CLIENT_ID_MAX = 128;
const ADD_KEYS = ['date', 'type', 'title', 'endDate', 'note', 'tags', 'clientEventId'];

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding the agent-events lock. Always released, also when `fn` throws. */
function withAgentLock(fn) {
  const lock = dataPath(LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw new Error(`Could not lock ${AGENT_EVENTS_FILE} for writing (${e.code || 'error'}).`);
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }   // released meanwhile
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`Another add_event or remove_event is writing ${AGENT_EVENTS_FILE} right now. Try again in a moment.`);
      sleepMs(25);
    }
  }
  try {
    try { fs.writeSync(fd, `${process.pid}\n`); } catch {}
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/** Refuse to write where a write would be wrong: demo mode, a locked pairing gate, a folder that
 *  holds no export, a read-only folder, or an encrypted export whose passphrase this server lacks
 *  (writing that event in plaintext beside sealed files would leak exactly what the user sealed).
 *  Returns the passphrase to seal with, or null for a plaintext destination. */
const assertNotDemo = (tool) => {
  if (DEMO) throw new Error(`${tool} is disabled in demo mode: there is no real export to write to. Restart without --demo to log events.`);
};

function assertWritable(tool) {
  assertNotDemo(tool);
  assertUnlocked();
  const dir = dataPath('');
  const has = (f) => { try { return fs.statSync(dataPath(f)).isFile(); } catch { return false; } };
  if (!has('.health-cache.json') && !has(EVENTS_FILE) && !has(AGENT_EVENTS_FILE)) {
    throw new Error(`${tool} writes beside a MetricBridge export, and ${dir} holds none (no .health-cache.json). Point HEALTH_DATA_DIR at the export folder, or log the event in the iOS app.`);
  }
  try { fs.accessSync(dir, fs.constants.W_OK); }
  catch { throw new Error(`The data folder ${dir} is not writable by this server, so ${tool} cannot save anything there. Log the event in the MetricBridge iOS app instead.`); }
  if (!encryptionStatus().encrypted) return null;
  let passphrase = null;
  try { passphrase = configuredPassphrase(); } catch { passphrase = null; }
  if (!passphrase) {
    throw new Error(`This export is encrypted and HEALTH_EXPORT_PASSPHRASE is not set, so ${tool} cannot seal the event like the rest of the export and will not write it in plaintext. Set the passphrase from the iOS app, or log the event in the app.`);
  }
  // The passphrase must open the export it will seal beside; a wrong one would write a file the
  // app cannot read. Reading the cache verifies it (memoized, so this is free after first use).
  try { readJSONCached(dataPath('.health-cache.json'), null); }
  catch (e) { if (e instanceof EnvelopeError) throw new Error(`${tool}: ${e.message}`); throw e; }
  return passphrase;
}

/** Replace health-events-agent.json atomically with `events`. Temp file in the same folder, renamed
 *  over the target; the temp file is removed if anything fails. */
function writeAgentEvents(events, passphrase) {
  const body = JSON.stringify({ schema: 1, writer: 'health-export-mcp', writtenAt: new Date().toISOString(), events }, null, 2);
  const bytes = passphrase ? JSON.stringify(sealEnvelope(body, passphrase)) : body;
  const tmp = dataPath(`.${AGENT_EVENTS_FILE}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp.nosync`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dataPath(AGENT_EVENTS_FILE));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`Could not write ${AGENT_EVENTS_FILE} (${e.code || e.message}). Nothing was changed.`);
  }
}

const optString = (v, label, max) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${label} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new Error(`${label} is ${t.length} characters; the limit is ${max}`);
  return t;
};

/** Validate add_event's arguments strictly: an agent must learn its argument was wrong, never have
 *  it silently coerced into an event the user did not mean. */
function validateNewEvent(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('add_event takes an object: {date, type, title, endDate?, note?, tags?, clientEventId?}');
  const unknown = Object.keys(args).filter((k) => !ADD_KEYS.includes(k));
  if (unknown.length) throw new Error(`add_event does not take ${unknown.map((k) => `"${k}"`).join(', ')}. Fields: ${ADD_KEYS.join(', ')}.`);
  const date = assertDay(args.date, 'date');
  if (!date) throw new Error('date is required (YYYY-MM-DD, the local day the event happened or started)');
  if (!KNOWN_EVENT_TYPES.includes(args.type)) {
    throw new Error(`type must be one of ${KNOWN_EVENT_TYPES.join(', ')} (got ${JSON.stringify(args.type)})`);
  }
  const title = optString(args.title, 'title', TITLE_MAX);
  if (!title) throw new Error('title is required: a short description, e.g. "Started magnesium"');
  const endDate = assertDay(args.endDate, 'endDate');
  if (endDate && endDate < date) throw new Error(`endDate (${endDate}) is before date (${date})`);
  const note = optString(args.note, 'note', NOTE_MAX);
  let tags;
  if (args.tags !== undefined && args.tags !== null) {
    if (!Array.isArray(args.tags)) throw new Error('tags must be an array of strings');
    if (args.tags.length > TAGS_MAX) throw new Error(`at most ${TAGS_MAX} tags`);
    tags = [...new Set(args.tags.map((t, i) => {
      const v = optString(t, `tags[${i}]`, TAG_MAX);
      if (!v) throw new Error(`tags[${i}] must be a non-empty string`);
      return v;
    }))];
    if (!tags.length) tags = undefined;
  }
  const clientEventId = optString(args.clientEventId, 'clientEventId', CLIENT_ID_MAX);
  return { date, type: args.type, title, endDate, note, tags, clientEventId };
}

/** add_event: log one event into health-events-agent.json. Idempotent: the same clientEventId (or,
 *  without one, the same date, type, title and endDate) returns the event already logged. */
export async function addEvent(args = {}) {
  assertNotDemo('add_event');
  const v = validateNewEvent(args);
  const passphrase = assertWritable('add_event');
  return withAgentLock(() => {
    const events = [...(loadAgentEventsFile()?.events ?? [])];
    const same = v.clientEventId
      ? (e) => e?.clientEventId === v.clientEventId
      : (e) => !e?.clientEventId && e?.date === v.date && e?.type === v.type && e?.title === v.title && (e?.endDate ?? undefined) === v.endDate;
    const existing = events.find(same);
    if (existing) {
      return {
        added: false, duplicate: true, file: AGENT_EVENTS_FILE, event: { ...existing, source: 'agent' },
        note: v.clientEventId
          ? `An event with clientEventId "${v.clientEventId}" is already logged, so nothing was added.`
          : 'An identical event (same date, type, title and endDate) is already logged, so nothing was added. Pass a distinct clientEventId to log a second one on purpose.',
      };
    }
    const event = {
      id: `agent-${crypto.randomUUID()}`,
      date: v.date, type: v.type, title: v.title,
      ...(v.endDate && { endDate: v.endDate }),
      ...(v.note && { note: v.note }),
      ...(v.tags && { tags: v.tags }),
      createdAt: new Date().toISOString(),
      ...(v.clientEventId && { clientEventId: v.clientEventId }),
    };
    writeAgentEvents([...events, event], passphrase);
    return {
      added: true, file: AGENT_EVENTS_FILE, event: { ...event, source: 'agent' },
      note: `Logged in ${AGENT_EVENTS_FILE} beside the export. list_events, compare_periods anchors and filterDays read it at once; the iOS app shows it read-only. Remove it with remove_event and this id.`,
    };
  });
}

/** remove_event: delete one agent-logged event. App events are refused (they belong to the app,
 *  which rewrites its own file). Removing an id that is already gone is a no-op, not an error. */
export async function removeEvent(args = {}) {
  assertNotDemo('remove_event');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('remove_event takes {id}');
  const unknown = Object.keys(args).filter((k) => k !== 'id');
  if (unknown.length) throw new Error(`remove_event takes only "id" (got ${unknown.map((k) => `"${k}"`).join(', ')})`);
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required: the event id from list_events or add_event');
  if (!id.startsWith('agent-')) {
    throw new Error(`"${id}" is not an agent-logged event. Only events added with add_event (ids starting "agent-", source "agent" in list_events) can be removed here; events logged in the MetricBridge iOS app are edited or deleted in the app.`);
  }
  const passphrase = assertWritable('remove_event');
  return withAgentLock(() => {
    const events = loadAgentEventsFile()?.events ?? [];
    const existing = events.find((e) => e?.id === id);
    if (!existing) {
      return { removed: false, id, file: AGENT_EVENTS_FILE, note: `No agent-logged event has id "${id}" (already removed, or never added). Nothing was changed.` };
    }
    writeAgentEvents(events.filter((e) => e?.id !== id), passphrase);
    return { removed: true, id, file: AGENT_EVENTS_FILE, event: { ...existing, source: 'agent' } };
  });
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
  const { kept, collapsed } = collapseDuplicateSessions(sessions);
  sessions = kept.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const manualInBed = sessions.filter((s) => s.manualInBed === true).length;
  return {
    available: true,
    count: sessions.length,
    ...(collapsed > 0 && { collapsedDuplicates: collapsed }),
    ...(manualInBed > 0 && { manualInBedSessions: manualInBed }),
    sessions,
    note: 'Sessions are attributed to the WAKING day: a night from 23:00 on the 18th to 06:50 on the 19th belongs to day 2026-08-19, matching the daily cache\'s sleep_analysis attribution. Separate sessions on one day are a split night, returned as separate rows; union the hours, never sum overlapping sessions.'
      + (collapsed > 0 ? ` ${collapsed} duplicate session(s) were collapsed: rows that share an end time with, or sit entirely inside, a longer session on the same day are copies of one night written by older app versions, and only the longer one is kept.` : '')
      + (manualInBed > 0 ? ` ${manualInBed} session(s) carry manualInBed:true: built from an "In Bed" entry the user typed into the Health app with no asleep sample from any device, counted as asleep.` : ''),
  };
}

/** Collapse copies of one night (contract section 10.5). Older app builds rebuilt a night from its
 *  post-midnight half and stored it beside the full night: same waking day, same end, later start,
 *  fewer hours. Within a waking day, a session that shares its end instant with a longer one, or
 *  lies entirely inside one, is that copy; the longer survives. Sessions whose times do not parse
 *  are never collapsed. A genuine split night (two sessions that do not overlap) is untouched. */
function collapseDuplicateSessions(sessions) {
  const byDay = new Map();
  for (const s of sessions) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push({ s, a: Date.parse(s.start), b: Date.parse(s.end) });
  }
  const kept = [];
  let collapsed = 0;
  for (const group of byDay.values()) {
    const span = (x) => (Number.isFinite(x.a) && Number.isFinite(x.b) ? x.b - x.a : -1);
    group.sort((x, y) => span(y) - span(x) || (Number(y.s.hours) || 0) - (Number(x.s.hours) || 0));
    const survivors = [];
    for (const x of group) {
      const timed = Number.isFinite(x.a) && Number.isFinite(x.b);
      const dup = timed && survivors.some((k) => Number.isFinite(k.a) && Number.isFinite(k.b)
        && (k.b === x.b || (x.a >= k.a && x.b <= k.b)));
      if (dup) collapsed++; else survivors.push(x);
    }
    kept.push(...survivors.map((x) => x.s));
  }
  return { kept, collapsed };
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

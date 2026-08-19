#!/usr/bin/env node
// MetricBridge — MCP server (zero-dependency, stdio JSON-RPC 2.0).
//
// Exposes your exported Apple Health data to any MCP-compatible agent
// (Claude Desktop, OpenClaw, Hermes, Cursor, …). Local-first by default.
//
//   HEALTH_DATA_DIR=/path/to/icloud/folder node server.mjs      # reads .health-cache.json
//   node server.mjs --demo                                      # synthetic dataset, no data needed
//   node server.mjs --doctor                                    # human-readable diagnostics
//   node server.mjs status --max-age 24                         # freshness gate for cron (exit 0/1)
//   node server.mjs receive                                     # standalone LAN receiver, no MCP
//
// Protocol: MCP over stdio — newline-delimited JSON-RPC 2.0. stdout is reserved
// for protocol messages; all logging goes to stderr. The CLI subcommands above run
// INSTEAD of the protocol loop, so their stdout is theirs to print to.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from './healthstore.mjs';
import * as ev from './events.mjs';
import { PROMPTS } from './prompts.mjs';
import { DEMO } from './demo.mjs';

const SERVER = { name: 'health-export-ai', version: '1.4.2' };
const DEFAULT_PROTOCOL = '2025-06-18';
const log = (...a) => process.stderr.write('[mcp] ' + a.join(' ') + '\n');

// ~25,000 tokens at the usual ~4 chars/token, matching Claude Code's MAX_MCP_OUTPUT_TOKENS default.
// Override with HEALTH_MAX_RESULT_CHARS when a host allows more.
// A NON-NUMERIC override used to disable the gate entirely: Number("200k") is NaN, and every
// `wireChars > NaN` comparison is false, so an unbounded result shipped. Fall back to the default
// rather than trusting whatever was set.
const BUDGET_CHARS = (() => {
  const raw = process.env.HEALTH_MAX_RESULT_CHARS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 100000;
})();

// ---- tool definitions ----------------------------------------------------
const DATE = { type: 'string', description: 'YYYY-MM-DD' };
const GRANULARITY = {
  type: 'string', enum: ['auto', 'day', 'week', 'month', 'quarter', 'year'],
  description: "Roll daily values up before returning them. 'auto' (default) picks the finest granularity that fits the response budget, so a multi-year range returns monthly points instead of thousands of daily ones.",
};
const LIMIT = { type: 'integer', description: 'Maximum data points to return (default 365, max 3000). The server rolls up rather than truncating.' };
const EXCLUDE_TRAVEL = {
  type: 'boolean',
  description: 'Drop days on which a timezone change landed (health-days.json): those days were not 24 hours long, so their totals are stretched or shortened by the clock. The answer reports how many days were excluded and why.',
};
// Data-heavy tools declare a larger persist-to-disk threshold so a legitimately big answer is
// written to a file and referenced, instead of being cut off mid-JSON.
const BIG_RESULT_META = { 'anthropic/maxResultSizeChars': 400000 };
// Every tool here is a pure read over local files: nothing is written, repeated calls with the
// same arguments return the same answer (until the iOS app rewrites a file), and no tool reaches
// beyond the configured data dir. Declared once and attached to all of them in tools/list.
const ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  {
    name: 'get_mcp_status',
    description: 'Health check: data source, how many metrics/workouts are available, which optional context files exist, and the most recent data date. Call this first to confirm the bridge is connected.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => store.status(),
  },
  {
    name: 'list_metrics',
    description: 'List every available Apple Health metric with its unit, day count, and date range. Use this to discover metric names before querying.',
    inputSchema: { type: 'object', properties: {} },
    // structuredContent must be a JSON object (MCP spec) — wrap the list so strict
    // clients (e.g. opencode) accept it rather than rejecting a top-level array.
    handler: async () => ({ metrics: await store.listMetrics() }),
  },
  {
    name: 'get_health_metrics',
    description: "Get values for a metric (or all metrics) over an optional date range, with an aggregate (avg/sum/min/max/latest). The core data-retrieval tool. Every result carries a `coverage` block giving the metric's real firstDate/lastDate/days: check it before trusting a long window, and note that `aggregate` is always computed over the full range even when `points` are rolled up. Single-metric answers also list any logged point events inside the window as segmentBoundaries.",
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name, e.g. step_count, heart_rate, sleep_analysis. Omit for all.' },
        start: DATE, end: DATE,
        aggregation: { type: 'string', enum: ['avg', 'sum', 'min', 'max', 'latest'] },
        granularity: GRANULARITY, limit: LIMIT,
        filterDays: {
          type: 'object',
          description: 'Restrict to days covered by matching logged events (health-events.json): endDate ranges cover every day inclusive, point events cover their single day, negate:true keeps only days NOT covered. The answer states how many days matched. Example: HRV on night-shift blocks vs days off.',
          properties: {
            eventType: { type: 'string', description: 'Event type to match, e.g. shift, medication, travel.' },
            eventTag: { type: 'string', description: 'Event tag to match, e.g. nights.' },
            negate: { type: 'boolean', description: 'Keep only days NOT covered by matching events.' },
          },
        },
      },
    },
    _meta: BIG_RESULT_META,
    handler: (a) => store.getHealthMetrics(a),
  },
  {
    name: 'get_trends',
    description: 'Compare the most recent N-day window against the prior N days for a metric: change, percent change and direction (up/down/flat). Also returns `daysAvailable` and `windowSatisfied`: if windowSatisfied is false the file does not hold enough history for the window you asked for, and the comparison is over less data than requested. Logged point events inside the compared span are listed as segmentBoundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        window: { type: 'integer', description: 'days per window (default 7)' },
        excludeTravelDays: EXCLUDE_TRAVEL,
      },
      required: ['metric'],
    },
    handler: (a) => store.getTrends(a),
  },
  {
    name: 'compare_periods',
    description: 'Compare a metric between two arbitrary date periods (A vs B): each aggregate plus the change and percent change. Pass periodA/periodB explicitly, or pass anchor {eventId, days} to build both periods around a logged event (the before/after question, with the event day excluded from both sides).',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        periodA: { type: 'object', properties: { start: DATE, end: DATE } },
        periodB: { type: 'object', properties: { start: DATE, end: DATE } },
        anchor: {
          type: 'object',
          description: 'Build both periods around a logged event instead of passing dates: periodA is the {days} days before the event date, periodB the {days} days after, the event day itself excluded from both. Get event ids from list_events. Pass either anchor or periodA/periodB, not both.',
          properties: {
            eventId: { type: 'string', description: 'Event id from list_events.' },
            days: { type: 'integer', description: 'Days on each side of the event.' },
          },
        },
        excludeTravelDays: EXCLUDE_TRAVEL,
      },
      required: ['metric'],
    },
    handler: (a) => store.comparePeriods(a),
  },
  {
    name: 'get_structured_export',
    description: "Return clean structured JSON for the chosen metrics/date range. Paginated: the result carries `nextCursor` when more metrics remain; pass it back as `cursor` for the next page. Prefer naming the metrics you need and a date range; calling it bare over a full history is a lot of data.",
    inputSchema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: { type: 'string' } }, start: DATE, end: DATE,
        granularity: GRANULARITY, limit: LIMIT,
        cursor: { type: 'string', description: 'Opaque cursor from a previous call\'s nextCursor.' },
      },
    },
    _meta: BIG_RESULT_META,
    handler: (a) => store.getStructuredExport(a),
  },
  {
    name: 'get_intraday',
    description: "The current hour-by-hour window from the iOS app's HOURLY automations (health-intraday.json, app 1.4+): each metric's hourly points plus its latest value. The file is REPLACED on every hourly run, so this is a live within-day view, not history; use get_health_metrics for day-level questions. Returns available:false with setup guidance when no hourly automation has delivered yet.",
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name to filter, e.g. heart_rate. Omit for every metric in the window.' },
      },
    },
    handler: (a) => store.getIntraday(a),
  },
  {
    name: 'query_health_data',
    description: 'Natural-language convenience: pass a question and get routed structured results. Prefer the specific tools above when you can, and call list_metrics first to see how much history exists, since this tool answers over whatever the file holds.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    handler: (a) => store.queryHealthData(a),
  },
  // ---- context tools (optional files; absence is reported, never guessed) ----
  {
    name: 'list_events',
    description: 'Logged context events from health-events.json: medication starts, habit changes, doctor visits, life events, shift blocks, episodes, travel, and any type a newer app adds. Optional {type, tag, start, end} filters; a range event matches a window it overlaps. Sorted ascending by date. Returns available:false when the file was never exported; absence means nothing was exported, not that nothing happened.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Event type, e.g. medication, habit, visit, life, shift, episode, travel, other. Unknown types pass through and can be filtered by their stored string.' },
        tag: { type: 'string', description: 'Match events carrying this tag.' },
        start: DATE, end: DATE,
      },
    },
    handler: (a) => ev.listEvents(a),
  },
  {
    name: 'get_profile',
    description: 'The context fields the user explicitly opted in to sharing (health-profile.json): conditions, medications, goals, allergies, notes. Returns the fields plus a presentFields list. An absent field was withheld by the user or never enabled; absence must never be read as "none".',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ev.getProfile(),
  },
  {
    name: 'get_workouts',
    description: 'Query the workouts cache with {activityType (a name like Running, or a raw HealthKit id like 37), start, end} filters and pagination ({limit} default 50 max 200, {cursor} from a previous nextCursor). Records are returned exactly as stored, including the newer optional keys (avgHeartRate, maxHeartRate, running dynamics, cycling power, intervals, hasRoute) when the app exported them; older caches simply lack those keys and nothing is fabricated. Also returns summary {count, byActivityType} over everything that matched.',
    inputSchema: {
      type: 'object',
      properties: {
        activityType: { type: 'string', description: 'Activity name (e.g. Running) or raw HealthKit activity id (e.g. 37).' },
        start: DATE, end: DATE,
        limit: { type: 'integer', description: 'Workouts per page (default 50, max 200).' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous call\'s nextCursor.' },
      },
    },
    _meta: BIG_RESULT_META,
    handler: (a) => store.getWorkouts(a),
  },
  {
    name: 'get_sleep_sessions',
    description: "Clustered sleep sessions from health-sessions.json with {start, end, day} filters. Sessions are attributed to the WAKING day, matching the daily cache's sleep_analysis, so the two surfaces never disagree; a split night appears as multiple sessions with the same day, returned as-is. Timestamps carry the local UTC offset at the time of the sample.",
    inputSchema: {
      type: 'object',
      properties: {
        start: { ...DATE, description: 'First waking day (inclusive), YYYY-MM-DD.' },
        end: { ...DATE, description: 'Last waking day (inclusive), YYYY-MM-DD.' },
        day: { ...DATE, description: 'A single waking day, YYYY-MM-DD.' },
      },
    },
    handler: (a) => ev.getSleepSessions(a),
  },
  {
    name: 'get_cycle_context',
    description: 'Cycle context derived from user-logged period starts (health-cycles.json): day-in-cycle and a coarse phase label (follicular from day 1 to the observed midpoint of that cycle, luteal for the remainder). Derived from logged periods only, never predictive, and no ovulation estimate is made. Optional {date} for a single day; default returns per-day context for the last cycle.',
    inputSchema: { type: 'object', properties: { date: DATE } },
    handler: (a) => ev.getCycleContext(a),
  },
  {
    name: 'correlate_metrics',
    description: "Pearson correlation between two metrics' daily values: {metricA, metricB, lag (0 to 3, default 0), start, end}. lag pairs metricA on day d with metricB on day d+lag, so lag 1 compares against the FOLLOWING day. Returns alignedPairs, r (withheld below 10 aligned pairs), and both means. The answer always carries the association-not-causation caveat; treat every r as alignment in this file, not mechanism.",
    inputSchema: {
      type: 'object',
      properties: {
        metricA: { type: 'string' },
        metricB: { type: 'string' },
        lag: { type: 'integer', description: '0 to 3 days. lag 1 pairs metricA on day d with metricB on the following day.' },
        start: DATE, end: DATE,
      },
      required: ['metricA', 'metricB'],
    },
    handler: (a) => store.correlateMetrics(a),
  },
];
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC plumbing ---------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'Apple Health export bridge. Call get_mcp_status, then list_metrics, then the data tools (get_health_metrics, get_trends, compare_periods, get_structured_export, get_workouts, correlate_metrics). The context tools (list_events, get_profile, get_sleep_sessions, get_cycle_context) read optional files: absence is reported explicitly, never read as "no data". prompts/list serves ready-made analysis prompts.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no response

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema, _meta }) => ({
          name, description, inputSchema,
          annotations: ANNOTATIONS,
          ...(_meta && { _meta }),
        })),
      });

    // Prompts are authored in prompts.mjs as a plain, JSON-serializable array (the iOS app vendors
    // the same file). Arguments substitute {{name}} placeholders; a missing optional argument
    // becomes an instruction to pick sensibly rather than a dangling template hole.
    case 'prompts/list':
      return result(id, {
        prompts: PROMPTS.map(({ name, description, arguments: args }) =>
          args && args.length ? { name, description, arguments: args } : { name, description }),
      });

    case 'prompts/get': {
      const p = PROMPTS.find((x) => x.name === params?.name);
      if (!p) return error(id, -32602, `unknown prompt: ${params?.name}`);
      const args = params?.arguments || {};
      const text = p.text.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        args[k] != null && String(args[k]).length ? String(args[k]) : `(${k} not specified: pick sensibly from the data)`);
      return result(id, {
        description: p.description,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      });
    }

    case 'tools/call': {
      const tool = TOOL_MAP[params?.name];
      if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
      try {
        let out = await tool.handler(params.arguments || {});
        // Demo watermark on EVERY answer, in both copies: `demo: true` leads the structured object
        // and the text copy is prefixed. Either copy alone, screenshotted or pasted, still says
        // synthetic. The flag is injected here rather than in each store function so no future
        // tool can forget it.
        if (DEMO) out = { demo: true, ...out };
        // Compact, not pretty-printed. The spec asks a tool returning structuredContent to ALSO
        // return the serialized JSON as text for older clients, so the payload is unavoidably sent
        // twice — pretty-printing made each copy ~2x larger again for nothing.
        let text = JSON.stringify(out);
        if (DEMO) text = '[SYNTHETIC DEMO DATA] ' + text;
        // Universal budget gate. Claude Code caps tool responses at 25,000 tokens
        // (MAX_MCP_OUTPUT_TOKENS) and warns above 10,000; other hosts have their own limits. The
        // per-tool `granularity`/`limit` handling should keep results well under this, so crossing
        // it means the caller asked for something genuinely huge. Say so, with the arguments that
        // would fix it — never truncate JSON mid-structure, which yields unparseable output and an
        // agent that cannot tell a cut-off answer from a complete one.
        // Gate the WIRE size, not one copy of it. The comment above records that the payload goes
        // out twice — once as content[0].text and once as structuredContent — and the gate then
        // measured a single copy, so a 99k result sailed through a 100k budget and delivered ~198k
        // to a host that had been told 100k was the limit.
        const wireChars = text.length * 2;
        if (wireChars > BUDGET_CHARS) {
          const advice = {
            ...(DEMO && { demo: true }),
            error: 'result_too_large',
            tool: tool.name,
            chars: wireChars,
            budgetChars: BUDGET_CHARS,
            approxTokens: Math.round(wireChars / 4),
            fix: 'Narrow the request: name a single metric, pass start/end, set granularity to "month" or "year", lower limit, or page with cursor.',
          };
          log(`result too large for ${tool.name}: ${wireChars} chars on the wire (${text.length} x2)`);
          return result(id, {
            content: [{ type: 'text', text: JSON.stringify(advice) }],
            structuredContent: advice,
            isError: true,
          });
        }
        return result(id, {
          content: [{ type: 'text', text }],
          structuredContent: out,
          isError: false,
        });
      } catch (e) {
        log('tool error', tool.name, String(e?.message || e));
        return result(id, {
          content: [{ type: 'text', text: (DEMO ? '[SYNTHETIC DEMO DATA] ' : '') + `Error: ${e?.message || e}` }],
          isError: true,
        });
      }
    }

    default:
      if (!isNotification) error(id, -32601, `method not found: ${method}`);
  }
}

// ---- CLI (runs INSTEAD of the protocol loop; stdout is safe to print to) ----

// The complete file family one export can produce. Doctor and the freshness gate look at all of
// them, because "the cache is fresh but events are three weeks stale" is a real state worth seeing.
const DATA_FILES = [
  '.health-cache.json',
  '.health-workouts-cache.json',
  'health-intraday.json',
  'health-events.json',
  'health-profile.json',
  'health-sessions.json',
  'health-cycles.json',
  'health-days.json',
];

function statFile(name) {
  try {
    const st = fs.statSync(store.dataPath(name));
    return st.isFile() ? st : null;
  } catch { return null; }
}

const fmtBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

function printHelp() {
  console.log(`health-export-mcp ${SERVER.version}
Zero-dependency MCP server for Apple Health data exported by the MetricBridge iOS app.

Usage:
  node server.mjs                     run the MCP server on stdio (the default)
  node server.mjs --demo              serve a deterministic SYNTHETIC dataset; every answer is watermarked
  node server.mjs --doctor            print a diagnostics report and exit 0
  node server.mjs status --max-age N  exit 0 if the newest data write is within N hours, else 1 (cron gate)
  node server.mjs receive             run the LAN receiver standalone (no MCP; binds 127.0.0.1 by default)
  node server.mjs --help              this text

Environment:
  HEALTH_DATA_DIR            folder holding .health-cache.json (default: current directory)
  PAIRING_SECRET             pairing code from the iOS app, when Agent pairing is on
  HEALTH_DEMO=1              same as --demo
  HEALTH_LISTEN=1            also accept LAN pushes inside the MCP process (see receiver.mjs)
  HEALTH_LISTEN_HOST/PORT    receiver bind address (default 127.0.0.1:27184) and port
  HEALTH_LISTEN_TOKEN        receiver auth token, MANDATORY on a non-loopback bind
  HEALTH_MAX_RESULT_CHARS    per-answer wire budget (default 100000)`);
}

async function doctor() {
  const dir = store.dataPath('');
  console.log(`health-export-mcp doctor (${SERVER.version})`);
  console.log(`  node:            ${process.version}`);
  console.log(`  data dir:        ${dir}${fs.existsSync(dir) ? '' : '   (DOES NOT EXIST)'}`);
  if (DEMO) console.log('  mode:            SYNTHETIC DEMO DATA (--demo / HEALTH_DEMO=1); the report below still describes the real directory');
  const p = store.pairing();
  console.log(`  pairing:         ${!p.required ? 'not required (no .health-pair.json)' : p.ok ? 'required, unlocked' : 'required, LOCKED: set PAIRING_SECRET to the code in the iOS app'}`);
  console.log('  files:');
  let newest = null;
  for (const name of DATA_FILES) {
    const st = statFile(name);
    if (!st) { console.log(`    ${name.padEnd(30)} absent`); continue; }
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: st.mtimeMs };
    console.log(`    ${name.padEnd(30)} ${fmtBytes(st.size).padStart(9)}   ${new Date(st.mtimeMs).toISOString()}`);
  }
  const raw = statFile('.health-cache.json') ? store.readJSONCached(store.dataPath('.health-cache.json'), null) : null;
  const meta = raw?._meta;
  console.log(`  cache schema:    ${meta?.schema ?? (raw ? '1 (no _meta: pre-1.2 app)' : 'no cache file')}${meta?.app ? ` (app ${meta.app})` : ''}`);
  try {
    const metrics = p.ok ? await store.listMetrics() : null;
    if (metrics) {
      let last = null;
      for (const m of metrics) if (m.lastDate && (!last || m.lastDate > last)) last = m.lastDate;
      console.log(`  metrics:         ${metrics.length}`);
      console.log(`  last data date:  ${last ?? 'none'}`);
    } else {
      console.log('  metrics:         unavailable while locked');
    }
  } catch (e) {
    console.log(`  metrics:         ERROR: ${e.message}`);
  }
  console.log(`  freshness:       ${newest ? `${((Date.now() - newest.mtimeMs) / 3600000).toFixed(1)} hours since the newest write (${newest.name})` : 'no data files present'}`);
}

// Freshness gate for cron: let a scheduled agent skip its run (and its tokens) when the phone has
// not delivered anything new. Exit code is the contract; the single line is for the log.
function statusCommand(argv) {
  const i = argv.indexOf('--max-age');
  const hours = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (!Number.isFinite(hours) || hours <= 0) {
    console.log('usage: node server.mjs status --max-age <hours>');
    process.exit(2);
  }
  let newest = null;
  for (const name of DATA_FILES) {
    const st = statFile(name);
    if (st && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { name, mtimeMs: st.mtimeMs };
  }
  if (!newest) {
    console.log(`stale: no data files found in ${store.dataPath('')}`);
    process.exit(1);
  }
  const age = (Date.now() - newest.mtimeMs) / 3600000;
  if (age <= hours) {
    console.log(`fresh: newest write ${age.toFixed(1)}h ago (${newest.name}), within --max-age ${hours}h`);
    process.exit(0);
  }
  console.log(`stale: newest write ${age.toFixed(1)}h ago (${newest.name}) exceeds --max-age ${hours}h`);
  process.exit(1);
}

// ---- stdio loop (newline-delimited JSON) ---------------------------------

function serveStdio() {
  // Optional LAN push: when HEALTH_LISTEN=1, also accept HTTP/WebSocket pushes from the iOS app
  // (the "WebSocket" path) in THIS same process — no separate daemon. Logs only to stderr so the
  // stdio MCP stream stays clean. Token = HEALTH_LISTEN_TOKEN (the iOS pairing code).
  if (process.env.HEALTH_LISTEN === '1') {
    import('./receiver.mjs').then((r) => r.startReceiver()).catch((e) => log('receiver failed:', e.message));
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('bad JSON line'); continue; }
      Promise.resolve(handle(msg)).catch((e) => log('handler crash', String(e)));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`ready: ${TOOLS.length} tools, ${PROMPTS.length} prompts, source: ${store.sourceLabel()}`);
}

// Importable on purpose (tests read TOOLS/SERVER; a future embedder reads handle): the protocol
// loop and the CLI run only when this file IS the entry point, mirroring receiver.mjs.
// `npx pkg` and `npm i -g pkg` BOTH invoke the bin through a SYMLINK, so process.argv[1] is the
// link (…/node_modules/.bin/health-export-mcp) while import.meta.url is the real file. Comparing
// the two directly made this false under npx: the protocol loop never started, the process exited
// 0 with no stdout and no stderr, and an MCP client saw only "connection closed" ~700 ms in.
// Reported 2026-08-19 by a user whose client failed four times in a row, working only when he
// bypassed the shim with a direct `node …/server.mjs`. Resolve BOTH sides to real paths.
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;          // argv[1] deleted mid-flight, or an unreadable path: not the entry point
  }
})();
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  } else if (argv.includes('--doctor')) {
    await doctor();
    process.exit(0);
  } else if (argv[0] === 'status') {
    statusCommand(argv);
  } else if (argv[0] === 'receive') {
    // Standalone receiver: no MCP stdio, just the LAN listener. receiver.mjs binds 127.0.0.1
    // unless HEALTH_LISTEN_HOST says otherwise, and refuses a non-loopback bind without a token.
    const r = await import('./receiver.mjs');
    if (!r.startReceiver()) process.exit(1);
  } else {
    serveStdio();
  }
}

export { TOOLS, SERVER, ANNOTATIONS, handle };

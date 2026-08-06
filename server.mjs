#!/usr/bin/env node
// Health Export AI — MCP server (zero-dependency, stdio JSON-RPC 2.0).
//
// Exposes your exported Apple Health data to any MCP-compatible agent
// (Claude Desktop, OpenClaw, Hermes, Cursor, …). Local-first by default.
//
//   HEALTH_DATA_DIR=/path/to/icloud/folder node server.mjs      # reads .health-cache.json
//
// Protocol: MCP over stdio — newline-delimited JSON-RPC 2.0. stdout is reserved
// for protocol messages; all logging goes to stderr.

import * as store from './healthstore.mjs';

const SERVER = { name: 'health-export-ai', version: '1.0.0' };
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

// Optional LAN push: when HEALTH_LISTEN=1, also accept HTTP/WebSocket pushes from the iOS app
// (the "WebSocket" path) in THIS same process — no separate daemon. Logs only to stderr so the
// stdio MCP stream stays clean. Token = HEALTH_LISTEN_TOKEN (the iOS pairing code).
if (process.env.HEALTH_LISTEN === '1') {
  import('./receiver.mjs').then((r) => r.startReceiver()).catch((e) => log('receiver failed:', e.message));
}

// ---- tool definitions ----------------------------------------------------
const DATE = { type: 'string', description: 'YYYY-MM-DD' };
const GRANULARITY = {
  type: 'string', enum: ['auto', 'day', 'week', 'month', 'quarter', 'year'],
  description: "Roll daily values up before returning them. 'auto' (default) picks the finest granularity that fits the response budget, so a multi-year range returns monthly points instead of thousands of daily ones.",
};
const LIMIT = { type: 'integer', description: 'Maximum data points to return (default 365, max 3000). The server rolls up rather than truncating.' };
// Data-heavy tools declare a larger persist-to-disk threshold so a legitimately big answer is
// written to a file and referenced, instead of being cut off mid-JSON.
const BIG_RESULT_META = { 'anthropic/maxResultSizeChars': 400000 };
const TOOLS = [
  {
    name: 'get_mcp_status',
    description: 'Health check: data source, how many metrics/workouts are available, and the most recent data date. Call this first to confirm the bridge is connected.',
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
    description: "Get values for a metric (or all metrics) over an optional date range, with an aggregate (avg/sum/min/max/latest). The core data-retrieval tool. Every result carries a `coverage` block giving the metric's real firstDate/lastDate/days — check it before trusting a long window, and note that `aggregate` is always computed over the full range even when `points` are rolled up.",
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name, e.g. step_count, heart_rate, sleep_analysis. Omit for all.' },
        start: DATE, end: DATE,
        aggregation: { type: 'string', enum: ['avg', 'sum', 'min', 'max', 'latest'] },
        granularity: GRANULARITY, limit: LIMIT,
      },
    },
    _meta: BIG_RESULT_META,
    handler: (a) => store.getHealthMetrics(a),
  },
  {
    name: 'get_trends',
    description: 'Compare the most recent N-day window against the prior N days for a metric — returns change, percent change and direction (up/down/flat). Also returns `daysAvailable` and `windowSatisfied`: if windowSatisfied is false the file does not hold enough history for the window you asked for, and the comparison is over less data than requested.',
    inputSchema: {
      type: 'object',
      properties: { metric: { type: 'string' }, window: { type: 'integer', description: 'days per window (default 7)' } },
      required: ['metric'],
    },
    handler: (a) => store.getTrends(a),
  },
  {
    name: 'compare_periods',
    description: 'Compare a metric between two arbitrary date periods (A vs B) — returns each aggregate plus the change and percent change.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        periodA: { type: 'object', properties: { start: DATE, end: DATE } },
        periodB: { type: 'object', properties: { start: DATE, end: DATE } },
      },
      required: ['metric', 'periodA', 'periodB'],
    },
    handler: (a) => store.comparePeriods(a),
  },
  {
    name: 'get_structured_export',
    description: "Return clean structured JSON for the chosen metrics/date range. Paginated: the result carries `nextCursor` when more metrics remain — pass it back as `cursor` for the next page. Prefer naming the metrics you need and a date range; calling it bare over a full history is a lot of data.",
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
    name: 'query_health_data',
    description: 'Natural-language convenience: pass a question and get routed structured results. Prefer the specific tools above when you can — and call list_metrics first to see how much history exists, since this tool answers over whatever the file holds.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    handler: (a) => store.queryHealthData(a),
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
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'Apple Health export bridge. Call get_mcp_status, then list_metrics, then get_health_metrics / get_trends / compare_periods / get_structured_export.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no response

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema, _meta }) =>
          _meta ? { name, description, inputSchema, _meta } : { name, description, inputSchema }),
      });

    case 'tools/call': {
      const tool = TOOL_MAP[params?.name];
      if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.handler(params.arguments || {});
        // Compact, not pretty-printed. The spec asks a tool returning structuredContent to ALSO
        // return the serialized JSON as text for older clients, so the payload is unavoidably sent
        // twice — pretty-printing made each copy ~2x larger again for nothing.
        let text = JSON.stringify(out);
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
        return result(id, { content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });
      }
    }

    default:
      if (!isNotification) error(id, -32601, `method not found: ${method}`);
  }
}

// ---- stdio loop (newline-delimited JSON) ---------------------------------
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
log(`ready — ${TOOLS.length} tools — source: ${store.sourceLabel()}`);

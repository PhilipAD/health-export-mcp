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

// Optional LAN push: when HEALTH_LISTEN=1, also accept HTTP/WebSocket pushes from the iOS app
// (the "WebSocket" path) in THIS same process — no separate daemon. Logs only to stderr so the
// stdio MCP stream stays clean. Token = HEALTH_LISTEN_TOKEN (the iOS pairing code).
if (process.env.HEALTH_LISTEN === '1') {
  import('./receiver.mjs').then((r) => r.startReceiver()).catch((e) => log('receiver failed:', e.message));
}

// ---- tool definitions ----------------------------------------------------
const DATE = { type: 'string', description: 'YYYY-MM-DD' };
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
    description: 'Get daily values for a metric (or all metrics) over an optional date range, with an aggregate (avg/sum/min/max/latest). The core data-retrieval tool.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name, e.g. step_count, heart_rate, sleep_analysis. Omit for all.' },
        start: DATE, end: DATE,
        aggregation: { type: 'string', enum: ['avg', 'sum', 'min', 'max', 'latest'] },
      },
    },
    handler: (a) => store.getHealthMetrics(a),
  },
  {
    name: 'get_trends',
    description: 'Compare the most recent N-day window against the prior N days for a metric — returns change, percent change and direction (up/down/flat).',
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
    description: 'Return clean structured JSON for the chosen metrics/date range — ideal to drop straight into an agent\'s context window.',
    inputSchema: {
      type: 'object',
      properties: { metrics: { type: 'array', items: { type: 'string' } }, start: DATE, end: DATE },
    },
    handler: (a) => store.getStructuredExport(a),
  },
  {
    name: 'query_health_data',
    description: 'Natural-language convenience: pass a question (e.g. "average HRV last month") and get routed structured results. Prefer the specific tools above when you can.',
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
      return result(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });

    case 'tools/call': {
      const tool = TOOL_MAP[params?.name];
      if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.handler(params.arguments || {});
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
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

// Scenario mock server for simulating every connection-test outcome end-to-end.
// Dev/test tool only (not shipped, not part of the app or the MCP server). Each path returns a
// deterministic response so we can drive Sources/ConnectionTester.swift through the full matrix:
//
//   /ok            200  {ok:true}            → "✓ Server/Receiver accepted test"
//   /unprocessable 422  {error:...}          → "✓ Connected — token accepted" (reached+authed, body rejected)
//   /badrequest    400                        → "✓ Connected — token accepted"
//   /unauth        401                        → "✗ Unauthorized / Auth failed"
//   /forbidden     403                        → "✗ Forbidden / Auth failed"
//   /nope          404                        → "✗ Wrong path (404)"
//   /teapot        418                        → "✗ Client error (418)"
//   /toomany       429                        → "✗ Client error (429)"
//   /boom          500                        → "✗ Server/Receiver error (500)"
//   /unavailable   503                        → "✗ Server error (503)"
//   /slow          200 after 30s              → URLError.timedOut (8s) → "✗ Timed out"
//   /html          200 text/html (captive)    → still 2xx → "✓ accepted" (status-driven, not body)
//   /redirect      302 → /ok                  → URLSession follows → 200
//   /health-cache, /api/health/ingest mirror /unprocessable so path-specific tests work.
//
// Honors X-Health-Token / Authorization: send ?requireToken=SECRET to make it 401 without a match.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 27300);
const REQUIRE = process.env.MOCK_REQUIRE_TOKEN || '';   // if set, missing/wrong token → 401 everywhere

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj || { code })); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (REQUIRE) {
    const got = req.headers['x-health-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || u.searchParams.get('token');
    if (got !== REQUIRE) return send(res, 401, { ok: false, error: 'bad token' });
  }
  switch (p) {
    case '/ok': case '/health-cache': return send(res, 200, { ok: true, wrote: ['metrics:1'] });
    case '/unprocessable': case '/api/health/ingest': return send(res, 422, { ok: false, error: 'nothing_parsed' });
    case '/badrequest': return send(res, 400, { ok: false });
    case '/unauth': return send(res, 401, { ok: false });
    case '/forbidden': return send(res, 403, { ok: false });
    case '/nope': return send(res, 404, { ok: false });
    case '/teapot': return send(res, 418, { ok: false });
    case '/toomany': return send(res, 429, { ok: false });
    case '/boom': return send(res, 500, { ok: false });
    case '/unavailable': return send(res, 503, { ok: false });
    case '/slow': setTimeout(() => send(res, 200, { ok: true }), 30000); return;
    case '/html': res.statusCode = 200; res.setHeader('content-type', 'text/html'); res.end('<html>captive portal</html>'); return;
    case '/redirect': res.statusCode = 302; res.setHeader('location', '/ok'); res.end(); return;
    default: return send(res, 404, { ok: false, error: 'unknown path' });
  }
});
server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[mock] listening on 127.0.0.1:${PORT}${REQUIRE ? ' (token required)' : ''}\n`));

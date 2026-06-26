#!/usr/bin/env bash
# Pack the zero-dependency Health Export MCP server into a one-click .mcpb bundle.
# An .mcpb is just a ZIP with manifest.json at the root + the server files.
# Install: drag health-export.mcpb into Claude Desktop → Settings (or any MCPB-aware client).
set -euo pipefail
cd "$(dirname "$0")"
OUT="health-export.mcpb"
rm -f "$OUT"
# -j keeps the files at the archive root (manifest.json must be at root).
# receiver.mjs is bundled too so the .mcpb supports the local-network (LAN) path like the published copy.
zip -j "$OUT" manifest.json server.mjs healthstore.mjs receiver.mjs >/dev/null
echo "built $OUT ($(du -h "$OUT" | cut -f1)) — contents:"
unzip -l "$OUT" | awk 'NR>3 && $4 {print "  " $4}' | grep -v '^\s*$' | head
echo "install: drag $OUT into Claude Desktop → Settings → Extensions"

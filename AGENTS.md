# Using health-export-mcp with your AI client

Copy-paste setup for every supported agent. The server is a single Node script (`server.mjs`,
zero dependencies). Point `HEALTH_DATA_DIR` at the folder that holds your exported
`.health-cache.json` — by default the [Health Export AI](https://www.healthexport.dev) iOS app
writes it to your iCloud Drive container:

```
~/Library/Mobile Documents/iCloud~ai~healthexport~app/Documents
```

**Tip:** get the absolute path to `server.mjs` with `node -e "console.log(process.cwd()+'/server.mjs')"` (run inside the repo), or let `node apply-mcp-config.mjs` write the config for you.

After configuring, restart the client and ask: **"Use health-export: what's my HRV trend this week?"**

---

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "health-export": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/health-export-mcp/server.mjs"],
      "env": { "HEALTH_DATA_DIR": "~/Library/Mobile Documents/iCloud~ai~healthexport~app/Documents" }
    }
  }
}
```

Or drag `health-export.mcpb` into **Claude Desktop → Settings → Extensions** (no JSON).

## Cursor

`~/.cursor/mcp.json` (same `mcpServers` shape as above), or run `node gen-deeplinks.mjs` for a one-click install link.

## VS Code (Copilot / Continue)

Run `node gen-deeplinks.mjs` and open the generated VS Code link, or add the server under your MCP settings.

## opencode

`opencode.json` (project root) or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "health-export": {
      "type": "local",
      "command": ["node", "/ABSOLUTE/PATH/TO/health-export-mcp/server.mjs"],
      "enabled": true,
      "environment": { "HEALTH_DATA_DIR": "~/Library/Mobile Documents/iCloud~ai~healthexport~app/Documents" }
    }
  }
}
```

## OpenClaw

Add the `health-export` block (same shape as Claude Desktop's `mcpServers` entry) to your OpenClaw MCP servers config, then reload.

## Hermes

Add the `health-export` block to your Hermes agent's MCP servers config, then restart the daemon.

## Non-MCP clients — ChatGPT · Gemini · Grok · n8n · Home Assistant

These don't speak MCP, so they don't use this server. Instead, the [Health Export AI](https://www.healthexport.dev) app **POSTs your data to a webhook** (or your own endpoint) and your automation/agent reads that JSON. Every delivery is token-authenticated.

---

## Auto-configure

`node apply-mcp-config.mjs` detects installed clients and writes the config for you.

## Example prompts

- "What's my average resting heart rate over the last 7 days?"
- "Compare my deep sleep this week vs last week."
- "Is my VO₂ max trending up this quarter?"
- "Export HRV, RHR and sleep as JSON for the last 14 days."

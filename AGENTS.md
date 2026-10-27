# Using health-export-mcp with your AI client

Copy-paste setup for every supported agent. The server is a single Node script (`server.mjs`,
zero dependencies). Point `HEALTH_DATA_DIR` at the folder that holds your exported
`.health-cache.json` (on a Mac, since 1.7.3, the server finds the app's iCloud folder by itself when it's unset), by default the [MetricBridge](https://www.healthexport.dev) iOS app
([App Store](https://apps.apple.com/app/apple-store/id6784185201?pt=129083290&ct=githubreadme&mt=8&ppid=2c28f88a-d94f-48f9-8e6a-74a8d89ce66e)) writes it to your iCloud Drive container:

```
~/Library/Mobile Documents/iCloud~ai~healthexport~app/Documents
```

**Tip:** get the absolute path to `server.mjs` with `node -e "console.log(process.cwd()+'/server.mjs')"` (run inside the repo), or let `node apply-mcp-config.mjs` write the config for you.

After configuring, restart the client and ask: **"Use health-export: what's my HRV trend this week?"**

---

## Claude Code

One command, no clone, no environment variable on a Mac (1.7.3 finds the app's iCloud Drive folder itself):

```bash
claude mcp add health-export -- npx -y health-export-mcp
```

Windows, Linux, or an export outside iCloud Drive:

```bash
claude mcp add health-export --env "HEALTH_DATA_DIR=/path/to/folder" -- npx -y health-export-mcp
```

Keep the double quotes if the path has a space. Add `--scope user` to use it in every project. No export yet: `claude mcp add health-export-demo -- npx -y health-export-mcp --demo` serves synthetic data. If Agent pairing is on, do not pass `PAIRING_SECRET` on the command line (shell history, `ps`); add it to the entry's `env` in the config file.

## Claude Desktop

Easiest: download [`health-export.mcpb`](https://github.com/PhilipAD/health-export-mcp/releases/latest/download/health-export.mcpb) and open it, or drag it into **Claude Desktop → Settings → Extensions**. Desktop runs it with its own Node, so there's no JSON and nothing to put on your PATH.

Or edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "health-export": {
      "command": "npx",
      "args": ["-y", "health-export-mcp"]
    }
  }
}
```

On a Mac the server reads the app's iCloud Drive folder when `HEALTH_DATA_DIR` isn't set (1.7.3+). If Desktop logs `spawn npx ENOENT`, its PATH can't see Node (common with nvm or Homebrew): set `"command"` to the full path from `which npx`, or use the `.mcpb`. To pin a vetted local checkout instead, use `"command": "node", "args": ["/ABSOLUTE/PATH/TO/health-export-mcp/server.mjs"]`.

## Cursor

`~/.cursor/mcp.json` (same `mcpServers` shape as above), or run `node gen-deeplinks.mjs` for a one-click install link.

## VS Code (Copilot / Continue)

Run `node gen-deeplinks.mjs` and open the generated VS Code link, or add the server under your MCP settings.

## opencode

`opencode.json` (project root) or `~/.config/opencode/opencode.json`. Drop the `environment` line on a Mac using iCloud Drive; for a pinned checkout use `["node", "/ABSOLUTE/PATH/TO/server.mjs"]`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "health-export": {
      "type": "local",
      "command": ["npx", "-y", "health-export-mcp"],
      "enabled": true,
      "environment": { "HEALTH_DATA_DIR": "/path/to/folder" }
    }
  }
}
```

## OpenClaw

Add the `health-export` block (same shape as Claude Desktop's `mcpServers` entry: command `npx`, args `["-y", "health-export-mcp"]`, plus `HEALTH_DATA_DIR` off a Mac) to your OpenClaw MCP servers config, then reload.

## Hermes

Add the same `health-export` block to your Hermes agent's MCP servers config, then restart the daemon.

## Non-MCP clients, ChatGPT · Gemini · Grok · n8n · Home Assistant

ChatGPT connects only to remote MCP servers (OpenAI's help centre: "Can I connect to a local MCP server? Not directly", checked 2026-10-27), and the others don't run local MCP servers either, so they don't use this one. Instead, the [MetricBridge](https://www.healthexport.dev) app **POSTs your data to a webhook** (or your own endpoint) and your automation/agent reads that JSON. Every delivery is token-authenticated.

---

## Auto-configure

`node apply-mcp-config.mjs` detects installed clients and writes the config for you.

## Example prompts

- "What's my average resting heart rate over the last 7 days?"
- "Compare my deep sleep this week vs last week."
- "Is my VO₂ max trending up this quarter?"
- "Export HRV, RHR and sleep as JSON for the last 14 days."

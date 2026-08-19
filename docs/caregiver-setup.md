# Caregiver setup: query a parent's Apple Health from your own AI

Apple Health Sharing is view-only on the recipient's phone. There is no export and no API for
shared-with-you data, so no AI tool can read it. This pattern is the lawful, consent-first way
around that limit: the app runs on the PARENT'S phone, the parent decides what leaves it, and
your agent reads the files from a folder you both can see.

The parent is the consent authority at every step. This is their data. The setup gives them a
visible, revocable switch, not a surveillance feed.

## What you need

- Parent: an iPhone with MetricBridge installed, and their Apple Health data on it.
- You: a computer that can mount a folder the parent shares (iCloud Drive shared folder works),
  plus any MCP client (Claude Desktop, Cursor, or the CLI).

## Setup, on the parent's phone (10 minutes together)

1. Install MetricBridge and connect Apple Health. The app is read-only: it can never write to
   or change their health data.
2. Open Settings, then "What leaves this phone". Walk through it together. Sensitive categories
   are off by default and stay off unless the parent turns them on.
3. Pick a destination the two of you share: a shared iCloud Drive folder is simplest. In the
   share sheet, the PARENT creates the shared folder and invites you.
4. Turn on the daily automation. Done: the folder now receives the cache files every day.

## Setup, on your computer

Point the MCP server at the mounted shared folder:

```json
{
  "mcpServers": {
    "parent-health": {
      "command": "npx",
      "args": ["health-export-mcp"],
      "env": { "HEALTH_DATA_DIR": "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/SharedHealthFolder" }
    }
  }
}
```

Two parents? Run two servers with two folder paths and name them `mum-health` and `dad-health`.

## Reading the data honestly

Before any conclusion, check coverage. A phone left on the nightstand looks like inactivity.
The tools report recorded-day counts and freshness on every answer: a gap in the data is a gap
in the data, never evidence of decline. Ask "how many days this month have step data" before
asking "are the steps declining".

Useful signals that live in the export: step counts, walking speed and steadiness (Apple
reports a plain OK, Low, or Very Low classification: quote it verbatim, never re-score it),
times fallen, heart rate, sleep. The daily brief prompt in the prompt library is written for
exactly this reading.

## Revoking

The parent can stop sharing the folder, turn off the automation, or delete the exports from
Settings at any time. All three work immediately, and nothing you have on your side updates
again.

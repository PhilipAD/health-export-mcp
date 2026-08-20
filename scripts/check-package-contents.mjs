#!/usr/bin/env node
/**
 * Fail if `npm publish` would ship anything that is not the server.
 *
 * WHY THIS EXISTS. 1.2.0 shipped internal growth/distribution records
 * (docs/placement-records-*.md, docs/registry-state.md) and internal research tooling
 * (scripts/exa_search.py, grok_query.py, perplexity_query.py) to the public registry, plus an
 * untracked local working file. None of it was in git — the GitHub repo was clean — but npm packs
 * the WORKING DIRECTORY, and packing was governed by `.npmignore`, a blocklist. A blocklist cannot
 * exclude a file nobody knew would exist, and this repo shares a working directory with agents that
 * drop local notes into docs/ and scripts/.
 *
 * package.json now carries a positive `files` allowlist, and this checks the allowlist is actually
 * doing its job — because the same reasoning applies to it: someone will add an entry one day.
 * Verifying the OUTPUT is the only check that cannot be reasoned around.
 *
 *   node scripts/check-package-contents.mjs
 */
import { execFileSync } from "node:child_process";

// Everything the published package is allowed to contain. npm always adds package.json, README
// and LICENSE regardless of the allowlist, so they are listed here too.
const ALLOWED = new Set([
  "package.json", "README.md", "LICENSE",
  "server.mjs", "healthstore.mjs", "receiver.mjs",
  "events.mjs", "prompts.mjs", "demo.mjs",
  "apply-mcp-config.mjs", "gen-deeplinks.mjs",
  "manifest.json", "server.json", "glama.json", ".mcp.json",
  "health-export.mcpb", "minisign.pub",
  "llms.txt", "AGENTS.md",
  "Dockerfile", ".dockerignore",
  "test/integration.mjs",
]);

// Shapes that must NEVER ship, checked independently of the allowlist so a careless addition to it
// still fails here. These are the categories the boundary policy is about, not a list of filenames.
const FORBIDDEN = [
  [/^docs\//, "internal documentation — growth, placement and registry records live here"],
  [/^scripts\/(?!check-package-contents)/, "internal tooling (Exa / Grok / Perplexity research scripts)"],
  [/^\.github\//, "CI configuration is not part of the published server"],
  [/\.py$/, "no Python belongs in this package"],
  [/placement|registry-state|seo|strategy|topics/i, "growth/SEO content must not leave the private repo"],
  [/\.env|secret|credential/i, "possible credential material"],
];

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const files = JSON.parse(out)[0].files.map((f) => f.path);

const problems = [];
for (const f of files) {
  for (const [re, why] of FORBIDDEN) {
    if (re.test(f)) problems.push(`  FORBIDDEN  ${f}\n             ${why}`);
  }
  if (!ALLOWED.has(f)) problems.push(`  NOT ALLOWED  ${f}\n               add it to package.json "files" AND to ALLOWED here, deliberately`);
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s) in the publish tarball (${files.length} files):\n`);
  console.error([...new Set(problems)].join("\n"));
  console.error("\nThis package is PUBLIC. Fix before publishing.\n");
  process.exit(1);
}

console.log(`✓ publish tarball clean — ${files.length} files, all on the allowlist`);

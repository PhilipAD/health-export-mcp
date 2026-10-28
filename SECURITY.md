# Security policy

`health-export-mcp` reads personal health data on your own machine. It never writes to Apple Health
or to any file the iOS app writes; its one write is `health-events-agent.json`, the events an agent
logs with `add_event` / `remove_event` (sealed like the rest of an encrypted export). It has zero
runtime dependencies and talks to no developer server. This file covers which versions get fixes,
how to report a vulnerability privately, and how to verify what you install.

## Supported versions

Security fixes are released as a new version on top of the latest release. Older versions are not
patched: upgrade to the latest.

| Version | Supported |
|---|---|
| Latest release on npm (`npm view health-export-mcp version`) | Yes |
| Anything older | No, upgrade |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Preferred: open a private report with GitHub Security Advisories:
   <https://github.com/PhilipAD/health-export-mcp/security/advisories/new>
   (the repository's **Security** tab, then **Report a vulnerability**).
2. Or email **security@healthexport.dev**.

Include the version (`npx -y health-export-mcp --doctor` prints it), your Node version and OS, what
you observed, and steps to reproduce. Use synthetic data in the report (`--demo` serves a synthetic
dataset): never send real health data, pairing codes or export passphrases.

In scope: the server and receiver code in this repository, the published npm package, the `.mcpb`
bundle and the release workflows. The MetricBridge iOS app is not part of this repository: report app
issues to the same email address.

## Verifying what you install

### npm: registry signatures and provenance

npm signs every published version, and versions published by this repository's release workflow
also carry a provenance attestation that links the tarball to the exact commit and workflow run
that built it. Verify both from a project that has the package installed:

```bash
mkdir verify-hx && cd verify-hx && npm init -y >/dev/null
npm install health-export-mcp
npm audit signatures
```

`npm audit signatures` reports how many packages have verified registry signatures and how many
have verified attestations, and fails if one does not verify. The provenance statement is also shown
on the package's npmjs.com page.

Provenance starts with the first version published by `.github/workflows/release.yml`. Version
1.6.0 and earlier were published by hand: they have npm registry signatures and no provenance
attestation.

### GitHub release assets: minisign and SHA-256

A release carries the npm tarball, the `health-export.mcpb` bundle, a `SHA256SUMS` file that lists
both, and `SHA256SUMS.minisig`, a [minisign](https://jedisct1.github.io/minisign/) signature over
`SHA256SUMS`. Signed checksums start with v1.6.0. The public key is `minisign.pub` in this
repository (key ID `951BA54856154FBA`):

```
RWS6TxVWSKUblYkx7Db6ZpmvHALwHpznZpjaED/FlZj+PpxSlel0MxHZ
```

Take the key from this repository, not from the release page you are verifying.

```bash
TAG=v1.6.0
BASE="https://github.com/PhilipAD/health-export-mcp/releases/download/$TAG"
curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.minisig"
curl -fsSLO "$BASE/health-export.mcpb"
minisign -Vm SHA256SUMS -P 'RWS6TxVWSKUblYkx7Db6ZpmvHALwHpznZpjaED/FlZj+PpxSlel0MxHZ' \
  || { echo "signature INVALID, do not install"; exit 1; }
shasum -a 256 --ignore-missing -c SHA256SUMS \
  || { echo "checksum mismatch, do not install"; exit 1; }
```

On Linux use `sha256sum --ignore-missing -c SHA256SUMS`. With a clone of this repository you can
pass `-p minisign.pub` in place of `-P '...'`.

The server files hosted at `healthexport.dev/mcp/` are signed with the same key. The README section
"Verifying releases" has the commands for that path.

### MCP Registry entry

`server.json` declares the `.mcpb` as a GitHub release asset together with its SHA-256
(`fileSha256`). A test fails if that hash is not the hash of the committed bundle, and the registry
workflow refuses to publish if the release asset does not match it.

### SBOM

The release workflow generates a CycloneDX SBOM with `npm sbom --sbom-format cyclonedx` and attaches
it to the GitHub release as `health-export-mcp-<version>.cdx.json`. The package has zero
dependencies, so the SBOM lists a single component. SBOMs start with the first release made after
the workflow was added.

## How releases are made

- **npm publish** runs in GitHub Actions (`.github/workflows/release.yml`) through npm trusted
  publishing: a short-lived GitHub OIDC credential, with provenance. No npm token is stored in this
  repository. `package.json` sets `publishConfig.provenance`, so a publish from a laptop fails
  unless provenance is switched off on purpose (`npm publish --provenance=false`), which produces a
  version without an attestation.
- **Fallback only:** if trusted publishing is ever unavailable and a token has to be used, it must
  be a granular access token with publish access to this one package, an expiry of 90 days or less,
  rotated before it expires and revoked as soon as the publish is done. Classic and non-expiring
  tokens are not used.
- **minisign signing is a manual step.** The signing key is not stored in GitHub and no workflow
  can sign. Before publishing a GitHub release the maintainer runs, on their own machine:

  ```bash
  npm pack                                   # health-export-mcp-<version>.tgz
  shasum -a 256 health-export-mcp-*.tgz health-export.mcpb > SHA256SUMS
  minisign -Sm SHA256SUMS -t "health-export-mcp v<version> release assets"
  gh release create v<version> health-export-mcp-*.tgz health-export.mcpb SHA256SUMS SHA256SUMS.minisig
  ```

  `health-export.mcpb` must be the file committed at the tag, not a rebuild: zip output is not
  byte-reproducible and `server.json` pins its hash.
- **GitHub Actions** used by the workflows are pinned to full commit SHAs and kept current by
  Dependabot (`.github/dependabot.yml`).
- **MCP Registry** publishing uses GitHub OIDC (`.github/workflows/registry.yml`), also with no
  stored secret.

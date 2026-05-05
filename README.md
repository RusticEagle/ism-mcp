# ism-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that serves
the **Australian Cyber Security Centre (ACSC) Information Security Manual (ISM)**
to MCP-capable LLM clients (Claude Desktop, VS Code, Cursor, Continue, etc.).

Data is sourced live from the official ASD/ACSC OSCAL mirror:

> <https://github.com/AustralianCyberSecurityCentre/ism-oscal>

Each git tag in that repository is one published ISM release. The server
discovers tags dynamically via the GitHub API, so:

- **All historical versions** back to `v2022.09.14` are available.
- **The current version** is whichever tag is newest.
- **Future versions** automatically appear the moment ASD publishes a new tag —
  no code changes or redeploys required.

Catalog and profile JSON is cached on disk (default
`~/.cache/ism-mcp/`, override with `ISM_MCP_CACHE_DIR`). Tag listings are
refreshed every six hours (override with `ISM_MCP_TAGS_TTL_MS`).

## Capabilities

### Tools

| Tool                   | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `list_versions`        | Enumerate every published ISM release (tag, id, SHA, date).                                       |
| `get_version_metadata` | OSCAL metadata + control/group counts for a version.                                              |
| `list_groups`          | Hierarchical chapter/guideline structure with control counts.                                     |
| `list_controls`        | Paginated list of controls, filterable by applicability / group / label prefix.                   |
| `search_controls`      | Full-text search across labels, titles, statements, and group paths.                              |
| `get_control`          | Full detail for a single control by OSCAL id or human label (e.g. `GOV-01`), as JSON or Markdown. |
| `get_controls`         | Full detail for multiple controls in one call, with unmatched identifiers and optional deduplication. |
| `compare_versions`     | Diff two ISM releases — added, removed, and modified controls.                                    |
| `list_profiles`        | List the eight OSCAL profiles (NC / OS / P / S / TS + E8 ML1/2/3).                                |
| `get_profile_controls` | Resolved set of controls for a given baseline or Essential Eight maturity level.                  |
| `cache_info`           | Inspect the local cache.                                                                          |

### Resources (templates)

- `ism://catalog/{version}` — full OSCAL catalog JSON (use `latest` or e.g. `2026.03.24`).
- `ism://catalog/{version}/control/{controlId}` — a single control rendered as Markdown.
- `ism://profile/{version}/{profile}` — OSCAL resolved-profile catalog for a baseline.

### Prompts

- `ism_compliance_check` — generate a structured compliance assessment of a system against a baseline.
- `ism_change_brief` — produce a change-management brief between two ISM releases.

## Install / build

```bash
npm install
npm run build
```

The compiled entrypoint is `dist/index.js` and is exposed as the `ism-mcp` bin.

## Run

The server speaks MCP over stdio:

```bash
node dist/index.js
```

For interactive exploration, use the official inspector:

```bash
npm run inspect
```

## Wire it into a client

### VS Code (`.vscode/mcp.json` or settings)

```jsonc
{
  "servers": {
    "ism": {
      "command": "node",
      "args": ["/absolute/path/to/ism-mcp/dist/index.js"],
    },
  },
}
```

### Claude Desktop (`claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "ism": {
      "command": "node",
      "args": ["/absolute/path/to/ism-mcp/dist/index.js"],
    },
  },
}
```

### Optional environment

| Variable              | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `ISM_MCP_CACHE_DIR`   | Override on-disk cache directory.                |
| `ISM_MCP_TAGS_TTL_MS` | Tag-list cache TTL in milliseconds (default 6h). |

## Example prompts to try

- "What ISM versions are available?"
- "Show me GOV-01 from the latest ISM, in Markdown."
- "Search for ISM controls about multi-factor authentication that apply to PROTECTED."
- "Compare ISM 2025.12.9 with the latest release and summarise the changes."
- "List the controls in the Essential Eight ML2 baseline for the latest ISM."

## Data and licensing

The ISM is published by the Australian Signals Directorate. See the upstream
repository and <https://www.cyber.gov.au> for terms of use. This server is an
unaffiliated tool that consumes the publicly published OSCAL data.

## CI / CD

Three GitHub Actions workflows ship with the repo:

- **`.github/workflows/ci.yml`** — type-checks, builds, and runs the offline smoke test on every push and PR.
- **`.github/workflows/release.yml`** — dispatched by CI after a successful `main` build when a new version tag is created (or by manual dispatch), bundles the latest data, builds, packs the tarball, generates checksums, creates a GitHub Release with the tarball and `data/index.json` attached, updates a rolling `latest` git tag to the released commit, and (optionally) publishes to npm. If Cloudflare credentials are configured, it deploys a Cloudflare Worker that serves the site and exposes the MCP Streamable HTTP endpoint at `/mcp` (manual dispatch can disable this via `deploy_cloudflare=false`).
- **`.github/workflows/upstream-sync.yml`** — checks the upstream ACSC ISM OSCAL repository on a daily schedule (or manual dispatch). When a new ISM tag is published upstream, it rebundles `data/`, bumps the package patch version, commits the update to `main`, and lets CI trigger the tagged release and Cloudflare deployment.

### One-time repository setup

1. Settings → Actions → General → Workflow permissions: **Read and write**.
2. (Optional) configure repository credentials for npm publish on release.
3. Update the `repository`, `homepage`, and `bugs` fields in `package.json` (replace `OWNER`).
4. (Optional) configure Cloudflare account credentials in repository secrets to enable Workers deployment on release.

### Cutting a release

```bash
# bump version
npm version patch        # or minor / major
git push --follow-tags
```

Manual releases run CI first; when CI succeeds on `main`, it creates the version tag and dispatches `release.yml`, which builds an offline-ready `ism-mcp-<version>.tgz`, attaches it to the GitHub Release, and (optionally) publishes the package to npm and deploys the Cloudflare Worker endpoint.

Upstream ISM releases are also checked automatically once per day. If a new upstream tag is detected, the sync workflow rebundles the data, bumps the package version, pushes the update to `main`, and the existing CI and release workflows take over from there.

For remote AI clients, add the remote MCP server with this URL:

`https://ism.mcp.zta.au/mcp`

```jsonc
{
  "servers": {
    "ism": {
      "type": "http",
      "url": "https://ism.mcp.zta.au/mcp",
    },
  },
}
```

## Remote MCP / HTTP transport

Beyond stdio, ism-mcp also speaks **MCP Streamable HTTP** so it can be hosted as a remote endpoint that AI tools query over the network.

```bash
# run as an HTTP server on :8080
MCP_TRANSPORT=http PORT=8080 node dist/index.js
# or via flag
node dist/index.js --http
```

Endpoints:

- `POST /mcp` — JSON-RPC over Streamable HTTP (per-session via `Mcp-Session-Id` header).
- `GET /health` — liveness probe.
- `GET /` — plain-text usage hint.
- `GET /.well-known/oauth-protected-resource/mcp` — protected resource metadata for MCP OAuth discovery.
- `GET /.well-known/oauth-authorization-server` — authorization server metadata.
- `POST /register` — dynamic client registration.
- `POST /token` — token issuance for registered clients using `client_credentials`.

The hosted Cloudflare deployment supports dynamic client registration and `client_credentials` token exchange in addition to unauthenticated MCP access.

For durable client registrations and issued tokens across Worker restarts, bind a Cloudflare KV namespace as `AUTH_KV`. If `AUTH_KV` is not configured, the Worker falls back to in-memory auth state.

Environment variables:

| Variable        | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `MCP_TRANSPORT` | `stdio` (default for CLI) or `http`. The Docker image sets this to `http`. |
| `PORT` / `HOST` | Bind address (defaults: `0.0.0.0:8080`).                                   |
| `MCP_HTTP_PATH` | URL path for the MCP endpoint (default `/mcp`).                            |

### Connect a client to the remote endpoint

Hosted endpoint: `https://ism.mcp.zta.au/mcp`

```jsonc
// VS Code .vscode/mcp.json
{
  "servers": {
    "ism": {
      "type": "http",
      "url": "https://ism.mcp.zta.au/mcp",
    },
  },
}
```

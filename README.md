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

| Tool | Purpose |
| --- | --- |
| `list_versions` | Enumerate every published ISM release (tag, id, SHA, date). |
| `get_version_metadata` | OSCAL metadata + control/group counts for a version. |
| `list_groups` | Hierarchical chapter/guideline structure with control counts. |
| `list_controls` | Paginated list of controls, filterable by applicability / group / label prefix. |
| `search_controls` | Full-text search across labels, titles, statements, and group paths. |
| `get_control` | Full detail for a single control by OSCAL id or human label (e.g. `GOV-01`), as JSON or Markdown. |
| `compare_versions` | Diff two ISM releases — added, removed, and modified controls. |
| `list_profiles` | List the eight OSCAL profiles (NC / OS / P / S / TS + E8 ML1/2/3). |
| `get_profile_controls` | Resolved set of controls for a given baseline or Essential Eight maturity level. |
| `cache_info` | Inspect the local cache. |

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
      "args": ["/absolute/path/to/ism-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "ism": {
      "command": "node",
      "args": ["/absolute/path/to/ism-mcp/dist/index.js"]
    }
  }
}
```

### Optional environment

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | Authenticated GitHub API calls (higher rate limits). |
| `ISM_MCP_CACHE_DIR` | Override on-disk cache directory. |
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
- **`.github/workflows/pages.yml`** — on every push to `main` (and weekly on a schedule), refreshes the bundled OSCAL data, builds the static landing site (`scripts/build-site.mjs`), and deploys it to GitHub Pages. The site exposes the `.tgz` package as a direct download.
- **`.github/workflows/release.yml`** — on a `v*.*.*` tag push (or manual dispatch), bundles the latest data, builds, packs the tarball, generates checksums, creates a GitHub Release with the tarball and `data/index.json` attached, and (if `NPM_TOKEN` is configured as a secret) publishes to npm with provenance. If Cloudflare credentials are configured, it then rebuilds the static site and deploys it to Cloudflare Workers.

### One-time repository setup

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Actions → General → Workflow permissions: **Read and write**.
3. (Optional) add an `NPM_TOKEN` secret to publish to npm on release.
4. Update the `repository`, `homepage`, and `bugs` fields in `package.json` (replace `OWNER`).
5. (Optional) add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets to enable Cloudflare Workers deployment on release.

### Cutting a release

```bash
# bump version
npm version patch        # or minor / major
git push --follow-tags
```

This triggers `release.yml`, which builds an offline-ready `ism-mcp-<version>.tgz`, attaches it to the GitHub Release, and (optionally) publishes the package to npm and deploys the static site to Cloudflare Workers.

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

Environment variables:

| Variable | Purpose |
| --- | --- |
| `MCP_TRANSPORT` | `stdio` (default for CLI) or `http`. The Docker image sets this to `http`. |
| `PORT` / `HOST` | Bind address (defaults: `0.0.0.0:8080`). `WEBSITES_PORT` is also honoured for Azure App Service. |
| `MCP_HTTP_PATH` | URL path for the MCP endpoint (default `/mcp`). |
| `MCP_AUTH_TOKEN` | If set, requests must include `Authorization: Bearer <token>`. Strongly recommended for any public deployment. |

### Connect a client to the remote endpoint

```jsonc
// VS Code .vscode/mcp.json
{
  "servers": {
    "ism": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Deploy to Azure Container Apps

The `.github/workflows/azure-deploy.yml` workflow builds the container image, pushes it to GHCR, and deploys it to **Azure Container Apps** on every `v*.*.*` tag push (and on manual dispatch).

It scales to zero, exposes HTTPS ingress automatically, and runs the server in HTTP mode with bearer-token auth.

### One-time Azure setup

1. Create (or reuse) an Azure subscription and an app registration with **federated credentials** for GitHub OIDC. Quickest path:
   ```bash
   az ad sp create-for-rbac --name ism-mcp-deployer --role contributor \
     --scopes /subscriptions/<SUB_ID> \
     --json-auth
   az ad app federated-credential create --id <APP_ID> --parameters '{
     "name": "github-main",
     "issuer": "https://token.actions.githubusercontent.com",
     "subject": "repo:<OWNER>/<REPO>:ref:refs/heads/main",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   az ad app federated-credential create --id <APP_ID> --parameters '{
     "name": "github-tags",
     "issuer": "https://token.actions.githubusercontent.com",
     "subject": "repo:<OWNER>/<REPO>:ref:refs/tags/*",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```
2. Add **repository secrets**:
   - `AZURE_CLIENT_ID` — the app registration's client ID.
   - `AZURE_TENANT_ID` — your Entra tenant ID.
   - `AZURE_SUBSCRIPTION_ID` — target subscription.
   - `MCP_AUTH_TOKEN` *(optional)* — pre-set the bearer token. If omitted on the first deploy, one is generated and persisted in the Container App's env vars.
   - `GHCR_PULL_PAT` *(optional)* — only needed if your GHCR package is private; a classic PAT with `read:packages`.
3. Add **repository variables** to override defaults (all optional):
   - `AZURE_RESOURCE_GROUP` (default `ism-mcp-rg`)
   - `AZURE_LOCATION` (default `australiaeast`)
   - `AZURE_CONTAINERAPPS_ENV` (default `ism-mcp-env`)
   - `AZURE_CONTAINER_APP_NAME` (default `ism-mcp`)
4. Create a GitHub **Environment** named `azure-prod` (Settings → Environments) if you want approval gates / branch protection on production deploys.

### Deploy

```bash
# automatic on tag
npm version patch && git push --follow-tags

# or on demand
gh workflow run azure-deploy.yml -f image_tag=latest
```

After deployment, the workflow summary prints the public FQDN, e.g. `https://ism-mcp.kindforest-1234abcd.australiaeast.azurecontainerapps.io/mcp`. Plug that URL plus the bearer token into any MCP-aware client.

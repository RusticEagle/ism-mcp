import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import {
  controlToMarkdown,
  diffControls,
  flattenCatalog,
  searchControls,
  summarizeGroups,
} from "../dist/store.js";
import { APPLICABILITY_LABELS, PROFILE_NAMES } from "../dist/types.js";

const VERSION = "0.7.0";
const GH_OWNER = "AustralianCyberSecurityCentre";
const GH_REPO = "ism-oscal";
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;
const TAGS_TTL_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_FETCH_TIMEOUT_MS = 12000;
const MCP_REQUEST_TIMEOUT_MS = 25000;
const MAX_CATALOG_CACHE = 24;
const MAX_PROFILE_CACHE = 24;
const MAX_TAG_PAGES = 10;
const MAX_REGISTERED_CLIENTS = 200;
const MAX_ISSUED_TOKENS = 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTH_CLIENT_PREFIX = "auth:client:";
const AUTH_TOKEN_PREFIX = "auth:token:";

const PROFILE_SCHEMA = z.enum(PROFILE_NAMES);
const APPLICABILITY_SCHEMA = z.enum(["NC", "OS", "P", "S", "TS"]);

const tagCache = {
  fetchedAt: 0,
  versions: [],
};
const catalogCache = new Map();
const profileCache = new Map();
const registeredClients = new Map();
const issuedTokens = new Map();

function getAuthKv(env) {
  const kv = env?.AUTH_KV;
  return kv && typeof kv.get === "function" && typeof kv.put === "function"
    ? kv
    : undefined;
}

async function kvGetJson(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

function setMapWithLimit(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  const wrapped = Promise.resolve(promise);
  let timeoutId;
  let didTimeout = false;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    clearTimeout(timeoutId);
    if (didTimeout) {
      // Avoid unhandled rejections if the original promise fails after timeout.
      wrapped.catch(() => undefined);
    }
  }
}

async function timedFetch(
  url,
  options = {},
  timeoutMs = UPSTREAM_FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function txt(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function asErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

async function storeRegisteredClient(env, client) {
  setMapWithLimit(
    registeredClients,
    client.client_id,
    client,
    MAX_REGISTERED_CLIENTS,
  );

  const kv = getAuthKv(env);
  if (kv) {
    await kv.put(
      `${AUTH_CLIENT_PREFIX}${client.client_id}`,
      JSON.stringify(client),
    );
  }
}

async function loadRegisteredClient(env, clientId) {
  const cached = registeredClients.get(clientId);
  if (cached) return cached;

  const kv = getAuthKv(env);
  if (!kv) return undefined;

  const stored = await kvGetJson(kv, `${AUTH_CLIENT_PREFIX}${clientId}`);
  if (!stored) return undefined;

  const client = OAuthClientInformationFullSchema.parse(stored);
  setMapWithLimit(registeredClients, client.client_id, client, MAX_REGISTERED_CLIENTS);
  return client;
}

async function storeIssuedToken(env, accessToken, tokenInfo) {
  setMapWithLimit(issuedTokens, accessToken, tokenInfo, MAX_ISSUED_TOKENS);

  const kv = getAuthKv(env);
  if (kv) {
    const ttlSeconds = Math.max(
      60,
      Math.ceil((tokenInfo.expiresAt - Date.now()) / 1000),
    );
    await kv.put(`${AUTH_TOKEN_PREFIX}${accessToken}`, JSON.stringify(tokenInfo), {
      expirationTtl: ttlSeconds,
    });
  }
}

async function loadIssuedToken(env, accessToken) {
  const cached = issuedTokens.get(accessToken);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      issuedTokens.delete(accessToken);
    } else {
      return cached;
    }
  }

  const kv = getAuthKv(env);
  if (!kv) return undefined;

  const stored = await kvGetJson(kv, `${AUTH_TOKEN_PREFIX}${accessToken}`);
  if (!stored) return undefined;
  if (stored.expiresAt <= Date.now()) {
    await kv.delete(`${AUTH_TOKEN_PREFIX}${accessToken}`);
    return undefined;
  }

  setMapWithLimit(issuedTokens, accessToken, stored, MAX_ISSUED_TOKENS);
  return stored;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function makeClientSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildOAuthMetadata(request) {
  const origin = new URL(request.url).origin;
  return OAuthMetadataSchema.parse({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    service_documentation: `${origin}/`,
  });
}

function buildProtectedResourceMetadata(request) {
  const url = new URL(request.url);
  return OAuthProtectedResourceMetadataSchema.parse({
    resource: `${url.origin}/mcp`,
    authorization_servers: [url.origin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "ism-mcp",
    resource_documentation: `${url.origin}/`,
  });
}

async function readJsonRequest(request, label = "JSON body") {
  const clone = request.clone();
  return withTimeout(clone.json(), 5000, label);
}

async function readFormRequest(request, label = "form body") {
  const clone = request.clone();
  const text = await withTimeout(clone.text(), 5000, label);
  return new URLSearchParams(text);
}

function parseBearerToken(request) {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function verifyBearerToken(request, env) {
  const token = parseBearerToken(request);
  if (!token) return { ok: true, token: undefined };

  const info = await loadIssuedToken(env, token);
  if (!info || info.expiresAt <= Date.now()) {
    issuedTokens.delete(token);
    return { ok: false, error: "Invalid or expired bearer token" };
  }

  return { ok: true, token: info };
}

async function handleRegisterRequest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      { error: "invalid_request", error_description: "Use POST for dynamic client registration." },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  const metadata = OAuthClientMetadataSchema.parse(
    await readJsonRequest(request, "client registration body"),
  );
  const now = Math.floor(Date.now() / 1000);
  const client = OAuthClientInformationFullSchema.parse({
    ...metadata,
    token_endpoint_auth_method:
      metadata.token_endpoint_auth_method ?? "client_secret_post",
    grant_types: metadata.grant_types ?? ["client_credentials"],
    response_types: metadata.response_types ?? ["code"],
    client_id: crypto.randomUUID(),
    client_secret: makeClientSecret(),
    client_id_issued_at: now,
    client_secret_expires_at: 0,
  });

  await storeRegisteredClient(env, client);

  return jsonResponse(client, 201);
}

async function handleTokenRequest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      { error: "invalid_request", error_description: "Use POST for token requests." },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  const params = await readFormRequest(request, "token request body");
  const grantType = params.get("grant_type");
  if (grantType !== "client_credentials") {
    return jsonResponse(
      {
        error: "unsupported_grant_type",
        error_description: "This server supports only client_credentials tokens.",
      },
      400,
    );
  }

  const clientId = params.get("client_id") || "";
  const clientSecret = params.get("client_secret") || "";
  const client = await loadRegisteredClient(env, clientId);
  if (!client || client.client_secret !== clientSecret) {
    return jsonResponse(
      { error: "invalid_client", error_description: "Client authentication failed." },
      401,
    );
  }

  const scope = params.get("scope") || client.scope || "mcp";
  const token = OAuthTokensSchema.parse({
    access_token: crypto.randomUUID(),
    token_type: "bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope,
  });

  await storeIssuedToken(env, token.access_token, {
    clientId,
    scope,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });

  return jsonResponse(token, 200);
}

function handleAuthorizeRequest() {
  return jsonResponse(
    {
      error: "unsupported_response_type",
      error_description:
        "This MCP deployment supports dynamic client registration and client_credentials tokens only.",
    },
    400,
  );
}

function compactControl(c) {
  return {
    id: c.id,
    label: c.label,
    title: c.title,
    section: c.groupPath.join(" › "),
    applicability: c.applicability,
  };
}

function parseDateFromTag(tag) {
  const m = tag.match(/^v(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function compareVersionsDesc(a, b) {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  return b.tag.localeCompare(a.tag);
}

async function listVersions() {
  const now = Date.now();
  if (tagCache.versions.length > 0 && now - tagCache.fetchedAt < TAGS_TTL_MS) {
    return tagCache.versions;
  }

  const versions = [];
  let page = 1;
  while (true) {
    if (page > MAX_TAG_PAGES) {
      throw new Error(
        `Exceeded max tag pages (${MAX_TAG_PAGES}) while listing upstream tags`,
      );
    }

    const res = await timedFetch(`${GH_API}/tags?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ism-mcp-cloudflare-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} listing tags`);
    }

    const tags = await res.json();
    if (tags.length === 0) break;

    for (const t of tags) {
      versions.push({
        tag: t.name,
        id: t.name.replace(/^v/, ""),
        sha: t.commit?.sha ?? "",
        date: parseDateFromTag(t.name),
      });
    }

    if (tags.length < 100) break;
    page += 1;
  }

  versions.sort(compareVersionsDesc);
  tagCache.fetchedAt = now;
  tagCache.versions = versions;
  return versions;
}

async function resolveVersion(input) {
  const versions = await listVersions();
  if (versions.length === 0) {
    throw new Error("No ISM versions are available from upstream.");
  }

  if (!input || input === "latest") return versions[0];

  const wantTag = input.startsWith("v") ? input : `v${input}`;
  const found = versions.find((v) => v.tag === wantTag || v.id === input);
  if (!found) {
    throw new Error(`Unknown ISM version \"${input}\".`);
  }
  return found;
}

async function fetchJson(url) {
  const res = await timedFetch(url, {
    headers: { "User-Agent": "ism-mcp-cloudflare-worker" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  return res.json();
}

async function getCatalogDoc(tag) {
  const key = `catalog:${tag}`;
  if (catalogCache.has(key)) return catalogCache.get(key);

  const doc = await fetchJson(`${GH_RAW}/${tag}/ISM_catalog.json`);
  setMapWithLimit(catalogCache, key, doc, MAX_CATALOG_CACHE);
  return doc;
}

async function getFlat(tag) {
  const key = `flat:${tag}`;
  if (catalogCache.has(key)) return catalogCache.get(key);

  const doc = await getCatalogDoc(tag);
  const flat = flattenCatalog(doc.catalog);
  setMapWithLimit(catalogCache, key, flat, MAX_CATALOG_CACHE);
  return flat;
}

async function getResolvedProfile(tag, profile) {
  const key = `${tag}:${profile}`;
  if (profileCache.has(key)) return profileCache.get(key);

  const file = `${profile}-baseline-resolved-profile_catalog.json`;
  const doc = await fetchJson(`${GH_RAW}/${tag}/${file}`);
  setMapWithLimit(profileCache, key, doc, MAX_PROFILE_CACHE);
  return doc;
}

function createServer(env) {
  const server = new McpServer(
    { name: "ism-mcp", version: VERSION },
    {
      instructions:
        "Serves the Australian Cyber Security Centre (ACSC) Information Security Manual (ISM). " +
        "Use list_versions to discover releases, get_control/search_controls to inspect controls, and compare_versions to see what changed.",
    },
  );

  const registerTool = (name, meta, handler) => {
    server.registerTool(name, meta, async (args) => {
      try {
        return await handler(args);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool error (${name}): ${asErrorMessage(err)}`,
            },
          ],
        };
      }
    });
  };

  registerTool(
    "list_versions",
    {
      title: "List ISM versions",
      description:
        "Lists every published ISM release from the official upstream tags.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit }) => {
      const versions = await listVersions();
      const items = limit ? versions.slice(0, limit) : versions;
      return txt({
        latest: versions[0]?.id ?? null,
        count: versions.length,
        versions: items,
        source: `https://github.com/${GH_OWNER}/${GH_REPO}`,
      });
    },
  );

  registerTool(
    "get_version_metadata",
    {
      title: "Get ISM version metadata",
      description: "Returns OSCAL metadata and control counts for a version.",
      inputSchema: {
        version: z.string().optional(),
      },
    },
    async ({ version }) => {
      const v = await resolveVersion(version);
      const doc = await getCatalogDoc(v.tag);
      const flat = await getFlat(v.tag);

      return txt({
        version: v.id,
        tag: v.tag,
        sha: v.sha,
        releaseDate: v.date,
        metadata: doc.catalog?.metadata,
        counts: {
          controls: flat.length,
          groups: doc.catalog?.groups?.length ?? 0,
        },
        applicabilityLabels: APPLICABILITY_LABELS,
      });
    },
  );

  registerTool(
    "list_groups",
    {
      title: "List ISM groups",
      description:
        "Returns hierarchical ISM chapter/group structure with control counts.",
      inputSchema: {
        version: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ version, maxDepth }) => {
      const v = await resolveVersion(version);
      const doc = await getCatalogDoc(v.tag);
      const groups = summarizeGroups(doc.catalog);

      const trim = (g, depth) => ({
        title: g.title,
        path: g.path,
        controlCount: g.controlCount,
        subgroups:
          maxDepth && depth >= maxDepth
            ? undefined
            : g.subgroups.map((s) => trim(s, depth + 1)),
      });

      return txt({ version: v.id, groups: groups.map((g) => trim(g, 1)) });
    },
  );

  registerTool(
    "list_controls",
    {
      title: "List ISM controls",
      description: "Returns a paginated, filtered list of ISM controls.",
      inputSchema: {
        version: z.string().optional(),
        applicability: APPLICABILITY_SCHEMA.optional(),
        group: z.string().optional(),
        labelPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ version, applicability, group, labelPrefix, limit, offset }) => {
      const v = await resolveVersion(version);
      const flat = await getFlat(v.tag);
      const result = searchControls(flat, {
        applicability,
        group,
        labelPrefix,
        limit,
        offset,
      });

      return txt({
        version: v.id,
        total: result.total,
        returned: result.items.length,
        offset: offset ?? 0,
        items: result.items.map(compactControl),
      });
    },
  );

  registerTool(
    "search_controls",
    {
      title: "Search ISM controls",
      description: "Full-text search over ISM controls.",
      inputSchema: {
        query: z.string().min(1),
        version: z.string().optional(),
        applicability: APPLICABILITY_SCHEMA.optional(),
        group: z.string().optional(),
        labelPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        includeStatement: z.boolean().optional(),
      },
    },
    async (args) => {
      const v = await resolveVersion(args.version);
      const flat = await getFlat(v.tag);
      const result = searchControls(flat, {
        query: args.query,
        applicability: args.applicability,
        group: args.group,
        labelPrefix: args.labelPrefix,
        limit: args.limit,
        offset: args.offset,
      });

      const items = result.items.map((c) =>
        args.includeStatement
          ? { ...compactControl(c), statement: c.statement }
          : compactControl(c),
      );

      return txt({
        version: v.id,
        query: args.query,
        total: result.total,
        returned: items.length,
        offset: args.offset ?? 0,
        items,
      });
    },
  );

  registerTool(
    "get_control",
    {
      title: "Get a single ISM control",
      description: "Returns full detail for a single ISM control.",
      inputSchema: {
        controlId: z.string(),
        version: z.string().optional(),
        format: z.enum(["json", "markdown"]).optional(),
      },
    },
    async ({ controlId, version, format }) => {
      const v = await resolveVersion(version);
      const flat = await getFlat(v.tag);
      const needle = controlId.toLowerCase();
      const match =
        flat.find((c) => c.id.toLowerCase() === needle) ??
        flat.find((c) => c.label.toLowerCase() === needle) ??
        flat.find((c) => c.id.toLowerCase().endsWith(needle));

      if (!match) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No control matched \"${controlId}\" in ISM ${v.id}.`,
            },
          ],
        };
      }

      if (format === "markdown") {
        return txt(controlToMarkdown(match, v.id));
      }

      return txt({
        version: v.id,
        id: match.id,
        label: match.label,
        title: match.title,
        section: match.groupPath,
        applicability: match.applicability,
        statement: match.statement,
        raw: match.raw,
      });
    },
  );

  registerTool(
    "compare_versions",
    {
      title: "Compare two ISM versions",
      description:
        "Computes added, removed, and modified controls between versions.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        includeBodies: z.boolean().optional(),
      },
    },
    async ({ from, to, includeBodies }) => {
      const a = await resolveVersion(from);
      const b = await resolveVersion(to);
      const [aFlat, bFlat] = await Promise.all([
        getFlat(a.tag),
        getFlat(b.tag),
      ]);
      const diff = diffControls(aFlat, bFlat);

      return txt({
        from: a.id,
        to: b.id,
        summary: {
          added: diff.added.length,
          removed: diff.removed.length,
          modified: diff.modified.length,
          unchanged: diff.unchanged,
        },
        added: diff.added.map(compactControl),
        removed: diff.removed.map(compactControl),
        modified: diff.modified.map((m) => ({
          id: m.id,
          label: m.label,
          title: m.title,
          changes: m.changes,
          ...(includeBodies
            ? { before: m.before.statement, after: m.after.statement }
            : {}),
        })),
      });
    },
  );

  registerTool(
    "list_profiles",
    {
      title: "List ISM OSCAL profiles",
      description:
        "Lists classification baselines and Essential Eight maturity profiles.",
      inputSchema: {},
    },
    async () =>
      txt({
        profiles: PROFILE_NAMES.map((name) => ({
          name,
          kind: name.startsWith("ISM_E8")
            ? "essential-eight"
            : "classification",
        })),
      }),
  );

  registerTool(
    "get_profile_controls",
    {
      title: "Get controls for an ISM OSCAL profile",
      description: "Returns the resolved controls included in a given profile.",
      inputSchema: {
        profile: PROFILE_SCHEMA,
        version: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ profile, version, limit, offset }) => {
      const v = await resolveVersion(version);
      const doc = await getResolvedProfile(v.tag, profile);
      const flat = flattenCatalog(doc.catalog);
      const off = offset ?? 0;
      const lim = limit ?? 500;

      return txt({
        version: v.id,
        profile,
        total: flat.length,
        returned: Math.max(0, Math.min(lim, flat.length - off)),
        offset: off,
        items: flat.slice(off, off + lim).map(compactControl),
      });
    },
  );

  server.registerTool(
    "cache_info",
    {
      title: "Inspect worker caches",
      description:
        "Reports in-memory cache sizes used by the Cloudflare worker instance.",
      inputSchema: {},
    },
    async () =>
      txt({
        runtime: "cloudflare-worker",
        authStorage: getAuthKv(env) ? "kv" : "memory",
        memoryCached: {
          tags: tagCache.versions.length,
          catalogs: [...catalogCache.keys()].filter((k) =>
            k.startsWith("catalog:"),
          ).length,
          flat: [...catalogCache.keys()].filter((k) => k.startsWith("flat:"))
            .length,
          profiles: profileCache.size,
          registeredClients: registeredClients.size,
          issuedTokens: issuedTokens.size,
        },
        cacheTtlMs: TAGS_TTL_MS,
      }),
  );

  return server;
}

async function handleMcpRequest(request, env) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createServer(env);
  await server.connect(transport);
  return withTimeout(
    transport.handleRequest(request),
    MCP_REQUEST_TIMEOUT_MS,
    "MCP request",
  );
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin") || "*";

  headers.set("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, mcp-session-id, last-event-id, mcp-protocol-version, authorization",
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "mcp-session-id, mcp-protocol-version",
  );
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request);
      }

      if (url.pathname === "/health" || url.pathname === "/healthz") {
        return withCors(
          Response.json({
            status: "ok",
            transport: "web-standard-http",
            path: "/mcp",
          }),
          request,
        );
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return withCors(jsonResponse(buildOAuthMetadata(request)), request);
      }

      if (
        url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp/"
      ) {
        return withCors(
          jsonResponse(buildProtectedResourceMetadata(request)),
          request,
        );
      }

      if (url.pathname === "/register") {
        return withCors(await handleRegisterRequest(request, env), request);
      }

      if (url.pathname === "/token") {
        return withCors(await handleTokenRequest(request, env), request);
      }

      if (url.pathname === "/authorize") {
        return withCors(handleAuthorizeRequest(), request);
      }

      if (url.pathname === "/" && request.method === "GET") {
        const endpoint = `${url.origin}/mcp`;
        const body = [
          `ism-mcp v${VERSION}`,
          "",
          "This deployment exposes an MCP Streamable HTTP endpoint for AI clients.",
          `Endpoint: ${endpoint}`,
          "Health: /health",
          "",
          "Example client configuration:",
          "{",
          '  "servers": {',
          '    "ism": {',
          '      "type": "http",',
          `      "url": "${endpoint}"`,
          "    }",
          "  }",
          "}",
        ].join("\n");

        return withCors(
          new Response(body, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          }),
          request,
        );
      }

      const isMcpPath = url.pathname === "/mcp" || url.pathname === "/mcp/";
      if (isMcpPath) {
        const bearer = await verifyBearerToken(request, env);
        if (!bearer.ok) {
          return withCors(
            new Response(`MCP error: ${bearer.error}`, {
              status: 401,
              headers: {
                "WWW-Authenticate": 'Bearer realm="ism-mcp", error="invalid_token"',
              },
            }),
            request,
          );
        }

        if (!["GET", "POST", "DELETE"].includes(request.method)) {
          return withCors(
            new Response("Method not allowed", {
              status: 405,
              headers: { Allow: "GET, POST, DELETE, OPTIONS" },
            }),
            request,
          );
        }

        if (request.method === "GET") {
          const accept = request.headers.get("accept") || "";
          const hasSession = Boolean(request.headers.get("mcp-session-id"));
          const wantsSse = accept.toLowerCase().includes("text/event-stream");

          if (!hasSession && !wantsSse) {
            return withCors(
              new Response(
                "MCP endpoint. Use POST for JSON-RPC initialization at /mcp.",
                {
                  status: 405,
                  headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    Allow: "POST, GET, DELETE, OPTIONS",
                  },
                },
              ),
              request,
            );
          }
        }

        try {
          const response = await handleMcpRequest(request, env);
          return withCors(response, request);
        } catch (err) {
          return withCors(
            new Response(`MCP error: ${asErrorMessage(err)}`, {
              status: 500,
            }),
            request,
          );
        }
      }

      return withTimeout(env.ASSETS.fetch(request), 8000, "Asset fetch");
    } catch (err) {
      return withCors(
        new Response(`Worker error: ${asErrorMessage(err)}`, {
          status: 500,
        }),
        request,
      );
    }
  },
};

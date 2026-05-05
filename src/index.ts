#!/usr/bin/env node
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  getCatalog,
  getCacheInfo,
  getProfile,
  listVersions,
  resolveVersion,
} from "./sources.js";
import {
  controlToMarkdown,
  diffControls,
  flattenCatalog,
  searchControls,
  summarizeGroups,
  type FlatControl,
} from "./store.js";
import {
  APPLICABILITY_LABELS,
  PROFILE_NAMES,
  type Applicability,
  type OscalCatalogDoc,
  type ProfileName,
} from "./types.js";

const VERSION = "0.1.0";

// ---- in-memory LRU for parsed catalogs --------------------------------------
const CATALOG_CACHE = new Map<string, FlatControl[]>(); // tag -> flat controls
const CATALOG_DOC_CACHE = new Map<string, OscalCatalogDoc>(); // tag -> doc
const MAX_CATALOGS = 6;

async function loadCatalogDoc(tag: string): Promise<OscalCatalogDoc> {
  let doc = CATALOG_DOC_CACHE.get(tag);
  if (doc) return doc;
  doc = (await getCatalog(tag)) as OscalCatalogDoc;
  // basic LRU eviction
  if (CATALOG_DOC_CACHE.size >= MAX_CATALOGS) {
    const firstKey = CATALOG_DOC_CACHE.keys().next().value;
    if (firstKey) {
      CATALOG_DOC_CACHE.delete(firstKey);
      CATALOG_CACHE.delete(firstKey);
    }
  }
  CATALOG_DOC_CACHE.set(tag, doc);
  return doc;
}

async function loadFlat(tag: string): Promise<FlatControl[]> {
  const cached = CATALOG_CACHE.get(tag);
  if (cached) return cached;
  const doc = await loadCatalogDoc(tag);
  const flat = flattenCatalog(doc.catalog);
  CATALOG_CACHE.set(tag, flat);
  return flat;
}

// ---- helpers ----------------------------------------------------------------
function txt(value: unknown): { content: { type: "text"; text: string }[] } {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function compactControl(c: FlatControl) {
  return {
    id: c.id,
    label: c.label,
    title: c.title,
    section: c.groupPath.join(" › "),
    applicability: c.applicability,
  };
}

function findControlMatch(flat: FlatControl[], controlId: string): FlatControl | undefined {
  const needle = controlId.toLowerCase();
  return (
    flat.find((c) => c.id.toLowerCase() === needle) ??
    flat.find((c) => c.label.toLowerCase() === needle) ??
    flat.find((c) => c.id.toLowerCase().endsWith(needle))
  );
}

const ApplicabilitySchema = z
  .enum(["NC", "OS", "P", "S", "TS"])
  .describe(
    "Applicability marking: NC=Non-classified, OS=OFFICIAL: Sensitive, P=PROTECTED, S=SECRET, TS=TOP SECRET.",
  );
const ProfileSchema = z.enum(PROFILE_NAMES as [ProfileName, ...ProfileName[]]);

// ---- server -----------------------------------------------------------------
const server = new McpServer(
  { name: "ism-mcp", version: VERSION },
  {
    instructions:
      "Serves the Australian Cyber Security Centre (ACSC) Information Security Manual (ISM). " +
      "Data is sourced from the official AustralianCyberSecurityCentre/ism-oscal GitHub repository: " +
      "every git tag is a published ISM release, so historical, current, and future versions are all available. " +
      "Use list_versions to discover releases, get_control/search_controls to inspect controls, and compare_versions to see what changed between releases.",
  },
);

// ---- tools ------------------------------------------------------------------

server.registerTool(
  "list_versions",
  {
    title: "List ISM versions",
    description:
      "Lists every published ISM release (historical, current, and any future tags as soon as they appear upstream). Returns tag, version id, commit SHA, and release date parsed from the tag.",
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Force a refresh of the upstream tag list, bypassing the cache.",
        ),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ refresh, limit }) => {
    const versions = await listVersions({ force: refresh });
    const items = limit ? versions.slice(0, limit) : versions;
    return txt({
      latest: versions[0]?.id ?? null,
      count: versions.length,
      versions: items,
      source: "https://github.com/AustralianCyberSecurityCentre/ism-oscal",
    });
  },
);

server.registerTool(
  "get_version_metadata",
  {
    title: "Get ISM version metadata",
    description:
      'Returns OSCAL metadata (title, version, last-modified, oscal-version) for a given ISM release. Use "latest" or omit to get the most recent.',
    inputSchema: {
      version: z
        .string()
        .optional()
        .describe('e.g. "2026.03.24" or "latest". Default: latest.'),
    },
  },
  async ({ version }) => {
    const v = await resolveVersion(version);
    const doc = await loadCatalogDoc(v.tag);
    const flat = await loadFlat(v.tag);
    return txt({
      version: v.id,
      tag: v.tag,
      sha: v.sha,
      releaseDate: v.date,
      metadata: doc.catalog.metadata,
      counts: {
        controls: flat.length,
        groups: doc.catalog.groups?.length ?? 0,
      },
      applicabilityLabels: APPLICABILITY_LABELS,
    });
  },
);

server.registerTool(
  "list_groups",
  {
    title: "List ISM groups (chapters and guidelines)",
    description:
      "Returns the hierarchical group structure of the ISM catalog (chapters, guidelines, sections) with control counts at each level.",
    inputSchema: {
      version: z.string().optional(),
      maxDepth: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ version, maxDepth }) => {
    const v = await resolveVersion(version);
    const doc = await loadCatalogDoc(v.tag);
    const groups = summarizeGroups(doc.catalog);
    const trim = (
      g: ReturnType<typeof summarizeGroups>[number],
      depth: number,
    ): unknown => ({
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

server.registerTool(
  "list_controls",
  {
    title: "List ISM controls",
    description:
      'Returns a paginated, filtered list of ISM controls. Supports filters by applicability, group/section name (substring), and label prefix (e.g. "GOV", "AC", "PHYS").',
    inputSchema: {
      version: z.string().optional(),
      applicability: ApplicabilitySchema.optional(),
      group: z
        .string()
        .optional()
        .describe("Substring match against group/chapter titles."),
      labelPrefix: z
        .string()
        .optional()
        .describe(
          'Match controls whose label starts with this prefix, e.g. "GOV".',
        ),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
  },
  async ({ version, applicability, group, labelPrefix, limit, offset }) => {
    const v = await resolveVersion(version);
    const flat = await loadFlat(v.tag);
    const result = searchControls(flat, {
      applicability: applicability as Applicability | undefined,
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

server.registerTool(
  "search_controls",
  {
    title: "Search ISM controls",
    description:
      "Full-text search across ISM control labels, titles, statements, and group paths. Combine with applicability/group/labelPrefix filters.",
    inputSchema: {
      query: z.string().min(1),
      version: z.string().optional(),
      applicability: ApplicabilitySchema.optional(),
      group: z.string().optional(),
      labelPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      includeStatement: z
        .boolean()
        .optional()
        .describe("Include the control statement in each result."),
    },
  },
  async (args) => {
    const v = await resolveVersion(args.version);
    const flat = await loadFlat(v.tag);
    const result = searchControls(flat, {
      query: args.query,
      applicability: args.applicability as Applicability | undefined,
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

server.registerTool(
  "get_control",
  {
    title: "Get a single ISM control",
    description:
      "Returns the full detail (title, group path, applicability, statement) for a single ISM control. Accepts either the OSCAL id (e.g. ism-principle-gov-01) or the human label (e.g. GOV-01).",
    inputSchema: {
      controlId: z
        .string()
        .describe(
          'Either OSCAL id (e.g. "ism-principle-gov-01") or label (e.g. "GOV-01").',
        ),
      version: z.string().optional(),
      format: z.enum(["json", "markdown"]).optional(),
    },
  },
  async ({ controlId, version, format }) => {
    const v = await resolveVersion(version);
    const flat = await loadFlat(v.tag);
    const match = findControlMatch(flat, controlId);
    if (!match) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No control matched "${controlId}" in ISM ${v.id}.`,
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

server.registerTool(
  "get_controls",
  {
    title: "Get multiple ISM controls",
    description:
      "Returns full detail for multiple ISM controls in one call. Accepts OSCAL ids and/or human labels (e.g. GOV-01).",
    inputSchema: {
      controlIds: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .describe(
          'Control identifiers to resolve, each as OSCAL id (e.g. "ism-principle-gov-01") or label (e.g. "GOV-01").',
        ),
      version: z.string().optional(),
      format: z.enum(["json", "markdown"]).optional(),
      deduplicate: z
        .boolean()
        .optional()
        .describe(
          "If true, return each matched control once by control id. If false, preserve duplicates in requested order.",
        ),
    },
  },
  async ({ controlIds, version, format, deduplicate }) => {
    const v = await resolveVersion(version);
    const flat = await loadFlat(v.tag);
    const matches: FlatControl[] = [];
    const unmatched: string[] = [];
    const seen = new Set<string>();
    const dedupeEnabled = deduplicate ?? false;

    for (const controlId of controlIds) {
      const match = findControlMatch(flat, controlId);
      if (match) {
        if (dedupeEnabled && seen.has(match.id)) {
          continue;
        }
        if (dedupeEnabled) {
          seen.add(match.id);
        }
        matches.push(match);
      } else {
        unmatched.push(controlId);
      }
    }

    if (format === "markdown") {
      const blocks = matches.map((m) => controlToMarkdown(m, v.id));
      if (unmatched.length > 0) {
        blocks.push(
          [
            "## Unmatched",
            "",
            ...unmatched.map((id) => `- ${id}`),
            "",
          ].join("\n"),
        );
      }
      return txt(blocks.join("\n---\n\n"));
    }

    return txt({
      version: v.id,
      requested: controlIds.length,
      matched: matches.length,
      deduplicated: dedupeEnabled,
      unmatched,
      items: matches.map((match) => ({
        id: match.id,
        label: match.label,
        title: match.title,
        section: match.groupPath,
        applicability: match.applicability,
        statement: match.statement,
        raw: match.raw,
      })),
    });
  },
);

server.registerTool(
  "compare_versions",
  {
    title: "Compare two ISM versions",
    description:
      "Computes the diff between two ISM releases: controls added, removed, and modified (title, statement, or applicability changes). Useful for change-management and gap analysis.",
    inputSchema: {
      from: z.string().describe('Older version, e.g. "2025.12.9".'),
      to: z
        .string()
        .describe(
          'Newer version, e.g. "2026.03.24". Use "latest" for the current.',
        ),
      includeBodies: z
        .boolean()
        .optional()
        .describe(
          "Include before/after statements for modified controls (verbose).",
        ),
    },
  },
  async ({ from, to, includeBodies }) => {
    const a = await resolveVersion(from);
    const b = await resolveVersion(to);
    const [aFlat, bFlat] = await Promise.all([
      loadFlat(a.tag),
      loadFlat(b.tag),
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

server.registerTool(
  "list_profiles",
  {
    title: "List ISM OSCAL profiles",
    description:
      "Lists the OSCAL profiles published alongside each ISM release: the five classification baselines (NC, OS, P, S, TS) and the three Essential Eight maturity levels (ML1, ML2, ML3).",
    inputSchema: {},
  },
  async () => {
    return txt({
      profiles: PROFILE_NAMES.map((name) => ({
        name,
        kind: name.startsWith("ISM_E8") ? "essential-eight" : "classification",
      })),
    });
  },
);

server.registerTool(
  "get_profile_controls",
  {
    title: "Get controls for an ISM OSCAL profile",
    description:
      "Returns the resolved set of controls included in a given ISM OSCAL profile (classification baseline or Essential Eight maturity level) for a given version.",
    inputSchema: {
      profile: ProfileSchema,
      version: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional(),
      offset: z.number().int().min(0).optional(),
    },
  },
  async ({ profile, version, limit, offset }) => {
    const v = await resolveVersion(version);
    const doc = (await getProfile(v.tag, profile, true)) as OscalCatalogDoc;
    const flat = flattenCatalog(doc.catalog);
    const off = offset ?? 0;
    const lim = limit ?? 500;
    return txt({
      version: v.id,
      profile,
      total: flat.length,
      returned: Math.min(lim, flat.length - off),
      offset: off,
      items: flat.slice(off, off + lim).map(compactControl),
    });
  },
);

server.registerTool(
  "cache_info",
  {
    title: "Inspect ISM MCP storage",
    description:
      "Reports the bundled offline data directory, the writable user cache directory, sizes, file counts, and whether the server is running in offline mode (ISM_MCP_OFFLINE).",
    inputSchema: {},
  },
  async () => {
    const info = await getCacheInfo();
    return txt({
      ...info,
      memoryCached: {
        catalogs: CATALOG_DOC_CACHE.size,
        flat: CATALOG_CACHE.size,
      },
    });
  },
);

// ---- resources --------------------------------------------------------------

server.registerResource(
  "ism-catalog",
  new ResourceTemplate("ism://catalog/{version}", { list: undefined }),
  {
    title: "ISM OSCAL catalog",
    description:
      "Full OSCAL catalog JSON for a given ISM version (use 'latest' for the current).",
    mimeType: "application/json",
  },
  async (uri, { version }) => {
    const v = await resolveVersion(
      typeof version === "string" ? version : undefined,
    );
    const doc = await loadCatalogDoc(v.tag);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(doc, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "ism-control",
  new ResourceTemplate("ism://catalog/{version}/control/{controlId}", {
    list: undefined,
  }),
  {
    title: "ISM control (Markdown)",
    description: "A single ISM control rendered as Markdown.",
    mimeType: "text/markdown",
  },
  async (uri, { version, controlId }) => {
    const v = await resolveVersion(
      typeof version === "string" ? version : undefined,
    );
    const flat = await loadFlat(v.tag);
    const needle = String(controlId).toLowerCase();
    const match =
      flat.find((c) => c.id.toLowerCase() === needle) ??
      flat.find((c) => c.label.toLowerCase() === needle);
    if (!match) {
      throw new Error(`No control matched "${controlId}" in ISM ${v.id}`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: controlToMarkdown(match, v.id),
        },
      ],
    };
  },
);

server.registerResource(
  "ism-profile",
  new ResourceTemplate("ism://profile/{version}/{profile}", {
    list: undefined,
  }),
  {
    title: "ISM OSCAL resolved profile catalog",
    description:
      "OSCAL resolved-profile catalog for a classification baseline (ISM_NON_CLASSIFIED, ISM_OFFICIAL_SENSITIVE, ISM_PROTECTED, ISM_SECRET, ISM_TOP_SECRET) or Essential Eight maturity level (ISM_E8_ML1/2/3).",
    mimeType: "application/json",
  },
  async (uri, { version, profile }) => {
    const v = await resolveVersion(
      typeof version === "string" ? version : undefined,
    );
    const profileName = String(profile) as ProfileName;
    if (!PROFILE_NAMES.includes(profileName)) {
      throw new Error(
        `Unknown profile "${profile}". Valid: ${PROFILE_NAMES.join(", ")}`,
      );
    }
    const doc = await getProfile(v.tag, profileName, true);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(doc, null, 2),
        },
      ],
    };
  },
);

// ---- prompts ----------------------------------------------------------------

server.registerPrompt(
  "ism_compliance_check",
  {
    title: "ISM compliance check",
    description:
      "Generate a structured ISM compliance assessment for a system description against a chosen baseline.",
    argsSchema: {
      systemDescription: z
        .string()
        .describe("Free-text description of the system under assessment."),
      profile: ProfileSchema.describe(
        "Classification baseline or Essential Eight maturity profile.",
      ),
      version: z
        .string()
        .optional()
        .describe('ISM version (e.g. "2026.03.24"). Default: latest.'),
    },
  },
  ({ systemDescription, profile, version }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `You are a cyber security assessor producing an ISM compliance review using ` +
            `ACSC Information Security Manual ${version ?? "latest"} under the ${profile} baseline.\n\n` +
            `Use the ism-mcp tools to:\n` +
            `1. Call get_profile_controls(profile="${profile}"${version ? `, version="${version}"` : ""}) to retrieve the in-scope controls.\n` +
            `2. For each control, decide: Compliant / Partially compliant / Non-compliant / Not applicable.\n` +
            `3. Cite the control label (e.g. GOV-01) and a one-line statement summary.\n` +
            `4. Identify the highest-risk gaps and propose remediations.\n\n` +
            `System under assessment:\n${systemDescription}`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "ism_change_brief",
  {
    title: "ISM change brief",
    description:
      "Produce a change-management brief between two ISM releases, focused on impact and required actions.",
    argsSchema: {
      from: z.string().describe('Older ISM version, e.g. "2025.12.9".'),
      to: z
        .string()
        .describe('Newer ISM version, e.g. "2026.03.24" (or "latest").'),
      audience: z
        .string()
        .optional()
        .describe(
          'Target audience, e.g. "CISO", "GRC team", "engineering managers".',
        ),
    },
  },
  ({ from, to, audience }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Use ism-mcp's compare_versions tool with from="${from}" and to="${to}" ` +
            `to enumerate added, removed, and modified controls. Then write a concise change brief ` +
            `for ${audience ?? "a security leadership audience"} covering: \n` +
            ` - Headline summary (counts and themes).\n` +
            ` - Notable new controls and what triggered them.\n` +
            ` - Removed/retired controls and their rationale (if discernible).\n` +
            ` - Material wording or applicability changes that affect existing assessments.\n` +
            ` - Recommended actions and timelines.`,
        },
      },
    ],
  }),
);

// ---- main -------------------------------------------------------------------

function pickTransport(): "stdio" | "http" {
  const fromArg = process.argv.includes("--http")
    ? "http"
    : process.argv.includes("--stdio")
      ? "stdio"
      : null;
  if (fromArg) return fromArg;
  const env = (process.env.MCP_TRANSPORT ?? "").toLowerCase();
  if (env === "http" || env === "streamable-http" || env === "streamablehttp") return "http";
  if (env === "stdio") return "stdio";
  // Default: stdio for local CLI use, http when running inside a container.
  return process.env.PORT || process.env.WEBSITES_PORT ? "http" : "stdio";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const limit = 4 * 1024 * 1024; // 4 MB
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function startHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? process.env.WEBSITES_PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";

  // Per-session transports. Returning undefined session id from the generator
  // would put the transport in stateless mode; we use stateful sessions here
  // so multiple concurrent clients (e.g. ChatGPT + VS Code) don't collide.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.statusCode = 400;
        res.end(`Invalid JSON body: ${(err as Error).message}`);
        return;
      }
    }

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await server.connect(transport);
    }

    try {
      await transport.handleRequest(req, res, body);
    } catch (err) {
      process.stderr.write(`[ism-mcp] http error: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      }
    }
  };

  const httpServer = createHttpServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Health probe for Azure / k8s.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", transport: "http", path }));
      return;
    }

    // Tiny landing page so the root URL is helpful when humans visit it.
    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        `ism-mcp v${VERSION} — MCP Streamable HTTP endpoint at ${path}\n` +
          "POST JSON-RPC messages to that path. See https://modelcontextprotocol.io for the protocol.\n",
      );
      return;
    }

    if (url.pathname === path) {
      await handleMcp(req, res);
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[ism-mcp] listening on http://${host}:${port}${path}\n`,
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[ism-mcp] received ${signal}, shutting down\n`);
    httpServer.close();
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  // Warm up the version list (and surface auth/network errors early), but
  // don't fail startup — the tool can also report this on demand.
  try {
    await listVersions();
  } catch (err) {
    process.stderr.write(
      `[ism-mcp] warning: failed to fetch versions at startup: ${(err as Error).message}\n`,
    );
  }

  const mode = pickTransport();
  if (mode === "http") {
    await startHttp();
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[ism-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

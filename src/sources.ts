import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import type {
  OscalCatalogDoc,
  OscalProfileDoc,
  ProfileName,
} from "./types.js";

/**
 * Source of truth: the official ASD/ACSC ISM OSCAL mirror.
 *   https://github.com/AustralianCyberSecurityCentre/ism-oscal
 *
 * Each git tag (e.g. `v2026.03.24`) corresponds to a published ISM release.
 * Lookup order for catalogs and profiles:
 *   1. Bundled offline data shipped with the package (data/).
 *   2. User cache directory (writable, populated from network).
 *   3. Live GitHub fetch (unless ISM_MCP_OFFLINE is set).
 *
 * Tag discovery merges the bundled tag list with any newer tags pulled from
 * GitHub, so a deployed package keeps working forever offline AND continues
 * to discover newly published releases when the network is available.
 */

const GH_OWNER = "AustralianCyberSecurityCentre";
const GH_REPO = "ism-oscal";
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;

export interface IsmVersion {
  /** Tag name, e.g. "v2026.03.24" */
  tag: string;
  /** Semver-ish id without the leading "v", e.g. "2026.03.24" */
  id: string;
  /** Commit SHA the tag points at */
  sha: string;
  /** Publication date parsed from tag (YYYY-MM-DD), best-effort. */
  date: string | null;
  /** Whether this version's data is bundled with the package. */
  bundled?: boolean;
}

const OFFLINE = (() => {
  const v = (process.env.ISM_MCP_OFFLINE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
})();

const CACHE_DIR =
  process.env.ISM_MCP_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ism-mcp");

const TAGS_TTL_MS = Number(
  process.env.ISM_MCP_TAGS_TTL_MS ?? 6 * 60 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Bundled data location
// ---------------------------------------------------------------------------
// When compiled, this file lives at <pkg>/dist/sources.js, so the bundled
// data folder is at <pkg>/data/. Override with ISM_MCP_DATA_DIR.

function defaultBundledDir(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "data");
  } catch {
    return resolve(process.cwd(), "data");
  }
}

const BUNDLED_DIR = process.env.ISM_MCP_DATA_DIR ?? defaultBundledDir();

interface BundleIndex {
  generatedAt: string;
  source: string;
  versions: IsmVersion[];
}

let bundleIndexMemo: BundleIndex | null | undefined;

async function loadBundleIndex(): Promise<BundleIndex | null> {
  if (bundleIndexMemo !== undefined) return bundleIndexMemo;
  const indexPath = join(BUNDLED_DIR, "index.json");
  if (!existsSync(indexPath)) {
    bundleIndexMemo = null;
    return null;
  }
  try {
    const raw = await readFile(indexPath, "utf8");
    bundleIndexMemo = JSON.parse(raw) as BundleIndex;
    return bundleIndexMemo;
  } catch {
    bundleIndexMemo = null;
    return null;
  }
}

function bundlePathFor(tag: string, file: string): string {
  return join(BUNDLED_DIR, "versions", tag, `${file}.gz`);
}

async function readBundledFile(
  tag: string,
  file: string,
): Promise<string | null> {
  const p = bundlePathFor(tag, file);
  if (!existsSync(p)) return null;
  const buf = await readFile(p);
  return gunzipSync(buf).toString("utf8");
}

// ---------------------------------------------------------------------------
// Cache + HTTP helpers
// ---------------------------------------------------------------------------

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ism-mcp/0.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function parseDateFromTag(tag: string): string | null {
  const m = tag.match(/^v(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function compareVersionsDesc(a: IsmVersion, b: IsmVersion): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  return b.tag.localeCompare(a.tag);
}

// ---------------------------------------------------------------------------
// Tag discovery
// ---------------------------------------------------------------------------

interface CachedTags {
  fetchedAt: number;
  versions: IsmVersion[];
}

let tagsMemo: CachedTags | null = null;

export function isOffline(): boolean {
  return OFFLINE;
}

export async function listVersions(
  opts: { force?: boolean } = {},
): Promise<IsmVersion[]> {
  const now = Date.now();
  if (!opts.force && tagsMemo && now - tagsMemo.fetchedAt < TAGS_TTL_MS) {
    return tagsMemo.versions;
  }

  const bundled = await loadBundleIndex();
  const bundledVersions = (bundled?.versions ?? []).map((v) => ({
    ...v,
    bundled: true,
  }));

  if (OFFLINE) {
    if (bundledVersions.length === 0) {
      throw new Error(
        "ISM_MCP_OFFLINE is set but no bundled data was found. " +
          "Run `npm run bundle` (or use a release tarball that includes data/).",
      );
    }
    bundledVersions.sort(compareVersionsDesc);
    tagsMemo = { fetchedAt: now, versions: bundledVersions };
    return bundledVersions;
  }

  await ensureCacheDir();
  const cacheFile = join(CACHE_DIR, "tags.json");

  try {
    const networkVersions = await fetchAllTagsFromGitHub();
    const merged = mergeVersions(bundledVersions, networkVersions);
    tagsMemo = { fetchedAt: now, versions: merged };
    await writeFile(cacheFile, JSON.stringify(tagsMemo), "utf8");
    return merged;
  } catch (err) {
    if (bundledVersions.length > 0) {
      bundledVersions.sort(compareVersionsDesc);
      tagsMemo = { fetchedAt: now, versions: bundledVersions };
      return bundledVersions;
    }
    if (existsSync(cacheFile)) {
      const raw = await readFile(cacheFile, "utf8");
      const cached = JSON.parse(raw) as CachedTags;
      tagsMemo = cached;
      return cached.versions;
    }
    throw err;
  }
}

function mergeVersions(
  bundled: IsmVersion[],
  network: IsmVersion[],
): IsmVersion[] {
  const byTag = new Map<string, IsmVersion>();
  for (const v of bundled) byTag.set(v.tag, { ...v, bundled: true });
  for (const v of network) {
    const existing = byTag.get(v.tag);
    byTag.set(v.tag, { ...v, bundled: existing?.bundled ?? false });
  }
  const merged = [...byTag.values()];
  merged.sort(compareVersionsDesc);
  return merged;
}

async function fetchAllTagsFromGitHub(): Promise<IsmVersion[]> {
  const versions: IsmVersion[] = [];
  let page = 1;
  while (true) {
    const url = `${GH_API}/tags?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} listing tags: ${await res.text()}`,
      );
    }
    const tags = (await res.json()) as Array<{
      name: string;
      commit: { sha: string };
    }>;
    if (tags.length === 0) break;
    for (const t of tags) {
      versions.push({
        tag: t.name,
        id: t.name.replace(/^v/, ""),
        sha: t.commit.sha,
        date: parseDateFromTag(t.name),
      });
    }
    if (tags.length < 100) break;
    page += 1;
  }
  versions.sort(compareVersionsDesc);
  return versions;
}

/** Resolve a user-supplied version (or "latest"/undefined) to a concrete tag. */
export async function resolveVersion(
  input?: string | null,
): Promise<IsmVersion> {
  const versions = await listVersions();
  if (versions.length === 0) {
    throw new Error(
      "No ISM versions are available (no bundled data and network unreachable).",
    );
  }
  if (!input || input === "latest") return versions[0];
  const want = input.startsWith("v") ? input : `v${input}`;
  const found = versions.find((v) => v.tag === want || v.id === input);
  if (!found) {
    throw new Error(
      `Unknown ISM version "${input}". Use list_versions to see available releases.`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// File loading: bundled -> cache -> network
// ---------------------------------------------------------------------------

async function loadJsonForTag<T>(tag: string, file: string): Promise<T> {
  const bundledText = await readBundledFile(tag, file);
  if (bundledText) {
    return JSON.parse(bundledText) as T;
  }

  await ensureCacheDir();
  const safeTag = tag.replace(/[^A-Za-z0-9._-]/g, "_");
  const cacheFile = join(CACHE_DIR, `${safeTag}__${file}`);
  if (existsSync(cacheFile)) {
    try {
      const raw = await readFile(cacheFile, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      // fall through
    }
  }

  if (OFFLINE) {
    throw new Error(
      `Offline mode: ${file} for ${tag} is not bundled and not cached. ` +
        "Run `npm run bundle` to pre-fetch all releases.",
    );
  }
  const url = `${GH_RAW}/${tag}/${file}`;
  const res = await fetch(url, { headers: { "User-Agent": "ism-mcp/0.1" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  await writeFile(cacheFile, text, "utf8");
  return JSON.parse(text) as T;
}

export async function getCatalog(tag: string): Promise<OscalCatalogDoc> {
  return loadJsonForTag<OscalCatalogDoc>(tag, "ISM_catalog.json");
}

export async function getProfile(
  tag: string,
  profile: ProfileName,
  resolved: boolean,
): Promise<OscalCatalogDoc | OscalProfileDoc> {
  const file = resolved
    ? `${profile}-baseline-resolved-profile_catalog.json`
    : `${profile}-baseline_profile.json`;
  return loadJsonForTag<OscalCatalogDoc | OscalProfileDoc>(tag, file);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export async function getCacheInfo(): Promise<{
  cacheDir: string;
  cacheBytes: number;
  cacheEntries: number;
  bundleDir: string;
  bundleEntries: number;
  bundleBytes: number;
  bundleAvailable: boolean;
  bundledVersions: number;
  offline: boolean;
}> {
  await ensureCacheDir();
  const files = await readdir(CACHE_DIR);
  let cacheBytes = 0;
  for (const f of files) {
    const s = await stat(join(CACHE_DIR, f));
    cacheBytes += s.size;
  }

  let bundleEntries = 0;
  let bundleBytes = 0;
  let bundleAvailable = false;
  let bundledVersions = 0;
  if (existsSync(BUNDLED_DIR)) {
    bundleAvailable = true;
    const idx = await loadBundleIndex();
    bundledVersions = idx?.versions.length ?? 0;
    const versionsDir = join(BUNDLED_DIR, "versions");
    if (existsSync(versionsDir)) {
      const tags = await readdir(versionsDir);
      for (const t of tags) {
        const tagDir = join(versionsDir, t);
        const inner = await readdir(tagDir);
        for (const f of inner) {
          const s = await stat(join(tagDir, f));
          bundleEntries += 1;
          bundleBytes += s.size;
        }
      }
    }
  }

  return {
    cacheDir: CACHE_DIR,
    cacheBytes,
    cacheEntries: files.length,
    bundleDir: BUNDLED_DIR,
    bundleEntries,
    bundleBytes,
    bundleAvailable,
    bundledVersions,
    offline: OFFLINE,
  };
}

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OscalCatalogDoc, OscalProfileDoc, ProfileName } from "./types.js";

/**
 * Source of truth: the official ASD/ACSC ISM OSCAL mirror.
 *   https://github.com/AustralianCyberSecurityCentre/ism-oscal
 *
 * Each git tag (e.g. `v2026.03.24`) corresponds to a published ISM release.
 * By dynamically discovering tags via the GitHub API we automatically expose
 * every historical version, the current version, and any future versions
 * the moment ASD publishes them — no code changes required.
 *
 * The special version id `latest` is an alias for the most recent tag.
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
}

const CACHE_DIR =
  process.env.ISM_MCP_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ism-mcp");

const TAGS_TTL_MS = Number(
  process.env.ISM_MCP_TAGS_TTL_MS ?? 6 * 60 * 60 * 1000,
); // 6h

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
  // Tags look like "v2026.03.24" -> 2026-03-24. Day may be 1-2 digits.
  const m = tag.match(/^v(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function compareVersionsDesc(a: IsmVersion, b: IsmVersion): number {
  // Sort newest first, using the parsed date when available, else lexicographic on tag.
  if (a.date && b.date) return b.date.localeCompare(a.date);
  return b.tag.localeCompare(a.tag);
}

interface CachedTags {
  fetchedAt: number;
  versions: IsmVersion[];
}

let tagsMemo: CachedTags | null = null;

export async function listVersions(
  opts: { force?: boolean } = {},
): Promise<IsmVersion[]> {
  await ensureCacheDir();
  const now = Date.now();
  if (!opts.force && tagsMemo && now - tagsMemo.fetchedAt < TAGS_TTL_MS) {
    return tagsMemo.versions;
  }
  const cacheFile = join(CACHE_DIR, "tags.json");

  // Try network first; fall back to disk cache on failure.
  try {
    const versions = await fetchAllTagsFromGitHub();
    tagsMemo = { fetchedAt: now, versions };
    await writeFile(cacheFile, JSON.stringify(tagsMemo), "utf8");
    return versions;
  } catch (err) {
    if (existsSync(cacheFile)) {
      const raw = await readFile(cacheFile, "utf8");
      const cached = JSON.parse(raw) as CachedTags;
      tagsMemo = cached;
      return cached.versions;
    }
    throw err;
  }
}

async function fetchAllTagsFromGitHub(): Promise<IsmVersion[]> {
  const versions: IsmVersion[] = [];
  let page = 1;
  // GitHub returns tags in repo order (typically newest first); paginate to be safe.
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
      "No ISM versions discovered from the upstream OSCAL repository.",
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

interface FileFetchResult<T> {
  data: T;
  fromCache: boolean;
}

async function fetchJsonFromTag<T>(
  tag: string,
  file: string,
): Promise<FileFetchResult<T>> {
  await ensureCacheDir();
  const safeTag = tag.replace(/[^A-Za-z0-9._-]/g, "_");
  const cacheFile = join(CACHE_DIR, `${safeTag}__${file}`);

  if (existsSync(cacheFile)) {
    try {
      const raw = await readFile(cacheFile, "utf8");
      return { data: JSON.parse(raw) as T, fromCache: true };
    } catch {
      // fall through to refetch
    }
  }

  const url = `${GH_RAW}/${tag}/${file}`;
  const res = await fetch(url, { headers: { "User-Agent": "ism-mcp/0.1" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  await writeFile(cacheFile, text, "utf8");
  return { data: JSON.parse(text) as T, fromCache: false };
}

export async function getCatalog(tag: string): Promise<OscalCatalogDoc> {
  const { data } = await fetchJsonFromTag<OscalCatalogDoc>(
    tag,
    "ISM_catalog.json",
  );
  return data;
}

export async function getProfile(
  tag: string,
  profile: ProfileName,
  resolved: boolean,
): Promise<OscalCatalogDoc | OscalProfileDoc> {
  const file = resolved
    ? `${profile}-baseline-resolved-profile_catalog.json`
    : `${profile}-baseline_profile.json`;
  const { data } = await fetchJsonFromTag<OscalCatalogDoc | OscalProfileDoc>(
    tag,
    file,
  );
  return data;
}

export async function getCacheInfo(): Promise<{
  dir: string;
  sizeBytes: number;
  entries: number;
}> {
  await ensureCacheDir();
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(CACHE_DIR);
  let total = 0;
  for (const f of files) {
    const s = await stat(join(CACHE_DIR, f));
    total += s.size;
  }
  return { dir: CACHE_DIR, sizeBytes: total, entries: files.length };
}

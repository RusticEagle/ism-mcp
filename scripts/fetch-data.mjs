#!/usr/bin/env node
// Pre-fetches every published ISM OSCAL release from the official ASD/ACSC
// mirror and writes a gzipped, package-bundled copy to <repo>/data/.
//
// Run with `npm run bundle`. The resulting `data/` directory is included in
// the published npm package and in the release tarball, enabling fully
// offline use of the ism-mcp server.
//
// Env:
//   GITHUB_TOKEN / GH_TOKEN  Optional; raises GitHub API rate limits.
//   ISM_MCP_BUNDLE_PROFILES  "0" to skip OSCAL profiles (catalogs only).
//   ISM_MCP_BUNDLE_LIMIT     Limit number of (newest) releases to bundle.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");
const VERSIONS_DIR = join(DATA_DIR, "versions");

const GH_OWNER = "AustralianCyberSecurityCentre";
const GH_REPO = "ism-oscal";
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;

const PROFILE_NAMES = [
  "ISM_NON_CLASSIFIED",
  "ISM_OFFICIAL_SENSITIVE",
  "ISM_PROTECTED",
  "ISM_SECRET",
  "ISM_TOP_SECRET",
  "ISM_E8_ML1",
  "ISM_E8_ML2",
  "ISM_E8_ML3",
];

const INCLUDE_PROFILES = process.env.ISM_MCP_BUNDLE_PROFILES !== "0";
const RELEASE_LIMIT = process.env.ISM_MCP_BUNDLE_LIMIT
  ? Math.max(1, Number(process.env.ISM_MCP_BUNDLE_LIMIT))
  : Infinity;

function ghHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ism-mcp-bundler/0.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function parseDateFromTag(tag) {
  const m = tag.match(/^v(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

async function listAllTags() {
  const out = [];
  let page = 1;
  while (true) {
    const url = `${GH_API}/tags?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const tags = await res.json();
    if (tags.length === 0) break;
    for (const t of tags) {
      out.push({
        tag: t.name,
        id: t.name.replace(/^v/, ""),
        sha: t.commit.sha,
        date: parseDateFromTag(t.name),
      });
    }
    if (tags.length < 100) break;
    page += 1;
  }
  out.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return b.tag.localeCompare(a.tag);
  });
  return out;
}

async function fetchRaw(tag, file) {
  const url = `${GH_RAW}/${tag}/${file}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ism-mcp-bundler/0.1" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function writeGz(targetPath, buf) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, gzipSync(buf, { level: 9 }));
}

async function bundleVersion(version) {
  const tagDir = join(VERSIONS_DIR, version.tag);
  const targets = ["ISM_catalog.json"];
  if (INCLUDE_PROFILES) {
    for (const p of PROFILE_NAMES) {
      targets.push(`${p}-baseline-resolved-profile_catalog.json`);
      targets.push(`${p}-baseline_profile.json`);
    }
  }

  let written = 0;
  let skipped = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const file of targets) {
    const out = join(tagDir, `${file}.gz`);
    if (existsSync(out)) {
      const s = await stat(out);
      totalOut += s.size;
      skipped += 1;
      continue;
    }
    const buf = await fetchRaw(version.tag, file);
    if (!buf) {
      // Some older tags don't include every profile; that's expected.
      continue;
    }
    totalIn += buf.length;
    await writeGz(out, buf);
    const s = await stat(out);
    totalOut += s.size;
    written += 1;
  }

  return { written, skipped, totalIn, totalOut };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  console.log(`[bundle] data dir: ${DATA_DIR}`);
  console.log(`[bundle] include profiles: ${INCLUDE_PROFILES}`);
  if (Number.isFinite(RELEASE_LIMIT)) {
    console.log(`[bundle] release limit: ${RELEASE_LIMIT}`);
  }

  await mkdir(VERSIONS_DIR, { recursive: true });

  console.log(`[bundle] fetching tag list…`);
  const versions = (await listAllTags()).slice(0, RELEASE_LIMIT);
  console.log(`[bundle] ${versions.length} releases to bundle`);

  let grandIn = 0;
  let grandOut = 0;
  for (let i = 0; i < versions.length; i += 1) {
    const v = versions[i];
    process.stdout.write(
      `[bundle] (${i + 1}/${versions.length}) ${v.tag}… `,
    );
    const r = await bundleVersion(v);
    grandIn += r.totalIn;
    grandOut += r.totalOut;
    console.log(
      `wrote ${r.written}, cached ${r.skipped}, ` +
        `in ${fmtBytes(r.totalIn)} -> out ${fmtBytes(r.totalOut)}`,
    );
  }

  const index = {
    generatedAt: new Date().toISOString(),
    source: `https://github.com/${GH_OWNER}/${GH_REPO}`,
    profilesIncluded: INCLUDE_PROFILES,
    versions: versions.map((v) => ({
      tag: v.tag,
      id: v.id,
      sha: v.sha,
      date: v.date,
    })),
  };
  await writeFile(join(DATA_DIR, "index.json"), JSON.stringify(index, null, 2));

  console.log(`[bundle] done.`);
  console.log(`[bundle] downloaded: ${fmtBytes(grandIn)}`);
  console.log(`[bundle] on-disk gzipped: ${fmtBytes(grandOut)}`);
  console.log(`[bundle] index: ${join(DATA_DIR, "index.json")}`);
}

main().catch((err) => {
  console.error(`[bundle] failed: ${err.stack ?? err}`);
  process.exit(1);
});

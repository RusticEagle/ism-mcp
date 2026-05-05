#!/usr/bin/env node
// Build the static GitHub Pages site for ism-mcp.
//
// Inputs:
//   - README.md            (rendered to HTML)
//   - data/index.json      (list of bundled ISM versions)
//   - ism-mcp-*.tgz        (npm tarball, optional — copied as a download)
//   - package.json         (version)
// Output:
//   - site/index.html
//   - site/data/index.json
//   - site/download/ism-mcp-<version>.tgz   (if a tarball is present)

import { mkdir, readFile, writeFile, copyFile, readdir, stat, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

async function ensure(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

// Tiny, dependency-free Markdown -> HTML renderer good enough for our README.
// Supports: headings, paragraphs, fenced code, inline code, bold, italic, links,
// unordered/ordered lists, simple tables, blockquotes, horizontal rules.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(s) {
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => {
    const href = u.replace(/"/g, "%22");
    return `<a href="${href}">${t}</a>`;
  });
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${escapeHtml(c)}</code>`);
  // Bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];

  const flushParagraph = (buf) => {
    if (buf.length === 0) return;
    out.push(`<p>${renderInline(buf.join(" ").trim())}</p>`);
  };

  let para = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre><code class="language-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeBuf = [];
        codeLang = "";
      } else {
        flushParagraph(para);
        para = [];
        inCode = true;
        codeLang = fence[1] || "";
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // Blank line -> paragraph break
    if (/^\s*$/.test(line)) {
      flushParagraph(para);
      para = [];
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph(para);
      para = [];
      const lvl = h[1].length;
      const slug = h[2]
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      out.push(`<h${lvl} id="${slug}">${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      flushParagraph(para);
      para = [];
      out.push("<hr/>");
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      para = [];
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Tables (pipe style with --- separator on second line)
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:|\s]+\|/.test(lines[i + 1])) {
      flushParagraph(para);
      para = [];
      const header = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(
          lines[i]
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim()),
        );
        i++;
      }
      let html = "<table><thead><tr>";
      for (const h2 of header) html += `<th>${renderInline(h2)}</th>`;
      html += "</tr></thead><tbody>";
      for (const r of rows) {
        html += "<tr>";
        for (const c of r) html += `<td>${renderInline(c)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
      out.push(html);
      continue;
    }

    // Lists
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph(para);
      para = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))
      ) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    para.push(line);
    i++;
  }
  flushParagraph(para);
  if (inCode) {
    out.push(
      `<pre><code class="language-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
    );
  }
  return out.join("\n");
}

function html(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{{title}}</title>
  <meta name="description" content="{{description}}" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='%23002f6c'/><text x='50%25' y='58%25' text-anchor='middle' font-family='system-ui' font-size='32' fill='%23ffd700' font-weight='700'>ISM</text></svg>" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; line-height: 1.55; color: #111; background: #fafafa; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eaeaea; } a { color: #6db4ff; } }
    header { background: linear-gradient(135deg, #002f6c, #00509e); color: #fff; padding: 3rem 1.25rem; }
    header .wrap { max-width: 960px; margin: 0 auto; }
    header h1 { margin: 0 0 .5rem; font-size: 2.25rem; }
    header p.tag { margin: 0; opacity: .9; font-size: 1.125rem; }
    .badges { margin-top: 1rem; display: flex; flex-wrap: wrap; gap: .5rem; }
    .badge { display: inline-block; background: rgba(255,255,255,.12); padding: .25rem .6rem; border-radius: 999px; font-size: .8rem; }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
    .hero-cta { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.25rem 0 0; }
    .btn { display: inline-block; padding: .65rem 1.1rem; border-radius: 8px; font-weight: 600; text-decoration: none; border: 1px solid transparent; }
    .btn.primary { background: #ffd700; color: #002f6c; }
    .btn.ghost { background: transparent; color: #fff; border-color: rgba(255,255,255,.5); }
    .btn:hover { filter: brightness(1.05); }
    section.cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 1rem; margin: 2rem 0; }
    .card { background: #fff; border: 1px solid #e3e3e3; border-radius: 10px; padding: 1rem; }
    @media (prefers-color-scheme: dark) { .card { background: #1a1a1a; border-color: #2a2a2a; } }
    .card h3 { margin-top: 0; }
    .card .num { font-size: 2rem; font-weight: 700; color: #002f6c; }
    @media (prefers-color-scheme: dark) { .card .num { color: #ffd700; } }
    pre { background: #0d1117; color: #e6edf3; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .95em; }
    p code, li code, td code { background: rgba(127,127,127,.15); padding: .1rem .35rem; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: .5rem .65rem; text-align: left; vertical-align: top; }
    @media (prefers-color-scheme: dark) { th, td { border-color: #333; } }
    blockquote { border-left: 4px solid #ffd700; margin: 1rem 0; padding: .25rem 1rem; background: rgba(255,215,0,.08); }
    h1, h2, h3, h4 { line-height: 1.25; }
    h2 { border-bottom: 1px solid #e3e3e3; padding-bottom: .25rem; margin-top: 2.5rem; }
    @media (prefers-color-scheme: dark) { h2 { border-color: #2a2a2a; } }
    footer { border-top: 1px solid #e3e3e3; margin-top: 3rem; padding: 1.25rem; text-align: center; color: #666; font-size: .9rem; }
    @media (prefers-color-scheme: dark) { footer { border-color: #2a2a2a; color: #888; } }
    details { margin: 1rem 0; }
    summary { cursor: pointer; font-weight: 600; }
    .versions-list { columns: 2; column-gap: 2rem; }
    @media (max-width: 600px) { .versions-list { columns: 1; } }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>ism-mcp</h1>
      <p class="tag">An offline-capable Model Context Protocol server for the ACSC Information Security Manual.</p>
      <div class="badges">
        <span class="badge">v{{pkgVersion}}</span>
        <span class="badge">{{versionCount}} ISM releases bundled</span>
        <span class="badge">{{controlCount}}+ controls</span>
        <span class="badge">MIT licensed</span>
      </div>
      <div class="hero-cta">
        {{downloadButton}}
        <a class="btn ghost" href="{{repoUrl}}">View on GitHub</a>
        <a class="btn ghost" href="#install">Install</a>
      </div>
    </div>
  </header>
  <main>
    <section class="cards">
      <div class="card"><h3>ISM versions</h3><div class="num">{{versionCount}}</div><p>Every published release from <code>{{oldestVersion}}</code> to <code>{{latestVersion}}</code> is bundled.</p></div>
      <div class="card"><h3>OSCAL profiles</h3><div class="num">8</div><p>Five classification baselines + Essential Eight ML1/2/3.</p></div>
      <div class="card"><h3>Offline ready</h3><div class="num">100%</div><p>Set <code>ISM_MCP_OFFLINE=1</code> for fully air-gapped operation.</p></div>
    </section>

    {{readme}}

    <h2 id="bundled-versions">Bundled ISM releases</h2>
    <p>The downloadable package and Docker image ship with these versions pre-fetched:</p>
    <details open>
      <summary>{{versionCount}} versions (latest first)</summary>
      <ul class="versions-list">{{versionList}}</ul>
    </details>
    <p>The current bundle was built from upstream commit <code>{{bundleSha}}</code> on {{bundleDate}}.</p>
  </main>
  <footer>
    <p>ism-mcp is an unaffiliated open-source project. The Information Security Manual is published by the Australian Signals Directorate (ASD) — see <a href="https://www.cyber.gov.au/business-government/asds-cyber-security-frameworks/ism">cyber.gov.au</a> for the canonical source and licensing terms.</p>
    <p>Built {{builtAt}}.</p>
  </footer>
</body>
</html>
`;

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  const readmeHtml = renderMarkdown(readme);

  let manifest = { generatedAt: null, count: 0, versions: [], source: "" };
  const manifestPath = join(ROOT, "data", "index.json");
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  }

  await ensure(SITE);
  await ensure(join(SITE, "data"));
  if (existsSync(manifestPath)) {
    await copyFile(manifestPath, join(SITE, "data", "index.json"));
  }

  // Copy bundled version payloads so Cloudflare Worker can serve fully offline MCP data.
  const bundledVersionsPath = join(ROOT, "data", "versions");
  if (existsSync(bundledVersionsPath)) {
    await cp(bundledVersionsPath, join(SITE, "data", "versions"), {
      recursive: true,
      force: true,
    });
  }

  // Find latest tarball if any.
  let downloadButton = `<a class="btn primary" href="${pkg.repository?.url ?? "#"}#install">Install</a>`;
  const tgzCandidates = (await readdir(ROOT)).filter(
    (f) => f.startsWith("ism-mcp-") && f.endsWith(".tgz"),
  );
  if (tgzCandidates.length > 0) {
    tgzCandidates.sort();
    const tgz = tgzCandidates[tgzCandidates.length - 1];
    await ensure(join(SITE, "download"));
    await copyFile(join(ROOT, tgz), join(SITE, "download", tgz));
    const sizeMb = ((await stat(join(SITE, "download", tgz))).size / (1024 * 1024)).toFixed(1);
    downloadButton = `<a class="btn primary" href="download/${tgz}">Download .tgz (${sizeMb} MB)</a>`;
  }

  const versions = manifest.versions ?? [];
  const versionList = versions
    .map(
      (v) =>
        `<li><code>${escapeHtml(v.id)}</code> <span style="opacity:.6">(${escapeHtml(v.date ?? "")})</span></li>`,
    )
    .join("");

  // Approximate control count from the freshest catalog if we have it.
  let controlCount = "1100";
  if (versions[0]?.controlCount) controlCount = String(versions[0].controlCount);

  const repoUrl =
    typeof pkg.repository === "string"
      ? pkg.repository
      : pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ??
        "https://github.com/";

  const out = html(SHELL, {
    title: "ism-mcp — ACSC Information Security Manual MCP server",
    description: pkg.description ?? "",
    pkgVersion: pkg.version,
    versionCount: String(versions.length || 0),
    controlCount,
    oldestVersion: versions.length > 0 ? versions[versions.length - 1].id : "n/a",
    latestVersion: versions.length > 0 ? versions[0].id : "n/a",
    downloadButton,
    repoUrl,
    readme: readmeHtml,
    versionList,
    bundleSha: versions[0]?.sha?.slice(0, 7) ?? "n/a",
    bundleDate: manifest.generatedAt
      ? new Date(manifest.generatedAt).toISOString().slice(0, 10)
      : "n/a",
    builtAt: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
  });

  await writeFile(join(SITE, "index.html"), out, "utf8");

  // .nojekyll so GitHub Pages serves files starting with _ as-is.
  await writeFile(join(SITE, ".nojekyll"), "", "utf8");

  console.log(`Site built at ${SITE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

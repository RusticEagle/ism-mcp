import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/workspaces/ism-mcp/dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(
  "tools:",
  tools.tools.map((t) => t.name),
);

const resources = await client.listResourceTemplates();
console.log(
  "resource templates:",
  resources.resourceTemplates.map((r) => r.uriTemplate),
);

const prompts = await client.listPrompts();
console.log(
  "prompts:",
  prompts.prompts.map((p) => p.name),
);

const versions = await client.callTool({
  name: "list_versions",
  arguments: { limit: 3 },
});
console.log("list_versions ->");
console.log(JSON.parse((versions.content as { text: string }[])[0].text));

const meta = await client.callTool({
  name: "get_version_metadata",
  arguments: {},
});
console.log("get_version_metadata ->");
const metaParsed = JSON.parse((meta.content as { text: string }[])[0].text);
console.log({
  version: metaParsed.version,
  title: metaParsed.metadata.title,
  controls: metaParsed.counts.controls,
});

const search = await client.callTool({
  name: "search_controls",
  arguments: { query: "multi-factor authentication", limit: 3 },
});
const searchParsed = JSON.parse((search.content as { text: string }[])[0].text);
console.log("search 'multi-factor authentication' total:", searchParsed.total);
console.log("first 3:", searchParsed.items);

const ctrl = await client.callTool({
  name: "get_control",
  arguments: { controlId: "GOV-01", format: "markdown" },
});
console.log(
  "\nget_control GOV-01 (markdown):\n",
  (ctrl.content as { text: string }[])[0].text,
);

const multi = await client.callTool({
  name: "get_controls",
  arguments: { controlIds: ["GOV-01", "does-not-exist"] },
});
const multiParsed = JSON.parse((multi.content as { text: string }[])[0].text);
console.log("\nget_controls GOV-01 + missing summary:", {
  matched: multiParsed.matched,
  unmatched: multiParsed.unmatched,
});

const multiNoDedupe = await client.callTool({
  name: "get_controls",
  arguments: { controlIds: ["GOV-01", "GOV-01"], deduplicate: false },
});
const multiNoDedupeParsed = JSON.parse(
  (multiNoDedupe.content as { text: string }[])[0].text,
);
console.log("\nget_controls duplicate requests (deduplicate=false):", {
  matched: multiNoDedupeParsed.matched,
  deduplicated: multiNoDedupeParsed.deduplicated,
});

const multiDedupe = await client.callTool({
  name: "get_controls",
  arguments: { controlIds: ["GOV-01", "GOV-01"], deduplicate: true },
});
const multiDedupeParsed = JSON.parse(
  (multiDedupe.content as { text: string }[])[0].text,
);
console.log("\nget_controls duplicate requests (deduplicate=true):", {
  matched: multiDedupeParsed.matched,
  deduplicated: multiDedupeParsed.deduplicated,
});

const diff = await client.callTool({
  name: "compare_versions",
  arguments: { from: "2025.12.9", to: "2026.03.24" },
});
const diffParsed = JSON.parse((diff.content as { text: string }[])[0].text);
console.log("\ncompare 2025.12.9 -> 2026.03.24 summary:", diffParsed.summary);

await client.close();

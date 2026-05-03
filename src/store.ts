import type {
  Applicability,
  OscalCatalog,
  OscalControl,
  OscalGroup,
  OscalPart,
  OscalProp,
} from "./types.js";

export interface FlatControl {
  id: string;
  /** Human-friendly identifier, e.g. "GOV-01" */
  label: string;
  title: string;
  /** Path of group titles from root to the control's parent. */
  groupPath: string[];
  applicability: Applicability[];
  /** Topic / chapter as recorded in props (if any). */
  topic?: string;
  /** Concatenated prose from `statement` parts. */
  statement: string;
  /** Original control reference (do not mutate). */
  raw: OscalControl;
}

export function getProp(
  props: OscalProp[] | undefined,
  name: string,
): string | undefined {
  return props?.find((p) => p.name === name)?.value;
}

export function getProps(
  props: OscalProp[] | undefined,
  name: string,
): string[] {
  return props?.filter((p) => p.name === name).map((p) => p.value) ?? [];
}

export function controlLabel(c: OscalControl): string {
  return getProp(c.props, "label") ?? c.id;
}

export function controlApplicability(c: OscalControl): Applicability[] {
  const vals = getProps(c.props, "applicability") as Applicability[];
  return vals.filter((v): v is Applicability =>
    ["NC", "OS", "P", "S", "TS"].includes(v),
  );
}

function collectStatement(parts: OscalPart[] | undefined): string {
  if (!parts) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (p.name === "statement" && p.prose) out.push(p.prose);
    if (p.parts) out.push(collectStatement(p.parts));
  }
  return out.join("\n").trim();
}

export function flattenCatalog(catalog: OscalCatalog): FlatControl[] {
  const out: FlatControl[] = [];
  const walk = (
    nodes: OscalGroup[] | undefined,
    parentTitles: string[],
  ): void => {
    if (!nodes) return;
    for (const g of nodes) {
      const path = [...parentTitles, g.title];
      for (const c of g.controls ?? []) {
        out.push(toFlat(c, path));
      }
      walk(g.groups, path);
    }
  };
  walk(catalog.groups, []);
  for (const c of catalog.controls ?? []) {
    out.push(toFlat(c, []));
  }
  return out;
}

function toFlat(c: OscalControl, groupPath: string[]): FlatControl {
  return {
    id: c.id,
    label: controlLabel(c),
    title: c.title,
    groupPath,
    applicability: controlApplicability(c),
    topic: groupPath[groupPath.length - 1],
    statement: collectStatement(c.parts),
    raw: c,
  };
}

export interface SearchOptions {
  query?: string;
  applicability?: Applicability;
  group?: string; // case-insensitive substring match against any element of groupPath
  labelPrefix?: string; // e.g. "GOV", "AC"
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  items: FlatControl[];
}

export function searchControls(
  controls: FlatControl[],
  opts: SearchOptions,
): SearchResult {
  const q = opts.query?.toLowerCase().trim();
  const groupQ = opts.group?.toLowerCase().trim();
  const labelPrefix = opts.labelPrefix?.toUpperCase().trim();

  const filtered = controls.filter((c) => {
    if (opts.applicability && !c.applicability.includes(opts.applicability))
      return false;
    if (groupQ && !c.groupPath.some((g) => g.toLowerCase().includes(groupQ)))
      return false;
    if (labelPrefix && !c.label.toUpperCase().startsWith(labelPrefix))
      return false;
    if (q) {
      const hay =
        `${c.label} ${c.title} ${c.statement} ${c.groupPath.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + limit),
  };
}

export interface GroupSummary {
  title: string;
  path: string[];
  controlCount: number;
  subgroups: GroupSummary[];
}

export function summarizeGroups(catalog: OscalCatalog): GroupSummary[] {
  const summarize = (g: OscalGroup, parent: string[]): GroupSummary => {
    const path = [...parent, g.title];
    const subgroups = (g.groups ?? []).map((sg) => summarize(sg, path));
    const direct = g.controls?.length ?? 0;
    const indirect = subgroups.reduce((n, s) => n + s.controlCount, 0);
    return {
      title: g.title,
      path,
      controlCount: direct + indirect,
      subgroups,
    };
  };
  return (catalog.groups ?? []).map((g) => summarize(g, []));
}

export interface ControlDiff {
  added: FlatControl[];
  removed: FlatControl[];
  modified: Array<{
    id: string;
    label: string;
    title: string;
    changes: {
      titleChanged: boolean;
      statementChanged: boolean;
      applicabilityAdded: Applicability[];
      applicabilityRemoved: Applicability[];
    };
    before: FlatControl;
    after: FlatControl;
  }>;
  unchanged: number;
}

export function diffControls(a: FlatControl[], b: FlatControl[]): ControlDiff {
  const aMap = new Map(a.map((c) => [c.id, c] as const));
  const bMap = new Map(b.map((c) => [c.id, c] as const));
  const added: FlatControl[] = [];
  const removed: FlatControl[] = [];
  const modified: ControlDiff["modified"] = [];
  let unchanged = 0;
  for (const [id, after] of bMap) {
    const before = aMap.get(id);
    if (!before) {
      added.push(after);
      continue;
    }
    const titleChanged = before.title !== after.title;
    const statementChanged = before.statement !== after.statement;
    const applicabilityAdded = after.applicability.filter(
      (x) => !before.applicability.includes(x),
    );
    const applicabilityRemoved = before.applicability.filter(
      (x) => !after.applicability.includes(x),
    );
    if (
      titleChanged ||
      statementChanged ||
      applicabilityAdded.length > 0 ||
      applicabilityRemoved.length > 0
    ) {
      modified.push({
        id,
        label: after.label,
        title: after.title,
        changes: {
          titleChanged,
          statementChanged,
          applicabilityAdded,
          applicabilityRemoved,
        },
        before,
        after,
      });
    } else {
      unchanged += 1;
    }
  }
  for (const [id, before] of aMap) {
    if (!bMap.has(id)) removed.push(before);
  }
  return { added, removed, modified, unchanged };
}

export function controlToMarkdown(c: FlatControl, version: string): string {
  const lines: string[] = [];
  lines.push(`# ${c.label} — ${c.title}`);
  lines.push("");
  lines.push(`- **Control ID:** \`${c.id}\``);
  lines.push(`- **ISM version:** ${version}`);
  if (c.groupPath.length > 0) {
    lines.push(`- **Section:** ${c.groupPath.join(" › ")}`);
  }
  if (c.applicability.length > 0) {
    lines.push(`- **Applicability:** ${c.applicability.join(", ")}`);
  }
  lines.push("");
  if (c.statement) {
    lines.push("## Statement");
    lines.push("");
    lines.push(c.statement);
    lines.push("");
  }
  return lines.join("\n");
}

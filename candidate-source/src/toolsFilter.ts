/**
 * Tool allow/deny filter: HH_TOOLS / HH_TOOLS_EXCLUDE and CLI --tools / --tools-exclude.
 */
export interface FilterableTool {
  name: string;
  /** Primary group. */
  group: string;
  /** Extra groups this tool also matches (e.g. get_resumes ∈ batch + resumes). */
  groups?: string[];
}

export interface ToolFilterResult<T extends FilterableTool> {
  tools: T[];
  effectiveCount: number;
  filterActive: boolean;
  allow: string[];
  exclude: string[];
}

function splitList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function toolGroups(t: FilterableTool): string[] {
  const set = new Set<string>([t.group.toLowerCase(), ...(t.groups ?? []).map((g) => g.toLowerCase())]);
  return [...set];
}

function matchesEntry(t: FilterableTool, entry: string): boolean {
  const name = t.name.toLowerCase();
  if (name === entry) return true;
  return toolGroups(t).includes(entry);
}

/**
 * Parse CLI args for --tools / --tools-exclude (consumes value after flag).
 * Mutates argv copy; returns remaining args.
 */
export function parseToolsCliArgs(argv: string[]): {
  tools?: string;
  toolsExclude?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let tools: string | undefined;
  let toolsExclude: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tools" || a.startsWith("--tools=")) {
      tools = a.includes("=") ? a.slice("--tools=".length) : argv[++i];
      continue;
    }
    if (a === "--tools-exclude" || a.startsWith("--tools-exclude=")) {
      toolsExclude = a.includes("=")
        ? a.slice("--tools-exclude=".length)
        : argv[++i];
      continue;
    }
    rest.push(a);
  }
  return { tools, toolsExclude, rest };
}

export function applyToolFilter<T extends FilterableTool>(
  all: T[],
  opts: {
    allow?: string;
    exclude?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ToolFilterResult<T> {
  const env = opts.env ?? process.env;
  const allow = splitList(opts.allow ?? env.HH_TOOLS);
  const exclude = splitList(opts.exclude ?? env.HH_TOOLS_EXCLUDE);
  const filterActive = allow.length > 0 || exclude.length > 0;

  if (!filterActive) {
    return {
      tools: all,
      effectiveCount: all.length,
      filterActive: false,
      allow: [],
      exclude: [],
    };
  }

  // Fail loudly on unknown entries.
  const known = new Set<string>();
  for (const t of all) {
    known.add(t.name.toLowerCase());
    for (const g of toolGroups(t)) known.add(g);
  }
  for (const entry of [...allow, ...exclude]) {
    if (!known.has(entry)) {
      throw new Error(
        `Unknown tool/group in HH_TOOLS filter: "${entry}". ` +
          `Known tools/groups: ${[...known].sort().join(", ")}`,
      );
    }
  }

  let selected = all;
  if (allow.length) {
    selected = all.filter((t) => allow.some((e) => matchesEntry(t, e)));
  }
  if (exclude.length) {
    selected = selected.filter((t) => !exclude.some((e) => matchesEntry(t, e)));
  }

  if (selected.length === 0) {
    throw new Error(
      "HH_TOOLS filter produced an empty tool list. Relax HH_TOOLS / HH_TOOLS_EXCLUDE.",
    );
  }

  return {
    tools: selected,
    effectiveCount: selected.length,
    filterActive: true,
    allow,
    exclude,
  };
}

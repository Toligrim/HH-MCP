function splitList(raw) {
    if (!raw?.trim())
        return [];
    return raw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}
function toolGroups(t) {
    const set = new Set([t.group.toLowerCase(), ...(t.groups ?? []).map((g) => g.toLowerCase())]);
    return [...set];
}
function matchesEntry(t, entry) {
    const name = t.name.toLowerCase();
    if (name === entry)
        return true;
    return toolGroups(t).includes(entry);
}
/**
 * Parse CLI args for --tools / --tools-exclude (consumes value after flag).
 * Mutates argv copy; returns remaining args.
 */
export function parseToolsCliArgs(argv) {
    const rest = [];
    let tools;
    let toolsExclude;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
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
export function applyToolFilter(all, opts = {}) {
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
    const known = new Set();
    for (const t of all) {
        known.add(t.name.toLowerCase());
        for (const g of toolGroups(t))
            known.add(g);
    }
    for (const entry of [...allow, ...exclude]) {
        if (!known.has(entry)) {
            throw new Error(`Unknown tool/group in HH_TOOLS filter: "${entry}". ` +
                `Known tools/groups: ${[...known].sort().join(", ")}`);
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
        throw new Error("HH_TOOLS filter produced an empty tool list. Relax HH_TOOLS / HH_TOOLS_EXCLUDE.");
    }
    return {
        tools: selected,
        effectiveCount: selected.length,
        filterActive: true,
        allow,
        exclude,
    };
}
//# sourceMappingURL=toolsFilter.js.map
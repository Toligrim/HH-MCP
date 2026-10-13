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
/**
 * Parse CLI args for --tools / --tools-exclude (consumes value after flag).
 * Mutates argv copy; returns remaining args.
 */
export declare function parseToolsCliArgs(argv: string[]): {
    tools?: string;
    toolsExclude?: string;
    rest: string[];
};
export declare function applyToolFilter<T extends FilterableTool>(all: T[], opts?: {
    allow?: string;
    exclude?: string;
    env?: NodeJS.ProcessEnv;
}): ToolFilterResult<T>;

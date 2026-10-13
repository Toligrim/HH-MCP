/**
 * Stable label for this MCP process in ledger/health/report.
 * Distinct from resumeBudget INSTANCE_ID (hostname:pid), which is for the
 * shared lock/breaker writers list.
 */
export declare function envFlag(name: string, env?: NodeJS.ProcessEnv): boolean;
export declare function getInstanceLabel(env?: NodeJS.ProcessEnv): string;

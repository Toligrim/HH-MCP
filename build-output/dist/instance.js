/**
 * Stable label for this MCP process in ledger/health/report.
 * Distinct from resumeBudget INSTANCE_ID (hostname:pid), which is for the
 * shared lock/breaker writers list.
 */
export function envFlag(name, env = process.env) {
    const v = env[name]?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "on";
}
export function getInstanceLabel(env = process.env) {
    const inst = env.HH_INSTANCE?.trim();
    if (inst)
        return inst;
    const ua = env.HH_USER_AGENT?.trim();
    if (ua)
        return ua;
    const port = env.HTTP_PORT?.trim() || env.PORT?.trim();
    if (port)
        return port;
    return "unknown";
}
//# sourceMappingURL=instance.js.map
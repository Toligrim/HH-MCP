/**
 * Stable label for this MCP process in ledger/health/report.
 * Distinct from resumeBudget INSTANCE_ID (hostname:pid), which is for the
 * shared lock/breaker writers list.
 */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export function getInstanceLabel(env: NodeJS.ProcessEnv = process.env): string {
  const inst = env.HH_INSTANCE?.trim();
  if (inst) return inst;
  const ua = env.HH_USER_AGENT?.trim();
  if (ua) return ua;
  const port = env.HTTP_PORT?.trim() || env.PORT?.trim();
  if (port) return port;
  return "unknown";
}

/**
 * Soft resume-view quota line for gated reads (informational only — not the captcha gate).
 */
import { hhGet } from "./client.js";

export interface ResumeQuota {
  left: number;
  limit: number;
  spend: number;
}

interface MeIds {
  employerId?: string;
  managerId?: string;
}

let cachedMe: { at: number; ids: MeIds } | null = null;
let cachedQuota: { at: number; quota: ResumeQuota | null } | null = null;
let lastKnown: { at: number; quota: ResumeQuota; path: string } | null = null;
/** Index into the candidate path list that last answered, and when. */
let preferredPath: { index: number; at: number } | null = null;
/** Paths that 4xx/5xx'd, skip until this timestamp. */
let badPathUntil: Record<number, number> = {};
const ME_TTL = 5 * 60_000;
const QUOTA_TTL = 5 * 60_000;

function quotaPathTtl(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HH_QUOTA_PATH_TTL_MS);
  return Number.isFinite(n) && n >= 0 && String(env.HH_QUOTA_PATH_TTL_MS ?? "").trim() !== ""
    ? n
    : 3_600_000;
}

function quotaStaleMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HH_QUOTA_STALE_MS);
  return Number.isFinite(n) && n >= 0 && String(env.HH_QUOTA_STALE_MS ?? "").trim() !== ""
    ? n
    : 1_800_000;
}

export interface LastKnownQuota {
  quota: ResumeQuota;
  quotaPath: string;
  quotaAgeS: number;
  refreshedAt: string;
  stale: boolean;
}

/** Last successfully read quota (no network) for diagnostics. */
export function getLastKnownQuota(
  env: NodeJS.ProcessEnv = process.env,
): LastKnownQuota | null {
  if (!lastKnown) return null;
  const quotaAgeS = Math.round((Date.now() - lastKnown.at) / 1000);
  return {
    quota: lastKnown.quota,
    quotaPath: lastKnown.path,
    quotaAgeS,
    refreshedAt: new Date(lastKnown.at).toISOString(),
    stale: Date.now() - lastKnown.at > quotaStaleMs(env),
  };
}

function quotaEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HH_QUOTA_CHECK?.trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export async function getMeIds(_env: NodeJS.ProcessEnv = process.env): Promise<MeIds> {
  if (cachedMe && Date.now() - cachedMe.at < ME_TTL) return cachedMe.ids;
  try {
    const me = (await hhGet("/me", { cost: "normal" })) as {
      employer?: { id?: string | number };
      manager?: { id?: string | number };
      id?: string | number;
    };
    const ids: MeIds = {
      employerId: me.employer?.id != null ? String(me.employer.id) : undefined,
      managerId: me.manager?.id != null ? String(me.manager.id) : undefined,
    };
    cachedMe = { at: Date.now(), ids };
    return ids;
  } catch {
    return {};
  }
}

function parseQuotaPayload(data: unknown): ResumeQuota | null {
  if (!data || typeof data !== "object") return null;
  const o = data as {
    limits?: { resume_view?: number };
    spend?: { resume_view?: number };
    left?: { resume_view?: number };
    // /limits/resume alternate shapes
    resume_view?: { left?: number; limit?: number; spend?: number };
  };
  if (o.left?.resume_view != null && o.limits?.resume_view != null) {
    return {
      left: o.left.resume_view,
      limit: o.limits.resume_view,
      spend: o.spend?.resume_view ?? o.limits.resume_view - o.left.resume_view,
    };
  }
  if (o.resume_view) {
    const rv = o.resume_view;
    if (rv.left != null && rv.limit != null) {
      return { left: rv.left, limit: rv.limit, spend: rv.spend ?? rv.limit - rv.left };
    }
  }
  return null;
}

export async function fetchResumeQuota(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResumeQuota | null> {
  if (!quotaEnabled(env)) return null;
  if (cachedQuota && Date.now() - cachedQuota.at < QUOTA_TTL) {
    const stale = lastKnown != null && Date.now() - lastKnown.at > quotaStaleMs(env);
    if (!stale) return cachedQuota.quota;
  }

  const ids = await getMeIds(env);
  if (!ids.employerId || !ids.managerId) {
    cachedQuota = { at: Date.now(), quota: null };
    return null;
  }

  const paths = [
    `/employers/${encodeURIComponent(ids.employerId)}/managers/${encodeURIComponent(ids.managerId)}/resume_view_limits`,
    `/employers/${encodeURIComponent(ids.employerId)}/managers/${encodeURIComponent(ids.managerId)}/limits/resume`,
  ];

  const ttl = quotaPathTtl(env);
  const order =
    preferredPath && Date.now() - preferredPath.at < ttl
      ? [preferredPath.index]
      : paths.map((_, i) => i);

  for (const i of order) {
    if ((badPathUntil[i] ?? 0) > Date.now()) continue;
    const p = paths[i]!;
    try {
      const data = await hhGet(p, { cost: "normal", probe: true });
      const quota = parseQuotaPayload(data);
      if (quota) {
        cachedQuota = { at: Date.now(), quota };
        preferredPath = { index: i, at: Date.now() };
        lastKnown = { at: Date.now(), quota, path: p.replace(/\/employers\/[^/]+\/managers\/[^/]+/, "/employers/{id}/managers/{id}") };
        return quota;
      }
    } catch {
      badPathUntil[i] = Date.now() + ttl;
    }
  }
  preferredPath = null;
  cachedQuota = { at: Date.now(), quota: null };
  return null;
}

export function formatQuotaLine(q: ResumeQuota): string {
  return `(просмотры резюме: осталось ${q.left} из ${q.limit})`;
}

export function __resetQuotaCacheForTests(): void {
  cachedMe = null;
  cachedQuota = null;
  lastKnown = null;
  preferredPath = null;
  badPathUntil = {};
}

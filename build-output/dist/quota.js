/**
 * Soft resume-view quota line for gated reads (informational only — not the captcha gate).
 */
import { hhGet } from "./client.js";
let cachedMe = null;
let cachedQuota = null;
let lastKnown = null;
/** Index into the candidate path list that last answered, and when. */
let preferredPath = null;
/** Paths that 4xx/5xx'd, skip until this timestamp. */
let badPathUntil = {};
const ME_TTL = 5 * 60_000;
const QUOTA_TTL = 5 * 60_000;
function quotaPathTtl(env) {
    const n = Number(env.HH_QUOTA_PATH_TTL_MS);
    return Number.isFinite(n) && n >= 0 && String(env.HH_QUOTA_PATH_TTL_MS ?? "").trim() !== ""
        ? n
        : 3_600_000;
}
function quotaStaleMs(env) {
    const n = Number(env.HH_QUOTA_STALE_MS);
    return Number.isFinite(n) && n >= 0 && String(env.HH_QUOTA_STALE_MS ?? "").trim() !== ""
        ? n
        : 1_800_000;
}
/** Last successfully read quota (no network) for diagnostics. */
export function getLastKnownQuota(env = process.env) {
    if (!lastKnown)
        return null;
    const quotaAgeS = Math.round((Date.now() - lastKnown.at) / 1000);
    return {
        quota: lastKnown.quota,
        quotaPath: lastKnown.path,
        quotaAgeS,
        refreshedAt: new Date(lastKnown.at).toISOString(),
        stale: Date.now() - lastKnown.at > quotaStaleMs(env),
    };
}
function quotaEnabled(env) {
    const raw = env.HH_QUOTA_CHECK?.trim().toLowerCase();
    return raw !== "off" && raw !== "0" && raw !== "false";
}
export async function getMeIds(_env = process.env) {
    if (cachedMe && Date.now() - cachedMe.at < ME_TTL)
        return cachedMe.ids;
    try {
        const me = (await hhGet("/me", { cost: "normal" }));
        const ids = {
            employerId: me.employer?.id != null ? String(me.employer.id) : undefined,
            managerId: me.manager?.id != null ? String(me.manager.id) : undefined,
        };
        cachedMe = { at: Date.now(), ids };
        return ids;
    }
    catch {
        return {};
    }
}
function parseQuotaPayload(data) {
    if (!data || typeof data !== "object")
        return null;
    const o = data;
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
export async function fetchResumeQuota(env = process.env) {
    if (!quotaEnabled(env))
        return null;
    if (cachedQuota && Date.now() - cachedQuota.at < QUOTA_TTL) {
        const stale = lastKnown != null && Date.now() - lastKnown.at > quotaStaleMs(env);
        if (!stale)
            return cachedQuota.quota;
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
    const order = preferredPath && Date.now() - preferredPath.at < ttl
        ? [preferredPath.index]
        : paths.map((_, i) => i);
    for (const i of order) {
        if ((badPathUntil[i] ?? 0) > Date.now())
            continue;
        const p = paths[i];
        try {
            const data = await hhGet(p, { cost: "normal", probe: true });
            const quota = parseQuotaPayload(data);
            if (quota) {
                cachedQuota = { at: Date.now(), quota };
                preferredPath = { index: i, at: Date.now() };
                lastKnown = { at: Date.now(), quota, path: p.replace(/\/employers\/[^/]+\/managers\/[^/]+/, "/employers/{id}/managers/{id}") };
                return quota;
            }
        }
        catch {
            badPathUntil[i] = Date.now() + ttl;
        }
    }
    preferredPath = null;
    cachedQuota = { at: Date.now(), quota: null };
    return null;
}
export function formatQuotaLine(q) {
    return `(просмотры резюме: осталось ${q.left} из ${q.limit})`;
}
export function __resetQuotaCacheForTests() {
    cachedMe = null;
    cachedQuota = null;
    lastKnown = null;
    preferredPath = null;
    badPathUntil = {};
}
//# sourceMappingURL=quota.js.map
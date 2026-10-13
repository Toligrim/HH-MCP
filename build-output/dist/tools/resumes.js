import { z } from "zod";
import { hhGet } from "../client.js";
import { requireToken, RESUME_ACCESS_NOTE } from "../auth.js";
import { formatResumeSearch, formatResume, formatNegotiationsHistory, formatSavedResumeSearchList, formatSavedResumeSearch, } from "../format.js";
import { cacheKey, formatCacheNote, readResumeCache, writeResumeCache, } from "../resumeCache.js";
import { appendLedger } from "../requestLog.js";
import { envFlag } from "../instance.js";
import { fetchResumeQuota, formatQuotaLine } from "../quota.js";
import { GatedDeadlineError, HhAccessError, HhApiError, HhNotFoundError, } from "../hhErrors.js";
import { getGatedPace, isRecoveryActive } from "../captchaBreaker.js";
import { peekGatedWaitMs } from "../resumeBudget.js";
const rawFlag = z
    .boolean()
    .optional()
    .describe("Return the full raw hh.ru JSON instead of the compact summary.");
// Resume ids are alphanumeric hashes, not numeric.
const resumeId = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "resume_id must be an hh.ru resume id");
const topicId = z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Negotiation (отклик) topic id the resume came through. Supplying it reads the " +
    "resume in the context of your own response instead of the resume database.");
const vacancyId = z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Vacancy id the negotiation belongs to. Used together with topic_id.");
export function buildResumePath(resume_id, topic_id, vacancy_id) {
    const query = new URLSearchParams();
    if (topic_id)
        query.set("topic_id", topic_id);
    if (vacancy_id && topic_id)
        query.set("vacancy_id", vacancy_id);
    let warning;
    if (vacancy_id && !topic_id) {
        warning =
            "vacancy_id ignored without topic_id — unscoped resume database read";
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return {
        path: `/resumes/${encodeURIComponent(resume_id)}${suffix}`,
        warning,
    };
}
export const searchResumesSchema = z.object({
    text: z.string().optional().describe("Search keywords (skills, job title, etc.)"),
    area: z.number().optional().describe("Region code (1=Moscow, 2=Saint Petersburg)"),
    professional_role: z
        .number()
        .optional()
        .describe("Professional role ID. Use get_professional_roles or suggest_professional_roles to find IDs."),
    salary: z.number().optional().describe("Expected salary amount"),
    experience: z
        .enum(["noExperience", "between1And3", "between3And6", "moreThan6"])
        .optional()
        .describe("Experience level"),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
    page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
    raw: rawFlag,
});
export async function handleSearchResumes(params) {
    requireToken(RESUME_ACCESS_NOTE);
    const query = new URLSearchParams();
    if (params.text)
        query.set("text", params.text);
    if (params.area != null)
        query.set("area", String(params.area));
    if (params.professional_role != null)
        query.set("professional_role", String(params.professional_role));
    if (params.salary != null)
        query.set("salary", String(params.salary));
    if (params.experience)
        query.set("experience", params.experience);
    query.set("per_page", String(params.per_page));
    query.set("page", String(params.page));
    const path = `/resumes?${query.toString()}`;
    const t0 = Date.now();
    try {
        const result = await hhGet(path);
        appendLedger({
            kind: "search",
            path,
            status: "ok",
            http_status: 200,
            ms: Date.now() - t0,
        });
        if (params.raw)
            return JSON.stringify(result, null, 2);
        return formatResumeSearch(result);
    }
    catch (err) {
        const httpStatus = err instanceof HhApiError ? err.status : undefined;
        appendLedger({
            kind: "search",
            path,
            status: err instanceof HhNotFoundError ? "not_found" : "failed",
            http_status: httpStatus,
            ms: Date.now() - t0,
            request_id: err instanceof HhApiError ? err.requestId : undefined,
        });
        throw err;
    }
}
export const getResumeSchema = z.object({
    resume_id: resumeId.describe("Resume ID"),
    topic_id: topicId,
    vacancy_id: vacancyId,
    allow_unscoped: z
        .boolean()
        .optional()
        .describe("Confirm a paid resume-database view when topic_id is omitted. Required when HH_REQUIRE_TOPIC is on."),
    no_cache: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip disk cache and force a fresh read."),
    raw: rawFlag,
});
const inflight = new Map();
/** Shared fetch used by get_resume and batch tools. */
export async function fetchResume(opts) {
    const { path, warning } = buildResumePath(opts.resume_id, opts.topic_id, opts.vacancy_id);
    const scope = opts.topic_id ? "scoped" : "unscoped";
    if (warning) {
        console.error(`[hh-mcp] ${warning}`);
    }
    const vacancyForKey = opts.topic_id ? opts.vacancy_id : undefined;
    if (!opts.no_cache) {
        const hit = readResumeCache({
            resumeId: opts.resume_id,
            topicId: opts.topic_id,
            vacancyId: vacancyForKey,
        });
        if (hit) {
            appendLedger({
                resume_id: opts.resume_id,
                topic_id: opts.topic_id,
                status: "cached",
                scope_explicit: opts.scopeExplicit && scope === "unscoped",
            });
            return {
                payload: hit.payload,
                path: hit.path,
                cached: true,
                scope,
                fetchedAt: hit.fetchedAt,
                warning,
            };
        }
    }
    const key = cacheKey(opts.resume_id, opts.topic_id, vacancyForKey);
    const pending = inflight.get(key);
    if (pending) {
        const shared = await pending;
        appendLedger({
            resume_id: opts.resume_id,
            topic_id: opts.topic_id,
            status: "cached",
            coalesced: true,
            scope_explicit: opts.scopeExplicit && scope === "unscoped",
        });
        return { ...shared, cached: true, coalesced: true, warning };
    }
    // Unscoped /resumes/{id} is gated by path classification in the client.
    const gated = opts.forceGated || scope === "unscoped";
    if (gated && opts.deadline != null) {
        const wait = peekGatedWaitMs(process.env, getGatedPace());
        if (Date.now() + wait > opts.deadline) {
            throw new GatedDeadlineError(wait);
        }
    }
    const run = networkRead(opts, path, scope, warning, vacancyForKey);
    inflight.set(key, run);
    try {
        return await run;
    }
    finally {
        inflight.delete(key);
    }
}
async function networkRead(opts, path, scope, warning, vacancyForKey) {
    const t0 = Date.now();
    const recovery = isRecoveryActive();
    try {
        const payload = await hhGet(path, {
            cost: opts.forceGated ? "gated" : undefined,
            resumeId: opts.resume_id,
            topicId: opts.topic_id,
            retryNotFound: true,
        });
        writeResumeCache({
            resumeId: opts.resume_id,
            topicId: opts.topic_id,
            vacancyId: vacancyForKey,
            pathUsed: path,
            payload,
        });
        appendLedger({
            resume_id: opts.resume_id,
            topic_id: opts.topic_id,
            status: scope === "unscoped" ? "unscoped" : "ok",
            ms: Date.now() - t0,
            recovery,
            scope_explicit: opts.scopeExplicit && scope === "unscoped",
        });
        return { payload, path, cached: false, scope, warning };
    }
    catch (err) {
        const isAccess = err instanceof HhAccessError;
        const status = isAccess && err.kind === "captcha"
            ? "captcha"
            : err instanceof HhNotFoundError
                ? "not_found"
                : "failed";
        appendLedger({
            resume_id: opts.resume_id,
            topic_id: opts.topic_id,
            status,
            kind: isAccess ? err.kind : status,
            ms: Date.now() - t0,
            request_id: err instanceof HhApiError ? err.requestId : undefined,
            http_status: err instanceof HhApiError ? err.status : undefined,
            attempt: err instanceof HhApiError ? err.attempt : undefined,
            retry: err instanceof HhApiError && (err.attempt ?? 1) > 1,
            recovery,
            breaker_denied: isAccess && err.breakerDenied,
        });
        throw err;
    }
}
const NO_TOPIC_MSG = "не передан `topic_id`; возьмите его из `get_application`/`list_applications` или подтвердите платный просмотр `allow_unscoped: true`";
export async function handleGetResume(params) {
    requireToken(RESUME_ACCESS_NOTE);
    const unscoped = !params.topic_id;
    if (unscoped && envFlag("HH_REQUIRE_TOPIC") && !params.allow_unscoped) {
        appendLedger({
            resume_id: params.resume_id,
            status: "skipped",
            reason: "no topic_id",
        });
        throw new Error(NO_TOPIC_MSG);
    }
    const result = await fetchResume({
        resume_id: params.resume_id,
        topic_id: params.topic_id,
        vacancy_id: params.vacancy_id,
        no_cache: params.no_cache,
        scopeExplicit: Boolean(params.allow_unscoped && unscoped),
    });
    if (params.raw) {
        if (result.warning &&
            result.payload &&
            typeof result.payload === "object" &&
            !Array.isArray(result.payload)) {
            return JSON.stringify({
                hh_mcp_warning: result.warning,
                hh_mcp_scope: result.scope,
                ...result.payload,
            }, null, 2);
        }
        return JSON.stringify(result.payload, null, 2);
    }
    const notes = [];
    if (result.warning)
        notes.push(result.warning);
    else if (result.scope === "unscoped") {
        notes.push("чтение без topic_id — просмотр из платной базы резюме");
    }
    if (result.cached && result.fetchedAt)
        notes.push(formatCacheNote(result.fetchedAt));
    const quota = await fetchResumeQuota().catch(() => null);
    if (quota)
        notes.push(formatQuotaLine(quota));
    const body = formatResume(result.payload);
    return notes.length ? `${notes.join(" · ")}\n${body}` : body;
}
export const getResumeNegotiationsHistorySchema = z.object({
    resume_id: resumeId.describe("Resume ID"),
    raw: rawFlag,
});
export async function handleGetResumeNegotiationsHistory(params) {
    requireToken();
    const result = await hhGet(`/resumes/${encodeURIComponent(params.resume_id)}/negotiations_history`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatNegotiationsHistory(result);
}
export const listSavedResumeSearchesSchema = z.object({
    page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
    raw: rawFlag,
});
export async function handleListSavedResumeSearches(params) {
    requireToken();
    const query = new URLSearchParams();
    query.set("page", String(params.page));
    query.set("per_page", String(params.per_page));
    const result = await hhGet(`/saved_searches/resumes?${query.toString()}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatSavedResumeSearchList(result);
}
export const getSavedResumeSearchSchema = z.object({
    id: z
        .string()
        .regex(/^\d+$/, "id must be a numeric saved-search id")
        .describe("Saved resume search ID"),
    raw: rawFlag,
});
export async function handleGetSavedResumeSearch(params) {
    requireToken();
    const result = await hhGet(`/saved_searches/resumes/${encodeURIComponent(params.id)}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatSavedResumeSearch(result);
}
//# sourceMappingURL=resumes.js.map
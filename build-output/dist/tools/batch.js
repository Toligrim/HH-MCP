/**
 * Batch resume tools — safe paced path for bulk отклики triage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { requireToken, RESUME_ACCESS_NOTE } from "../auth.js";
import { errorFields, GatedDeadlineError, HhAccessError, HhNotFoundError, } from "../hhErrors.js";
import { hhGet } from "../client.js";
import { fetchResume } from "./resumes.js";
import { resolveSubCollection, } from "./negotiations.js";
import { getCaptchaBreakerHealth } from "../captchaBreaker.js";
import { getResumeBudgetHealth } from "../resumeBudget.js";
import { fetchResumeQuota, formatQuotaLine } from "../quota.js";
const rawFlag = z
    .boolean()
    .optional()
    .describe("Return structured JSON instead of the compact Russian summary.");
const resumeId = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "resume_id must be an hh.ru resume id");
const numericId = z.string().regex(/^\d+$/);
function exportDir(env = process.env) {
    const raw = env.HH_EXPORT_DIR?.trim();
    return raw || path.join(os.tmpdir(), "hh-mcp-export");
}
function atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
}
/** Parsed payload of an existing raw export, or null if missing/empty/corrupt. */
export function readValidRawFile(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            parsed.id != null) {
            return parsed;
        }
    }
    catch {
        /* missing or corrupt — re-read */
    }
    return null;
}
const CSV_COLUMNS = [
    "negotiation_id",
    "resume_id",
    "vacancy_id",
    "name",
    "title",
    "file",
    "status",
];
/** raw/ + manifest.json + negotiations.csv under one export root. */
class ExportWriter {
    root;
    rawDir;
    manifestPath;
    csvPath;
    manifest;
    constructor(root) {
        this.root = root;
        this.rawDir = path.join(root, "raw");
        this.manifestPath = path.join(root, "manifest.json");
        this.csvPath = path.join(root, "negotiations.csv");
        fs.mkdirSync(this.rawDir, { recursive: true });
        this.manifest = [];
        if (fs.existsSync(this.manifestPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
                if (Array.isArray(parsed))
                    this.manifest = parsed;
            }
            catch {
                this.manifest = [];
            }
        }
    }
    rawPath(resumeId, topicId) {
        return path.join(this.rawDir, `${resumeId}__${topicId ?? "unscoped"}.json`);
    }
    writeRaw(file, payload) {
        const data = JSON.stringify(payload, null, 2);
        atomicWrite(file, data);
        return Buffer.byteLength(data, "utf8");
    }
    find(resumeId, negotiationId) {
        return this.manifest.find((m) => String(m.resume_id) === resumeId &&
            String(m.negotiation_id ?? "") === (negotiationId ?? ""));
    }
    /** Upsert by (resume_id, negotiation_id); a failure never downgrades a saved ok row. */
    upsert(row) {
        const rid = String(row.resume_id);
        const nid = row.negotiation_id != null ? String(row.negotiation_id) : undefined;
        const idx = this.manifest.findIndex((m) => String(m.resume_id) === rid &&
            String(m.negotiation_id ?? "") === (nid ?? ""));
        if (idx < 0) {
            this.manifest.push(row);
            return;
        }
        const prev = this.manifest[idx];
        const prevSaved = prev.status === "ok" || prev.status === "cached" || prev.status === "unscoped";
        const nextSaved = row.status === "ok" || row.status === "cached" || row.status === "unscoped";
        if (prevSaved && !nextSaved)
            return;
        this.manifest[idx] = { ...prev, ...row };
    }
    flush() {
        atomicWrite(this.manifestPath, JSON.stringify(this.manifest, null, 2));
        const header = `${CSV_COLUMNS.join(",")}\n`;
        const body = this.manifest
            .map((m) => CSV_COLUMNS.map((c) => `"${String(m[c] ?? "").replace(/"/g, '""')}"`).join(","))
            .join("\n");
        // BOM so Excel opens UTF-8 Cyrillic correctly.
        atomicWrite(this.csvPath, `\uFEFF${header}${body}${body ? "\n" : ""}`);
    }
}
function nameFromPayload(p) {
    if (!p || typeof p !== "object")
        return {};
    const o = p;
    const name = [o.last_name, o.first_name, o.middle_name]
        .filter((x) => typeof x === "string" && x)
        .join(" ");
    return {
        name: name || undefined,
        title: typeof o.title === "string" ? o.title : undefined,
    };
}
function windowExhausted() {
    const b = getResumeBudgetHealth();
    return b.maxPerWindow > 0 && b.windowUsed >= b.maxPerWindow;
}
function windowLine(waitMsBefore) {
    const b = getResumeBudgetHealth();
    if (b.maxPerWindow <= 0)
        return "";
    const paused = Math.round((b.windowWaitTotalMs - waitMsBefore) / 1000);
    return (`лимит окна: ${b.windowUsed}/${b.maxPerWindow} за ${Math.round(b.windowMs / 1000)} с` +
        (paused > 0 ? `, пауза ${paused} с` : ""));
}
// ---------------------------------------------------------------------------
// get_resumes
// ---------------------------------------------------------------------------
const batchItem = z.object({
    resume_id: resumeId,
    topic_id: numericId.optional().describe("Negotiation (отклик) id for a scoped read"),
    vacancy_id: numericId.optional().describe("Overrides the top-level vacancy_id"),
});
export const getResumesSchema = z.object({
    items: z
        .array(batchItem)
        .min(1)
        .max(50)
        .optional()
        .describe("Preferred input: [{resume_id, topic_id, vacancy_id?}] (1..50). Keeps each resume with its " +
        "negotiation id so a typo cannot silently turn into a paid unscoped read. Do not combine with resume_ids/topics."),
    resume_ids: z
        .array(resumeId)
        .min(1)
        .max(50)
        .optional()
        .describe("Legacy input: resume ids to fetch (1..50). Prefer items."),
    topics: z
        .record(z.string())
        .optional()
        .describe("Legacy: map resume_id → topic_id. Every key must be one of resume_ids, otherwise the call fails before any request."),
    vacancy_id: numericId
        .optional()
        .describe("Vacancy id applied with each topic_id"),
    require_topic: z
        .boolean()
        .optional()
        .default(false)
        .describe("Never read without topic_id: rows lacking one are returned as skipped with no network call. Recommended true."),
    out_dir: z
        .string()
        .optional()
        .describe("Persist payloads to <out_dir>/raw/<resume_id>__<topic_id>.json plus manifest.json and negotiations.csv. " +
        "Existing valid files are reused without a network read."),
    no_cache: z.boolean().optional().default(false),
    max_wait_ms: z
        .number()
        .int()
        .min(1000)
        .max(110_000)
        .default(90_000)
        .describe("Stop starting new gated reads after this many ms (hard-capped at 110000; DSH timeout is 120s). At default 1.5s spacing ≈55 resumes/call."),
    stop_on_captcha: z.boolean().optional().default(true),
    raw: rawFlag,
});
/**
 * Resolve items vs legacy resume_ids+topics and validate before any network call.
 * Throws with every mismatched id listed so typos are visible.
 */
export function normalizeGetResumesInput(params) {
    if (params.items && (params.resume_ids || params.topics)) {
        throw new Error("get_resumes: pass either items or resume_ids+topics, not both — no requests were made.");
    }
    if (params.items) {
        return params.items.map((i) => ({
            resume_id: i.resume_id,
            topic_id: i.topic_id,
            vacancy_id: i.vacancy_id ?? params.vacancy_id,
        }));
    }
    if (!params.resume_ids?.length) {
        throw new Error("get_resumes: items or resume_ids is required.");
    }
    const topics = params.topics ?? {};
    const ids = new Set(params.resume_ids);
    const extra = Object.keys(topics).filter((k) => !ids.has(k));
    const badValues = Object.entries(topics).filter(([, v]) => !/^\d+$/.test(v));
    if (extra.length || badValues.length) {
        const uncovered = params.resume_ids.filter((id) => topics[id] === undefined);
        const lines = ["get_resumes: topics do not match resume_ids — no requests were made."];
        if (extra.length)
            lines.push(`topics keys not in resume_ids: ${extra.join(", ")}`);
        if (extra.length)
            lines.push(`resume_ids without a topic: ${uncovered.join(", ") || "—"}`);
        if (badValues.length) {
            lines.push(`non-numeric topic_id: ${badValues.map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        lines.push("Check for typos, or pass items:[{resume_id, topic_id}] instead.");
        throw new Error(lines.join("\n"));
    }
    return params.resume_ids.map((id) => ({
        resume_id: id,
        topic_id: topics[id],
        vacancy_id: params.vacancy_id,
    }));
}
const ROW_STATUSES = [
    "ok",
    "cached",
    "unscoped",
    "captcha",
    "not_found",
    "failed",
    "skipped",
    "not_attempted",
];
function failureStatus(err) {
    if (err instanceof HhAccessError && err.kind === "captcha")
        return "captcha";
    if (err instanceof HhNotFoundError)
        return "not_found";
    return "failed";
}
function shortError(r) {
    if (r.reason)
        return ` (${r.reason})`;
    if (!r.error)
        return "";
    const f = r.error_fields ?? {};
    const facts = ["value", "type", "request_id", "retry_after_s", "fallback_url"]
        .filter((k) => f[k] != null)
        .map((k) => `${k}=${String(f[k])}`);
    const first = r.error.split("\n")[0];
    return ` (${first}${facts.length ? `; ${facts.join(", ")}` : ""})`;
}
export async function handleGetResumes(params) {
    const items = normalizeGetResumesInput(params);
    requireToken(RESUME_ACCESS_NOTE);
    const started = Date.now();
    const maxWait = Math.min(params.max_wait_ms ?? 90_000, 110_000);
    const deadline = started + maxWait;
    const windowWaitBefore = getResumeBudgetHealth().windowWaitTotalMs;
    const writer = params.out_dir?.trim() ? new ExportWriter(params.out_dir.trim()) : null;
    const rows = [];
    let stoppedForCaptcha = false;
    let stoppedForTime = false;
    let stoppedForWindow = false;
    const markRest = (from) => {
        for (let j = from; j < items.length; j++) {
            rows.push({
                resume_id: items[j].resume_id,
                topic_id: items[j].topic_id,
                status: "not_attempted",
            });
        }
    };
    const record = (item, row, payload) => {
        rows.push(row);
        if (!writer)
            return;
        writer.upsert({
            negotiation_id: item.topic_id,
            resume_id: item.resume_id,
            vacancy_id: item.vacancy_id,
            ...nameFromPayload(payload),
            file: row.file,
            status: row.status,
            error: row.error?.split("\n")[0],
        });
    };
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (Date.now() >= deadline) {
            stoppedForTime = true;
            markRest(i);
            break;
        }
        if (!item.topic_id && params.require_topic) {
            rows.push({
                resume_id: item.resume_id,
                status: "skipped",
                reason: "no topic_id",
            });
            continue;
        }
        const file = writer?.rawPath(item.resume_id, item.topic_id);
        if (writer && file && !params.no_cache) {
            const existing = readValidRawFile(file);
            if (existing) {
                record(item, {
                    resume_id: item.resume_id,
                    topic_id: item.topic_id,
                    status: "cached",
                    file,
                    bytes: fs.statSync(file).size,
                    payload: params.raw ? existing : undefined,
                }, existing);
                continue;
            }
        }
        try {
            const result = await fetchResume({
                resume_id: item.resume_id,
                topic_id: item.topic_id,
                vacancy_id: item.vacancy_id,
                no_cache: params.no_cache,
                forceGated: true,
                deadline,
            });
            const status = result.cached
                ? "cached"
                : result.scope === "unscoped"
                    ? "unscoped"
                    : "ok";
            const bytes = writer && file ? writer.writeRaw(file, result.payload) : undefined;
            record(item, {
                resume_id: item.resume_id,
                topic_id: item.topic_id,
                status,
                file,
                bytes,
                payload: params.raw ? result.payload : undefined,
            }, result.payload);
        }
        catch (err) {
            if (err instanceof GatedDeadlineError) {
                if (windowExhausted())
                    stoppedForWindow = true;
                else
                    stoppedForTime = true;
                markRest(i);
                break;
            }
            const status = failureStatus(err);
            record(item, {
                resume_id: item.resume_id,
                topic_id: item.topic_id,
                status,
                error: err instanceof Error ? err.message : String(err),
                error_fields: errorFields(err),
            });
            if (status === "captcha" && params.stop_on_captcha !== false) {
                stoppedForCaptcha = true;
                markRest(i + 1);
                break;
            }
        }
    }
    writer?.flush();
    const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
    const breaker = getCaptchaBreakerHealth();
    const quota = await fetchResumeQuota().catch(() => null);
    const window = windowLine(windowWaitBefore);
    const savedFiles = rows.filter((r) => r.file && r.bytes != null);
    const unscopedWarning = counts.unscoped > 0
        ? `${counts.unscoped} просмотр(ов) ушло в платную базу резюме (без topic_id)`
        : undefined;
    if (params.raw) {
        const inlineOk = rows.length <= 10;
        let note;
        if (!inlineOk) {
            note = writer
                ? `payloads omitted (batch >10, raw:true): files written to ${writer.rawDir} (${savedFiles.length}), read them from disk`
                : "payloads omitted (batch >10): pass out_dir to persist payloads";
        }
        return JSON.stringify({
            counts,
            warning: unscopedWarning,
            stoppedForCaptcha,
            stoppedForTime,
            stoppedForWindow,
            max_wait_ms: maxWait,
            elapsed_ms: Date.now() - started,
            breaker,
            resumeBudget: getResumeBudgetHealth(),
            quota,
            out_dir: writer?.root,
            manifest: writer?.manifestPath,
            csv: writer?.csvPath,
            files: writer
                ? savedFiles.map((r) => ({
                    resume_id: r.resume_id,
                    topic_id: r.topic_id,
                    status: r.status,
                    file: r.file,
                    bytes: r.bytes,
                }))
                : undefined,
            rows: rows.map((r) => ({
                ...r,
                payload: inlineOk ? r.payload : undefined,
            })),
            note,
        }, null, 2);
    }
    const headerBits = [
        `Резюме: ok ${counts.ok}, из кэша ${counts.cached}, unscoped ${counts.unscoped}, ` +
            `капча ${counts.captcha}, not_found ${counts.not_found}, ошибок ${counts.failed}, ` +
            `пропущено ${counts.skipped}, не тронуто ${counts.not_attempted}`,
    ];
    if (unscopedWarning)
        headerBits.push(`⚠ ${unscopedWarning}`);
    if (quota)
        headerBits.push(formatQuotaLine(quota));
    if (window)
        headerBits.push(window);
    if (stoppedForCaptcha) {
        headerBits.push(`остановка по капче (retry_after_s=${breaker.retryAfterS ?? "—"})`);
    }
    else if (stoppedForWindow) {
        headerBits.push("остановка по лимиту окна — продолжите с оставшихся id позже");
    }
    else if (stoppedForTime) {
        headerBits.push(`лимит времени ${maxWait} мс — продолжите с оставшихся id`);
    }
    else if (counts.not_attempted === 0 && counts.captcha === 0) {
        headerBits.push("готово");
    }
    if (writer) {
        headerBits.push(`файлы: ${writer.rawDir} (${savedFiles.length}), manifest: ${writer.manifestPath}`);
    }
    const table = rows
        .map((r) => `${r.resume_id}${r.topic_id ? ` topic=${r.topic_id}` : ""} → ${r.status}` +
        shortError(r))
        .join("\n");
    return `${headerBits.join(" · ")}\n\n${table}`;
}
// ---------------------------------------------------------------------------
// collect_vacancy_resumes
// ---------------------------------------------------------------------------
export const collectVacancyResumesSchema = z.object({
    vacancy_id: numericId.describe("Vacancy id whose responses to collect"),
    collection: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional()
        .describe('Funnel stage id, default "response"'),
    sub_collection: z
        .string()
        .optional()
        .describe("Same resolution rules as list_applications"),
    max: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max resumes to fetch this call (default 25, max 100)"),
    cursor: z
        .string()
        .optional()
        .describe("Opaque resume point from a previous truncated call"),
    out_dir: z.string().optional().describe("Export directory (default HH_EXPORT_DIR)"),
    stop_on_captcha: z.boolean().optional().default(true),
    max_wait_ms: z
        .number()
        .int()
        .min(1000)
        .max(110_000)
        .default(90_000)
        .describe("Stop starting new gated reads after this many ms (cap 110000)"),
    raw: rawFlag,
});
function encodeCursor(skip) {
    return Buffer.from(JSON.stringify({ v: 2, skip: [...skip] }), "utf8").toString("base64url");
}
function decodeCursor(raw) {
    if (!raw)
        return { skip: new Set() };
    try {
        const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        if (parsed.v === 2) {
            const skip = Array.isArray(parsed.skip) ? parsed.skip.map(String) : [];
            return { skip: new Set(skip) };
        }
        return {
            legacyOffset: Math.max(0, Number(parsed.offset) || 0),
            skip: new Set(),
        };
    }
    catch {
        return { skip: new Set() };
    }
}
async function listAllNegotiations(opts) {
    const items = [];
    let page = 0;
    let pages = 1;
    while (page < pages && page < 100) {
        const query = new URLSearchParams();
        query.set("vacancy_id", opts.vacancyId);
        query.set("page", String(page));
        query.set("per_page", "50");
        const result = (await hhGet(`/negotiations/${encodeURIComponent(opts.collection)}?${query.toString()}`, { cost: "normal" }));
        items.push(...(result.items ?? []));
        pages = result.pages ?? 1;
        page++;
    }
    return items;
}
/** Dedupe by negotiation id and order deterministically (created_at, then id). */
export function orderNegotiations(items) {
    const seen = new Map();
    let duplicates = 0;
    for (const n of items) {
        const id = String(n.id);
        if (seen.has(id)) {
            duplicates++;
            continue;
        }
        seen.set(id, n);
    }
    const ordered = [...seen.values()].sort((a, b) => {
        const ca = a.created_at ?? "";
        const cb = b.created_at ?? "";
        if (ca !== cb)
            return ca < cb ? -1 : 1;
        return String(a.id).localeCompare(String(b.id), "en", { numeric: true });
    });
    return { items: ordered, duplicates };
}
const TERMINAL = new Set(["ok", "cached", "not_found"]);
export async function handleCollectVacancyResumes(params) {
    requireToken(RESUME_ACCESS_NOTE);
    const started = Date.now();
    const maxWait = Math.min(params.max_wait_ms ?? 90_000, 110_000);
    const deadline = started + maxWait;
    const max = params.max ?? 25;
    const writer = new ExportWriter(params.out_dir?.trim() || exportDir());
    const windowWaitBefore = getResumeBudgetHealth().windowWaitTotalMs;
    let collection = params.collection ?? "response";
    if (params.sub_collection) {
        const resolved = await resolveSubCollection(params.vacancy_id, params.sub_collection, params.collection);
        collection = resolved.collection;
    }
    const listed = await listAllNegotiations({
        vacancyId: params.vacancy_id,
        collection,
    });
    const { items: negotiations, duplicates } = orderNegotiations(listed);
    const cursor = decodeCursor(params.cursor);
    const legacySkipped = new Set(cursor.legacyOffset
        ? negotiations.slice(0, cursor.legacyOffset).map((n) => String(n.id))
        : []);
    const isDone = (n) => {
        const rid = n.resume?.id;
        if (!rid)
            return true;
        const row = writer.find(rid, String(n.id));
        if (row && TERMINAL.has(String(row.status))) {
            if (row.status === "not_found")
                return true;
            if (readValidRawFile(writer.rawPath(rid, String(n.id))))
                return true;
        }
        return false;
    };
    const pending = negotiations.filter((n) => !legacySkipped.has(String(n.id)) &&
        !cursor.skip.has(String(n.id)) &&
        !isDone(n));
    const todo = pending.slice(0, max);
    let ok = 0;
    let cached = 0;
    let captcha = 0;
    let notFound = 0;
    let errors = 0;
    let stoppedForCaptcha = false;
    let stoppedForTime = false;
    let stoppedForWindow = false;
    const handled = new Set();
    const failedSkip = new Set(cursor.skip);
    for (const n of todo) {
        if (Date.now() >= deadline) {
            stoppedForTime = true;
            break;
        }
        const nid = String(n.id);
        const rid = n.resume?.id;
        const base = {
            negotiation_id: n.id,
            resume_id: rid,
            vacancy_id: params.vacancy_id,
            name: [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name]
                .filter(Boolean)
                .join(" "),
            title: n.resume?.title,
        };
        if (!rid) {
            handled.add(nid);
            errors++;
            continue;
        }
        const file = writer.rawPath(rid, nid);
        const existing = readValidRawFile(file);
        if (existing) {
            cached++;
            handled.add(nid);
            writer.upsert({ ...base, file, status: "cached" });
            continue;
        }
        try {
            const result = await fetchResume({
                resume_id: rid,
                topic_id: nid,
                vacancy_id: params.vacancy_id,
                forceGated: true,
                deadline,
            });
            writer.writeRaw(file, result.payload);
            if (result.cached)
                cached++;
            else
                ok++;
            handled.add(nid);
            writer.upsert({ ...base, file, status: result.cached ? "cached" : "ok" });
        }
        catch (err) {
            if (err instanceof GatedDeadlineError) {
                if (windowExhausted())
                    stoppedForWindow = true;
                else
                    stoppedForTime = true;
                break;
            }
            const status = failureStatus(err);
            if (status === "captcha") {
                captcha++;
                if (params.stop_on_captcha !== false) {
                    stoppedForCaptcha = true;
                    break;
                }
                continue;
            }
            handled.add(nid);
            if (status === "not_found")
                notFound++;
            else {
                errors++;
                failedSkip.add(nid);
            }
            writer.upsert({
                ...base,
                status,
                error: err instanceof Error ? err.message.split("\n")[0] : String(err),
            });
        }
    }
    writer.flush();
    const remainingItems = pending.filter((n) => !handled.has(String(n.id)) && !failedSkip.has(String(n.id)));
    const remaining = remainingItems.length;
    const processedTotal = negotiations.filter((n) => isDone(n)).length;
    const nextCursor = remaining > 0 || stoppedForTime || stoppedForCaptcha || stoppedForWindow
        ? encodeCursor(failedSkip)
        : undefined;
    const breaker = getCaptchaBreakerHealth();
    const window = windowLine(windowWaitBefore);
    const payload = {
        vacancy_id: params.vacancy_id,
        collection,
        всего_откликов: negotiations.length,
        прочитано: ok,
        из_кэша: cached,
        капча: captcha,
        not_found: notFound,
        ошибок: errors,
        processed_total: processedTotal,
        remaining,
        skipped_duplicates: duplicates,
        cursor: nextCursor,
        manifest: writer.manifestPath,
        csv: writer.csvPath,
        stoppedForCaptcha,
        stoppedForTime,
        stoppedForWindow,
        elapsed_ms: Date.now() - started,
        breaker,
        resumeBudget: getResumeBudgetHealth(),
    };
    if (params.raw)
        return JSON.stringify(payload, null, 2);
    const lines = [
        `Вакансия ${params.vacancy_id} / ${collection}: всего откликов ${negotiations.length}` +
            (duplicates ? ` (дублей в списке ${duplicates})` : ""),
        `прочитано ${ok}, из кэша ${cached}, капча ${captcha}, not_found ${notFound}, ошибок ${errors}`,
        `manifest: ${writer.manifestPath}`,
    ];
    if (window)
        lines.push(window);
    if (stoppedForCaptcha) {
        lines.push(`остановка по капче — подождите ${breaker.retryAfterS ?? "—"} с, продолжите с cursor=${nextCursor}`);
    }
    else if (stoppedForWindow) {
        lines.push(`остановка по лимиту окна — продолжите позже с cursor=${nextCursor}`);
    }
    else if (remaining > 0 || stoppedForTime) {
        lines.push(`обработано ${processedTotal} из ${negotiations.length}, осталось ${remaining} — продолжите с cursor=${nextCursor}`);
    }
    else {
        lines.push(failedSkip.size > 0
            ? `готово (с ошибками: ${failedSkip.size}; повторите без cursor, чтобы дочитать их)`
            : "готово");
    }
    return lines.join("\n");
}
//# sourceMappingURL=batch.js.map
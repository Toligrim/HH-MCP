/**
 * Disk cache for resume reads — spend the paid/gated call once per (resume, scope).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function parseTtl(env) {
    const raw = env.HH_CACHE_TTL_MS;
    if (raw == null || String(raw).trim() === "")
        return 86_400_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return 86_400_000;
    return Math.floor(n);
}
export function getCacheDir(env = process.env) {
    const raw = env.HH_CACHE_DIR?.trim();
    if (raw === "off")
        return null;
    if (raw)
        return raw;
    return path.join(os.tmpdir(), "hh-mcp-cache");
}
export function cacheKey(resumeId, topicId, vacancyId) {
    const material = `${resumeId}\u0000${topicId ?? ""}\u0000${vacancyId ?? ""}`;
    return crypto.createHash("sha256").update(material).digest("hex");
}
function fileFor(dir, resumeId, topicId, vacancyId) {
    return path.join(dir, `${cacheKey(resumeId, topicId, vacancyId)}.json`);
}
export function readResumeCache(opts) {
    const env = opts.env ?? process.env;
    const ttl = parseTtl(env);
    if (ttl === 0)
        return null;
    const dir = getCacheDir(env);
    if (!dir)
        return null;
    const fp = fileFor(dir, opts.resumeId, opts.topicId, opts.vacancyId);
    try {
        const raw = fs.readFileSync(fp, "utf8");
        const envl = JSON.parse(raw);
        if (!envl || typeof envl.fetchedAt !== "number" || envl.payload === undefined) {
            return null;
        }
        if (Date.now() - envl.fetchedAt > ttl)
            return null;
        return envl;
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            console.error(`[hh-mcp] resume cache unreadable, ignoring: ${fp}`);
        }
        return null;
    }
}
export function writeResumeCache(opts) {
    const env = opts.env ?? process.env;
    const ttl = parseTtl(env);
    if (ttl === 0)
        return;
    const dir = getCacheDir(env);
    if (!dir)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const fp = fileFor(dir, opts.resumeId, opts.topicId, opts.vacancyId);
        const envelope = {
            fetchedAt: Date.now(),
            path: opts.pathUsed,
            resumeId: opts.resumeId,
            topicId: opts.topicId,
            vacancyId: opts.vacancyId,
            payload: opts.payload,
        };
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(envelope), "utf8");
        fs.renameSync(tmp, fp);
    }
    catch (err) {
        console.error("[hh-mcp] resume cache write failed:", err.message);
    }
}
export function formatCacheNote(fetchedAt) {
    const d = new Date(fetchedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `(из кэша, прочитано ${stamp})`;
}
//# sourceMappingURL=resumeCache.js.map
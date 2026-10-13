/**
 * Optional JSONL request log + gated-read ledger for post-mortems.
 */
import fs from "node:fs";
import path from "node:path";
import { getInstanceLabel } from "./instance.js";
function todayStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function redactPath(p) {
    return p.replace(/([?&](?:token|access_token|authorization)=)[^&]*/gi, "$1***");
}
/** Strip bearer tokens from any free text that may end up in logs. */
export function redactSecrets(text) {
    return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}
function redactFields(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = typeof v === "string" ? redactSecrets(v) : v;
    }
    return out;
}
function appendLine(file, obj) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(redactFields(obj))}\n`, "utf8");
    }
    catch (err) {
        console.error("[hh-mcp] log write failed:", err.message);
    }
}
export function getLogDir(env = process.env) {
    const raw = env.HH_LOG_DIR?.trim();
    if (!raw || raw === "off")
        return null;
    return raw;
}
export function getLedgerFile(env = process.env) {
    const raw = env.HH_LEDGER_FILE?.trim();
    if (!raw || raw === "off")
        return null;
    return raw;
}
function logFilePath(env) {
    const dir = getLogDir(env);
    if (!dir)
        return null;
    const port = env.HTTP_PORT || env.PORT || process.pid;
    return path.join(dir, `hh-mcp-${port}-${todayStamp()}.jsonl`);
}
export function logHhRequest(entry, env = process.env) {
    const file = logFilePath(env);
    if (!file)
        return;
    appendLine(file, {
        ts: new Date().toISOString(),
        method: entry.method ?? "GET",
        path: redactPath(entry.path),
        status: entry.status,
        ms: entry.ms,
        attempt: entry.attempt,
        retry: entry.retry || undefined,
        gated: entry.gated,
        cached: entry.cached,
        resume_id: entry.resume_id,
        topic_id: entry.topic_id,
        request_id: entry.request_id,
        kind: entry.kind,
    });
}
export function logHhEvent(event, fields = {}, env = process.env) {
    const file = logFilePath(env);
    if (!file)
        return;
    appendLine(file, {
        ts: new Date().toISOString(),
        event,
        ...fields,
    });
}
export function appendLedger(entry, env = process.env) {
    const file = getLedgerFile(env);
    if (!file)
        return;
    appendLine(file, {
        ts: new Date().toISOString(),
        instance: getInstanceLabel(env),
        resume_id: entry.resume_id,
        topic_id: entry.topic_id,
        path: entry.path ? redactPath(entry.path) : undefined,
        status: entry.status,
        kind: entry.kind,
        reason: entry.reason,
        ms: entry.ms,
        request_id: entry.request_id,
        http_status: entry.http_status,
        attempt: entry.attempt,
        retry: entry.retry || undefined,
        recovery: entry.recovery || undefined,
        breaker_denied: entry.breaker_denied || undefined,
        coalesced: entry.coalesced || undefined,
        scope_explicit: entry.scope_explicit || undefined,
    });
}
function parseJsonl(file) {
    try {
        const raw = fs.readFileSync(file, "utf8");
        return raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((x) => x != null);
    }
    catch {
        return [];
    }
}
function readLogRows(logDir) {
    try {
        const rows = [];
        const files = fs
            .readdirSync(logDir)
            .filter((f) => f.startsWith("hh-mcp-") && f.endsWith(".jsonl"))
            .map((f) => path.join(logDir, f));
        for (const f of files)
            rows.push(...parseJsonl(f));
        return rows;
    }
    catch {
        return null;
    }
}
const NETWORK_STATUSES = new Set(["ok", "unscoped", "captcha", "not_found", "failed"]);
function rowInstance(row) {
    return typeof row.instance === "string" && row.instance.trim() ? row.instance : "unknown";
}
function isSearchRow(row) {
    if (row.kind === "search")
        return true;
    if (typeof row.path === "string") {
        const bare = row.path.split("?")[0] ?? row.path;
        return bare === "/resumes";
    }
    return false;
}
export function summarizeUsage(env = process.env) {
    const ledger = getLedgerFile(env);
    const logDir = getLogDir(env);
    const logRows = logDir ? readLogRows(logDir) : null;
    let source = "none";
    let rows = [];
    if (ledger) {
        rows = parseJsonl(ledger);
        source = "ledger";
    }
    else if (logDir) {
        if (logRows) {
            rows = logRows;
            source = "log";
        }
        else {
            source = "log-unreadable";
        }
    }
    const now = Date.now();
    const dayMs = 86_400_000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const report = {
        source,
        coverage: {},
        gatedReadsToday: 0,
        gatedReads7d: 0,
        viewsToday: 0,
        views7d: 0,
        searchReadsToday: 0,
        searchReads7d: 0,
        gatedReadsTodayByInstance: {},
        captchaCount: 0,
        breakerOpens: 0,
        breakerDenied: 0,
        cacheHits: 0,
        cacheMisses: 0,
        okCount: 0,
        unscoped: 0,
        notFound: 0,
        failCount: 0,
        retried: 0,
        failedByStatus: {},
        perHour: {},
    };
    const captchaKeys = new Set();
    const bumpStatus = (code) => {
        const key = typeof code === "number" ? String(code) : "unknown";
        report.failedByStatus[key] = (report.failedByStatus[key] ?? 0) + 1;
    };
    for (const row of rows) {
        const tsRaw = typeof row.ts === "string" ? row.ts : undefined;
        if (tsRaw) {
            if (!report.coverage.from || tsRaw < report.coverage.from)
                report.coverage.from = tsRaw;
            if (!report.coverage.to || tsRaw > report.coverage.to)
                report.coverage.to = tsRaw;
        }
        const ts = tsRaw ? Date.parse(tsRaw) : NaN;
        if (row.event === "breaker.open") {
            if (source === "log")
                report.breakerOpens++;
            continue;
        }
        if (typeof row.event === "string")
            continue;
        let isNetworkRead = false;
        let isCaptcha = false;
        if (source === "ledger") {
            const status = String(row.status ?? "");
            if (status === "skipped" || status === "cached") {
                if (status === "cached")
                    report.cacheHits++;
                continue;
            }
            if (status === "captcha" && row.breaker_denied === true) {
                report.breakerDenied++;
                continue;
            }
            isNetworkRead = NETWORK_STATUSES.has(status);
            isCaptcha = status === "captcha";
            if (!isSearchRow(row)) {
                if (status === "ok")
                    report.okCount++;
                if (status === "unscoped")
                    report.unscoped++;
                if (status === "not_found")
                    report.notFound++;
                if (status === "failed" || status === "captcha" || status === "not_found") {
                    report.failCount++;
                    bumpStatus(row.http_status ?? (status === "captcha" ? 403 : status === "not_found" ? 404 : undefined));
                }
            }
            else if (status === "failed" || status === "captcha" || status === "not_found") {
                report.failCount++;
                bumpStatus(row.http_status ?? (status === "not_found" ? 404 : undefined));
            }
            if (typeof row.attempt === "number" && row.attempt > 1)
                report.retried++;
        }
        else if (source === "log") {
            if (row.gated !== true)
                continue;
            isNetworkRead = true;
            const status = typeof row.status === "number" ? row.status : undefined;
            isCaptcha = row.kind === "captcha";
            if (row.cached === true)
                report.cacheHits++;
            if (typeof row.attempt === "number" && row.attempt > 1)
                report.retried++;
            if (row.kind === "retrying") {
                // Intermediate attempt that was retried — a real read, not an outcome.
            }
            else if (status != null && status < 400) {
                report.okCount++;
                if (typeof row.path === "string" &&
                    /^\/resumes\/[^/?]+(?:\?|$)/.test(row.path) &&
                    !/[?&]topic_id=/.test(row.path)) {
                    report.unscoped++;
                }
            }
            else {
                if (row.kind === "not_found")
                    report.notFound++;
                report.failCount++;
                bumpStatus(status);
            }
        }
        if (isCaptcha) {
            const key = typeof row.request_id === "string" && row.request_id
                ? row.request_id
                : `${tsRaw ?? ""}\u0000${String(row.resume_id ?? "")}`;
            if (!captchaKeys.has(key)) {
                captchaKeys.add(key);
                report.captchaCount++;
            }
            if (tsRaw && (!report.lastCaptchaAt || tsRaw > report.lastCaptchaAt)) {
                report.lastCaptchaAt = tsRaw;
            }
        }
        if (isNetworkRead && Number.isFinite(ts)) {
            report.cacheMisses++;
            const search = isSearchRow(row);
            if (ts >= todayMs) {
                report.gatedReadsToday++;
                if (search)
                    report.searchReadsToday++;
                else
                    report.viewsToday++;
                const inst = rowInstance(row);
                report.gatedReadsTodayByInstance[inst] = (report.gatedReadsTodayByInstance[inst] ?? 0) + 1;
                const hour = String(new Date(ts).getHours()).padStart(2, "0");
                report.perHour[hour] = (report.perHour[hour] ?? 0) + 1;
            }
            if (ts >= now - 7 * dayMs) {
                report.gatedReads7d++;
                if (search)
                    report.searchReads7d++;
                else
                    report.views7d++;
            }
        }
    }
    if (source === "ledger") {
        // breaker.open events live in the request log; fall back to captcha count.
        report.breakerOpens = logRows
            ? logRows.filter((r) => r.event === "breaker.open").length
            : report.captchaCount;
    }
    return report;
}
//# sourceMappingURL=requestLog.js.map
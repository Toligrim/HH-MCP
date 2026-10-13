/**
 * Diagnostics tools. Quota may be refreshed over the network (normal cost, not gated).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getCaptchaBreakerHealth } from "../captchaBreaker.js";
import { getResumeBudgetHealth } from "../resumeBudget.js";
import { getCacheDir } from "../resumeCache.js";
import { getLedgerFile, getLogDir, summarizeUsage } from "../requestLog.js";
import { fetchResumeQuota, getLastKnownQuota } from "../quota.js";
import { getInstanceLabel } from "../instance.js";
export const hhUsageReportSchema = z.object({
    raw: z
        .boolean()
        .optional()
        .describe("Return JSON instead of the compact Russian summary."),
});
function cacheStats(dir) {
    if (!dir)
        return { entries: 0 };
    try {
        let oldest = Infinity;
        let entries = 0;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json"))
                continue;
            entries++;
            const m = fs.statSync(path.join(dir, f)).mtimeMs;
            if (m < oldest)
                oldest = m;
        }
        return {
            entries,
            oldestCacheEntry: Number.isFinite(oldest) ? new Date(oldest).toISOString() : undefined,
        };
    }
    catch {
        return { entries: 0 };
    }
}
function formatInstanceSplit(by) {
    const parts = Object.entries(by)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => `${k}: ${n}`);
    return parts.length ? ` (${parts.join(" · ")})` : "";
}
export async function handleHhUsageReport(params = {}) {
    const usage = summarizeUsage();
    const breaker = getCaptchaBreakerHealth();
    const budget = getResumeBudgetHealth();
    const cacheDir = getCacheDir();
    const cache = cacheStats(cacheDir);
    let quota = getLastKnownQuota();
    if (!quota || quota.stale) {
        await fetchResumeQuota().catch(() => null);
        quota = getLastKnownQuota();
    }
    const quotaPayload = quota ?? { stale: true, refreshedAt: null };
    const report = {
        instance: getInstanceLabel(),
        usage,
        captchaBreaker: breaker,
        resumeBudget: budget,
        quota: quotaPayload,
        cacheDir,
        cache,
        ledgerFile: getLedgerFile(),
        logDir: getLogDir(),
        note: "Счётчик resume_view_limits на стороне hh.ru может не отражать реальные просмотры — только информативно, не сигнал капчи.",
    };
    if (params.raw)
        return JSON.stringify(report, null, 2);
    const failed = Object.entries(usage.failedByStatus)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
    const perHour = Object.entries(usage.perHour)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([h, n]) => `${h}ч:${n}`)
        .join(" ");
    const recovery = breaker.recovery?.active
        ? ` · recovery: active (until ${new Date(breaker.recovery.until).toISOString()})`
        : "";
    const lines = [
        `Отчёт hh-mcp (источник: ${usage.source}` +
            (usage.coverage.from ? `, ${usage.coverage.from} … ${usage.coverage.to}` : "") +
            ")",
        `Просмотры резюме: сегодня ${usage.viewsToday}, за 7 дней ${usage.views7d}`,
        `Поисковые чтения: сегодня ${usage.searchReadsToday}, за 7 дней ${usage.searchReads7d}`,
        `Гейтед-чтения: сегодня ${usage.gatedReadsToday}${formatInstanceSplit(usage.gatedReadsTodayByInstance)}, за 7 дней ${usage.gatedReads7d}` +
            (perHour ? ` · по часам: ${perHour}` : ""),
        `ok ${usage.okCount} · unscoped ${usage.unscoped} · not_found ${usage.notFound} · ` +
            `кэш-хиты ${usage.cacheHits} · повторов ${usage.retried}`,
        `капча ${usage.captchaCount} · breaker.open ${usage.breakerOpens} · быстрых отказов ${usage.breakerDenied}` +
            (usage.lastCaptchaAt ? ` (последняя ${usage.lastCaptchaAt})` : ""),
        failed ? `ошибки по HTTP-статусу: ${failed}` : "",
        `Breaker: ${breaker.state}` +
            (breaker.retryAfterS != null ? ` · retry_after_s=${breaker.retryAfterS}` : "") +
            (breaker.failures ? ` · failures=${breaker.failures}` : "") +
            (breaker.requestId ? ` · request_id=${breaker.requestId}` : "") +
            recovery +
            (breaker.lastWriter ? ` · lastWriter=${breaker.lastWriter}` : ""),
        `Budget: concurrency=${budget.maxConcurrency} · intervalMs=${budget.minIntervalMs} · ` +
            `окно ${budget.windowUsed}/${budget.maxPerWindow} за ${Math.round(budget.windowMs / 1000)} с · shared=${budget.shared}`,
        quota && "quota" in quota && quota.quota
            ? `Квота: осталось ${quota.quota.left} из ${quota.quota.limit} (${quota.quotaPath}, ${quota.quotaAgeS} с назад)`
            : "Квота: н/д (обновится при первом чтении резюме)",
        `Кэш: ${cache.entries} записей` +
            (cache.oldestCacheEntry ? `, старейшая ${cache.oldestCacheEntry}` : ""),
        report.note,
    ];
    return lines.filter(Boolean).join("\n");
}
//# sourceMappingURL=diagnostics.js.map
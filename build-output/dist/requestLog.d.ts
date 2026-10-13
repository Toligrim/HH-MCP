/** Strip bearer tokens from any free text that may end up in logs. */
export declare function redactSecrets(text: string): string;
export declare function getLogDir(env?: NodeJS.ProcessEnv): string | null;
export declare function getLedgerFile(env?: NodeJS.ProcessEnv): string | null;
export declare function logHhRequest(entry: {
    method?: string;
    path: string;
    status?: number;
    ms?: number;
    attempt?: number;
    retry?: boolean;
    gated?: boolean;
    cached?: boolean;
    resume_id?: string;
    topic_id?: string;
    request_id?: string;
    kind?: string;
}, env?: NodeJS.ProcessEnv): void;
export declare function logHhEvent(event: string, fields?: Record<string, unknown>, env?: NodeJS.ProcessEnv): void;
export type LedgerStatus = "ok" | "unscoped" | "cached" | "captcha" | "not_found" | "failed" | "skipped";
export declare function appendLedger(entry: {
    resume_id?: string;
    topic_id?: string;
    path?: string;
    status: LedgerStatus;
    kind?: string;
    reason?: string;
    ms?: number;
    request_id?: string;
    http_status?: number;
    attempt?: number;
    retry?: boolean;
    recovery?: boolean;
    breaker_denied?: boolean;
    coalesced?: boolean;
    scope_explicit?: boolean;
}, env?: NodeJS.ProcessEnv): void;
export interface UsageReport {
    source: "ledger" | "log" | "none" | "log-unreadable";
    coverage: {
        from?: string;
        to?: string;
    };
    /** Resume-id views + gated search reads (sum of views* + searchReads*). */
    gatedReadsToday: number;
    gatedReads7d: number;
    /** Paid/scoped resume views by id (not search listings). */
    viewsToday: number;
    views7d: number;
    /** Gated `/resumes?...` search reads. */
    searchReadsToday: number;
    searchReads7d: number;
    gatedReadsTodayByInstance: Record<string, number>;
    /** Real captcha responses, deduplicated by request_id. */
    captchaCount: number;
    breakerOpens: number;
    /** Fast fails from an open breaker — no request reached hh.ru. */
    breakerDenied: number;
    lastCaptchaAt?: string;
    cacheHits: number;
    cacheMisses: number;
    okCount: number;
    unscoped: number;
    notFound: number;
    failCount: number;
    retried: number;
    failedByStatus: Record<string, number>;
    /** Gated network reads today by local hour ("00".."23"). */
    perHour: Record<string, number>;
}
export declare function summarizeUsage(env?: NodeJS.ProcessEnv): UsageReport;

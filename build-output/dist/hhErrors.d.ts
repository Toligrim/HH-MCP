/** Structured hh.ru access / anti-bot errors (403 captcha, quota, scope). */
export type HhAccessKind = "captcha" | "quota" | "auth" | "scope" | "unknown";
export interface HhErrorDetails {
    value?: string;
    type?: string;
    fallbackUrl?: string;
    captchaUrl?: string;
    requestId?: string;
    description?: string;
    rawBody?: string;
}
export declare class HhApiError extends Error {
    status: number;
    statusText: string;
    body?: string | undefined;
    /** Attempt number of the request that produced this error (1-based). */
    attempt?: number;
    requestId?: string;
    constructor(status: number, statusText: string, body?: string | undefined);
}
/** Resume read returned 404 twice (after one paced retry). */
export declare class HhNotFoundError extends HhApiError {
    readonly kind: "not_found";
    constructor(opts: {
        path: string;
        topicId?: string;
        requestId?: string;
        body?: string;
    });
}
/** Next gated read would start after the caller's deadline (window/interval wait). */
export declare class GatedDeadlineError extends Error {
    waitMs: number;
    constructor(waitMs: number);
}
export declare class HhAccessError extends HhApiError {
    kind: HhAccessKind;
    retryAfterS?: number;
    fallbackUrl?: string;
    captchaUrl?: string;
    requestId?: string;
    value?: string;
    errorType?: string;
    /** Fast-fail from the local/shared breaker — no request reached hh.ru. */
    breakerDenied?: boolean;
    constructor(opts: {
        status: number;
        kind: HhAccessKind;
        statusText: string;
        body?: string;
        retryAfterS?: number;
        fallbackUrl?: string;
        captchaUrl?: string;
        requestId?: string;
        value?: string;
        errorType?: string;
        breakerDenied?: boolean;
    });
    /** Machine-readable payload for MCP clients / batch tools. */
    toStructured(): Record<string, unknown>;
}
export declare function parseHhErrorBody(body?: string): HhErrorDetails;
export declare function classify403(body?: string): {
    kind: HhAccessKind;
    details: HhErrorDetails;
};
export declare function formatCaptchaMessage(opts: {
    details: HhErrorDetails;
    retryAfterS?: number;
}): string;
export declare function formatAccessMessage(kind: HhAccessKind, details: HhErrorDetails, retryAfterS?: number): string;
/** Structured per-row error fields for batch tools. */
export declare function errorFields(err: unknown): Record<string, unknown> | undefined;
export declare function accessErrorFrom403(body?: string, retryAfterS?: number): HhAccessError;

/** Structured hh.ru access / anti-bot errors (403 captcha, quota, scope). */
export class HhApiError extends Error {
    status;
    statusText;
    body;
    /** Attempt number of the request that produced this error (1-based). */
    attempt;
    requestId;
    constructor(status, statusText, body) {
        super(`hh.ru HTTP ${status}: ${statusText}`);
        this.status = status;
        this.statusText = statusText;
        this.body = body;
        this.name = "HhApiError";
    }
}
/** Resume read returned 404 twice (after one paced retry). */
export class HhNotFoundError extends HhApiError {
    kind = "not_found";
    constructor(opts) {
        super(404, `hh.ru вернул 404 дважды: резюме удалено/скрыто либо negotiation недоступна ` +
            `(topic_id=${opts.topicId ?? "—"}, request_id=${opts.requestId ?? "—"})`, opts.body);
        this.name = "HhNotFoundError";
        this.requestId = opts.requestId;
    }
}
/** Next gated read would start after the caller's deadline (window/interval wait). */
export class GatedDeadlineError extends Error {
    waitMs;
    constructor(waitMs) {
        super(`gated read would wait ${waitMs} ms — past the call deadline`);
        this.waitMs = waitMs;
        this.name = "GatedDeadlineError";
    }
}
export class HhAccessError extends HhApiError {
    kind;
    retryAfterS;
    fallbackUrl;
    captchaUrl;
    requestId;
    value;
    errorType;
    /** Fast-fail from the local/shared breaker — no request reached hh.ru. */
    breakerDenied;
    constructor(opts) {
        super(opts.status, opts.statusText, opts.body);
        this.name = "HhAccessError";
        this.kind = opts.kind;
        this.retryAfterS = opts.retryAfterS;
        this.fallbackUrl = opts.fallbackUrl;
        this.captchaUrl = opts.captchaUrl;
        this.requestId = opts.requestId;
        this.value = opts.value;
        this.errorType = opts.errorType;
        this.breakerDenied = opts.breakerDenied;
    }
    /** Machine-readable payload for MCP clients / batch tools. */
    toStructured() {
        return {
            hh: {
                status: this.status,
                kind: this.kind,
                value: this.value,
                type: this.errorType,
                retry_after_s: this.retryAfterS,
                fallback_url: this.fallbackUrl,
                captcha_url: this.captchaUrl,
                request_id: this.requestId,
            },
        };
    }
}
export function parseHhErrorBody(body) {
    if (!body?.trim())
        return { rawBody: body };
    try {
        const parsed = JSON.parse(body);
        const first = parsed.errors?.[0];
        return {
            description: parsed.description,
            requestId: parsed.request_id,
            value: first?.value,
            type: first?.type,
            fallbackUrl: first?.fallback_url,
            captchaUrl: first?.captcha_url,
            rawBody: body,
        };
    }
    catch {
        return { rawBody: body };
    }
}
function looksLikeQuota(details, body) {
    const blob = `${details.value ?? ""} ${details.type ?? ""} ${details.description ?? ""} ${body ?? ""}`.toLowerCase();
    return (/quota|limit.*view|view.*limit|exhausted|превышен.*лимит|лимит.*просмотр|too many.*resume|resume.*limit/.test(blob) || details.value === "limit_exceeded");
}
export function classify403(body) {
    const details = parseHhErrorBody(body);
    if (details.value === "captcha_required") {
        return { kind: "captcha", details };
    }
    if (details.type === "oauth") {
        return { kind: "auth", details };
    }
    if (looksLikeQuota(details, body)) {
        return { kind: "quota", details };
    }
    if (details.value || details.type) {
        return { kind: "scope", details };
    }
    // Unparseable / empty — hedge as unknown, not a hard scope claim.
    if (!body?.trim() || details.rawBody === body) {
        try {
            JSON.parse(body ?? "");
        }
        catch {
            return { kind: "unknown", details };
        }
    }
    return { kind: "unknown", details };
}
export function formatCaptchaMessage(opts) {
    const wait = opts.retryAfterS ?? 60;
    const lines = [
        "hh.ru требует капчу на просмотр резюме (антифрод, лимит обращений).",
        `Подождите ${wait}–120 с и повторите ОДИН вызов. Не повторяйте пачкой и не переключайте сервер/токен — блокировка на аккаунте, второй инстанс упрётся так же.`,
    ];
    if (opts.details.fallbackUrl) {
        lines.push(`Если доступ нужен сейчас: откройте в браузере ${opts.details.fallbackUrl} под аккаунтом работодателя.`);
    }
    if (opts.details.captchaUrl) {
        lines.push(`captcha_url: ${opts.details.captchaUrl}`);
    }
    if (opts.details.requestId) {
        lines.push(`request_id: ${opts.details.requestId}`);
    }
    return lines.join("\n");
}
export function formatAccessMessage(kind, details, retryAfterS) {
    if (kind === "captcha") {
        return formatCaptchaMessage({ details, retryAfterS });
    }
    if (kind === "quota") {
        return ("hh.ru: исчерпан лимит просмотров резюме (квота/платный сервис).\n" +
            (details.requestId ? `request_id: ${details.requestId}` : "")).trim();
    }
    const facts = [
        details.value ? `value=${details.value}` : "",
        details.type ? `type=${details.type}` : "",
        details.requestId ? `request_id=${details.requestId}` : "",
    ]
        .filter(Boolean)
        .join(", ");
    const suffix = facts ? ` (${facts})` : "";
    if (kind === "auth") {
        return (`hh.ru отклонил OAuth-токен${suffix}: токен недействителен, истёк или отозван. ` +
            "Получите новый токен на https://dev.hh.ru/admin и перезапустите сервер.");
    }
    if (kind === "scope") {
        return (`Forbidden — possible missing OAuth scope for this endpoint${suffix}. ` +
            "Проверьте errors[].value в теле — текст-обёртка шаблонный.");
    }
    return `Forbidden — hh.ru rejected the request (reason unknown)${suffix}`;
}
/** Structured per-row error fields for batch tools. */
export function errorFields(err) {
    if (err instanceof HhAccessError) {
        return {
            status: err.status,
            kind: err.kind,
            value: err.value,
            type: err.errorType,
            request_id: err.requestId,
            fallback_url: err.fallbackUrl,
            retry_after_s: err.retryAfterS,
        };
    }
    if (err instanceof HhNotFoundError) {
        return { status: 404, kind: "not_found", request_id: err.requestId };
    }
    if (err instanceof HhApiError) {
        return { status: err.status, kind: "failed", request_id: err.requestId };
    }
    return undefined;
}
export function accessErrorFrom403(body, retryAfterS) {
    const { kind, details } = classify403(body);
    return new HhAccessError({
        status: 403,
        kind,
        statusText: formatAccessMessage(kind, details, retryAfterS),
        body,
        retryAfterS: kind === "captcha" ? (retryAfterS ?? 60) : retryAfterS,
        fallbackUrl: details.fallbackUrl,
        captchaUrl: details.captchaUrl,
        requestId: details.requestId,
        value: details.value,
        errorType: details.type,
    });
}
//# sourceMappingURL=hhErrors.js.map
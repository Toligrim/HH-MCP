/**
 * Captcha circuit breaker: fail fast while gated instead of hammering hh.ru.
 * State is mirrored monotonically into the shared budget file so two instances
 * behind one IP respect each other's cooldown, half-open probe and recovery.
 */
import { formatCaptchaMessage, HhAccessError, accessErrorFrom403, } from "./hhErrors.js";
import { getResumeBudgetConfig, INSTANCE_ID, PROBE_TTL_MS, readSharedBreaker, writeSharedBreaker, } from "./resumeBudget.js";
/** Successful reads in recovery before the pace returns to normal. */
const RECOVERY_READS = 10;
function parsePositiveInt(raw, fallback) {
    if (raw == null || String(raw).trim() === "")
        return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return fallback;
    return Math.floor(n);
}
function parseRetryLadder(env) {
    const raw = env.HH_CAPTCHA_RETRY_S?.trim();
    if (!raw)
        return [45, 120, 300];
    const parts = raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
    return parts.length ? parts.map((n) => Math.floor(n)) : [45, 120, 300];
}
function initialState() {
    return {
        state: "closed",
        openedAt: 0,
        cooldownMs: 0,
        failures: 0,
        halfOpenInFlight: false,
        remoteProbe: false,
        details: {},
        recoveryUntil: 0,
        recoverySuccesses: 0,
    };
}
let state = initialState();
function baseCooldown(env) {
    return parsePositiveInt(env.HH_CAPTCHA_COOLDOWN_MS, 60_000);
}
function maxCooldown(env) {
    return parsePositiveInt(env.HH_CAPTCHA_COOLDOWN_MAX_MS, 600_000);
}
function recoveryMs(env) {
    return parsePositiveInt(env.HH_CAPTCHA_RECOVERY_MS, 600_000);
}
function recoveryStepMs(env) {
    return parsePositiveInt(env.HH_CAPTCHA_RECOVERY_STEP_MS, 5_000);
}
function openUntil() {
    return state.openedAt + state.cooldownMs;
}
function syncFromShared(env) {
    const shared = readSharedBreaker(env);
    if (!shared)
        return;
    const now = Date.now();
    state.lastWriter = shared.lastWriter;
    state.writers = shared.writers;
    if ((shared.recoveryUntil ?? 0) > state.recoveryUntil) {
        state.recoveryUntil = shared.recoveryUntil;
        state.recoverySuccesses = shared.recoverySuccesses ?? 0;
    }
    const sharedUntil = shared.openUntil ?? (shared.openedAt ?? 0) + (shared.cooldownMs ?? 0);
    if (shared.state === "open" && sharedUntil > now) {
        const localUntil = state.state === "open" ? openUntil() : 0;
        if (sharedUntil > localUntil) {
            const openedAt = shared.openedAt ?? now;
            state = {
                ...state,
                state: "open",
                openedAt,
                cooldownMs: sharedUntil - openedAt,
                failures: Math.max(shared.failures ?? 0, state.failures),
                halfOpenInFlight: false,
                remoteProbe: false,
                details: {
                    requestId: shared.requestId,
                    fallbackUrl: shared.fallbackUrl,
                    captchaUrl: shared.captchaUrl,
                    value: shared.value,
                    errorType: shared.errorType,
                },
            };
        }
        return;
    }
    if (shared.state === "half-open") {
        const remote = shared.probeBy != null &&
            shared.probeBy !== INSTANCE_ID &&
            (shared.probeAt ?? 0) > now - PROBE_TTL_MS;
        if (state.state !== "open" || now >= openUntil()) {
            state.state = "half-open";
            state.failures = Math.max(shared.failures ?? 0, state.failures);
            state.remoteProbe = remote;
        }
        return;
    }
    if (shared.state === "closed" &&
        state.state !== "closed" &&
        (shared.closedAt ?? 0) >= openUntil() &&
        now >= openUntil()) {
        // Another instance's probe succeeded after our cooldown ended.
        state = {
            ...state,
            state: "closed",
            openedAt: 0,
            cooldownMs: 0,
            failures: 0,
            halfOpenInFlight: false,
            remoteProbe: false,
        };
    }
}
function snapshot(extra = {}) {
    return {
        state: state.state,
        openedAt: state.openedAt || undefined,
        cooldownMs: state.cooldownMs || undefined,
        openUntil: state.state === "open" ? openUntil() : undefined,
        failures: state.failures,
        requestId: state.details.requestId,
        fallbackUrl: state.details.fallbackUrl,
        captchaUrl: state.details.captchaUrl,
        value: state.details.value,
        errorType: state.details.errorType,
        sourceInstance: INSTANCE_ID,
        recoveryUntil: state.recoveryUntil || undefined,
        recoverySuccesses: state.recoverySuccesses,
        ...extra,
    };
}
function mirror(env, extra = {}) {
    const merged = writeSharedBreaker(snapshot(extra), env);
    if (merged) {
        state.lastWriter = merged.lastWriter;
        state.writers = merged.writers;
    }
    return merged;
}
function remainingCooldownS() {
    if (state.state !== "open")
        return 0;
    const rem = openUntil() - Date.now();
    return Math.max(0, Math.ceil(rem / 1000));
}
function maybeTransitionToHalfOpen(env) {
    if (state.state !== "open")
        return;
    if (Date.now() >= openUntil()) {
        state.state = "half-open";
        state.halfOpenInFlight = false;
        state.remoteProbe = false;
        mirror(env);
        console.error("[hh-mcp] captcha breaker → half-open");
    }
}
export function isRecoveryActive(env = process.env) {
    void env;
    return (state.recoveryUntil > Date.now() && state.recoverySuccesses < RECOVERY_READS);
}
/**
 * Pace for the next gated start: normal outside recovery; in recovery the
 * interval doubles and the window halves, and the first read after the probe
 * waits at least HH_CAPTCHA_RECOVERY_STEP_MS.
 */
export function getGatedPace(env = process.env) {
    syncFromShared(env);
    const cfg = getResumeBudgetConfig(env);
    if (!isRecoveryActive(env)) {
        return { minIntervalMs: cfg.minIntervalMs, maxPerWindow: cfg.maxPerWindow };
    }
    let interval = cfg.minIntervalMs * 2;
    if (state.recoverySuccesses === 0) {
        interval = Math.max(interval, recoveryStepMs(env));
    }
    return {
        minIntervalMs: interval,
        maxPerWindow: cfg.maxPerWindow > 0 ? Math.max(1, Math.floor(cfg.maxPerWindow / 2)) : 0,
    };
}
/** Minimum pause before retrying a 404 while recovery is active. */
export function recoveryRetryFloorMs(env = process.env) {
    return isRecoveryActive(env) ? recoveryStepMs(env) : 0;
}
export function getCaptchaBreakerHealth(env = process.env) {
    syncFromShared(env);
    maybeTransitionToHalfOpen(env);
    const recoveryActive = isRecoveryActive(env);
    return {
        state: state.state,
        openedAt: state.openedAt || undefined,
        openUntil: state.state === "open" ? openUntil() : undefined,
        cooldownMs: state.cooldownMs || undefined,
        failures: state.failures || undefined,
        retryAfterS: state.state === "open" ? remainingCooldownS() : undefined,
        requestId: state.details.requestId,
        recovery: state.recoveryUntil
            ? {
                active: recoveryActive,
                until: state.recoveryUntil,
                successes: state.recoverySuccesses,
            }
            : undefined,
        lastWriter: state.lastWriter,
        writers: state.writers,
    };
}
function deniedError(retryAfterS, why) {
    return new HhAccessError({
        status: 403,
        kind: "captcha",
        statusText: formatCaptchaMessage({
            details: {
                fallbackUrl: state.details.fallbackUrl,
                captchaUrl: state.details.captchaUrl,
                requestId: state.details.requestId,
            },
            retryAfterS,
        }) + `\n(${why}, retry_after_s=${retryAfterS})`,
        retryAfterS,
        value: state.details.value ?? "captcha_required",
        errorType: state.details.errorType ?? "employer_resume_view",
        fallbackUrl: state.details.fallbackUrl,
        captchaUrl: state.details.captchaUrl,
        requestId: state.details.requestId,
        breakerDenied: true,
    });
}
/**
 * Before a gated network call: throw if breaker is open; reserve half-open probe.
 * `ownsProbe` lets a retry of the probing request pass its own reservation.
 * Returns true when this call holds the half-open probe.
 */
export function beforeGatedCall(env = process.env, opts = {}) {
    syncFromShared(env);
    maybeTransitionToHalfOpen(env);
    if (state.state === "open") {
        const retryAfterS = remainingCooldownS() || Math.ceil(state.cooldownMs / 1000);
        throw deniedError(retryAfterS, "breaker open");
    }
    if (state.state === "half-open") {
        if (opts.ownsProbe)
            return true;
        if (state.halfOpenInFlight || state.remoteProbe) {
            throw deniedError(45, "breaker half-open probe in flight");
        }
        const merged = mirror(env, { probeBy: INSTANCE_ID, probeAt: Date.now() });
        if (merged && merged.state !== "closed" && merged.probeBy !== INSTANCE_ID) {
            state.remoteProbe = merged.state === "half-open";
            syncFromShared(env);
            throw deniedError(remainingCooldownS() || 45, "breaker half-open probe in flight");
        }
        state.halfOpenInFlight = true;
        return true;
    }
    return false;
}
export function onGatedSuccess(env = process.env) {
    const wasTripped = state.state === "half-open" || state.state === "open" || state.failures > 0;
    if (wasTripped) {
        console.error("[hh-mcp] captcha breaker → closed (recovery mode)");
        state.recoveryUntil = Date.now() + recoveryMs(env);
        state.recoverySuccesses = 0;
    }
    else if (state.recoveryUntil > Date.now()) {
        state.recoverySuccesses += 1;
    }
    state = {
        ...state,
        state: "closed",
        openedAt: 0,
        cooldownMs: 0,
        failures: 0,
        halfOpenInFlight: false,
        remoteProbe: false,
    };
    mirror(env, { closedAt: Date.now(), probeBy: undefined, probeAt: undefined });
}
export function onCaptcha(err, env = process.env) {
    syncFromShared(env);
    const ladder = parseRetryLadder(env);
    const base = baseCooldown(env);
    const max = maxCooldown(env);
    const nextFailures = state.failures + 1;
    // Prefer ladder steps, then escalate ×2 from base.
    const ladderMs = ladder[Math.min(nextFailures - 1, ladder.length - 1)] * 1000;
    const escalated = Math.min(max, Math.max(base * 2 ** Math.max(0, nextFailures - 1), ladderMs));
    state = {
        ...state,
        state: "open",
        openedAt: Date.now(),
        cooldownMs: escalated,
        failures: nextFailures,
        halfOpenInFlight: false,
        remoteProbe: false,
        details: {
            requestId: err.requestId,
            fallbackUrl: err.fallbackUrl,
            captchaUrl: err.captchaUrl,
            value: err.value,
            errorType: err.errorType,
        },
    };
    mirror(env, { probeBy: undefined, probeAt: undefined });
    // A longer shared cooldown from the other instance wins.
    syncFromShared(env);
    console.error(`[hh-mcp] captcha breaker → open cooldownMs=${state.cooldownMs} request_id=${err.requestId ?? "—"}`);
}
/** Update breaker after a failed gated request (captcha opens; others free the probe). */
export function noteGatedFailure(error, env = process.env) {
    if (error instanceof HhAccessError && error.kind === "captcha") {
        if (error.breakerDenied)
            return;
        onCaptcha(error, env);
        // Refresh retry_after on the error from breaker state.
        error.retryAfterS = remainingCooldownS() || error.retryAfterS;
    }
    else if (state.state === "half-open" && state.halfOpenInFlight) {
        state.halfOpenInFlight = false;
        mirror(env, { probeBy: undefined, probeAt: undefined });
    }
}
export function openBreakerFromBody(body, env = process.env) {
    const err = accessErrorFrom403(body);
    onCaptcha(err, env);
    err.retryAfterS = remainingCooldownS() || err.retryAfterS;
    return err;
}
export function __resetCaptchaBreakerForTests() {
    state = initialState();
}
//# sourceMappingURL=captchaBreaker.js.map
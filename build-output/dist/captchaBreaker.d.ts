/**
 * Captcha circuit breaker: fail fast while gated instead of hammering hh.ru.
 * State is mirrored monotonically into the shared budget file so two instances
 * behind one IP respect each other's cooldown, half-open probe and recovery.
 */
import { HhAccessError } from "./hhErrors.js";
import { type GatedPace } from "./resumeBudget.js";
export type BreakerState = "closed" | "open" | "half-open";
export interface CaptchaBreakerHealth {
    state: BreakerState;
    openedAt?: number;
    openUntil?: number;
    cooldownMs?: number;
    failures?: number;
    retryAfterS?: number;
    requestId?: string;
    recovery?: {
        active: boolean;
        until?: number;
        successes?: number;
    };
    lastWriter?: string;
    writers?: string[];
}
export declare function isRecoveryActive(env?: NodeJS.ProcessEnv): boolean;
/**
 * Pace for the next gated start: normal outside recovery; in recovery the
 * interval doubles and the window halves, and the first read after the probe
 * waits at least HH_CAPTCHA_RECOVERY_STEP_MS.
 */
export declare function getGatedPace(env?: NodeJS.ProcessEnv): GatedPace;
/** Minimum pause before retrying a 404 while recovery is active. */
export declare function recoveryRetryFloorMs(env?: NodeJS.ProcessEnv): number;
export declare function getCaptchaBreakerHealth(env?: NodeJS.ProcessEnv): CaptchaBreakerHealth;
/**
 * Before a gated network call: throw if breaker is open; reserve half-open probe.
 * `ownsProbe` lets a retry of the probing request pass its own reservation.
 * Returns true when this call holds the half-open probe.
 */
export declare function beforeGatedCall(env?: NodeJS.ProcessEnv, opts?: {
    ownsProbe?: boolean;
}): boolean;
export declare function onGatedSuccess(env?: NodeJS.ProcessEnv): void;
export declare function onCaptcha(err: HhAccessError, env?: NodeJS.ProcessEnv): void;
/** Update breaker after a failed gated request (captcha opens; others free the probe). */
export declare function noteGatedFailure(error: unknown, env?: NodeJS.ProcessEnv): void;
export declare function openBreakerFromBody(body?: string, env?: NodeJS.ProcessEnv): HhAccessError;
export declare function __resetCaptchaBreakerForTests(): void;

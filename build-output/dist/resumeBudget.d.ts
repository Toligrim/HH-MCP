export interface ResumeBudgetConfig {
    maxConcurrency: number;
    minIntervalMs: number;
    /** Max gated starts per sliding window; 0 = window limiter off. */
    maxPerWindow: number;
    windowMs: number;
    budgetFile: string | null;
    shared: boolean;
}
export interface ResumeBudgetHealth {
    minIntervalMs: number;
    maxConcurrency: number;
    maxPerWindow: number;
    windowMs: number;
    /** Gated starts inside the current window (shared across instances when shared). */
    windowUsed: number;
    /** Total ms spent waiting on the window limiter by this process. */
    windowWaitTotalMs: number;
    shared: boolean;
    budgetFile: string | null;
}
/** Per-call pace override (recovery mode after a captcha). */
export interface GatedPace {
    minIntervalMs: number;
    maxPerWindow: number;
}
/** Half-open probe reservations older than this are considered abandoned. */
export declare const PROBE_TTL_MS = 30000;
export declare function getResumeBudgetConfig(env?: NodeJS.ProcessEnv): ResumeBudgetConfig;
/** ±20 % jitter so parallel instances do not re-synchronise. */
export declare function jitterInterval(ms: number): number;
export interface SharedBreaker {
    state: "closed" | "open" | "half-open";
    openedAt?: number;
    cooldownMs?: number;
    /** openedAt + cooldownMs; the merge key — never decreases while open. */
    openUntil?: number;
    failures?: number;
    closedAt?: number;
    requestId?: string;
    fallbackUrl?: string;
    captchaUrl?: string;
    value?: string;
    errorType?: string;
    sourceInstance?: string;
    /** Instance holding the half-open probe and when it took it. */
    probeBy?: string;
    probeAt?: number;
    recoveryUntil?: number;
    recoverySuccesses?: number;
    lastWriter?: string;
    writers?: string[];
    /** Last time each writer id was seen; used to drop dead pids. */
    writerSeen?: Record<string, number>;
}
export declare const INSTANCE_ID: string;
export interface GatedSlot {
    release: () => Promise<void>;
}
/**
 * Reserve a gated slot (concurrency + spacing + window). Caller must release
 * when the request finishes (success or failure).
 */
export declare function acquireGatedSlot(env?: NodeJS.ProcessEnv, pace?: GatedPace): Promise<GatedSlot>;
/**
 * Estimate how long the next gated start would wait (no reservation, no jitter).
 * Used by batch tools to stop cleanly instead of sleeping past their deadline.
 */
export declare function peekGatedWaitMs(env?: NodeJS.ProcessEnv, pace?: GatedPace): number;
export declare function getResumeBudgetHealth(env?: NodeJS.ProcessEnv): ResumeBudgetHealth;
/** Test helper: reset in-process counters. */
export declare function __resetResumeBudgetForTests(): void;
export declare function readSharedBreaker(env?: NodeJS.ProcessEnv): SharedBreaker | undefined;
/**
 * Monotonic merge of breaker state: `openUntil` never decreases, and a
 * closed/half-open write cannot overwrite an open state before it expires.
 */
export declare function mergeBreaker(shared: SharedBreaker | undefined, incoming: SharedBreaker, now?: number): SharedBreaker;
export declare function writeSharedBreaker(breaker: SharedBreaker, env?: NodeJS.ProcessEnv): SharedBreaker | undefined;

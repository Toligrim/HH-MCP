import { getCaptchaBreakerHealth } from "./captchaBreaker.js";
import { getResumeBudgetHealth } from "./resumeBudget.js";
export { HhApiError, HhAccessError, HhNotFoundError } from "./hhErrors.js";
export { getResumeBudgetHealth } from "./resumeBudget.js";
export { getCaptchaBreakerHealth } from "./captchaBreaker.js";
export type HhCost = "gated" | "normal";
export interface HhGetOptions {
    /** Override auto path classification. */
    cost?: HhCost;
    resumeId?: string;
    topicId?: string;
    /**
     * Retry a 404 once (paced, through the breaker and gated slot). Only for
     * resume reads, where hh.ru returns transient 404s under load.
     */
    retryNotFound?: boolean;
    /** Log failures as a quiet `quota.path.probe` event instead of a request row. */
    probe?: boolean;
}
/**
 * Paths that hit hh.ru's resume anti-bot / paid-view gate when unscoped.
 * Scoped `/resumes/{id}?topic_id=` is treated as normal unless forced gated.
 */
export declare function isGatedPath(path: string): boolean;
export declare function hhGet(path: string, opts?: HhGetOptions): Promise<unknown>;
/** Health extras for GET /health. */
export declare function getClientHealth(): {
    instance: string;
    resumeBudget: ReturnType<typeof getResumeBudgetHealth>;
    captchaBreaker: ReturnType<typeof getCaptchaBreakerHealth>;
};

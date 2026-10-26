import { VERSION } from "./version.js";
import {
  accessErrorFrom403,
  HhAccessError,
  HhApiError,
  HhNotFoundError,
  parseHhErrorBody,
} from "./hhErrors.js";
import {
  beforeGatedCall,
  getGatedPace,
  noteGatedFailure,
  onGatedSuccess,
  getCaptchaBreakerHealth,
  recoveryRetryFloorMs,
} from "./captchaBreaker.js";
import {
  acquireGatedSlot,
  getResumeBudgetHealth,
  jitterInterval,
  type GatedSlot,
} from "./resumeBudget.js";
import { logHhEvent, logHhRequest } from "./requestLog.js";
import { getInstanceLabel } from "./instance.js";
import {
  assertHhBudgetAvailable,
  assertHhRequestAvailable,
  HhBudgetError,
  recordHhRequestAttempt,
  recordHhResponseBytes,
  type HhRequestBudget,
} from "./requestBudget.js";

export { HhApiError, HhAccessError, HhNotFoundError } from "./hhErrors.js";
export { getResumeBudgetHealth } from "./resumeBudget.js";
export { getCaptchaBreakerHealth } from "./captchaBreaker.js";

const DEFAULT_BASE_URL = "https://api.hh.ru";

function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HH_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

const TIMEOUT = 10_000;
const MAX_RETRIES = 3;

const DEFAULT_USER_AGENT = `hh-mcp/${VERSION} (+https://github.com/AndreyTepaykin/hh-mcp)`;
const USER_AGENT = process.env.HH_USER_AGENT?.trim() || DEFAULT_USER_AGENT;

// Rate limiter: 5 requests per second (normal traffic).
const RATE_LIMIT = 5;
const RATE_WINDOW = 1000;
const timestamps: number[] = [];
let rateLimitTail: Promise<void> = Promise.resolve();

export function __resetRateLimitForTests(): void {
  timestamps.length = 0;
  rateLimitTail = Promise.resolve();
}

function budgetAbortError(budget?: HhRequestBudget, signal?: AbortSignal): Error {
  if (signal?.aborted) return new HhBudgetError("cancelled");
  if (budget && Date.now() >= budget.deadline) {
    return new HhBudgetError("duration_budget");
  }
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

async function waitForBudget<T>(
  promise: Promise<T>,
  budget?: HhRequestBudget,
  signal?: AbortSignal,
): Promise<T> {
  if (!budget && !signal) return promise;
  if (budget) assertHhBudgetAvailable(budget, signal);
  else if (signal?.aborted) throw new HhBudgetError("cancelled");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(budgetAbortError(budget, signal));
    signal?.addEventListener("abort", abort, { once: true });
    if (budget) {
      timer = setTimeout(() => reject(new HhBudgetError("duration_budget")), Math.max(0, budget.deadline - Date.now()));
    }
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function waitForDelay(
  requestedMs: number,
  budget?: HhRequestBudget,
  signal?: AbortSignal,
): Promise<void> {
  if (!budget && !signal) {
    if (requestedMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, requestedMs));
    return;
  }
  if (budget) assertHhBudgetAvailable(budget, signal);
  else if (signal?.aborted) throw new HhBudgetError("cancelled");
  const delay = Math.min(Math.max(0, requestedMs), budget ? Math.max(0, budget.deadline - Date.now()) : requestedMs);
  if (delay > 0) {
    await waitForBudget(new Promise<void>((resolve) => setTimeout(resolve, delay)), budget, signal);
  }
  if (budget) assertHhBudgetAvailable(budget, signal);
  else if (signal?.aborted) throw new HhBudgetError("cancelled");
}

async function waitForRateLimit(budget?: HhRequestBudget, signal?: AbortSignal): Promise<void> {
  if (budget) assertHhBudgetAvailable(budget, signal);
  else if (signal?.aborted) throw new HhBudgetError("cancelled");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = rateLimitTail;
  rateLimitTail = previous.then(() => gate);
  let acquired = false;

  try {
    await waitForBudget(previous, budget, signal);
    acquired = true;
    const trim = (now: number) => {
      while (timestamps.length > 0 && timestamps[0]! <= now - RATE_WINDOW) {
        timestamps.shift();
      }
    };

    trim(Date.now());
    if (timestamps.length >= RATE_LIMIT) {
      const oldest = timestamps[0]!;
      const waitMs = oldest + RATE_WINDOW - Date.now();
      if (waitMs > 0) {
        await waitForDelay(waitMs, budget, signal);
      }
      trim(Date.now());
    }
    if (budget) assertHhBudgetAvailable(budget, signal);
    else if (signal?.aborted) throw new HhBudgetError("cancelled");
    timestamps.push(Date.now());
  } finally {
    if (acquired) release();
    else void previous.then(release);
  }
}

export type HhCost = "gated" | "normal";

export interface HhGetOptions {
  /** Shared request, time and response byte limits for this logical operation. */
  budget?: HhRequestBudget;
  /** Cancel limiter waits, network requests, retries and response reads. */
  signal?: AbortSignal;
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
export function isGatedPath(path: string): boolean {
  const bare = path.split("?")[0] ?? path;
  if (bare === "/resumes" || bare.startsWith("/resumes?")) return true;
  // /resumes/{id}/negotiations_history
  if (/^\/resumes\/[^/]+\/negotiations_history$/.test(bare)) return true;
  // /resumes/{id} without topic_id in query → gated
  if (/^\/resumes\/[^/]+$/.test(bare)) {
    const q = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    if (/(?:^|&)topic_id=/.test(q)) return false;
    return true;
  }
  return false;
}

function resolveCost(path: string, opts?: HhGetOptions): HhCost {
  if (opts?.cost) return opts.cost;
  return isGatedPath(path) ? "gated" : "normal";
}

async function readBudgetedBody(
  response: Response,
  budget: HhRequestBudget,
  signal: AbortSignal | undefined,
  requestController: AbortController,
): Promise<string> {
  assertHhBudgetAvailable(budget, signal);
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await waitForBudget(response.text(), budget, signal);
    recordHhResponseBytes(budget, new TextEncoder().encode(text).byteLength);
    return text;
  }

  try {
    while (true) {
      assertHhBudgetAvailable(budget, signal);
      const { done, value } = await waitForBudget(reader.read(), budget, signal);
      if (done) break;
      recordHhResponseBytes(budget, value.byteLength);
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    assertHhBudgetAvailable(budget, signal);
    return chunks.join("");
  } catch (error) {
    requestController.abort();
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function retryAfterDelay(value: string | null, fallbackMs: number, now: number): number {
  if (value == null || value.trim() === "") return fallbackMs;
  const trimmed = value.trim();
  if (/^-\d/.test(trimmed)) return fallbackMs;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : fallbackMs;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : fallbackMs;
}

export async function hhGet(
  path: string,
  opts: HhGetOptions = {},
): Promise<unknown> {
  const env = process.env;
  const gated = resolveCost(path, opts) === "gated";
  let ownsProbe = false;
  let notFoundSeen = 0;

  for (let attempt = 1; ; attempt++) {
    const retry = attempt > 1;
    const logBase = {
      path,
      attempt,
      retry,
      gated,
      resume_id: opts.resumeId,
      topic_id: opts.topicId,
    };
    const log = (entry: { status?: number; ms?: number; request_id?: string; kind?: string }) => {
      if (opts.probe && (entry.status ?? 0) >= 400) {
        if (env.HH_DEBUG === "1" || env.HH_DEBUG?.trim().toLowerCase() === "true") {
          logHhEvent("quota.path.probe", { path, ok: false, status: entry.status }, env);
        }
        return;
      }
      logHhRequest({ ...logBase, ...entry }, env);
    };

    // Every attempt (retries included) re-checks the breaker and takes a fresh slot.
    if (opts.budget) {
      assertHhBudgetAvailable(opts.budget, opts.signal);
      assertHhRequestAvailable(opts.budget);
    }
    else if (opts.signal?.aborted) throw new HhBudgetError("cancelled");
    let slot: GatedSlot | null = null;
    if (gated) {
      ownsProbe = beforeGatedCall(env, { ownsProbe }) || ownsProbe;
      const acquiringSlot = acquireGatedSlot(env, getGatedPace(env));
      try {
        slot = await waitForBudget(acquiringSlot, opts.budget, opts.signal);
      } catch (error) {
        void acquiringSlot.then((lateSlot) => lateSlot.release()).catch(() => undefined);
        throw error;
      }
      try {
        beforeGatedCall(env, { ownsProbe });
        if (opts.budget) {
          assertHhBudgetAvailable(opts.budget, opts.signal);
          assertHhRequestAvailable(opts.budget);
        }
      } catch (err) {
        await slot.release();
        throw err;
      }
    }

    const started = Date.now();
    let delay: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortFromCaller: (() => void) | undefined;
    try {
      if (opts.budget) assertHhRequestAvailable(opts.budget);
      await waitForRateLimit(opts.budget, opts.signal);
      if (opts.budget) assertHhBudgetAvailable(opts.budget, opts.signal);
      if (opts.budget) assertHhRequestAvailable(opts.budget);
      else if (opts.signal?.aborted) throw new HhBudgetError("cancelled");
      const controller = new AbortController();
      const remaining = opts.budget ? Math.max(0, opts.budget.deadline - Date.now()) : TIMEOUT;
      timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT, remaining));
      abortFromCaller = () => controller.abort();
      opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const headers: Record<string, string> = {
        "HH-User-Agent": USER_AGENT,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      };
      const token = env.HH_ACCESS_TOKEN;
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      if (opts.budget) {
        assertHhBudgetAvailable(opts.budget, opts.signal);
        recordHhRequestAttempt(opts.budget, retry);
      }
      const response = await fetch(`${baseUrl(env)}${path}`, {
        headers,
        signal: controller.signal,
      });
      const ms = Date.now() - started;

      if (response.ok) {
        const json = opts.budget
          ? JSON.parse(await readBudgetedBody(response, opts.budget, opts.signal, controller)) as unknown
          : await response.json();
        if (gated) onGatedSuccess(env);
        log({ status: response.status, ms });
        return json;
      }

      let body: string;
      try {
        body = opts.budget
          ? await readBudgetedBody(response, opts.budget, opts.signal, controller)
          : await response.text();
      } catch (error) {
        if (error instanceof HhBudgetError) throw error;
        if (!opts.budget) body = "";
        else throw error;
      }
      const status = response.status;
      const requestId = parseHhErrorBody(body).requestId;

      if (status === 401) {
        log({ status, ms });
        const err = new HhApiError(
          401,
          "Unauthorized — set HH_ACCESS_TOKEN env var with a valid OAuth2 bearer token",
          body,
        );
        err.attempt = attempt;
        throw err;
      }

      if (status === 403) {
        const err = accessErrorFrom403(body);
        err.attempt = attempt;
        if (gated && err.kind === "captcha") {
          noteGatedFailure(err, env);
          logHhEvent(
            "breaker.open",
            {
              cooldownMs: err.retryAfterS ? err.retryAfterS * 1000 : undefined,
              requestId: err.requestId,
            },
            env,
          );
        }
        log({ status, ms, request_id: err.requestId, kind: err.kind });
        throw err;
      }

      if (status === 404 && opts.retryNotFound) {
        notFoundSeen++;
        if (notFoundSeen === 1 && attempt < MAX_RETRIES) {
          log({ status, ms, request_id: requestId, kind: "retrying" });
          delay = Math.max(
            jitterInterval(Math.min(1000 * 2 ** (attempt - 1), 8000)),
            recoveryRetryFloorMs(env),
          );
          console.error(`[hh-mcp] 404 on resume read, one retry in ${delay}ms`);
        } else {
          log({ status, ms, request_id: requestId, kind: "not_found" });
          const err = new HhNotFoundError({
            path,
            topicId: opts.topicId,
            requestId,
            body,
          });
          err.attempt = attempt;
          throw err;
        }
      } else if (status === 429 && attempt < MAX_RETRIES) {
        delay = retryAfterDelay(
          response.headers.get("Retry-After"),
          Math.min(1000 * 2 ** (attempt - 1), 8000),
          Date.now(),
        );
        log({ status, ms, request_id: requestId, kind: "retrying" });
        console.error(
          `[hh-mcp] 429 rate limited, retry in ${delay}ms (${attempt}/${MAX_RETRIES})`,
        );
      } else if (status >= 500 && attempt < MAX_RETRIES) {
        delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        log({ status, ms, request_id: requestId, kind: "retrying" });
        console.error(
          `[hh-mcp] ${status}, retry in ${delay}ms (${attempt}/${MAX_RETRIES})`,
        );
      } else {
        log({ status, ms, request_id: requestId });
        const err =
          status === 429
            ? new HhApiError(429, "Rate limited — all retries exhausted", body)
            : new HhApiError(status, response.statusText, body);
        err.attempt = attempt;
        err.requestId = requestId;
        throw err;
      }
    } catch (error) {
      if (error instanceof HhBudgetError) throw error;
      if (opts.signal?.aborted) throw new HhBudgetError("cancelled");
      if (opts.budget && Date.now() >= opts.budget.deadline) {
        throw new HhBudgetError("duration_budget");
      }
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (isAbort && attempt < MAX_RETRIES) {
        console.error(`[hh-mcp] Timeout, retry (${attempt}/${MAX_RETRIES})`);
        log({ ms: Date.now() - started, kind: "retrying" });
        delay = 0;
      } else {
        const isCaptcha = error instanceof HhAccessError && error.kind === "captcha";
        if (gated && !isCaptcha) noteGatedFailure(error, env);
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (abortFromCaller) opts.signal?.removeEventListener("abort", abortFromCaller);
      if (slot) await slot.release();
    }

    if (delay != null && delay > 0) {
      await waitForDelay(delay, opts.budget, opts.signal);
    }
  }
}

/** Health extras for GET /health. */
export function getClientHealth(): {
  instance: string;
  resumeBudget: ReturnType<typeof getResumeBudgetHealth>;
  captchaBreaker: ReturnType<typeof getCaptchaBreakerHealth>;
} {
  return {
    instance: getInstanceLabel(),
    resumeBudget: getResumeBudgetHealth(),
    captchaBreaker: getCaptchaBreakerHealth(),
  };
}

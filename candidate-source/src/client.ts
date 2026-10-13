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

async function waitForRateLimit(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = rateLimitTail;
  rateLimitTail = previous.then(() => gate);
  await previous;

  try {
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
        await new Promise((r) => setTimeout(r, waitMs));
      }
      trim(Date.now());
    }
    timestamps.push(Date.now());
  } finally {
    release();
  }
}

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
    let slot: GatedSlot | null = null;
    if (gated) {
      ownsProbe = beforeGatedCall(env, { ownsProbe }) || ownsProbe;
      slot = await acquireGatedSlot(env, getGatedPace(env));
      try {
        beforeGatedCall(env, { ownsProbe });
      } catch (err) {
        await slot.release();
        throw err;
      }
    }

    const started = Date.now();
    let delay: number | null = null;
    try {
      await waitForRateLimit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      const headers: Record<string, string> = {
        "HH-User-Agent": USER_AGENT,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      };
      const token = env.HH_ACCESS_TOKEN;
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl(env)}${path}`, {
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - started;

      if (response.ok) {
        const json = await response.json();
        if (gated) onGatedSuccess(env);
        log({ status: response.status, ms });
        return json;
      }

      const body = await response.text().catch(() => "");
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
        const retryAfter = parseInt(response.headers.get("Retry-After") ?? "", 10);
        delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 8000);
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
      if (slot) await slot.release();
    }

    if (delay != null && delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
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

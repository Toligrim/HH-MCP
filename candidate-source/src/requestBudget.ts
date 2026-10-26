export interface HhRequestBudget {
  maxRequests: number;
  deadline: number;
  maxBytes: number;
  requests: number;
  retries: number;
  bytes: number;
}

export type HhBudgetErrorCode =
  | "request_budget"
  | "duration_budget"
  | "byte_budget"
  | "cancelled";

export class HhBudgetError extends Error {
  readonly code: HhBudgetErrorCode;

  constructor(code: HhBudgetErrorCode) {
    const messages: Record<HhBudgetErrorCode, string> = {
      request_budget: "HH request attempt budget exhausted",
      duration_budget: "HH request duration budget exhausted",
      byte_budget: "HH response byte budget exhausted",
      cancelled: "HH request cancelled",
    };
    super(messages[code]);
    this.name = "HhBudgetError";
    this.code = code;
  }
}

export function createHhRequestBudget(
  limits: { max_requests: number; max_duration_sec: number; max_bytes: number },
  now = Date.now(),
): HhRequestBudget {
  if (
    !Number.isSafeInteger(limits.max_requests) || limits.max_requests < 0 ||
    !Number.isFinite(limits.max_duration_sec) || limits.max_duration_sec < 0 ||
    !Number.isSafeInteger(limits.max_bytes) || limits.max_bytes < 0 ||
    !Number.isFinite(now)
  ) {
    throw new RangeError("HH request budget limits must be finite non-negative values");
  }

  return {
    maxRequests: limits.max_requests,
    deadline: now + limits.max_duration_sec * 1000,
    maxBytes: limits.max_bytes,
    requests: 0,
    retries: 0,
    bytes: 0,
  };
}

export function assertHhBudgetAvailable(
  budget: HhRequestBudget,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new HhBudgetError("cancelled");
  if (Date.now() >= budget.deadline) throw new HhBudgetError("duration_budget");
}

export function recordHhRequestAttempt(
  budget: HhRequestBudget,
  retry: boolean,
): void {
  assertHhRequestAvailable(budget);
  budget.requests++;
  if (retry) budget.retries++;
}

export function assertHhRequestAvailable(budget: HhRequestBudget): void {
  if (budget.requests >= budget.maxRequests) {
    throw new HhBudgetError("request_budget");
  }
}

export function recordHhResponseBytes(
  budget: HhRequestBudget,
  bytes: number,
): void {
  budget.bytes += bytes;
  if (budget.bytes > budget.maxBytes) {
    throw new HhBudgetError("byte_budget");
  }
}

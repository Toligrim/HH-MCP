import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hhGet, __resetRateLimitForTests } from "../client.js";
import { __resetCaptchaBreakerForTests } from "../captchaBreaker.js";
import { __resetResumeBudgetForTests } from "../resumeBudget.js";
import { createHhRequestBudget } from "../requestBudget.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function budget(overrides: Partial<{ maxRequests: number; deadline: number; maxBytes: number; requests: number; retries: number; bytes: number }> = {}) {
  return {
    maxRequests: 4,
    deadline: Date.now() + 10_000,
    maxBytes: 1024,
    requests: 0,
    retries: 0,
    bytes: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  mockFetch.mockReset();
  delete process.env.HH_ACCESS_TOKEN;
  process.env.HH_RESUME_MIN_INTERVAL_MS = "0";
  process.env.HH_RESUME_MAX_CONCURRENCY = "5";
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_QUOTA_CHECK = "off";
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HH_ACCESS_TOKEN;
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
  __resetRateLimitForTests();
});

describe("HH request budgets", () => {
  it("creates a shared counter with an absolute deadline and byte cap", () => {
    expect(createHhRequestBudget({ max_requests: 7, max_duration_sec: 2.5, max_bytes: 80 }, 1000)).toEqual({
      maxRequests: 7,
      deadline: 3500,
      maxBytes: 80,
      requests: 0,
      retries: 0,
      bytes: 0,
    });
  });

  it("counts real fetch attempts and retries against one shared budget", async () => {
    const shared = budget({ maxRequests: 2 });
    mockFetch.mockResolvedValueOnce(response(500, "temporary")).mockResolvedValueOnce(jsonResponse({ ok: true }));

    const pending = hhGet("/vacancies", { budget: shared });
    const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toEqual({ value: { ok: true } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(shared).toMatchObject({ requests: 2, retries: 1 });
  });

  it("rejects before fetching when the shared request budget is exhausted", async () => {
    const shared = budget({ maxRequests: 1, requests: 1 });

    const settled = hhGet("/vacancies", { budget: shared }).then(() => undefined, (error: unknown) => error);
    await expect(settled).resolves.toMatchObject({ code: "request_budget" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops a Retry-After wait at the shared deadline without starting another request", async () => {
    const shared = budget({ maxRequests: 4, deadline: Date.now() + 500 });
    mockFetch.mockResolvedValueOnce(response(429, "busy", { "Retry-After": "2" }));

    const pending = hhGet("/vacancies", { budget: shared });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toMatchObject({ code: "duration_budget" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels while waiting for Retry-After and does not retry", async () => {
    const controller = new AbortController();
    const shared = budget();
    mockFetch.mockResolvedValueOnce(response(429, "busy", { "Retry-After": "30" }));

    const pending = hhGet("/vacancies", { budget: shared, signal: controller.signal });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toMatchObject({ code: "cancelled" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("stops in the shared rate queue when its deadline expires", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const firstFive = Array.from({ length: 5 }, () => hhGet("/areas"));
    await vi.runAllTimersAsync();
    await Promise.all(firstFive);
    const callsBeforeWait = mockFetch.mock.calls.length;

    const shared = budget({ deadline: Date.now() + 100 });
    const pending = hhGet("/vacancies", { budget: shared }).then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ code: "duration_budget" });
    expect(mockFetch).toHaveBeenCalledTimes(callsBeforeWait);
  });

  it("cancels in the shared rate queue without fetching", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const firstFive = Array.from({ length: 5 }, () => hhGet("/areas"));
    await vi.runAllTimersAsync();
    await Promise.all(firstFive);
    const callsBeforeWait = mockFetch.mock.calls.length;
    const controller = new AbortController();
    const pending = hhGet("/vacancies", { budget: budget(), signal: controller.signal })
      .then(() => undefined, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    expect(mockFetch).toHaveBeenCalledTimes(callsBeforeWait);
  });

  it("counts streamed response bytes and cancels an overflowing body", async () => {
    const shared = budget({ maxBytes: 3 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"ok\":true}"));
        controller.enqueue(new TextEncoder().encode("!"));
        setTimeout(() => controller.error(new Error("body read interrupted")), 50);
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const settled = hhGet("/vacancies", { budget: shared }).then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toMatchObject({ code: "byte_budget" });
    expect(shared.bytes).toBeGreaterThan(3);
    expect(cancelled).toBe(true);
  });

  it("keeps the request deadline active while the response body is streaming", async () => {
    const shared = budget({ deadline: Date.now() + 100 });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          } catch {
            // The request deadline may cancel this deliberately delayed stream first.
          }
          resolve();
        }, 200));
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const pending = hhGet("/vacancies", { budget: shared });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toMatchObject({ code: "duration_budget" });
  });

  it("cancels an in-progress response body read when the caller aborts", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const pending = hhGet("/vacancies", { budget: budget(), signal: controller.signal });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toMatchObject({ code: "cancelled" });
    expect((mockFetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it.each([401, 403])("does not retry HTTP %i with a request budget", async (status) => {
    mockFetch.mockResolvedValueOnce(response(status, "private upstream detail"));

    const pending = hhGet("/vacancies", { budget: budget() });
    const settled = pending.then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await settled).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a captcha 403 with a request budget", async () => {
    mockFetch.mockResolvedValueOnce(response(403, JSON.stringify({
      errors: [{ value: "captcha_required" }],
    })));

    const pending = hhGet("/resumes/abc", { budget: budget() }).then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After HTTP-date and keeps budget errors free of response details", async () => {
    const shared = budget({ maxRequests: 1 });
    const detail = "secret upstream response body";
    mockFetch.mockResolvedValueOnce(response(429, detail, { "Retry-After": new Date(Date.now() + 2_000).toUTCString() }));

    const pending = hhGet("/vacancies", { budget: shared });
    const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.runAllTimersAsync();

    const { error } = await settled as { error: unknown };
    expect(error).toMatchObject({ code: "request_budget" });
    expect(String(error)).not.toContain(detail);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - 1_800_000_000_000).toBeGreaterThanOrEqual(1500);
  });

  it.each(["-2", "not-a-date"])("uses the bounded fallback for malformed Retry-After %s", async (retryAfter) => {
    mockFetch.mockResolvedValueOnce(response(429, "busy", { "Retry-After": retryAfter }));
    const pending = hhGet("/vacancies", { budget: budget({ maxRequests: 1 }) })
      .then(() => undefined, (error: unknown) => error);

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ code: "request_budget" });
    expect(Date.now() - 1_800_000_000_000).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - 1_800_000_000_000).toBeLessThan(2000);
  });
});

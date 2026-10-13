import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hhGet, HhApiError, HhAccessError, isGatedPath } from "../client.js";
import {
  __resetCaptchaBreakerForTests,
  getCaptchaBreakerHealth,
} from "../captchaBreaker.js";
import { __resetResumeBudgetForTests } from "../resumeBudget.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function ok(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: { get: () => null },
  };
}

function fail(
  status: number,
  statusText = "Error",
  headers: Record<string, string> = {},
  body?: string,
) {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({ error: statusText }),
    text: () => Promise.resolve(body ?? statusText),
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  };
}

const CAPTCHA_BODY = JSON.stringify({
  description: "Forbidden",
  errors: [
    {
      value: "captcha_required",
      fallback_url: "https://hh.ru/resume/x?captcha=true",
      captcha_url: "https://hh.ru/account/captcha?state=1",
      type: "employer_resume_view",
    },
  ],
  request_id: "1790264024790e25aa9eaf6d36496003",
});

let clock = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000;
  vi.setSystemTime(clock);
  mockFetch.mockReset();
  delete process.env.HH_ACCESS_TOKEN;
  process.env.HH_RESUME_MIN_INTERVAL_MS = "0";
  process.env.HH_RESUME_MAX_CONCURRENCY = "5";
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_QUOTA_CHECK = "off";
  process.env.HH_CAPTCHA_COOLDOWN_MS = "60000";
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HH_ACCESS_TOKEN;
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
});

function headersOf(callIndex = 0): Record<string, string> {
  return mockFetch.mock.calls[callIndex]![1]!.headers as Record<string, string>;
}

describe("isGatedPath", () => {
  it("marks unscoped resume reads and search as gated", () => {
    expect(isGatedPath("/resumes/abc")).toBe(true);
    expect(isGatedPath("/resumes?text=x")).toBe(true);
    expect(isGatedPath("/resumes/abc/negotiations_history")).toBe(true);
  });

  it("treats topic_id-scoped resume reads as normal", () => {
    expect(isGatedPath("/resumes/abc?topic_id=1")).toBe(false);
    expect(isGatedPath("/resumes/abc?topic_id=1&vacancy_id=2")).toBe(false);
  });
});

describe("auth + required headers", () => {
  it("sends HH-User-Agent and User-Agent, omits Authorization without a token", async () => {
    mockFetch.mockResolvedValueOnce(ok({ a: 1 }));
    const p = hhGet("/areas");
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ a: 1 });
    const h = headersOf();
    expect(h["HH-User-Agent"]).toMatch(/hh-mcp\//);
    expect(h["User-Agent"]).toBeTruthy();
    expect(h["Authorization"]).toBeUndefined();
  });

  it("adds a Bearer Authorization header when HH_ACCESS_TOKEN is set", async () => {
    process.env.HH_ACCESS_TOKEN = "tok123";
    mockFetch.mockResolvedValueOnce(ok({}));
    const p = hhGet("/me");
    await vi.runAllTimersAsync();
    await p;
    expect(headersOf()["Authorization"]).toBe("Bearer tok123");
  });
});

describe("error handling", () => {
  it("fails fast on 401 without retrying", async () => {
    mockFetch.mockResolvedValueOnce(fail(401, "Unauthorized"));
    await expect(hhGet("/resumes")).rejects.toBeInstanceOf(HhApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies captcha_required 403 without claiming a scope problem", async () => {
    mockFetch.mockResolvedValueOnce(fail(403, "Forbidden", {}, CAPTCHA_BODY));
    let caught: unknown;
    const p = hhGet("/resumes/abc").catch((e) => {
      caught = e;
    });
    await vi.runAllTimersAsync();
    await p;
    expect(caught).toBeInstanceOf(HhAccessError);
    const err = caught as HhAccessError;
    expect(err.kind).toBe("captcha");
    expect(err.requestId).toBe("1790264024790e25aa9eaf6d36496003");
    expect(err.message).toMatch(/капчу/i);
    expect(err.message).not.toMatch(/scope/i);
    expect(err.toStructured().hh).toMatchObject({
      kind: "captcha",
      request_id: "1790264024790e25aa9eaf6d36496003",
    });

    // Breaker open — next gated call fails fast with zero network.
    mockFetch.mockClear();
    let denied: unknown;
    const p2 = hhGet("/resumes/abc").catch((e) => {
      denied = e;
    });
    await vi.runAllTimersAsync();
    await p2;
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(denied).toBeInstanceOf(HhAccessError);
    expect((denied as HhAccessError).kind).toBe("captcha");
    expect(getCaptchaBreakerHealth().state).toBe("open");
  });

  it("fails fast on plain 403 without retrying", async () => {
    mockFetch.mockResolvedValueOnce(
      fail(403, "Forbidden", {}, '{"errors":[{"value":"forbidden"}]}'),
    );
    let caught: unknown;
    const p = hhGet("/areas").catch((e) => {
      caught = e;
    });
    await vi.runAllTimersAsync();
    await p;
    expect(caught).toMatchObject({ status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx then throws HhApiError after MAX_RETRIES", async () => {
    mockFetch.mockResolvedValue(fail(500, "Server Error"));
    const p = hhGet("/vacancies");
    const assertion = expect(p).rejects.toMatchObject({ status: 500 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("rate limit + retries", () => {
  it("honors Retry-After on 429 and then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(fail(429, "Too Many Requests", { "Retry-After": "0" }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const p = hhGet("/vacancies");
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries once on an aborted/timed-out request then succeeds", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    mockFetch.mockRejectedValueOnce(abortErr).mockResolvedValueOnce(ok({ done: true }));
    const p = hhGet("/vacancies");
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ done: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("lets a burst of calls through (serializing extras past the 5 req/s window)", async () => {
    mockFetch.mockResolvedValue(ok({}));
    const started: number[] = [];
    mockFetch.mockImplementation(() => {
      started.push(Date.now());
      return Promise.resolve(ok({}));
    });
    const ps = Array.from({ length: 7 }, () => hhGet("/x"));
    await vi.runAllTimersAsync();
    await Promise.all(ps);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    const sorted = [...started].sort((a, b) => a - b);
    expect(sorted[5]! - sorted[0]!).toBeGreaterThanOrEqual(1000);
  });
});

describe("gated resume budget", () => {
  it("spaces gated starts by HH_RESUME_MIN_INTERVAL_MS", async () => {
    process.env.HH_RESUME_MIN_INTERVAL_MS = "1500";
    process.env.HH_RESUME_MAX_CONCURRENCY = "1";
    __resetResumeBudgetForTests();

    const started: number[] = [];
    mockFetch.mockImplementation(() => {
      started.push(Date.now());
      return Promise.resolve(ok({}));
    });

    const p1 = hhGet("/resumes/a");
    const p2 = hhGet("/resumes/b");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);
    expect(started.length).toBe(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(1200); // 1500 ±20% jitter
  });

  it("makes the incident burst (30 views / 6s) impossible at defaults", async () => {
    process.env.HH_RESUME_MIN_INTERVAL_MS = "1500";
    process.env.HH_RESUME_MAX_CONCURRENCY = "1";
    __resetResumeBudgetForTests();
    mockFetch.mockResolvedValue(ok({}));

    const started: number[] = [];
    mockFetch.mockImplementation(() => {
      started.push(Date.now());
      return Promise.resolve(ok({}));
    });

    const ps = Array.from({ length: 5 }, (_, i) => hhGet(`/resumes/r${i}`));
    // Advance enough for 5 * 1.5s
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    await Promise.all(ps);
    expect(started.length).toBe(5);
    expect(started[4]! - started[0]!).toBeGreaterThanOrEqual(1500 * 4);
    // 5 starts with 1.5s spacing cannot fit in 6s for 30 views — density check:
    const window = 6000;
    let maxInWindow = 0;
    for (let i = 0; i < started.length; i++) {
      const end = started[i]! + window;
      const count = started.filter((t) => t >= started[i]! && t <= end).length;
      maxInWindow = Math.max(maxInWindow, count);
    }
    expect(maxInWindow).toBeLessThan(30);
  });
});

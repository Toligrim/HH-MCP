import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hhGet } from "../client.js";
import { appendLedger, summarizeUsage } from "../requestLog.js";
import { handleGetResume, getResumeSchema } from "../tools/resumes.js";
import {
  getManagerResumeLimitsSchema,
  handleGetManagerResumeLimits,
} from "../tools/employers.js";
import {
  __resetQuotaCacheForTests,
  fetchResumeQuota,
  getLastKnownQuota,
} from "../quota.js";
import { handleHhUsageReport } from "../tools/diagnostics.js";
import { mergeBreaker, __resetResumeBudgetForTests } from "../resumeBudget.js";
import { __resetCaptchaBreakerForTests } from "../captchaBreaker.js";

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

function fail(status: number, body = "{}", statusText = "Error") {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

let tmp: string;
let clock = 1_900_000_000_000;

const ENV_KEYS = [
  "HH_ACCESS_TOKEN",
  "HH_REQUIRE_TOPIC",
  "HH_INSTANCE",
  "HH_USER_AGENT",
  "HTTP_PORT",
  "HH_LEDGER_FILE",
  "HH_LOG_DIR",
  "HH_QUOTA_CHECK",
  "HH_QUOTA_PATH_TTL_MS",
  "HH_QUOTA_STALE_MS",
  "HH_DEBUG",
  "HH_BUDGET_FILE",
  "HH_CACHE_DIR",
  "HH_CACHE_TTL_MS",
  "HH_RESUME_MIN_INTERVAL_MS",
  "HH_RESUME_MAX_CONCURRENCY",
  "HH_RESUME_MAX_PER_WINDOW",
];

beforeEach(() => {
  vi.useFakeTimers();
  clock += 3_600_000;
  vi.setSystemTime(clock);
  mockFetch.mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-r-"));
  process.env.HH_ACCESS_TOKEN = "tok";
  process.env.HH_RESUME_MIN_INTERVAL_MS = "0";
  process.env.HH_RESUME_MAX_CONCURRENCY = "5";
  process.env.HH_RESUME_MAX_PER_WINDOW = "0";
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_LEDGER_FILE = path.join(tmp, "ledger.jsonl");
  process.env.HH_LOG_DIR = path.join(tmp, "logs");
  process.env.HH_QUOTA_CHECK = "off";
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
  __resetQuotaCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) delete process.env[k];
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
  __resetQuotaCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function logRows(): Record<string, unknown>[] {
  const dir = process.env.HH_LOG_DIR!;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => readJsonl(path.join(dir, f)));
}

describe("R-1: HH_REQUIRE_TOPIC on get_resume", () => {
  it("blocks unscoped reads before the network and ledgers skipped", async () => {
    process.env.HH_REQUIRE_TOPIC = "1";
    await expect(handleGetResume({ resume_id: "abc123" })).rejects.toThrow(/topic_id/);
    expect(mockFetch).not.toHaveBeenCalled();
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "skipped", reason: "no topic_id" });
    expect(ledger.some((r) => r.status === "unscoped")).toBe(false);
  });

  it("allow_unscoped performs one read and marks scope_explicit", async () => {
    process.env.HH_REQUIRE_TOPIC = "1";
    mockFetch.mockResolvedValueOnce(ok({ id: "abc123", title: "Dev" }));
    const parsed = getResumeSchema.parse({
      resume_id: "abc123",
      allow_unscoped: true,
      raw: true,
    });
    await handleGetResume(parsed);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger.some((r) => r.status === "unscoped" && r.scope_explicit === true)).toBe(
      true,
    );
  });

  it("keeps 3.0.0 behaviour when the flag is off", async () => {
    mockFetch.mockResolvedValueOnce(ok({ id: "abc123" }));
    await handleGetResume({ resume_id: "abc123", raw: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger.some((r) => r.status === "unscoped")).toBe(true);
    expect(ledger.some((r) => r.scope_explicit === true)).toBe(false);
  });
});

describe("R-2 / R-3: instance split and search reads", () => {
  it("summarizeUsage splits instances and treats missing instance as unknown", () => {
    process.env.HH_INSTANCE = "3011";
    appendLedger({ resume_id: "a", status: "unscoped" });
    process.env.HH_INSTANCE = "3012";
    appendLedger({ kind: "search", path: "/resumes?text=x", status: "ok", http_status: 200 });
    appendLedger({ kind: "search", path: "/resumes?area=1", status: "ok", http_status: 200 });
    appendLedger({ kind: "search", path: "/resumes?text=y", status: "ok", http_status: 200 });
    const raw = fs.readFileSync(process.env.HH_LEDGER_FILE!, "utf8");
    fs.writeFileSync(
      process.env.HH_LEDGER_FILE!,
      raw +
        JSON.stringify({
          ts: new Date().toISOString(),
          resume_id: "old",
          status: "ok",
        }) +
        "\n",
    );
    const u = summarizeUsage();
    expect(u.viewsToday).toBe(2);
    expect(u.searchReadsToday).toBe(3);
    expect(u.gatedReadsToday).toBe(5);
    expect(u.gatedReadsTodayByInstance["3011"]).toBe(1);
    expect(u.gatedReadsTodayByInstance["3012"]).toBe(3);
    expect(u.gatedReadsTodayByInstance.unknown).toBe(1);
  });

  it("hh_usage_report raw exposes the split counters", async () => {
    process.env.HH_INSTANCE = "3012";
    appendLedger({ resume_id: "a", status: "unscoped" });
    appendLedger({ kind: "search", path: "/resumes?q=1", status: "ok" });
    appendLedger({ kind: "search", path: "/resumes?q=2", status: "ok" });
    appendLedger({ kind: "search", path: "/resumes?q=3", status: "ok" });
    const raw = JSON.parse(await handleHhUsageReport({ raw: true })) as {
      usage: { viewsToday: number; searchReadsToday: number };
      quota: { stale?: boolean };
    };
    expect(raw.usage.viewsToday).toBe(1);
    expect(raw.usage.searchReadsToday).toBe(3);
    expect(raw.quota.stale).toBe(true);
  });
});

describe("R-4: employer/manager ids", () => {
  it("rejects 0 before any network call", () => {
    expect(() =>
      getManagerResumeLimitsSchema.parse({ employer_id: "0", manager_id: "0" }),
    ).toThrow(/positive numeric/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves missing ids via /me then hits limits/resume", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).endsWith("/me")) {
        return Promise.resolve(
          ok({ employer: { id: "919758" }, manager: { id: "12108711" } }),
        );
      }
      if (String(url).includes("/limits/resume")) {
        return Promise.resolve(ok({ left: 10 }));
      }
      return Promise.resolve(fail(404));
    });
    await handleGetManagerResumeLimits({ raw: true });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/me"))).toBe(true);
    expect(urls.some((u) => u.includes("/employers/919758/managers/12108711/limits/resume"))).toBe(
      true,
    );
  });

  it("errors clearly when /me has no manager.id", async () => {
    mockFetch.mockResolvedValueOnce(ok({ employer: { id: "1" } }));
    await expect(handleGetManagerResumeLimits({})).rejects.toThrow(/validate_token/);
  });
});

describe("R-5: quota freshness and probe mute", () => {
  const quotaBody = {
    left: { resume_view: 499 },
    limits: { resume_view: 500 },
    spend: { resume_view: 1 },
  };

  it("does not log probe-404 and remembers the bad path", async () => {
    delete process.env.HH_QUOTA_CHECK;
    process.env.HH_QUOTA_PATH_TTL_MS = "3600000";
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/me")) {
        return Promise.resolve(ok({ employer: { id: "1" }, manager: { id: "2" } }));
      }
      if (u.includes("resume_view_limits")) return Promise.resolve(fail(404));
      if (u.includes("/limits/resume")) return Promise.resolve(ok(quotaBody));
      return Promise.resolve(fail(500));
    });
    const q1 = await fetchResumeQuota();
    expect(q1).toEqual({ left: 499, limit: 500, spend: 1 });
    expect(logRows().some((r) => r.event === "quota.path.probe")).toBe(false);
    const firstLimits = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/limits/resume"),
    ).length;
    const firstBad = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("resume_view_limits"),
    ).length;
    expect(firstBad).toBe(1);
    expect(firstLimits).toBe(1);

    vi.setSystemTime(Date.now() + 6 * 60_000);
    const q2 = await fetchResumeQuota();
    expect(q2?.left).toBe(499);
    const badAgain = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("resume_view_limits"),
    ).length;
    expect(badAgain).toBe(1);
  });

  it("marks stale quota and reports н/д when none is known", async () => {
    const text = await handleHhUsageReport();
    expect(text).toMatch(/Квота: н\/д/);
    const raw = JSON.parse(await handleHhUsageReport({ raw: true })) as {
      quota: { stale: boolean; refreshedAt: string | null };
    };
    expect(raw.quota.stale).toBe(true);
    expect(raw.quota.refreshedAt).toBeNull();
  });

  it("refreshes when last known quota is older than TTL", async () => {
    delete process.env.HH_QUOTA_CHECK;
    process.env.HH_QUOTA_STALE_MS = "1000";
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/me")) {
        return Promise.resolve(ok({ employer: { id: "1" }, manager: { id: "2" } }));
      }
      if (u.includes("/limits/resume")) return Promise.resolve(ok(quotaBody));
      return Promise.resolve(fail(404));
    });
    await fetchResumeQuota();
    expect(getLastKnownQuota()?.stale).toBe(false);
    vi.setSystemTime(Date.now() + 2000);
    expect(getLastKnownQuota()?.stale).toBe(true);
    mockFetch.mockClear();
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/me")) {
        return Promise.resolve(ok({ employer: { id: "1" }, manager: { id: "2" } }));
      }
      if (u.includes("/limits/resume")) return Promise.resolve(ok(quotaBody));
      return Promise.resolve(fail(404));
    });
    const raw = JSON.parse(await handleHhUsageReport({ raw: true })) as {
      quota: { stale: boolean; quota: { left: number } };
    };
    expect(raw.quota.quota.left).toBe(499);
    expect(raw.quota.stale).toBe(false);
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("R-6: writer list age prune", () => {
  it("drops writer pids older than 24h", () => {
    const now = Date.now();
    const merged = mergeBreaker(
      {
        state: "closed",
        writers: ["host:13052", "host:5952"],
        writerSeen: {
          "host:13052": now - 25 * 3600_000,
          "host:5952": now - 60_000,
        },
      },
      { state: "closed", writers: ["host:5952"] },
      now,
    );
    expect(merged.writers).toEqual(["host:5952"]);
  });
});

describe("hhGet still works for a normal resume path", () => {
  it("isGated unscoped resume still fetches", async () => {
    mockFetch.mockResolvedValueOnce(ok({ id: "r" }));
    await hhGet("/resumes/r");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

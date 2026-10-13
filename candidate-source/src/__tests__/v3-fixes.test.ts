import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hhGet, HhAccessError, HhNotFoundError } from "../client.js";
import {
  __resetCaptchaBreakerForTests,
  beforeGatedCall,
  getGatedPace,
  onGatedSuccess,
  openBreakerFromBody,
} from "../captchaBreaker.js";
import {
  __resetResumeBudgetForTests,
  mergeBreaker,
  writeSharedBreaker,
} from "../resumeBudget.js";
import { readResumeCache } from "../resumeCache.js";
import { appendLedger, logHhEvent, logHhRequest, summarizeUsage } from "../requestLog.js";
import { fetchResume } from "../tools/resumes.js";
import { handleCollectVacancyResumes, handleGetResumes, getResumesSchema } from "../tools/batch.js";

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

function fail(status: number, body = "", statusText = "Error") {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

const CAPTCHA_BODY = JSON.stringify({
  errors: [
    {
      value: "captcha_required",
      type: "employer_resume_view",
      fallback_url: "https://hh.ru/resume/x?captcha=true",
    },
  ],
  request_id: "rq-captcha-1",
});

let tmp: string;
let clock = 1_800_000_000_000;

const ENV_KEYS = [
  "HH_ACCESS_TOKEN",
  "HH_RESUME_MIN_INTERVAL_MS",
  "HH_RESUME_MAX_CONCURRENCY",
  "HH_RESUME_MAX_PER_WINDOW",
  "HH_RESUME_WINDOW_MS",
  "HH_BUDGET_FILE",
  "HH_CACHE_DIR",
  "HH_CACHE_TTL_MS",
  "HH_QUOTA_CHECK",
  "HH_LEDGER_FILE",
  "HH_LOG_DIR",
  "HH_CAPTCHA_COOLDOWN_MS",
  "HH_CAPTCHA_RECOVERY_MS",
  "HH_CAPTCHA_RECOVERY_STEP_MS",
  "HH_EXPORT_DIR",
];

beforeEach(() => {
  vi.useFakeTimers();
  clock += 3_600_000;
  vi.setSystemTime(clock);
  mockFetch.mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-v3-"));
  process.env.HH_ACCESS_TOKEN = "tok";
  process.env.HH_RESUME_MIN_INTERVAL_MS = "0";
  process.env.HH_RESUME_MAX_CONCURRENCY = "5";
  process.env.HH_RESUME_MAX_PER_WINDOW = "0";
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_QUOTA_CHECK = "off";
  process.env.HH_CAPTCHA_COOLDOWN_MS = "60000";
  process.env.HH_LEDGER_FILE = path.join(tmp, "ledger.jsonl");
  process.env.HH_LOG_DIR = path.join(tmp, "logs");
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) delete process.env[k];
  __resetCaptchaBreakerForTests();
  __resetResumeBudgetForTests();
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

async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 200 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return tracked;
}

function resumeIdFromUrl(url: string): string {
  return /\/resumes\/([^?]+)/.exec(url)![1]!;
}

describe("P0-3: transient 404 on resume reads", () => {
  it("retries a 404 once and succeeds; logs attempt 2 and one ok ledger row", async () => {
    mockFetch
      .mockResolvedValueOnce(fail(404, "{}", "Not Found"))
      .mockResolvedValueOnce(ok({ id: "r1" }));
    const res = await drive(
      fetchResume({ resume_id: "r1", topic_id: "5", forceGated: true }),
    );
    expect(res.payload).toEqual({ id: "r1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const final = logRows().find((r) => r.status === 200);
    expect(final).toMatchObject({ attempt: 2, retry: true });
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "ok" });
  });

  it("404 twice → not_found with request_id, no cache write", async () => {
    process.env.HH_CACHE_TTL_MS = "86400000";
    process.env.HH_CACHE_DIR = path.join(tmp, "cache");
    mockFetch.mockResolvedValue(fail(404, '{"request_id":"rq404"}', "Not Found"));
    let caught: unknown;
    await drive(
      fetchResume({ resume_id: "r2", topic_id: "6", forceGated: true }).catch((e) => {
        caught = e;
      }),
    );
    expect(caught).toBeInstanceOf(HhNotFoundError);
    expect((caught as HhNotFoundError).message).toMatch(/404 дважды/);
    expect((caught as HhNotFoundError).requestId).toBe("rq404");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(readResumeCache({ resumeId: "r2", topicId: "6" })).toBeNull();
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger[0]).toMatchObject({ status: "not_found", http_status: 404, attempt: 2 });
  });

  it("does not retry 404 on non-resume endpoints", async () => {
    mockFetch.mockResolvedValue(fail(404, "{}", "Not Found"));
    await drive(hhGet("/vacancies/1").catch(() => undefined));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("P0-6: retries go back through the breaker", () => {
  it("does not hit the network when the shared breaker opens between attempts", async () => {
    process.env.HH_BUDGET_FILE = path.join(tmp, "budget.json");
    mockFetch.mockImplementationOnce(() => {
      const now = Date.now();
      writeSharedBreaker({
        state: "open",
        openedAt: now,
        cooldownMs: 120_000,
        openUntil: now + 120_000,
        failures: 1,
        requestId: "rq-other",
        fallbackUrl: "https://hh.ru/resume/y?captcha=true",
        sourceInstance: "other:1",
      });
      return Promise.resolve(fail(500, "", "Server Error"));
    });
    let caught: unknown;
    await drive(
      hhGet("/resumes/a").catch((e) => {
        caught = e;
      }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(HhAccessError);
    const err = caught as HhAccessError;
    expect(err.kind).toBe("captcha");
    expect(err.breakerDenied).toBe(true);
    expect(err.retryAfterS).toBeGreaterThan(100);
    expect(err.fallbackUrl).toMatch(/captcha=true/);
  });
});

describe("P0-5: sliding window limiter", () => {
  it("holds the (N+1)-th gated start until the window frees a slot", async () => {
    process.env.HH_RESUME_MAX_PER_WINDOW = "3";
    process.env.HH_RESUME_WINDOW_MS = "60000";
    const started: number[] = [];
    mockFetch.mockImplementation(() => {
      started.push(Date.now());
      return Promise.resolve(ok({}));
    });
    const ps = Array.from({ length: 4 }, (_, i) => hhGet(`/resumes/w${i}`));
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all(ps);
    expect(started).toHaveLength(4);
    expect(started[3]! - started[0]!).toBeGreaterThanOrEqual(60_000);
  });
});

describe("P0-4: monotonic shared breaker", () => {
  it("a closed write cannot erase another instance's open cooldown", () => {
    const now = Date.now();
    const shared = { state: "open" as const, openedAt: now, cooldownMs: 60_000, openUntil: now + 60_000, failures: 1 };
    expect(mergeBreaker(shared, { state: "closed", closedAt: now }, now).state).toBe("open");
    const shorter = mergeBreaker(
      shared,
      { state: "open", openedAt: now, cooldownMs: 10_000, openUntil: now + 10_000, failures: 1 },
      now,
    );
    expect(shorter.openUntil).toBe(now + 60_000);
  });

  it("a second instance fails fast with the original captcha details", () => {
    process.env.HH_BUDGET_FILE = path.join(tmp, "budget.json");
    openBreakerFromBody(CAPTCHA_BODY);
    __resetCaptchaBreakerForTests(); // "instance B": fresh local state, same file
    let denied: unknown;
    try {
      beforeGatedCall();
    } catch (e) {
      denied = e;
    }
    expect(denied).toBeInstanceOf(HhAccessError);
    expect((denied as HhAccessError).requestId).toBe("rq-captcha-1");
    expect((denied as HhAccessError).fallbackUrl).toMatch(/captcha=true/);
    expect((denied as HhAccessError).retryAfterS).toBeGreaterThan(0);
  });

  it("respects a half-open probe held by another instance", () => {
    const file = path.join(tmp, "budget.json");
    process.env.HH_BUDGET_FILE = file;
    fs.writeFileSync(
      file,
      JSON.stringify({
        lastStartMs: 0,
        inflight: 0,
        windowStarts: [],
        breaker: { state: "half-open", failures: 1, probeBy: "other:1", probeAt: Date.now() },
      }),
    );
    expect(() => beforeGatedCall()).toThrow(/probe in flight/);
  });
});

describe("P1-2: recovery mode after captcha", () => {
  it("doubles the interval (first step ≥ RECOVERY_STEP) for 10 reads, then returns to normal", () => {
    process.env.HH_RESUME_MIN_INTERVAL_MS = "1500";
    process.env.HH_RESUME_MAX_PER_WINDOW = "20";
    openBreakerFromBody(CAPTCHA_BODY);
    vi.setSystemTime(Date.now() + 61_000);
    expect(beforeGatedCall()).toBe(true); // half-open probe
    onGatedSuccess();
    expect(getGatedPace()).toEqual({ minIntervalMs: 5000, maxPerWindow: 10 });
    onGatedSuccess();
    expect(getGatedPace().minIntervalMs).toBe(3000);
    for (let i = 0; i < 9; i++) onGatedSuccess();
    expect(getGatedPace()).toEqual({ minIntervalMs: 1500, maxPerWindow: 20 });
  });
});

describe("P1-3: usage report on the 29.09 incident fixture", () => {
  function writeFixture() {
    for (let i = 0; i < 30; i++) appendLedger({ resume_id: `s${i}`, topic_id: `${i}`, status: "ok" });
    appendLedger({ resume_id: "2a06", topic_id: "5606959341", status: "captcha", kind: "captcha", request_id: "rq-captcha-1" });
    for (let i = 0; i < 12; i++) appendLedger({ resume_id: `b${i}`, topic_id: `${i}`, status: "ok" });
    for (let i = 0; i < 5; i++) appendLedger({ resume_id: `u${i}`, status: "unscoped" });
    for (let i = 0; i < 25; i++) appendLedger({ resume_id: `c${i}`, topic_id: `${i}`, status: "cached" });
    for (let i = 0; i < 5; i++) {
      appendLedger({ resume_id: `n${i}`, topic_id: `${i}`, status: "not_found", http_status: 404, attempt: 2, retry: true });
    }
    appendLedger({ resume_id: "d1", topic_id: "1", status: "captcha", kind: "captcha", breaker_denied: true });
    logHhEvent("breaker.open", { cooldownMs: 60000, requestId: "rq-captcha-1" });
    logHhRequest({ path: "/resumes/2a06?topic_id=5606959341", status: 403, gated: true, kind: "captcha", request_id: "rq-captcha-1", attempt: 1 });
  }

  it("counts captcha once, separates breaker opens and denials, reports unscoped/not_found", () => {
    writeFixture();
    const u = summarizeUsage();
    expect(u.source).toBe("ledger");
    expect(u.captchaCount).toBe(1);
    expect(u.breakerOpens).toBe(1);
    expect(u.breakerDenied).toBe(1);
    expect(u.unscoped).toBe(5);
    expect(u.notFound).toBe(5);
    expect(u.cacheHits).toBe(25);
    expect(u.retried).toBe(5);
    expect(u.failedByStatus).toMatchObject({ "403": 1, "404": 5 });
    // 30 + 1 + 12 + 5 + 5 network reads; cached and denied are not reads.
    expect(Object.values(u.perHour).reduce((a, b) => a + b, 0)).toBe(53);
    expect(u.gatedReadsToday).toBe(53);
  });

  it("log-only source does not double-count the captcha", () => {
    delete process.env.HH_LEDGER_FILE;
    writeFixture();
    const u = summarizeUsage();
    expect(u.source).toBe("log");
    expect(u.captchaCount).toBe(1);
    expect(u.breakerOpens).toBe(1);
  });
});

describe("P0-1 / P0-2: get_resumes input safety and export", () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(ok({ id: resumeIdFromUrl(url), last_name: "Иванов", title: "Техник" })),
    );
  });

  it("rejects items together with resume_ids before any request", async () => {
    const params = getResumesSchema.parse({
      items: [{ resume_id: "a", topic_id: "1" }],
      resume_ids: ["a"],
    });
    await expect(handleGetResumes(params)).rejects.toThrow(/not both/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails fast on a typo in topics keys and names both ids", async () => {
    const good = "d8871c4d0008ff48ce0001e0b96a3666656967";
    const typo = "d8871c4d0008ff48ce00001e0b96a3666656656967";
    const params = getResumesSchema.parse({
      resume_ids: ["aaa", good],
      topics: { aaa: "1", [typo]: "2" },
      vacancy_id: "136230668",
    });
    const err = await handleGetResumes(params).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(good);
    expect((err as Error).message).toContain(typo);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("require_topic skips uncovered ids without touching the network", async () => {
    const params = getResumesSchema.parse({
      resume_ids: ["a", "b"],
      topics: { a: "1" },
      require_topic: true,
      raw: true,
    });
    const out = JSON.parse(await drive(handleGetResumes(params))) as {
      counts: Record<string, number>;
      rows: Array<{ resume_id: string; status: string; reason?: string }>;
    };
    expect(out.counts.skipped).toBe(1);
    expect(out.rows.find((r) => r.resume_id === "b")).toMatchObject({ status: "skipped", reason: "no topic_id" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("marks an unscoped read as unscoped (not ok) in the reply and ledger", async () => {
    const params = getResumesSchema.parse({
      resume_ids: ["a", "b"],
      topics: { a: "1" },
      raw: true,
    });
    const out = JSON.parse(await drive(handleGetResumes(params))) as {
      counts: Record<string, number>;
      warning?: string;
    };
    expect(out.counts).toMatchObject({ ok: 1, unscoped: 1 });
    expect(out.warning).toMatch(/платную базу/);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.find((u) => u.includes("/resumes/b"))).not.toMatch(/topic_id/);
    const ledger = readJsonl(process.env.HH_LEDGER_FILE!);
    expect(ledger.map((r) => r.status).sort()).toEqual(["ok", "unscoped"]);
  });

  it("writes raw files + manifest + csv for >10 ids and is idempotent", async () => {
    const outDir = path.join(tmp, "out");
    const items = Array.from({ length: 12 }, (_, i) => ({ resume_id: `r${i}`, topic_id: `${100 + i}` }));
    const params = getResumesSchema.parse({ items, vacancy_id: "1", out_dir: outDir, raw: true });
    const out = JSON.parse(await drive(handleGetResumes(params))) as {
      counts: Record<string, number>;
      files: Array<{ file: string; bytes: number }>;
      note: string;
    };
    expect(out.counts.ok).toBe(12);
    expect(out.files).toHaveLength(12);
    expect(out.note).toMatch(/files written to/);
    expect(fs.readdirSync(path.join(outDir, "raw"))).toHaveLength(12);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")) as unknown[];
    expect(manifest).toHaveLength(12);
    expect(fs.readFileSync(path.join(outDir, "negotiations.csv"), "utf8")).toContain("Иванов");

    mockFetch.mockClear();
    const again = JSON.parse(await drive(handleGetResumes(params))) as { counts: Record<string, number> };
    expect(again.counts.cached).toBe(12);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("P1-5: collect_vacancy_resumes id-based cursor", () => {
  it("survives insertions between calls without gaps or double reads, and re-reads broken raw files", async () => {
    const outDir = path.join(tmp, "collect");
    const neg = (id: number, created: string) => ({
      id: String(id),
      created_at: created,
      resume: { id: `res${id}`, first_name: "A", last_name: "B", title: "T" },
    });
    let listing = [
      neg(1, "2026-09-01T10:00:00"),
      neg(2, "2026-09-02T10:00:00"),
      neg(3, "2026-09-05T10:00:00"),
      neg(4, "2026-09-06T10:00:00"),
      neg(5, "2026-09-07T10:00:00"),
    ];
    const resumeReads: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/negotiations/")) {
        return Promise.resolve(ok({ items: listing, pages: 1 }));
      }
      const u = new URL(url);
      resumeReads.push(`${resumeIdFromUrl(url)}#${u.searchParams.get("topic_id")}`);
      return Promise.resolve(ok({ id: resumeIdFromUrl(url) }));
    });

    const first = JSON.parse(
      await drive(
        handleCollectVacancyResumes({ vacancy_id: "9", max: 2, out_dir: outDir, raw: true } as never),
      ),
    ) as { cursor?: string; remaining: number };
    expect(resumeReads).toEqual(["res1#1", "res2#2"]);
    expect(first.remaining).toBe(3);
    expect(first.cursor).toBeTruthy();

    listing = [
      ...listing.slice(0, 2),
      neg(10, "2026-09-03T10:00:00"),
      neg(11, "2026-09-03T11:00:00"),
      neg(12, "2026-09-04T10:00:00"),
      ...listing.slice(2),
    ];
    // Corrupt one already-exported file: it must be re-read.
    fs.writeFileSync(path.join(outDir, "raw", "res2__2.json"), "");

    const second = JSON.parse(
      await drive(
        handleCollectVacancyResumes({
          vacancy_id: "9",
          max: 100,
          out_dir: outDir,
          cursor: first.cursor,
          raw: true,
        } as never),
      ),
    ) as { remaining: number; processed_total: number; cursor?: string };
    expect(second.remaining).toBe(0);
    expect(second.processed_total).toBe(8);
    expect(second.cursor).toBeUndefined();
    const reads = resumeReads.slice(2);
    expect(reads.sort()).toEqual(
      ["res2#2", "res10#10", "res11#11", "res12#12", "res3#3", "res4#4", "res5#5"].sort(),
    );
    expect(new Set(reads).size).toBe(reads.length);
  });
});

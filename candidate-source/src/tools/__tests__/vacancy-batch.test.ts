import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVacanciesBatch, getVacanciesBatchSchema } from "../vacancyBatch.js";
import { createHhRequestBudget } from "../../requestBudget.js";

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("get_vacancies_batch", () => {
  it("validates positive digit IDs, deduplicates, and rejects injection or more than 20 IDs", () => {
    expect(getVacanciesBatchSchema.safeParse({ ids: ["123", "123"] }).success).toBe(true);
    expect(getVacanciesBatchSchema.safeParse({ ids: ["0"] }).success).toBe(false);
    expect(getVacanciesBatchSchema.safeParse({ ids: ["12/evil"] }).success).toBe(false);
    expect(getVacanciesBatchSchema.safeParse({ ids: Array.from({ length: 21 }, (_, i) => String(i + 1)) }).success).toBe(false);
  });

  it("returns 404 per ID but stops after a forbidden card and marks all remaining IDs", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/1")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({}, 404);
      }
      return jsonResponse({ errors: [{ value: "captcha_required" }] }, 403);
    }));
    const result = await fetchVacanciesBatch(["1", "2", "3"]);
    expect(result.items.map((item) => item.status)).toEqual(["not_found", "forbidden", "error"]);
    expect(result.items[2]?.error?.code).toBe("stopped_forbidden");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("captcha_required");
  });

  it("limits concurrent requests to two and shares the supplied attempt budget", async () => {
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const id = String(url).split("/").at(-1);
      return jsonResponse({ id });
    }));
    const budget = createHhRequestBudget({ max_requests: 2, max_duration_sec: 2, max_bytes: 100_000 });
    const result = await fetchVacanciesBatch(["1", "2", "3"], { budget });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(budget.requests).toBe(2);
    expect(result.items).toHaveLength(3);
    expect(result.items[2]?.status).toBe("error");
    expect(result.items[2]?.error?.code).toMatch(/budget/);
  });

  it("keeps description HTML and extracts text while enforcing the UTF-8 output cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "42", description: "<p>Работа в <b>чате</b></p>" })));
    const result = await fetchVacanciesBatch(["42"]);
    expect(result.items[0]?.status).toBe("ok");
    if (result.items[0]?.status === "ok") {
      expect(result.items[0].description_html).toBe("<p>Работа в <b>чате</b></p>");
      expect(result.items[0].description_text).toContain("Работа в чате");
    }
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "43", description: "x".repeat(70_000) })));
    const oversized = await fetchVacanciesBatch(["43"]);
    expect(oversized.items[0]?.status).toBe("error");
    expect(oversized.items[0]?.error?.code).toBe("response_too_large");
  });

  it("never returns a card whose HH response ID differs from the requested ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "999", description: "foreign" })));
    const result = await fetchVacanciesBatch(["42"]);
    expect(result.items[0]?.status).toBe("error");
    expect(result.items[0]?.error?.code).toBe("id_mismatch");
    expect(JSON.stringify(result)).not.toContain("foreign");
  });

  it("rejects a cap too small to represent all error rows before making requests", async () => {
    const fetch = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetch);
    const budget = createHhRequestBudget({ max_requests: 0, max_duration_sec: 2, max_bytes: 100_000 });
    await expect(fetchVacanciesBatch(Array.from({ length: 20 }, (_, index) => String(index + 1)), { max_response_bytes: 1024, budget })).rejects.toThrow(/cap/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops dispatching after 401 and marks undispatched IDs with stopped_auth", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/1")) return jsonResponse({ secret: "private upstream body" }, 401);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ id: "2" });
    }));
    const result = await fetchVacanciesBatch(["1", "2", "3"]);
    expect(calls).toHaveLength(2);
    expect(result.items[0]?.error?.status).toBe(401);
    expect(result.items[2]?.error?.code).toBe("stopped_auth");
    expect(JSON.stringify(result)).not.toContain("private upstream body");
  });
});

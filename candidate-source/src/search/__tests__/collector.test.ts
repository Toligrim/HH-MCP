import { describe, expect, it, vi } from "vitest";
import { HhAccessError, HhApiError } from "../../hhErrors.js";
import { assertHhBudgetAvailable, createHhRequestBudget, HhBudgetError, recordHhRequestAttempt, recordHhResponseBytes, type HhRequestBudget } from "../../requestBudget.js";
import { planSearch } from "../planner.js";
import { collectSearch } from "../collector.js";

const limits = { max_requests: 100, max_items: 6000, max_duration_sec: 60, max_bytes: 5_000_000, max_detail_fetches: 0 };
const plan = (native: Record<string, unknown> = {}) => planSearch({ native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z", ...native }, limits }, Date.UTC(2026, 0, 2));
const vacancy = (id: string) => ({ id, name: `Vacancy ${id}`, published_at: "2026-01-01T00:01:00+0000" });
function page(found: number, ids: string[], pages = Math.ceil(found / 100)) { return { found, pages, items: ids.map(vacancy) }; }
function injected(getter: (path: string) => unknown) {
  const budget = createHhRequestBudget({ max_requests: 1000, max_duration_sec: 60, max_bytes: 5_000_000 });
  const get = vi.fn(async (path: string, options?: { budget?: typeof budget }) => {
    if (options?.budget) { assertHhBudgetAvailable(options.budget); recordHhRequestAttempt(options.budget, options.budget.requests > 0); recordHhResponseBytes(options.budget, Buffer.byteLength(JSON.stringify(getter(path)))); }
    return getter(path);
  });
  return { get, budget };
}

describe("deep collector coverage and resume", () => {
  it.each([0, 1, 1999, 2000, 2001, 5138])( "records found=%i honestly within HH's 2000-result pagination cap", async (found) => {
    const { get } = injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const pageNo = Number(url.searchParams.get("page") ?? 0);
      const count = Math.min(100, Math.max(0, found - pageNo * 100));
      return page(found, Array.from({ length: count }, (_, i) => String(100000 + pageNo * 100 + i)), Math.min(20, Math.ceil(found / 100)));
    });
    const result = await collectSearch(plan(), { get: get as never });
    expect(result.manifest.found).toBe(found);
    if (found > 2000) expect(result.manifest.status).toBe("PARTIAL");
    if (found <= 2000) expect(result.manifest.status).toBe("COMPLETE");
  });

  it("retains first page hits, deduplicates overlap, and records branch provenance", async () => {
    const search = page(2501, ["7", "8"]);
    const { get } = injected(() => search);
    const multi = planSearch({ native: { area: 1, date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" }, branches: [{ name: "a", native: { text: "a" } }, { name: "b", native: { text: "b" } }], limits }, Date.UTC(2026, 0, 2));
    const result = await collectSearch(multi, { get: get as never });
    expect(result.items.map((item) => item.id)).toEqual(["7", "8"]);
    expect([...new Set(result.items[0]!.provenance.map((p) => p.branch))]).toEqual(["a", "b"]);
    expect(result.manifest.branches.map((b) => b.total_ids)).toEqual([2, 2]);
  });

  it("keeps cross-page duplicate hits partial and preserves their provenance", async () => {
    const base = plan();
    const { get } = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      return page(150, pageNo === 0
        ? Array.from({ length: 100 }, (_, i) => String(i + 1))
        : Array.from({ length: 50 }, (_, i) => String(i + 96)));
    });

    const result = await collectSearch(base, { get: get as never });

    expect(result.status).toBe("PARTIAL");
    expect(result.manifest.found).toBe(150);
    expect(result.manifest.known_items).toBe(145);
    expect(result.items.find((item) => item.id === "96")?.provenance).toHaveLength(1);
    expect(result.manifest.gaps.some((gap) => gap.code === "duplicate_vacancy_id")).toBe(true);
    expect(result.manifest.gaps.some((gap) => gap.code === "coverage_mismatch")).toBe(true);

    const noRequests = vi.fn();
    const resumed = await collectSearch(base, { checkpoint: result.checkpoint, get: noRequests as never });
    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("PARTIAL");
    expect(resumed.manifest.gaps.some((gap) => gap.code === "duplicate_vacancy_id")).toBe(true);

    const legacy = structuredClone(result.checkpoint);
    legacy.status = "COMPLETE";
    legacy.gaps = [];
    for (const part of legacy.partitions) {
      delete (part as unknown as Record<string, unknown>).observed_items;
      delete (part as unknown as Record<string, unknown>).duplicate_items;
      delete (part as unknown as Record<string, unknown>).invalid_items;
      delete (part as unknown as Record<string, unknown>).coverage_invalid;
    }
    const legacyResume = await collectSearch(base, { checkpoint: legacy, get: noRequests as never });
    expect(legacyResume.status).toBe("PARTIAL");
    expect(legacyResume.manifest.gaps.some((gap) => gap.code === "coverage_mismatch")).toBe(true);
  });

  it("keeps an intra-page duplicate from becoming complete", async () => {
    const { get } = injected(() => page(3, ["1", "1", "2"]));
    const result = await collectSearch(plan(), { get: get as never });

    expect(result.status).toBe("PARTIAL");
    expect(result.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(result.manifest.gaps.some((gap) => gap.code === "duplicate_vacancy_id")).toBe(true);
  });

  it("keeps invalid canonical IDs from being treated as leaf hits", async () => {
    const { get } = injected(() => ({ found: 1, pages: 1, items: [{ id: "0", name: "Invalid ID" }] }));
    const result = await collectSearch(plan(), { get: get as never });

    expect(result.status).toBe("PARTIAL");
    expect(result.items).toEqual([]);
    expect(result.manifest.gaps.some((gap) => gap.code === "invalid_vacancy_id")).toBe(true);
    expect(result.manifest.gaps.some((gap) => gap.code === "coverage_mismatch")).toBe(true);
  });

  it("keeps an overfull first page partial even when its retained IDs equal found", async () => {
    const { get } = injected(() => page(100, Array.from({ length: 150 }, (_, i) => String(30_000 + i)), 1));
    const result = await collectSearch(plan(), { get: get as never });

    expect(result.status).toBe("PARTIAL");
    expect(result.items).toHaveLength(100);
    expect(result.manifest.gaps.some((gap) => gap.code === "long_page")).toBe(true);
  });

  it("counts legitimate sibling overlap once when terminal leaves cover the parent result", async () => {
    const long = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const leftIds = Array.from({ length: 1251 }, (_, i) => String(20_000 + i));
    const rightIds = Array.from({ length: 1251 }, (_, i) => String(21_250 + i));
    const get = injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === long.frozen_date_bounds.date_from
        && url.searchParams.get("date_to") === long.frozen_date_bounds.date_to;
      const pageNo = Number(url.searchParams.get("page") ?? 0);
      if (root) return page(2501, leftIds.slice(0, 100), 20);
      const ids = url.searchParams.get("date_from") === long.frozen_date_bounds.date_from ? leftIds : rightIds;
      return page(ids.length, ids.slice(pageNo * 100, (pageNo + 1) * 100));
    });

    const result = await collectSearch(long, { get: get.get as never });

    expect(result.status).toBe("COMPLETE");
    expect(result.manifest.found).toBe(2501);
    expect(result.manifest.known_items).toBe(2501);
    expect(result.manifest.gaps).toEqual([]);
    expect(result.items.find((item) => item.id === "21250")?.provenance.map((p) => p.partition_id)).toHaveLength(2);
  });

  it("detects split-parent versus completed-leaf index drift and keeps the diagnostic on resume", async () => {
    const long = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const get = injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === long.frozen_date_bounds.date_from
        && url.searchParams.get("date_to") === long.frozen_date_bounds.date_to;
      return root ? page(2501, Array.from({ length: 100 }, (_, i) => String(500 + i)), 20) : page(1, ["500"]);
    });
    const first = await collectSearch(long, { get: get.get as never });

    expect(first.status).toBe("PARTIAL");
    expect(first.manifest.known_items).toBe(100);
    expect(first.manifest.gaps.some((gap) => gap.code === "coverage_mismatch" && gap.partition_id === "1")).toBe(true);

    const legacyLooking = structuredClone(first.checkpoint);
    legacyLooking.status = "COMPLETE";
    legacyLooking.gaps = legacyLooking.gaps.filter((gap) => gap.code !== "coverage_mismatch");
    for (const part of legacyLooking.partitions) {
      delete (part as unknown as Record<string, unknown>).observed_items;
      delete (part as unknown as Record<string, unknown>).duplicate_items;
      delete (part as unknown as Record<string, unknown>).invalid_items;
      delete (part as unknown as Record<string, unknown>).coverage_invalid;
    }
    const noRequests = vi.fn();
    const resumed = await collectSearch(long, { checkpoint: legacyLooking, get: noRequests as never });
    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("PARTIAL");
    expect(resumed.manifest.gaps.some((gap) => gap.code === "coverage_mismatch" && gap.partition_id === "1")).toBe(true);
  });

  it("rejects changed signatures and resumes cumulative request counters", async () => {
    const base = plan();
    const { get } = injected(() => page(1, ["9"]));
    const checkpoints: unknown[] = [];
    const first = await collectSearch(base, { get: get as never, onCheckpoint: async (cp) => { checkpoints.push(structuredClone(cp)); } });
    expect(checkpoints.length).toBeGreaterThan(0);
    await expect(collectSearch(plan({ text: "different" }), { checkpoint: first.checkpoint, get: get as never })).rejects.toThrow(/signature/i);
    const next = await collectSearch(base, { checkpoint: first.checkpoint, get: get as never });
    expect(next.checkpoint.counters.requests).toBeGreaterThanOrEqual(first.checkpoint.counters.requests);
  });

  it("splits overloaded windows with a 5-minute overlap and keeps the parent's first-page hit", async () => {
    const long = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const { get } = injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === long.frozen_date_bounds.date_from && url.searchParams.get("date_to") === long.frozen_date_bounds.date_to;
      return root ? page(2501, Array.from({ length: 100 }, (_, i) => String(500 + i)), 20) : page(1, ["500"]);
    });
    const result = await collectSearch(long, { get: get as never });
    expect(result.checkpoint.partitions.filter((p) => p.parent_id)).toHaveLength(2);
    expect(result.items.find((item) => item.id === "500")!.provenance.length).toBeGreaterThan(1);
    const [left, right] = result.checkpoint.partitions.filter((p) => p.parent_id);
    expect(Date.parse(left!.date_to) - Date.parse(right!.date_from)).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("persists the split transition with the overloaded first-page checkpoint", async () => {
    const long = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const get = vi.fn(async (path: string, options?: { budget?: HhRequestBudget }) => {
      if (options?.budget) { recordHhRequestAttempt(options.budget, options.budget.requests > 0); recordHhResponseBytes(options.budget, 100); }
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === long.frozen_date_bounds.date_from && url.searchParams.get("date_to") === long.frozen_date_bounds.date_to;
      return root ? page(2501, Array.from({ length: 100 }, (_, i) => String(1500 + i)), 20) : page(0, []);
    });
    let saved: import("../collector.js").CollectorCheckpoint | undefined;
    await expect(collectSearch(long, { get: get as never, onCheckpoint: async (state) => {
      if (state.partitions.length === 3 && state.partitions[0]!.first_page_done) { saved = structuredClone(state); throw new Error("persisted split boundary"); }
    } })).rejects.toThrow(/onCheckpoint persistence failed/);
    expect(saved!.partitions).toHaveLength(3);
    const resumed = await collectSearch(long, { checkpoint: saved, get: get as never });
    expect(resumed.checkpoint.partitions.filter((part) => part.parent_id)).toHaveLength(2);
    expect(resumed.manifest.gaps.some((gap) => gap.code === "interrupted_http_unknown")).toBe(false);
  });

  it("resumes a persisted page cursor without resetting attempts or active time", async () => {
    const base = plan();
    const { get } = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      return pageNo === 0 ? page(101, Array.from({ length: 100 }, (_, i) => String(700 + i))) : page(101, ["900"]);
    });
    let saved: import("../collector.js").CollectorCheckpoint | undefined;
    await expect(collectSearch(base, { get: get as never, onCheckpoint: async (state) => {
      saved = structuredClone(state);
      if (state.partitions[0]?.first_page_done && state.partitions[0]?.page === 1) throw new Error("simulated process loss after safe page checkpoint");
    } })).rejects.toThrow(/onCheckpoint persistence failed/);
    expect(saved!.counters.requests).toBe(1);
    expect(saved!.partitions[0]).toMatchObject({ status: "running", first_page_done: true, page: 1, pages: 2 });
    const resumed = await collectSearch(base, { checkpoint: saved, get: get as never });
    expect(resumed.checkpoint.counters.requests).toBe(2);
    expect(resumed.checkpoint.counters.active_elapsed_ms).toBeGreaterThanOrEqual(saved!.counters.active_elapsed_ms);
    expect(resumed.checkpoint.interrupted_http_unknown).toBe(true);
    expect(resumed.manifest.gaps.some((gap) => gap.code === "interrupted_http_unknown")).toBe(true);
  });

  it("retries a failed 5xx partition only after explicit resume and clears its resolved gap", async () => {
    const base = plan();
    let attempts = 0;
    const get = vi.fn(async (_path: string, options?: { budget?: HhRequestBudget }) => {
      if (options?.budget) { assertHhBudgetAvailable(options.budget); recordHhRequestAttempt(options.budget, options.budget.requests > 0); recordHhResponseBytes(options.budget, 10); }
      if (attempts++ === 0) throw new HhApiError(503, "Unavailable");
      return page(0, []);
    });
    const first = await collectSearch(base, { get: get as never });
    expect(first.status).toBe("PARTIAL");
    expect(first.checkpoint.partitions[0]).toMatchObject({ status: "failed", page: 0, first_page_done: false });
    expect(first.checkpoint.counters.requests).toBe(1);
    const resumed = await collectSearch(base, { checkpoint: first.checkpoint, get: get as never });
    expect(get).toHaveBeenCalledTimes(2);
    expect(resumed.status).toBe("COMPLETE");
    expect(resumed.checkpoint.counters.requests).toBe(2);
    expect(resumed.checkpoint.counters.retries).toBeGreaterThanOrEqual(first.checkpoint.counters.retries);
    expect(resumed.checkpoint.counters.bytes).toBeGreaterThanOrEqual(first.checkpoint.counters.bytes);
    expect(resumed.manifest.gaps).toEqual([]);
  });

  it("resumes a transient continuation failure at its saved page without losing earlier hits", async () => {
    const base = plan();
    let continuationAttempts = 0;
    const get = vi.fn(async (path: string, options?: { budget?: HhRequestBudget }) => {
      if (options?.budget) { assertHhBudgetAvailable(options.budget); recordHhRequestAttempt(options.budget, options.budget.requests > 0); recordHhResponseBytes(options.budget, 10); }
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      if (pageNo === 0) return page(101, Array.from({ length: 100 }, (_, i) => String(100 + i)), 2);
      if (continuationAttempts++ === 0) throw new HhApiError(500, "Server Error");
      return page(101, ["999"], 2);
    });
    const first = await collectSearch(base, { get: get as never });
    expect(first.items).toHaveLength(100);
    expect(first.checkpoint.partitions[0]).toMatchObject({ status: "failed", first_page_done: true, page: 1 });
    const resumed = await collectSearch(base, { checkpoint: first.checkpoint, get: get as never });
    expect(get.mock.calls).toHaveLength(3);
    expect(resumed.items).toHaveLength(101);
    expect(resumed.items.some((item) => item.id === "999")).toBe(true);
    expect(resumed.checkpoint.counters.requests).toBe(3);
    expect(resumed.status).toBe("COMPLETE");
  });

  it("resumes a transport failure but leaves forbidden and exhausted-budget partitions terminal", async () => {
    const base = plan();
    let networkAttempts = 0;
    const networkGet = vi.fn(async (_path: string, options?: { budget?: HhRequestBudget }) => {
      if (options?.budget) { assertHhBudgetAvailable(options.budget); recordHhRequestAttempt(options.budget, options.budget.requests > 0); }
      if (networkAttempts++ === 0) throw new TypeError("network connection reset");
      return page(0, []);
    });
    const networkFailure = await collectSearch(base, { get: networkGet as never });
    const networkResumed = await collectSearch(base, { checkpoint: networkFailure.checkpoint, get: networkGet as never });
    expect(networkResumed.status).toBe("COMPLETE");
    expect(networkGet).toHaveBeenCalledTimes(2);

    const forbiddenGet = injected(() => { throw new HhApiError(403, "Forbidden"); });
    const forbidden = await collectSearch(base, { get: forbiddenGet.get as never });
    const forbiddenResumed = await collectSearch(base, { checkpoint: forbidden.checkpoint, get: forbiddenGet.get as never });
    expect(forbiddenGet.get).toHaveBeenCalledTimes(1);
    expect(forbiddenResumed.checkpoint.partitions[0]?.status).toBe("failed");

    const oneRequest = planSearch({ native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" }, limits: { ...limits, max_requests: 1 } }, Date.UTC(2026, 0, 2));
    const exhaustedGet = injected((path) => {
      if (new URL(path, "https://api.hh.ru").searchParams.get("page") === "1") return page(101, [], 2);
      return page(101, Array.from({ length: 100 }, (_, i) => String(2000 + i)), 2);
    });
    const exhausted = await collectSearch(oneRequest, { get: exhaustedGet.get as never });
    const callsAfterExhaustion = exhaustedGet.get.mock.calls.length;
    const exhaustedResumed = await collectSearch(oneRequest, { checkpoint: exhausted.checkpoint, get: exhaustedGet.get as never });
    expect(exhausted.checkpoint.partitions[0]?.status).toBe("failed");
    expect(exhaustedResumed.checkpoint.partitions[0]?.status).toBe("failed");
    expect(exhaustedResumed.checkpoint.counters.requests).toBe(1);
    expect(exhaustedGet.get).toHaveBeenCalledTimes(callsAfterExhaustion);

    const lastAttemptPlan = planSearch({ native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" }, limits: { ...limits, max_requests: 1 } }, Date.UTC(2026, 0, 2));
    const lastAttemptGet = injected(() => { throw new HhApiError(503, "Unavailable"); });
    const lastAttempt = await collectSearch(lastAttemptPlan, { get: lastAttemptGet.get as never });
    const callsAtCap = lastAttemptGet.get.mock.calls.length;
    const lastAttemptResumed = await collectSearch(lastAttemptPlan, { checkpoint: lastAttempt.checkpoint, get: lastAttemptGet.get as never });
    expect(lastAttemptResumed.checkpoint.partitions[0]?.status).toBe("failed");
    expect(lastAttemptResumed.checkpoint.counters.requests).toBe(1);
    expect(lastAttemptGet.get).toHaveBeenCalledTimes(callsAtCap);
  });

  it.each([
    ["script", `<script>Linux is required.</script><p>Public description has no technology requirement.</p>`],
    ["style", `<style>Linux is required.</style><p>Public description has no technology requirement.</p>`],
  ])("filters hidden %s text through canonical HTML cleanup", async (_kind, description) => {
    const filtered = planSearch({ native: {}, post_filters: [{ rule: "required_technology", value: "Linux" }], details: "none", limits: { ...limits, max_detail_fetches: 1 } }, Date.UTC(2026, 0, 2));
    const { get } = injected((path) => path.startsWith("/vacancies/") ? { id: "42", description } : page(1, ["42"]));
    const result = await collectSearch(filtered, { get: get as never });
    expect(result.items[0]?.filtering?.state).toBe("unknown");
    expect(result.items[0]?.filtering?.rules[0]?.state).toBe("unknown");
    expect(result.items[0]?.raw_detail).toBeUndefined();
  });

  it("uses visible HTML as filter evidence and preserves original detail HTML", async () => {
    const filtered = planSearch({ native: {}, post_filters: [{ rule: "required_technology", value: "Linux" }], details: "full", limits: { ...limits, max_detail_fetches: 1 } }, Date.UTC(2026, 0, 2));
    const description = `<p>Linux is required for this role.</p>`;
    const { get } = injected((path) => path.startsWith("/vacancies/") ? { id: "42", description } : page(1, ["42"]));
    const result = await collectSearch(filtered, { get: get as never });
    expect(result.items[0]?.filtering?.rules[0]?.state).toBe("match");
    expect(result.items[0]?.raw_detail?.description).toBe(description);
  });

  it("requires full cards for postfilters even when raw details are not retained", async () => {
    const filtered = planSearch({ native: {}, post_filters: [{ rule: "no_mandatory_phone_calls" }], details: "none", limits: { ...limits, max_detail_fetches: 1 } }, Date.UTC(2026, 0, 2));
    const { get } = injected((path) => path.startsWith("/vacancies/") ? { id: "42", description: "Contact the team." } : page(1, ["42"]));
    const result = await collectSearch(filtered, { get: get as never });
    expect(get.mock.calls.map((call) => call[0])).toContain("/vacancies/42");
    expect(result.checkpoint.counters.detail_fetches).toBe(1);
    expect(result.items[0]!.raw_detail).toBeUndefined();
    expect(result.items[0]!.filtering?.state).toBe("unknown");
  });

  it("does not reread successfully evaluated cards after details:none checkpoint resume", async () => {
    const filtered = planSearch({ native: {}, post_filters: [{ rule: "no_mandatory_phone_calls" }], details: "none", limits: { ...limits, max_detail_fetches: 2 } }, Date.UTC(2026, 0, 2));
    const { get } = injected((path) => path.startsWith("/vacancies/") ? { id: "43", description: "Contact the team." } : page(1, ["43"]));
    let saved: import("../collector.js").CollectorCheckpoint | undefined;
    await expect(collectSearch(filtered, { get: get as never, onCheckpoint: async (state) => {
      if (state.items[0]?.detail_checked) { saved = structuredClone(state); throw new Error("process loss after detail"); }
    } })).rejects.toThrow(/onCheckpoint persistence failed/);
    const countBefore = get.mock.calls.length;
    const resumed = await collectSearch(filtered, { checkpoint: saved, get: get as never });
    expect(get.mock.calls.length).toBe(countBefore);
    expect(resumed.checkpoint.counters.detail_fetches).toBe(1);
  });

  it("can resume a CANCELLED checkpoint from the pending page cursor", async () => {
    const base = plan();
    const abort = new AbortController();
    abort.abort();
    const cancelled = await collectSearch(base, { signal: abort.signal, get: injected(() => { throw new HhBudgetError("cancelled"); }).get as never });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.checkpoint.partitions[0]!.status).toBe("pending");
    const resumed = await collectSearch(base, { checkpoint: cancelled.checkpoint, get: injected(() => page(0, [])).get as never });
    expect(resumed.checkpoint.partitions[0]!.status).toBe("done");
    expect(resumed.manifest.gaps.some((gap) => gap.code === "cancelled")).toBe(false);
  });

  it("enforces cumulative item, byte, and deadline budgets with explicit partial coverage", async () => {
    const oneItem = planSearch({ native: {}, limits: { ...limits, max_items: 1 } }, Date.UTC(2026, 0, 2));
    const itemResult = await collectSearch(oneItem, { get: injected(() => page(2, ["1", "2"])).get as never });
    expect(itemResult.items).toHaveLength(1);
    expect(itemResult.manifest.gaps.some((gap) => gap.code === "item_budget")).toBe(true);

    const tinyBytes = planSearch({ native: {}, limits: { ...limits, max_bytes: 1 } }, Date.UTC(2026, 0, 2));
    const byteResult = await collectSearch(tinyBytes, { get: injected(() => page(1, ["3"])).get as never });
    expect(byteResult.status).toBe("PARTIAL");
    expect(byteResult.manifest.gaps.some((gap) => gap.code === "byte_budget")).toBe(true);
    expect(byteResult.checkpoint.counters.bytes).toBeGreaterThan(1);

    const shortTime = planSearch({ native: {}, limits: { ...limits, max_duration_sec: 0.001 } }, Date.UTC(2026, 0, 2));
    const slowGet = vi.fn(async (_path: string, options?: { budget?: HhRequestBudget }) => {
      if (options?.budget) { assertHhBudgetAvailable(options.budget); recordHhRequestAttempt(options.budget, false); }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options?.budget) assertHhBudgetAvailable(options.budget);
      return page(0, []);
    });
    const timeResult = await collectSearch(shortTime, { get: slowGet as never });
    expect(timeResult.status).toBe("PARTIAL");
    expect(timeResult.manifest.gaps.some((gap) => gap.code === "duration_budget")).toBe(true);
  });

  it("stops other branches on 429 but can record a 5xx partition failure and continue", async () => {
    const multi = planSearch({ native: {}, branches: [{ name: "one", native: { text: "one" } }, { name: "two", native: { text: "two" } }], limits }, Date.UTC(2026, 0, 2));
    const throttled = injected(() => { throw new HhApiError(429, "Too Many Requests"); });
    const stopped = await collectSearch(multi, { get: throttled.get as never });
    expect(throttled.get).toHaveBeenCalledTimes(1);
    expect(stopped.manifest.gaps.some((gap) => gap.code === "http_429")).toBe(true);

    let calls = 0;
    const transient = injected(() => { if (calls++ === 0) throw new HhApiError(500, "Server Error"); return page(0, []); });
    const continued = await collectSearch(multi, { get: transient.get as never });
    expect(transient.get).toHaveBeenCalledTimes(2);
    expect(continued.manifest.partitions.some((partition) => partition.status === "failed")).toBe(true);
  });

  it("keeps short or changing pagination metadata incomplete", async () => {
    const changing = plan();
    const { get } = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      return pageNo === 0 ? page(101, Array.from({ length: 100 }, (_, i) => String(800 + i)), 2) : page(99, [], 1);
    });
    const result = await collectSearch(changing, { get: get as never });
    expect(result.status).toBe("PARTIAL");
    expect(result.manifest.gaps.map((gap) => gap.code)).toContain("found_changed");
    expect(result.manifest.gaps.map((gap) => gap.code)).toContain("pages_changed");
  });

  it.each([99, 102])("retains found observations and reports upward or downward index drift to %i", async (nextFound) => {
    const get = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      if (pageNo === 0) return page(101, Array.from({ length: 100 }, (_, i) => String(10_000 + i)), 2);
      return { found: nextFound, pages: 2, items: nextFound < 101 ? [] : [vacancy("10099"), vacancy("10100")] };
    });
    const result = await collectSearch(plan(), { get: get.get as never });

    expect(result.status).toBe("PARTIAL");
    expect(result.checkpoint.partitions[0]?.found_history).toEqual([101, nextFound]);
    expect(result.manifest.gaps.some((gap) => gap.code === "found_changed")).toBe(true);
  });

  it("marks a short continuation page partial and retains prior page hits", async () => {
    const { get } = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      return pageNo === 0 ? page(101, Array.from({ length: 100 }, (_, i) => String(1000 + i)), 2) : page(101, [], 2);
    });
    const result = await collectSearch(plan(), { get: get as never });
    expect(result.status).toBe("PARTIAL");
    expect(result.items).toHaveLength(100);
    expect(result.manifest.gaps.map((gap) => gap.code)).toContain("short_page");
  });

  it("rejects corrupted checkpoint counters and plan content before requests", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(0, [])).get as never });
    const corrupt = structuredClone(first.checkpoint);
    corrupt.counters.requests = -1;
    const get = vi.fn();
    await expect(collectSearch(base, { checkpoint: corrupt, get: get as never })).rejects.toThrow(/counter/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects malformed partition dates and item provenance before requests", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(0, [])).get as never });
    const badDate = structuredClone(first.checkpoint);
    badDate.partitions[0]!.date_from = "not-a-date";
    badDate.partitions[0]!.status = "pending";
    badDate.partitions[0]!.page = 0;
    badDate.partitions[0]!.first_page_done = false;
    const get = vi.fn();
    await expect(collectSearch(base, { checkpoint: badDate, get: get as never })).rejects.toThrow(/partition/i);
    expect(get).not.toHaveBeenCalled();

    const badItem = structuredClone(first.checkpoint);
    badItem.items.push({ id: "7", raw_search: {}, provenance: [{ branch: "missing", partition_id: "1", fetched_at: "invalid" }], first_fetched_at: "invalid", last_fetched_at: "invalid" } as never);
    badItem.counters.items = 1;
    const secondGet = vi.fn();
    await expect(collectSearch(base, { checkpoint: badItem, get: secondGet as never })).rejects.toThrow(/item/i);
    expect(secondGet).not.toHaveBeenCalled();
  });

  it("loads old v1 checkpoints from provenance and rejects repeated global item IDs", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(1, ["7"])).get as never });
    const old = structuredClone(first.checkpoint);
    for (const part of old.partitions) {
      delete (part as unknown as Record<string, unknown>).observed_items;
      delete (part as unknown as Record<string, unknown>).duplicate_items;
      delete (part as unknown as Record<string, unknown>).invalid_items;
      delete (part as unknown as Record<string, unknown>).coverage_invalid;
    }
    const noRequests = vi.fn();
    const resumed = await collectSearch(base, { checkpoint: old, get: noRequests as never });
    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("COMPLETE");

    const duplicateId = structuredClone(first.checkpoint);
    duplicateId.items.push(structuredClone(duplicateId.items[0]!));
    duplicateId.counters.items = duplicateId.items.length;
    const rejectedGet = vi.fn();
    await expect(collectSearch(base, { checkpoint: duplicateId, get: rejectedGet as never })).rejects.toThrow(/duplicate global checkpoint item/i);
    expect(rejectedGet).not.toHaveBeenCalled();
  });

  it("does not trust coverage counters that disagree with stored provenance", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(1, ["17"])).get as never });
    const invalid = structuredClone(first.checkpoint);
    const partition = invalid.partitions[0] as unknown as Record<string, unknown>;
    partition.observed_items = 2;
    partition.duplicate_items = 0;
    partition.invalid_items = 0;
    const noRequests = vi.fn();

    const resumed = await collectSearch(base, { checkpoint: invalid, get: noRequests as never });

    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("PARTIAL");
    expect(resumed.manifest.gaps.some((gap) => gap.code === "coverage_state_invalid")).toBe(true);
  });

  it("counts duplicate provenance aliases once when reconstructing a leaf membership set", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(1, ["18"])).get as never });
    const alias = structuredClone(first.checkpoint);
    alias.items[0]!.provenance.push({ ...alias.items[0]!.provenance[0]! });
    const noRequests = vi.fn();

    const resumed = await collectSearch(base, { checkpoint: alias, get: noRequests as never });

    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("COMPLETE");
    expect(resumed.manifest.gaps).toEqual([]);
  });

  it("splits an exactly 15-minute overloaded window when both children strictly shrink", async () => {
    const quarter = plan({ date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:15:00Z" });
    const { get } = injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      return url.searchParams.get("page") === "0" && url.searchParams.get("date_from") === quarter.frozen_date_bounds.date_from && url.searchParams.get("date_to") === quarter.frozen_date_bounds.date_to
        ? page(2501, Array.from({ length: 100 }, (_, i) => String(3000 + i)), 20)
        : page(0, []);
    });
    const result = await collectSearch(quarter, { get: get as never });
    const children = result.checkpoint.partitions.filter((part) => part.parent_id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => Date.parse(child.date_to) - Date.parse(child.date_from) < 15 * 60_000)).toBe(true);
  });

  it("stops all remaining execution branches after a forbidden response", async () => {
    const multi = planSearch({ native: {}, branches: [{ name: "one", native: { text: "one" } }, { name: "two", native: { text: "two" } }], limits }, Date.UTC(2026, 0, 2));
    const { get } = injected(() => { throw new HhAccessError({ status: 403, kind: "unknown", statusText: "forbidden" }); });
    const result = await collectSearch(multi, { get: get as never });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("PARTIAL");
    expect(result.manifest.gaps.some((gap) => gap.code === "request_failed" || gap.code === "forbidden")).toBe(true);
  });

  it("keeps branch-specific date bounds on the actual execution request", async () => {
    const multi = planSearch({ native: {}, branches: [{ name: "recent", native: { period: 7 } }], limits }, Date.UTC(2026, 0, 8));
    const { get } = injected(() => page(0, []));
    await collectSearch(multi, { get: get as never });
    const request = new URL(get.mock.calls[0]![0], "https://api.hh.ru");
    expect(request.searchParams.get("date_from")).toBe(multi.branches[0]!.native.date_from);
    expect(request.searchParams.get("date_from")).not.toBe(multi.frozen_date_bounds.date_from);
  });

  it("executes branch period against frozen current even when base bounds are historical", async () => {
    const multi = planSearch({ native: { area: 1, date_from: "2020-01-01", date_to: "2020-01-31" }, branches: [{ name: "recent", native: { period: 7 } }], limits }, Date.UTC(2026, 0, 8));
    const { get } = injected(() => page(0, []));
    await collectSearch(multi, { get: get as never });
    const request = new URL(get.mock.calls[0]![0], "https://api.hh.ru");
    expect(request.searchParams.get("date_from")).toBe("2026-01-01T00:00:00+0000");
    expect(request.searchParams.get("date_to")).toBe("2026-01-08T00:00:00+0000");
    expect(request.searchParams.get("area")).toBe("1");
  });

  it("allows a PARTIAL checkpoint with pending branches to resume", async () => {
    const multi = planSearch({ native: {}, branches: [{ name: "one", native: { text: "one" } }, { name: "two", native: { text: "two" } }], limits }, Date.UTC(2026, 0, 2));
    const first = await collectSearch(multi, { get: injected(() => { throw new HhAccessError({ status: 403, kind: "unknown", statusText: "forbidden" }); }).get as never });
    expect(first.status).toBe("PARTIAL");
    const resumed = await collectSearch(multi, { checkpoint: first.checkpoint, get: injected(() => page(0, [])).get as never });
    expect(resumed.checkpoint.partitions.every((part) => part.status !== "pending")).toBe(true);
  });

  it("rejects a missing execution root before issuing requests", async () => {
    const multi = planSearch({ native: {}, branches: [{ name: "one", native: { text: "one" } }, { name: "two", native: { text: "two" } }], limits }, Date.UTC(2026, 0, 2));
    const first = await collectSearch(multi, { get: injected(() => page(0, [])).get as never });
    const missing = structuredClone(first.checkpoint);
    missing.partitions = [];
    const get = vi.fn();
    await expect(collectSearch(multi, { checkpoint: missing, get: get as never })).rejects.toThrow(/partition|queue|root/i);
    expect(get).not.toHaveBeenCalled();

    const missingBranch = structuredClone(first.checkpoint);
    missingBranch.partitions.splice(0, 1);
    const secondGet = vi.fn();
    await expect(collectSearch(multi, { checkpoint: missingBranch, get: secondGet as never })).rejects.toThrow(/partition|queue|root/i);
    expect(secondGet).not.toHaveBeenCalled();

    const splitPlan = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const split = await collectSearch(splitPlan, { get: injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === splitPlan.frozen_date_bounds.date_from && url.searchParams.get("date_to") === splitPlan.frozen_date_bounds.date_to;
      return root ? page(2501, [], 20) : page(0, []);
    }).get as never });
    const missingChild = structuredClone(split.checkpoint);
    missingChild.partitions.splice(missingChild.partitions.findIndex((part) => part.parent_id !== undefined), 1);
    const thirdGet = vi.fn();
    await expect(collectSearch(splitPlan, { checkpoint: missingChild, get: thirdGet as never })).rejects.toThrow(/split|partition|queue/i);
    expect(thirdGet).not.toHaveBeenCalled();
  });

  it("rejects split checkpoints with less than five minutes of child overlap before requests", async () => {
    const splitPlan = planSearch({ native: {}, limits }, Date.UTC(2026, 0, 2));
    const split = await collectSearch(splitPlan, { get: injected((path) => {
      const url = new URL(path, "https://api.hh.ru");
      const root = url.searchParams.get("date_from") === splitPlan.frozen_date_bounds.date_from && url.searchParams.get("date_to") === splitPlan.frozen_date_bounds.date_to;
      return root ? page(2501, [], 20) : page(0, []);
    }).get as never });
    const children = split.checkpoint.partitions.filter((part) => part.parent_id !== undefined);
    expect(Date.parse(children[0]!.date_to) - Date.parse(children[1]!.date_from)).toBeGreaterThanOrEqual(5 * 60_000);

    for (const overlapMs of [0, 4 * 60_000]) {
      const malformed = structuredClone(split.checkpoint);
      const malformedChildren = malformed.partitions.filter((part) => part.parent_id !== undefined);
      const rightFrom = Date.parse(malformedChildren[1]!.date_from);
      malformedChildren[0]!.date_to = new Date(rightFrom + overlapMs).toISOString().replace(/\.\d{3}Z$/, "+0000");
      const get = vi.fn();
      await expect(collectSearch(splitPlan, { checkpoint: malformed, get: get as never })).rejects.toThrow(/split|overlap/i);
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("rolls back an oversized short continuation page and keeps a resumable capped checkpoint", async () => {
    const largePlan = planSearch({ native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" }, limits: { ...limits, max_bytes: 64 * 1024 * 1024 } }, Date.UTC(2026, 0, 2));
    const hugeName = "x".repeat(34 * 1024 * 1024);
    const largeGet = injected((path) => {
      const pageNo = Number(new URL(path, "https://api.hh.ru").searchParams.get("page") ?? 0);
      return pageNo === 0 ? page(200, Array.from({ length: 100 }, (_, i) => String(4000 + i)), 2) : { found: 200, pages: 2, items: [{ id: "9000", name: hugeName }] };
    });
    const result = await collectSearch(largePlan, { get: largeGet.get as never });
    expect(result.status).toBe("PARTIAL");
    expect(result.checkpoint.partitions[0]).toMatchObject({ status: "pending", page: 1, first_page_done: true });
    expect(result.items).toHaveLength(100);
    expect(result.checkpoint.counters.bytes).toBeGreaterThan(34 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.checkpoint), "utf8")).toBeLessThan(32 * 1024 * 1024);
    expect(result.manifest.gaps.some((gap) => gap.code === "state_budget")).toBe(true);

    const resumedGet = injected(() => page(200, Array.from({ length: 100 }, (_, i) => String(5000 + i)), 2));
    const resumed = await collectSearch(largePlan, { checkpoint: result.checkpoint, get: resumedGet.get as never });
    expect(resumedGet.get).toHaveBeenCalledTimes(1);
    expect(resumed.checkpoint.counters.requests).toBe(result.checkpoint.counters.requests + 1);
    expect(resumed.checkpoint.counters.bytes).toBeGreaterThan(result.checkpoint.counters.bytes);
    expect(resumed.items).toHaveLength(200);
  });

  it("rolls back only the oversized page while restoring prior item provenance and metadata", async () => {
    const multi = planSearch({
      native: {},
      branches: [{ name: "a", native: { text: "a" } }, { name: "b", native: { text: "b" } }],
      limits: { ...limits, max_bytes: 64 * 1024 * 1024 },
    }, Date.UTC(2026, 0, 2));
    const hugeName = "x".repeat(34 * 1024 * 1024);
    const get = injected((path) => {
      const text = new URL(path, "https://api.hh.ru").searchParams.get("text");
      if (text === "a") return page(1, ["42"]);
      return { found: 2, pages: 1, items: [vacancy("42"), { id: "9000", name: hugeName }] };
    });
    let savedAfterFirstBranch: import("../collector.js").CollectorCheckpoint | undefined;

    const result = await collectSearch(multi, { get: get.get as never, onCheckpoint: async (state) => {
      if (!savedAfterFirstBranch && state.partitions[0]?.status === "done" && state.partitions[1]?.status === "pending") {
        savedAfterFirstBranch = structuredClone(state);
      }
    } });

    expect(result.status).toBe("PARTIAL");
    expect(result.checkpoint.partitions[1]).toMatchObject({ status: "pending", page: 0, first_page_done: false, observed_items: 0, duplicate_items: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.raw_search.name).toBe("Vacancy 42");
    expect(result.items[0]?.provenance.map((entry) => entry.branch)).toEqual(["a"]);
    expect(result.items[0]?.last_fetched_at).toBe(savedAfterFirstBranch?.items[0]?.last_fetched_at);
    expect(result.checkpoint.counters.requests).toBe(2);
    expect(result.checkpoint.counters.bytes).toBeGreaterThan(34 * 1024 * 1024);

    const resumed = await collectSearch(multi, { checkpoint: result.checkpoint, get: injected((path) => {
      const text = new URL(path, "https://api.hh.ru").searchParams.get("text");
      return text === "b" ? page(2, ["42", "9000"]) : page(1, ["42"]);
    }).get as never });
    expect(resumed.items.find((item) => item.id === "42")?.provenance.map((entry) => entry.branch)).toEqual(["a", "b"]);
    expect(resumed.items.some((item) => item.id === "9000")).toBe(true);
  });

  it("accepts a checkpoint whose serialized state is exactly 32 MiB", async () => {
    const base = plan();
    const first = await collectSearch(base, { get: injected(() => page(1, ["42"])).get as never });
    const boundary = structuredClone(first.checkpoint);
    boundary.counters.active_elapsed_ms = 20_000;
    const item = boundary.items[0]!;
    const name = String(item.raw_search.name);
    const currentBytes = Buffer.byteLength(JSON.stringify(boundary), "utf8");
    item.raw_search.name = "x".repeat(32 * 1024 * 1024 - currentBytes + name.length);
    expect(Buffer.byteLength(JSON.stringify(boundary), "utf8")).toBe(32 * 1024 * 1024);

    const noRequests = vi.fn();
    const resumed = await collectSearch(base, { checkpoint: boundary, get: noRequests as never });

    expect(noRequests).not.toHaveBeenCalled();
    expect(resumed.status).toBe("COMPLETE");
  });

  it("uses real hhGet with mocked fetch and charges attempts to max_requests exactly once", async () => {
    const prior = globalThis.fetch;
    const oldBase = process.env.HH_API_BASE_URL;
    process.env.HH_API_BASE_URL = "https://api.hh.ru";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify(page(1, ["22"])), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      const tiny = planSearch({ native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" }, limits: { ...limits, max_requests: 1 } }, Date.UTC(2026, 0, 2));
      globalThis.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify(page(101, Array.from({ length: 100 }, (_, i) => String(100 + i)))), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
      const result = await collectSearch(tiny);
      expect(calls).toBe(1);
      expect(result.checkpoint.counters.requests).toBe(1);
      expect(result.manifest.status).toBe("PARTIAL");
      expect(result.manifest.gaps.some((gap) => gap.code === "request_budget")).toBe(true);
    } finally {
      globalThis.fetch = prior;
      if (oldBase === undefined) delete process.env.HH_API_BASE_URL; else process.env.HH_API_BASE_URL = oldBase;
    }
  });
});

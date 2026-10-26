import { hhGet, HhAccessError, HhApiError, HhNotFoundError, type HhGetOptions } from "../client.js";
import { createHhRequestBudget, HhBudgetError, type HhRequestBudget } from "../requestBudget.js";
import { evaluatePostFilters } from "./filters.js";
import { SearchPlan, SearchBranch, verifySearchPlan } from "./planner.js";

type PartitionStatus = "pending" | "running" | "done" | "failed" | "partial";
export type CollectorProvenance = { branch: string; partition_id: string; fetched_at: string };
export type CollectorItem = { id: string; raw_search: Record<string, unknown>; raw_detail?: Record<string, unknown>; detail_checked?: boolean; provenance: CollectorProvenance[]; first_fetched_at: string; last_fetched_at: string; filtering?: { state: "verified" | "unknown"; decision: "keep" | "exclude" | "review"; rules: ReturnType<typeof evaluatePostFilters>["rules"] } };
type Partition = { id: string; branch: string; parent_id?: string; query: string; date_from: string; date_to: string; status: PartitionStatus; page: number; found?: number; found_history: number[]; pages?: number; first_page_done: boolean; error?: { code: string; status?: number } };
type Counters = { requests: number; retries: number; bytes: number; logical_pages: number; items: number; detail_fetches: number; active_elapsed_ms: number };
export type CollectorCheckpoint = {
  version: "hh-search-checkpoint-v1"; signature: string; plan: SearchPlan; partitions: Partition[]; items: CollectorItem[];
  counters: Counters; gaps: Array<{ code: string; branch?: string; partition_id?: string; detail?: string }>;
  started_at: string; updated_at: string; interrupted_http_unknown: boolean; running_detail_id?: string; status: "RUNNING" | "COMPLETE" | "PARTIAL" | "CANCELLED";
};
export type CollectorResult = {
  status: "COMPLETE" | "PARTIAL" | "CANCELLED";
  manifest: { status: "COMPLETE" | "PARTIAL" | "CANCELLED"; found: number; known_items: number; requests: number; retries: number; bytes: number; logical_pages: number; detail_fetches: number; active_elapsed_ms: number; branches: Array<{ name: string; total_ids: number; unique_contribution: number }>; gaps: CollectorCheckpoint["gaps"]; warnings: string[]; partitions: Array<Pick<Partition, "id" | "branch" | "parent_id" | "status" | "found" | "found_history" | "error">> };
  items: CollectorItem[]; checkpoint: CollectorCheckpoint;
};
export type CollectSearchOptions = { checkpoint?: CollectorCheckpoint; onCheckpoint?: (state: CollectorCheckpoint) => Promise<void>; signal?: AbortSignal; get?: typeof hhGet };

const CHECKPOINT_LIMIT = 32 * 1024 * 1024;
const PAGE_SIZE = 100;
const PAGE_CAP = 20;
const MIN_INTERVAL_MS = 5 * 60_000;
const own = (x: unknown): x is Record<string, unknown> => Boolean(x && typeof x === "object" && !Array.isArray(x));
class CheckpointPersistenceError extends Error {
  constructor(cause: unknown) { super("onCheckpoint persistence failed", { cause }); this.name = "CheckpointPersistenceError"; }
}
const safeJsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function safeError(error: unknown): { code: string; status?: number } {
  if (error instanceof HhBudgetError) return { code: error.code };
  if (error instanceof HhNotFoundError) return { code: "not_found", status: 404 };
  if (error instanceof HhAccessError) return { code: error.kind === "captcha" ? "captcha" : "forbidden", status: 403 };
  if (error instanceof HhApiError) return { code: `http_${error.status}`, status: error.status };
  if (error instanceof Error && error.name === "AbortError") return { code: "cancelled" };
  return { code: "request_failed" };
}
function canonicalId(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw);
  if (!/^\d{1,20}$/.test(text) || !/[1-9]/.test(text)) return undefined;
  return BigInt(text).toString();
}
function parsePage(value: unknown): { found: number; pages?: number; items: Record<string, unknown>[] } {
  if (!own(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.found) || Number(value.found) < 0) throw new Error("malformed_search_response");
  const items = value.items.filter(own);
  const pages = Number.isSafeInteger(value.pages) && Number(value.pages) >= 0 ? Number(value.pages) : undefined;
  return { found: Number(value.found), pages, items };
}
function queryFor(partition: Partition, page: number, branch: SearchBranch, fast = false): string {
  const params = new URLSearchParams(branch.query);
  const perPage = fast ? 20 : PAGE_SIZE;
  params.set("date_from", partition.date_from);
  params.set("date_to", partition.date_to);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  const order = branch.native.order_by;
  params.set("order_by", typeof order === "string" ? order : order?.[0] ?? "publication_time");
  partition.query = params.toString();
  return `/vacancies?${params.toString()}`;
}
function initialPartitions(plan: SearchPlan): Partition[] {
  return plan.branches.map((branch, i) => ({ id: `${i + 1}`, branch: branch.name, query: branch.query, date_from: branch.native.date_from ?? plan.frozen_date_bounds.date_from, date_to: branch.native.date_to ?? plan.frozen_date_bounds.date_to, status: "pending", page: 0, found_history: [], first_page_done: false }));
}
function validateCheckpoint(value: unknown, plan: SearchPlan): CollectorCheckpoint {
  if (!own(value) || value.version !== "hh-search-checkpoint-v1" || value.signature !== plan.signature || !Array.isArray(value.partitions) || !Array.isArray(value.items) || !Array.isArray(value.gaps) || !own(value.counters) || !own(value.plan)) throw new Error("invalid checkpoint version, shape, or signature");
  if (value.plan.signature !== plan.signature || value.plan.version !== "hh-search-v1" || JSON.stringify(value.plan) !== JSON.stringify(plan) || !["RUNNING", "COMPLETE", "PARTIAL", "CANCELLED"].includes(String(value.status))) throw new Error("checkpoint plan signature or plan mismatch");
  const c = value.counters as Record<string, unknown>;
  for (const key of ["requests", "retries", "bytes", "logical_pages", "items", "detail_fetches", "active_elapsed_ms"]) if (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0) throw new Error(`invalid checkpoint counter ${key}`);
  const gaps = value.gaps as Array<{ code?: unknown }>;
  const overflowRecorded = (code: string) => gaps.some((gap) => gap?.code === code);
  if (Number(c.requests) > plan.limits.max_requests || Number(c.retries) > Number(c.requests) || Number(c.bytes) > plan.limits.max_bytes && !overflowRecorded("byte_budget") || Number(c.detail_fetches) > plan.limits.max_detail_fetches || Number(c.active_elapsed_ms) > plan.limits.max_duration_sec * 1000 && !overflowRecorded("duration_budget") || Number(c.items) !== value.items.length || value.partitions.length > 10_000 || value.items.length > plan.limits.max_items) throw new Error("checkpoint counters exceed the effective plan");
  if (value.running_detail_id !== undefined && (typeof value.running_detail_id !== "string" || !value.items.some((item) => own(item) && item.id === value.running_detail_id))) throw new Error("invalid running detail cursor");
  const allowed = new Set(["pending", "running", "done", "failed", "partial"]);
  const branches = new Map(plan.branches.map((branch) => [branch.name, branch]));
  const partitionIds = new Set<string>();
  const dateMs = (raw: unknown): number | undefined => {
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return undefined;
    const parsed = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  for (const part of value.partitions) {
    if (!own(part) || typeof part.id !== "string" || !part.id || partitionIds.has(part.id) || typeof part.branch !== "string" || !branches.has(part.branch) || typeof part.query !== "string" || !allowed.has(String(part.status)) || !Number.isSafeInteger(part.page) || Number(part.page) < 0 || Number(part.page) > PAGE_CAP || typeof part.first_page_done !== "boolean" || !Array.isArray(part.found_history) || part.found_history.some((x) => !Number.isSafeInteger(x) || Number(x) < 0) || part.found !== undefined && (!Number.isSafeInteger(part.found) || Number(part.found) < 0) || part.pages !== undefined && (!Number.isSafeInteger(part.pages) || Number(part.pages) < 0)) throw new Error("invalid checkpoint partition shape");
    partitionIds.add(part.id);
    const from = dateMs(part.date_from);
    const to = dateMs(part.date_to);
    const branch = branches.get(part.branch)!;
    const branchFrom = dateMs(branch.native.date_from ?? plan.frozen_date_bounds.date_from)!;
    const branchTo = dateMs(branch.native.date_to ?? plan.frozen_date_bounds.date_to)!;
    if (from === undefined || to === undefined || from >= to || from < branchFrom || to > branchTo) throw new Error("invalid checkpoint partition date bounds");
    if (part.first_page_done ? Number(part.page) < 1 || part.found === undefined || part.found_history.length === 0 : Number(part.page) !== 0 || part.found !== undefined || part.pages !== undefined || part.found_history.length !== 0) throw new Error("invalid checkpoint partition page cursor");
    if (part.status === "done" && !part.first_page_done || part.status === "running" && Number(part.page) > 0 && !part.first_page_done) throw new Error("invalid checkpoint partition status and cursor");
  }
  for (const part of value.partitions as Array<Record<string, unknown>>) {
    if (part.parent_id !== undefined) {
      if (typeof part.parent_id !== "string" || part.parent_id === part.id) throw new Error("invalid checkpoint partition parent");
      const parent = (value.partitions as Array<Record<string, unknown>>).find((candidate) => candidate.id === part.parent_id);
      if (!parent || parent.branch !== part.branch || dateMs(part.date_from)! < dateMs(parent.date_from)! || dateMs(part.date_to)! > dateMs(parent.date_to)!) throw new Error("invalid checkpoint partition parent bounds");
    }
  }
  const partitionById = new Map((value.partitions as Array<Record<string, unknown>>).map((part) => [part.id as string, part]));
  for (const item of value.items) {
    if (!own(item) || canonicalId(item.id) !== item.id || !own(item.raw_search) || !Array.isArray(item.provenance) || item.provenance.length === 0 || dateMs(item.first_fetched_at) === undefined || dateMs(item.last_fetched_at) === undefined || item.detail_checked !== undefined && typeof item.detail_checked !== "boolean" || item.raw_detail !== undefined && !own(item.raw_detail)) throw new Error("invalid checkpoint item shape");
    for (const provenance of item.provenance) {
      if (!own(provenance) || typeof provenance.branch !== "string" || !branches.has(provenance.branch) || typeof provenance.partition_id !== "string" || dateMs(provenance.fetched_at) === undefined) throw new Error("invalid checkpoint item provenance");
      const source = partitionById.get(provenance.partition_id);
      if (!source || source.branch !== provenance.branch) throw new Error("invalid checkpoint item provenance partition");
    }
  }
  if (value.status === "COMPLETE" && value.partitions.some((part) => !own(part) || part.status !== "done")) throw new Error("invalid complete checkpoint partition status");
  if (safeJsonBytes(value) > CHECKPOINT_LIMIT) throw new Error("checkpoint exceeds 32 MiB");
  return structuredClone(value) as unknown as CollectorCheckpoint;
}

export async function collectSearch(plan: SearchPlan, options: CollectSearchOptions = {}): Promise<CollectorResult> {
  if (!plan || !/^[a-f0-9]{64}$/.test(plan.signature) || !verifySearchPlan(plan)) throw new Error("invalid search plan signature or content");
  const clockStart = Date.now();
  const cp: CollectorCheckpoint = options.checkpoint
    ? validateCheckpoint(options.checkpoint, plan)
    : { version: "hh-search-checkpoint-v1", signature: plan.signature, plan: structuredClone(plan), partitions: initialPartitions(plan), items: [], counters: { requests: 0, retries: 0, bytes: 0, logical_pages: 0, items: 0, detail_fetches: 0, active_elapsed_ms: 0 }, gaps: [], started_at: new Date().toISOString(), updated_at: new Date().toISOString(), interrupted_http_unknown: false, status: "RUNNING" };
  if (cp.partitions.some((p) => p.status === "running") || cp.running_detail_id) {
    cp.interrupted_http_unknown = true;
    for (const part of cp.partitions) if (part.status === "running") part.status = "pending";
    cp.running_detail_id = undefined;
    if (!cp.gaps.some((g) => g.code === "interrupted_http_unknown")) cp.gaps.push({ code: "interrupted_http_unknown", detail: "A previous process may have sent a request after the last persisted checkpoint; its response and exact attempt count are unknown." });
  }
  if (options.checkpoint) cp.gaps = cp.gaps.filter((gap) => gap.code !== "cancelled");
  cp.status = "RUNNING";
  const remainingMs = Math.max(0, plan.limits.max_duration_sec * 1000 - cp.counters.active_elapsed_ms);
  const budget: HhRequestBudget = createHhRequestBudget({ max_requests: plan.limits.max_requests, max_duration_sec: remainingMs / 1000, max_bytes: plan.limits.max_bytes });
  budget.requests = cp.counters.requests;
  budget.retries = cp.counters.retries;
  budget.bytes = cp.counters.bytes;
  const get = options.get ?? hhGet;
  const branchByName = new Map(plan.branches.map((b) => [b.name, b]));
  let fatalStop = false;
  let stateBudget = false;

  const persist = async (): Promise<void> => {
    cp.updated_at = new Date().toISOString();
    cp.counters.active_elapsed_ms = Math.max(cp.counters.active_elapsed_ms, Date.now() - clockStart + (options.checkpoint ? (options.checkpoint as CollectorCheckpoint).counters.active_elapsed_ms : 0));
    if (cp.counters.active_elapsed_ms > plan.limits.max_duration_sec * 1000) {
      if (!cp.gaps.some((gap) => gap.code === "duration_budget")) cp.gaps.push({ code: "duration_budget" });
      fatalStop = true;
      if (cp.status !== "CANCELLED") cp.status = "PARTIAL";
    }
    cp.counters.requests = budget.requests;
    cp.counters.retries = budget.retries;
    cp.counters.bytes = budget.bytes;
    cp.counters.items = cp.items.length;
    if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) throw new Error("checkpoint exceeds 32 MiB");
    if (options.onCheckpoint) {
      try { await options.onCheckpoint(structuredClone(cp)); }
      catch (error) { throw new CheckpointPersistenceError(error); }
    }
  };
  const addHits = (part: Partition, rows: Record<string, unknown>[]): void => {
    const fetchedAt = new Date().toISOString();
    for (const row of rows) {
      const id = canonicalId(row.id);
      if (!id) { cp.gaps.push({ code: "invalid_vacancy_id", branch: part.branch, partition_id: part.id }); continue; }
      const existing = cp.items.find((item) => item.id === id);
      const provenance = { branch: part.branch, partition_id: part.id, fetched_at: fetchedAt };
      if (existing) {
        existing.last_fetched_at = fetchedAt;
        if (!existing.provenance.some((p) => p.branch === part.branch && p.partition_id === part.id)) existing.provenance.push(provenance);
      } else {
        if (cp.items.length >= plan.limits.max_items) { cp.gaps.push({ code: "item_budget", branch: part.branch, partition_id: part.id }); continue; }
        cp.items.push({ id, raw_search: row, provenance: [provenance], first_fetched_at: fetchedAt, last_fetched_at: fetchedAt });
      }
    }
    cp.counters.items = cp.items.length;
  };
  const request = async (path: string): Promise<unknown> => get(path, { budget, signal: options.signal } as HhGetOptions);
  const paginate = async (part: Partition, branch: SearchBranch): Promise<void> => {
    const pageSize = plan.mode === "fast" ? 20 : PAGE_SIZE;
    const maxPages = plan.mode === "fast" ? 1 : PAGE_CAP;
    const advertised = Math.min(maxPages, Math.max(1, part.pages ?? Math.ceil((part.found ?? 0) / pageSize)));
    for (let pageNo = part.page; pageNo < advertised; pageNo++) {
      if (cp.items.length >= plan.limits.max_items) { part.status = "partial"; cp.gaps.push({ code: "item_budget", branch: part.branch, partition_id: part.id }); return; }
      const pageItemsSnapshot = structuredClone(cp.items);
      cp.counters.logical_pages++;
      const row = parsePage(await request(queryFor(part, pageNo, branch, plan.mode === "fast")));
      if (part.found !== row.found) { part.found_history.push(row.found); cp.gaps.push({ code: "found_changed", branch: part.branch, partition_id: part.id }); }
      part.found = row.found;
      if (row.pages !== undefined && part.pages !== undefined && row.pages !== part.pages) { part.status = "partial"; cp.gaps.push({ code: "pages_changed", branch: part.branch, partition_id: part.id }); return; }
      addHits(part, row.items);
      const expected = Math.min(pageSize, Math.max(0, row.found - pageNo * pageSize));
      if (row.items.length < expected) { part.page = pageNo + 1; part.status = "partial"; cp.gaps.push({ code: "short_page", branch: part.branch, partition_id: part.id }); await persist(); return; }
      if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
        cp.items = pageItemsSnapshot;
        cp.counters.items = cp.items.length;
        part.status = "pending";
        part.page = pageNo;
        stateBudget = true;
        cp.gaps.push({ code: "state_budget", branch: part.branch, partition_id: part.id });
        await persist();
        return;
      }
      part.page = pageNo + 1;
      await persist();
    }
    if (part.status === "running") part.status = "done";
  };
  const registerRequestError = (part: Partition, error: unknown): void => {
    const safe = safeError(error);
    part.error = safe;
    part.status = safe.code === "cancelled" ? "pending" : "failed";
    cp.gaps.push({ code: safe.code, branch: part.branch, partition_id: part.id });
    if (safe.status === 401 || safe.status === 403 || safe.code === "captcha" || safe.status === 429 || safe.code === "cancelled" || safe.code.endsWith("_budget")) fatalStop = true;
  };

  await persist();
  while (!fatalStop && !stateBudget) {
      const part = cp.partitions.find((p) => p.status === "pending");
      if (!part) break;
      const branch = branchByName.get(part.branch);
      if (!branch) throw new Error("checkpoint contains unknown branch");
      part.status = "running";
      await persist();
      try {
        if (!part.first_page_done) {
          cp.counters.logical_pages++;
          const beforeFirstPageItems = structuredClone(cp.items);
          const first = parsePage(await request(queryFor(part, 0, branch, plan.mode === "fast")));
          part.first_page_done = true;
          part.found = first.found;
          part.found_history.push(first.found);
          part.pages = first.pages;
          part.page = 1;
          const maxPages = plan.mode === "fast" ? 1 : PAGE_CAP;
          const pageSize = plan.mode === "fast" ? 20 : PAGE_SIZE;
          addHits(part, first.items.slice(0, pageSize));
          if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
            cp.items = beforeFirstPageItems;
            cp.counters.items = cp.items.length;
            part.status = "pending";
            part.page = 0;
            part.found = undefined;
            part.found_history = [];
            part.pages = undefined;
            part.first_page_done = false;
            stateBudget = true;
            cp.gaps.push({ code: "state_budget", branch: part.branch, partition_id: part.id });
            await persist();
            break;
          }
          const expectedPageCount = Math.min(maxPages, Math.ceil(first.found / pageSize));
          if (first.pages !== undefined && first.pages !== expectedPageCount) {
            cp.gaps.push({ code: "pages_mismatch", branch: part.branch, partition_id: part.id });
            part.status = "partial";
          }
          if (first.found > maxPages * pageSize && plan.mode !== "fast") {
            const from = Date.parse(part.date_from.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
            const to = Date.parse(part.date_to.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
            if (Number.isFinite(from) && Number.isFinite(to) && to - from >= MIN_INTERVAL_MS * 3) {
              const midpoint = Math.floor(((from + to) / 2) / MIN_INTERVAL_MS) * MIN_INTERVAL_MS;
              const leftTo = midpoint + MIN_INTERVAL_MS;
              const rightFrom = midpoint;
              const leftFrom = Math.floor(from / MIN_INTERVAL_MS) * MIN_INTERVAL_MS;
              const rightTo = Math.ceil(to / MIN_INTERVAL_MS) * MIN_INTERVAL_MS;
              const leftShrinks = leftFrom < leftTo && leftTo < to;
              const rightShrinks = rightFrom > from && rightFrom < rightTo;
              if (leftShrinks && rightShrinks) {
                part.status = "done";
                const suffix = cp.partitions.reduce((n, p) => Math.max(n, Number(p.id.split(".").at(-1)) || 0), 0) + 1;
                cp.partitions.push(
                  { ...part, id: `${part.id}.${suffix}`, parent_id: part.id, date_from: toHH(from), date_to: toHH(leftTo), status: "pending", page: 0, found: undefined, found_history: [], pages: undefined, first_page_done: false, error: undefined },
                  { ...part, id: `${part.id}.${suffix + 1}`, parent_id: part.id, date_from: toHH(rightFrom), date_to: toHH(rightTo), status: "pending", page: 0, found: undefined, found_history: [], pages: undefined, first_page_done: false, error: undefined },
                );
                if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
                  cp.partitions.splice(-2);
                  part.status = "partial";
                  cp.gaps.push({ code: "state_budget", branch: part.branch, partition_id: part.id });
                  stateBudget = true;
                  await persist();
                  break;
                }
                await persist();
                continue;
              }
            }
            part.status = "partial";
            cp.gaps.push({ code: "unsplittable_over_cap", branch: part.branch, partition_id: part.id });
          }
          if (first.found > 0 && first.items.length < Math.min(pageSize, first.found)) {
            part.status = "partial";
            cp.gaps.push({ code: "short_page", branch: part.branch, partition_id: part.id });
          }
          if (plan.mode === "fast") {
            part.status = "partial";
            cp.gaps.push({ code: "fast_sample", branch: part.branch, partition_id: part.id });
          }
          await persist();
          if (part.status === "running") await paginate(part, branch);
          await persist();
        }
        else if (part.first_page_done) await paginate(part, branch);
      } catch (error) {
        if (error instanceof CheckpointPersistenceError) throw error;
        registerRequestError(part, error);
        await persist();
        if (fatalStop) break;
      }
  }

  if (!fatalStop && (plan.post_filters.length || plan.details === "full")) {
    for (const item of cp.items) {
      if (item.raw_detail || plan.details === "none" && plan.post_filters.length > 0 && item.detail_checked) continue;
      if (cp.counters.detail_fetches >= plan.limits.max_detail_fetches || cp.counters.detail_fetches >= plan.limits.max_items) {
        if (plan.post_filters.length) item.filtering = { state: "unknown", decision: "review", rules: [] };
        cp.gaps.push({ code: "detail_budget", branch: item.provenance[0]?.branch });
        continue;
      }
      try {
        cp.counters.detail_fetches++;
        cp.running_detail_id = item.id;
        await persist();
        const detail = await request(`/vacancies/${encodeURIComponent(item.id)}`);
        cp.running_detail_id = undefined;
        if (!own(detail) || canonicalId(detail.id) !== item.id) throw new Error("malformed_detail_response");
        item.detail_checked = true;
        item.raw_detail = detail;
        if (plan.post_filters.length) {
          const description = typeof detail.description === "string" ? detail.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
          const evaluated = evaluatePostFilters({ ...detail, description }, plan.post_filters, plan.filter_mode);
          item.filtering = { state: evaluated.rules.some((rule) => rule.state === "unknown") ? "unknown" : "verified", decision: evaluated.decision, rules: evaluated.rules };
        }
        if (plan.details === "none") delete item.raw_detail;
        if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) { delete item.raw_detail; item.filtering = { state: "unknown", decision: "review", rules: [] }; stateBudget = true; cp.gaps.push({ code: "state_budget" }); }
        await persist();
        if (stateBudget) break;
      } catch (error) {
        if (error instanceof CheckpointPersistenceError) throw error;
        cp.running_detail_id = undefined;
        const safe = safeError(error);
        if (plan.post_filters.length) item.filtering = { state: "unknown", decision: "review", rules: [] };
        cp.gaps.push({ code: safe.code, branch: item.provenance[0]?.branch });
        if (safe.status === 401 || safe.status === 403 || safe.status === 429 || safe.code.endsWith("_budget") || safe.code === "cancelled" || safe.code === "captcha") { fatalStop = true; break; }
        await persist();
      }
    }
  }
  if (options.signal?.aborted) cp.status = "CANCELLED";
  else cp.status = cp.partitions.every((p) => p.status === "done") && cp.gaps.length === 0 && !stateBudget ? "COMPLETE" : "PARTIAL";
  if (fatalStop && options.signal?.aborted) cp.status = "CANCELLED";
  if (fatalStop && cp.status !== "CANCELLED") cp.status = "PARTIAL";
  if (fatalStop && plan.post_filters.length) {
    for (const item of cp.items) if (!item.filtering) item.filtering = { state: "unknown", decision: "review", rules: [] };
    if (!cp.gaps.some((gap) => gap.code === "filtering_incomplete")) cp.gaps.push({ code: "filtering_incomplete" });
  }
  if (cp.interrupted_http_unknown && cp.status === "COMPLETE") cp.status = "PARTIAL";
  await persist();
  const idsByBranch = new Map<string, Set<string>>(plan.branches.map((b) => [b.name, new Set()]));
  for (const item of cp.items) for (const provenance of item.provenance) idsByBranch.get(provenance.branch)?.add(item.id);
  const branchMembership = new Map<string, string[]>();
  for (const [branch, ids] of idsByBranch) for (const id of ids) branchMembership.set(id, [...(branchMembership.get(id) ?? []), branch]);
  const branchStats = plan.branches.map((branch) => {
    const ids = idsByBranch.get(branch.name) ?? new Set();
    return { name: branch.name, total_ids: ids.size, unique_contribution: [...ids].filter((id) => branchMembership.get(id)?.length === 1).length };
  });
  const roots = cp.partitions.filter((p) => p.parent_id === undefined);
  const found = roots.reduce((sum, p) => sum + (p.found ?? 0), 0);
  const warnings = [...plan.warnings, "Results describe the live HH index at collection time; they do not certify historical completeness."];
  return {
    status: cp.status,
    manifest: { status: cp.status, found, known_items: cp.items.length, requests: cp.counters.requests, retries: cp.counters.retries, bytes: cp.counters.bytes, logical_pages: cp.counters.logical_pages, detail_fetches: cp.counters.detail_fetches, active_elapsed_ms: cp.counters.active_elapsed_ms, branches: branchStats, gaps: structuredClone(cp.gaps), warnings, partitions: cp.partitions.map(({ id, branch, parent_id, status, found: count, found_history, error }) => ({ id, branch, parent_id, status, found: count, found_history, error })) },
    items: structuredClone(cp.items), checkpoint: structuredClone(cp),
  };
}

function toHH(value: number): string { return new Date(value).toISOString().replace(/\.\d{3}Z$/, "+0000"); }

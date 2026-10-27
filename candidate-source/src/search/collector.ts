import { hhGet, HhAccessError, HhApiError, HhNotFoundError, type HhGetOptions } from "../client.js";
import { createHhRequestBudget, HhBudgetError, type HhRequestBudget } from "../requestBudget.js";
import { evaluatePostFilters } from "./filters.js";
import { SearchPlan, SearchBranch, verifySearchPlan } from "./planner.js";

type PartitionStatus = "pending" | "running" | "done" | "failed" | "partial";
export type CollectorProvenance = { branch: string; partition_id: string; fetched_at: string };
export type CollectorItem = { id: string; raw_search: Record<string, unknown>; raw_detail?: Record<string, unknown>; detail_checked?: boolean; provenance: CollectorProvenance[]; first_fetched_at: string; last_fetched_at: string; filtering?: { state: "verified" | "unknown"; decision: "keep" | "exclude" | "review"; rules: ReturnType<typeof evaluatePostFilters>["rules"] } };
type Partition = { id: string; branch: string; parent_id?: string; query: string; date_from: string; date_to: string; status: PartitionStatus; page: number; found?: number; found_history: number[]; pages?: number; first_page_done: boolean; observed_items?: number; duplicate_items?: number; invalid_items?: number; coverage_invalid?: boolean; error?: { code: string; status?: number } };
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
  if (error instanceof TypeError) return { code: "network_error" };
  return { code: "request_failed" };
}
function retryablePartitionError(error: Partition["error"]): boolean {
  return Boolean(error && (error.code === "network_error" || /^http_5\d\d$/.test(error.code)));
}
function canonicalId(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw);
  if (!/^\d{1,20}$/.test(text) || !/[1-9]/.test(text)) return undefined;
  return BigInt(text).toString();
}
function addPartitionGap(cp: CollectorCheckpoint, part: Partition, code: string, detail?: string): void {
  const existing = cp.gaps.find((gap) => gap.code === code && gap.partition_id === part.id);
  if (existing) {
    if (detail !== undefined) existing.detail = detail;
    return;
  }
  cp.gaps.push({ code, branch: part.branch, partition_id: part.id, ...(detail === undefined ? {} : { detail }) });
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
  return plan.branches.map((branch, i) => ({ id: `${i + 1}`, branch: branch.name, query: branch.query, date_from: branch.native.date_from ?? plan.frozen_date_bounds.date_from, date_to: branch.native.date_to ?? plan.frozen_date_bounds.date_to, status: "pending", page: 0, found_history: [], first_page_done: false, observed_items: 0, duplicate_items: 0, invalid_items: 0 }));
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
    if (!own(part)) throw new Error("invalid checkpoint partition shape");
    const coverageValues = [part.observed_items, part.duplicate_items, part.invalid_items];
    const coveragePresent = coverageValues.filter((entry) => entry !== undefined).length;
    if (typeof part.id !== "string" || !/^[1-9]\d*(?:\.[1-9]\d*)*$/.test(part.id) || partitionIds.has(part.id) || typeof part.branch !== "string" || !branches.has(part.branch) || typeof part.query !== "string" || !allowed.has(String(part.status)) || !Number.isSafeInteger(part.page) || Number(part.page) < 0 || Number(part.page) > PAGE_CAP || typeof part.first_page_done !== "boolean" || !Array.isArray(part.found_history) || part.found_history.length > PAGE_CAP || part.found_history.some((x) => !Number.isSafeInteger(x) || Number(x) < 0) || part.found !== undefined && (!Number.isSafeInteger(part.found) || Number(part.found) < 0) || part.pages !== undefined && (!Number.isSafeInteger(part.pages) || Number(part.pages) < 0) || coveragePresent !== 0 && coveragePresent !== coverageValues.length || coverageValues.some((entry) => entry !== undefined && (!Number.isSafeInteger(entry) || Number(entry) < 0)) || typeof part.coverage_invalid !== "undefined" && typeof part.coverage_invalid !== "boolean") throw new Error("invalid checkpoint partition shape");
    if (coveragePresent === coverageValues.length && Number(part.duplicate_items) + Number(part.invalid_items) > Number(part.observed_items)) throw new Error("invalid checkpoint partition coverage counters");
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
  const partitions = value.partitions as Array<Record<string, unknown>>;
  const partitionById = new Map(partitions.map((part) => [part.id as string, part]));
  if (partitions.length < plan.branches.length) throw new Error("invalid checkpoint execution queue: missing branch root");
  const roots = partitions.filter((part) => part.parent_id === undefined);
  if (roots.length !== plan.branches.length) throw new Error("invalid checkpoint execution queue roots");
  for (const branch of plan.branches) {
    const branchRoots = roots.filter((root) => root.branch === branch.name);
    if (branchRoots.length !== 1) throw new Error("invalid checkpoint execution queue branch root");
    const root = branchRoots[0]!;
    if (dateMs(root.date_from) !== dateMs(branch.native.date_from ?? plan.frozen_date_bounds.date_from) || dateMs(root.date_to) !== dateMs(branch.native.date_to ?? plan.frozen_date_bounds.date_to)) throw new Error("invalid checkpoint branch root bounds");
  }
  for (const parent of partitions) {
    const children = partitions.filter((child) => child.parent_id === parent.id);
    if (children.length === 0) continue;
    if (children.length !== 2 || parent.status !== "done" || children.some((child) => child.branch !== parent.branch)) throw new Error("invalid checkpoint split children");
    const [left, right] = [...children].sort((a, b) => dateMs(a.date_from)! - dateMs(b.date_from)!);
    const parentFrom = dateMs(parent.date_from)!;
    const parentTo = dateMs(parent.date_to)!;
    const leftFrom = dateMs(left!.date_from)!;
    const leftTo = dateMs(left!.date_to)!;
    const rightFrom = dateMs(right!.date_from)!;
    const rightTo = dateMs(right!.date_to)!;
    if (leftFrom !== parentFrom || rightTo !== parentTo || leftTo - rightFrom < MIN_INTERVAL_MS || leftFrom >= leftTo || rightFrom >= rightTo || leftTo - leftFrom >= parentTo - parentFrom || rightTo - rightFrom >= parentTo - parentFrom) throw new Error("invalid checkpoint split coverage bounds");
  }
  const reached = new Set<string>();
  const visit = (part: Record<string, unknown>, ancestors: Set<string>): void => {
    const id = part.id as string;
    if (ancestors.has(id)) throw new Error("invalid checkpoint partition cycle");
    if (reached.has(id)) return;
    reached.add(id);
    const nextAncestors = new Set(ancestors).add(id);
    for (const child of partitions.filter((candidate) => candidate.parent_id === id)) visit(child, nextAncestors);
  };
  for (const root of roots) visit(root, new Set());
  if (reached.size !== partitions.length || partitions.some((part) => part.parent_id !== undefined && !partitionById.has(part.parent_id as string))) throw new Error("invalid checkpoint execution queue graph");
  const itemIds = new Set<string>();
  for (const item of value.items) {
    if (!own(item) || canonicalId(item.id) !== item.id || !own(item.raw_search) || !Array.isArray(item.provenance) || item.provenance.length === 0 || dateMs(item.first_fetched_at) === undefined || dateMs(item.last_fetched_at) === undefined || item.detail_checked !== undefined && typeof item.detail_checked !== "boolean" || item.raw_detail !== undefined && !own(item.raw_detail)) throw new Error("invalid checkpoint item shape");
    if (itemIds.has(item.id as string)) throw new Error("duplicate global checkpoint item ID");
    itemIds.add(item.id as string);
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
  const itemsById = new Map(cp.items.map((item) => [item.id, item]));
  const partitionItems = new Map(cp.partitions.map((part) => [part.id, new Set<string>()]));
  for (const item of cp.items) {
    for (const provenance of item.provenance) partitionItems.get(provenance.partition_id)?.add(item.id);
  }
  for (const part of cp.partitions) {
    const ids = partitionItems.get(part.id)!;
    if (part.observed_items === undefined || part.duplicate_items === undefined || part.invalid_items === undefined) {
      // v1 checkpoints predate these bounded counters. Provenance still proves
      // the unique IDs already retained, so continue from that lower bound.
      part.observed_items = ids.size;
      part.duplicate_items = 0;
      part.invalid_items = 0;
    } else if (part.observed_items - part.duplicate_items - part.invalid_items !== ids.size) {
      part.coverage_invalid = true;
    }
    if (part.coverage_invalid) addPartitionGap(cp, part, "coverage_state_invalid", "Persisted per-partition coverage counters disagree with item provenance.");
  }
  if (cp.partitions.some((p) => p.status === "running") || cp.running_detail_id) {
    cp.interrupted_http_unknown = true;
    for (const part of cp.partitions) if (part.status === "running") part.status = "pending";
    cp.running_detail_id = undefined;
    if (!cp.gaps.some((g) => g.code === "interrupted_http_unknown")) cp.gaps.push({ code: "interrupted_http_unknown", detail: "A previous process may have sent a request after the last persisted checkpoint; its response and exact attempt count are unknown." });
  }
  if (options.checkpoint) {
    const retryBudgetAvailable = cp.counters.requests < plan.limits.max_requests
      && cp.counters.bytes < plan.limits.max_bytes
      && cp.counters.active_elapsed_ms < plan.limits.max_duration_sec * 1000;
    for (const part of cp.partitions) {
      if (!retryBudgetAvailable || part.status !== "failed" || !retryablePartitionError(part.error)) continue;
      const resolvedCode = part.error!.code;
      part.status = "pending";
      delete part.error;
      cp.gaps = cp.gaps.filter((gap) => !(gap.partition_id === part.id && gap.code === resolvedCode));
    }
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

  type PageUndo = {
    itemsLength: number;
    gapsLength: number;
    itemCount: number;
    logicalPages: number;
    addedItemIds: Set<string>;
    addedPartitionIds: string[];
      changedItems: Map<string, { item: CollectorItem; lastFetchedAt: string; provenanceLength: number }>;
    part: { query: string; page: number; found?: number; foundHistoryLength: number; pages?: number; firstPageDone: boolean; observedItems: number; duplicateItems: number; invalidItems: number; coverageInvalid?: boolean; error?: Partition["error"] };
  };
  const beginPage = (part: Partition): PageUndo => ({
    itemsLength: cp.items.length,
    gapsLength: cp.gaps.length,
    itemCount: cp.counters.items,
    logicalPages: cp.counters.logical_pages,
    addedItemIds: new Set(),
    addedPartitionIds: [],
    changedItems: new Map(),
    part: {
      query: part.query,
      page: part.page,
      found: part.found,
      foundHistoryLength: part.found_history.length,
      pages: part.pages,
      firstPageDone: part.first_page_done,
      observedItems: part.observed_items ?? 0,
      duplicateItems: part.duplicate_items ?? 0,
      invalidItems: part.invalid_items ?? 0,
      coverageInvalid: part.coverage_invalid,
      error: part.error ? { ...part.error } : undefined,
    },
  });
  const rollbackPage = (part: Partition, undo: PageUndo): void => {
    for (const state of undo.changedItems.values()) {
      state.item.last_fetched_at = state.lastFetchedAt;
      state.item.provenance.length = state.provenanceLength;
    }
    cp.items.length = undo.itemsLength;
    for (const id of undo.addedItemIds) itemsById.delete(id);
    const ids = partitionItems.get(part.id)!;
    for (const id of undo.addedPartitionIds) ids.delete(id);
    cp.gaps.length = undo.gapsLength;
    cp.counters.items = undo.itemCount;
    cp.counters.logical_pages = undo.logicalPages;
    part.query = undo.part.query;
    part.page = undo.part.page;
    part.found = undo.part.found;
    part.found_history.length = undo.part.foundHistoryLength;
    part.pages = undo.part.pages;
    part.first_page_done = undo.part.firstPageDone;
    part.status = "pending";
    part.observed_items = undo.part.observedItems;
    part.duplicate_items = undo.part.duplicateItems;
    part.invalid_items = undo.part.invalidItems;
    part.coverage_invalid = undo.part.coverageInvalid;
    part.error = undo.part.error ? { ...undo.part.error } : undefined;
  };

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
  const addHits = (part: Partition, rows: Record<string, unknown>[], undo: PageUndo): void => {
    const fetchedAt = new Date().toISOString();
    const partitionIds = partitionItems.get(part.id)!;
    for (const row of rows) {
      part.observed_items = (part.observed_items ?? 0) + 1;
      const id = canonicalId(row.id);
      if (!id) { part.invalid_items = (part.invalid_items ?? 0) + 1; continue; }
      const isDuplicateInPartition = partitionIds.has(id);
      if (isDuplicateInPartition) part.duplicate_items = (part.duplicate_items ?? 0) + 1;
      else {
        partitionIds.add(id);
        undo.addedPartitionIds.push(id);
      }
      const existing = itemsById.get(id);
      const provenance = { branch: part.branch, partition_id: part.id, fetched_at: fetchedAt };
      if (existing) {
        if (!undo.addedItemIds.has(id) && !undo.changedItems.has(id)) {
          undo.changedItems.set(id, { item: existing, lastFetchedAt: existing.last_fetched_at, provenanceLength: existing.provenance.length });
        }
        existing.last_fetched_at = fetchedAt;
        if (!isDuplicateInPartition && !existing.provenance.some((p) => p.branch === part.branch && p.partition_id === part.id)) existing.provenance.push(provenance);
      } else {
        if (cp.items.length >= plan.limits.max_items) { addPartitionGap(cp, part, "item_budget"); continue; }
        const item: CollectorItem = { id, raw_search: row, provenance: [provenance], first_fetched_at: fetchedAt, last_fetched_at: fetchedAt };
        cp.items.push(item);
        itemsById.set(id, item);
        undo.addedItemIds.add(id);
      }
    }
    cp.counters.items = cp.items.length;
  };
  const reconcileCoverage = (): void => {
    const childrenByParent = new Map<string, Partition[]>();
    for (const part of cp.partitions) {
      if (part.parent_id === undefined) continue;
      const children = childrenByParent.get(part.parent_id) ?? [];
      children.push(part);
      childrenByParent.set(part.parent_id, children);
    }
    const internalPartitionIds = new Set(childrenByParent.keys());
    // v1 wrote invalid-ID gaps for the overloaded parent's probe page. Its
    // descendant leaves now provide the actual coverage evidence.
    cp.gaps = cp.gaps.filter((gap) => !(gap.code === "invalid_vacancy_id" && gap.partition_id && internalPartitionIds.has(gap.partition_id)));
    const leavesUnder = (part: Partition): Partition[] => {
      const children = childrenByParent.get(part.id) ?? [];
      return children.length === 0 ? [part] : children.flatMap(leavesUnder);
    };

    for (const part of cp.partitions) {
      const leafIds = partitionItems.get(part.id)!;
      if (part.observed_items! - part.duplicate_items! - part.invalid_items! !== leafIds.size) part.coverage_invalid = true;
      if (part.coverage_invalid) addPartitionGap(cp, part, "coverage_state_invalid", "Persisted per-partition coverage counters disagree with item provenance.");
      const isLeaf = (childrenByParent.get(part.id)?.length ?? 0) === 0;
      if (!isLeaf) continue;

      if ((part.duplicate_items ?? 0) > 0) {
        addPartitionGap(cp, part, "duplicate_vacancy_id", `duplicate_rows=${part.duplicate_items}`);
      }
      if ((part.invalid_items ?? 0) > 0) {
        addPartitionGap(cp, part, "invalid_vacancy_id", `invalid_rows=${part.invalid_items}`);
      }
      if (part.found_history.length > 1 && new Set(part.found_history).size > 1 || part.found !== undefined && part.found_history.at(-1) !== part.found) {
        addPartitionGap(cp, part, "found_changed");
      }
      if (part.status === "done" && part.found !== undefined) {
        const unique = leafIds.size;
        if (unique !== part.found) {
          addPartitionGap(cp, part, "coverage_mismatch", `expected=${part.found};unique=${unique}`);
        }
      }
    }

    for (const part of cp.partitions) {
      if (!(childrenByParent.get(part.id)?.length)) continue;
      const leaves = leavesUnder(part);
      if (!leaves.length || leaves.some((leaf) => leaf.status !== "done") || part.found === undefined) continue;
      const leafUnion = new Set<string>();
      for (const leaf of leaves) for (const id of partitionItems.get(leaf.id)!) leafUnion.add(id);
      if (leafUnion.size !== part.found) {
        addPartitionGap(cp, part, "coverage_mismatch", `expected=${part.found};unique_leaf_union=${leafUnion.size}`);
      }
    }
  };
  const request = async (path: string): Promise<unknown> => get(path, { budget, signal: options.signal } as HhGetOptions);
  const paginate = async (part: Partition, branch: SearchBranch): Promise<void> => {
    const pageSize = plan.mode === "fast" ? 20 : PAGE_SIZE;
    const maxPages = plan.mode === "fast" ? 1 : PAGE_CAP;
    const advertised = Math.min(maxPages, Math.max(1, part.pages ?? Math.ceil((part.found ?? 0) / pageSize)));
    for (let pageNo = part.page; pageNo < advertised; pageNo++) {
      if (cp.items.length >= plan.limits.max_items) { part.status = "partial"; addPartitionGap(cp, part, "item_budget"); return; }
      const undo = beginPage(part);
      cp.counters.logical_pages++;
      const row = parsePage(await request(queryFor(part, pageNo, branch, plan.mode === "fast")));
      if (part.found !== row.found) addPartitionGap(cp, part, "found_changed");
      part.found_history.push(row.found);
      part.found = row.found;
      if (row.pages !== undefined && part.pages !== undefined && row.pages !== part.pages) { part.status = "partial"; addPartitionGap(cp, part, "pages_changed"); return; }
      addHits(part, row.items, undo);
      if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
        rollbackPage(part, undo);
        stateBudget = true;
        cp.gaps.push({ code: "state_budget", branch: part.branch, partition_id: part.id });
        await persist();
        return;
      }
      const expected = Math.min(pageSize, Math.max(0, row.found - pageNo * pageSize));
      if (row.items.length < expected) { part.page = pageNo + 1; part.status = "partial"; addPartitionGap(cp, part, "short_page"); await persist(); return; }
      if (row.items.length > expected) { part.page = pageNo + 1; part.status = "partial"; addPartitionGap(cp, part, "long_page"); await persist(); return; }
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
          const undo = beginPage(part);
          cp.counters.logical_pages++;
          const first = parsePage(await request(queryFor(part, 0, branch, plan.mode === "fast")));
          part.first_page_done = true;
          part.found = first.found;
          part.found_history.push(first.found);
          part.pages = first.pages;
          part.page = 1;
          const maxPages = plan.mode === "fast" ? 1 : PAGE_CAP;
          const pageSize = plan.mode === "fast" ? 20 : PAGE_SIZE;
          addHits(part, first.items.slice(0, pageSize), undo);
          if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
            rollbackPage(part, undo);
            stateBudget = true;
            addPartitionGap(cp, part, "state_budget");
            await persist();
            break;
          }
          const expectedPageCount = Math.min(maxPages, Math.ceil(first.found / pageSize));
          if (first.pages !== undefined && first.pages !== expectedPageCount) {
            addPartitionGap(cp, part, "pages_mismatch");
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
                  { ...part, id: `${part.id}.${suffix}`, parent_id: part.id, date_from: toHH(from), date_to: toHH(leftTo), status: "pending", page: 0, found: undefined, found_history: [], pages: undefined, first_page_done: false, observed_items: 0, duplicate_items: 0, invalid_items: 0, coverage_invalid: undefined, error: undefined },
                  { ...part, id: `${part.id}.${suffix + 1}`, parent_id: part.id, date_from: toHH(rightFrom), date_to: toHH(rightTo), status: "pending", page: 0, found: undefined, found_history: [], pages: undefined, first_page_done: false, observed_items: 0, duplicate_items: 0, invalid_items: 0, coverage_invalid: undefined, error: undefined },
                );
                partitionItems.set(cp.partitions.at(-2)!.id, new Set());
                partitionItems.set(cp.partitions.at(-1)!.id, new Set());
                if (safeJsonBytes(cp) > CHECKPOINT_LIMIT) {
                  cp.partitions.splice(-2);
                  partitionItems.delete(`${part.id}.${suffix}`);
                  partitionItems.delete(`${part.id}.${suffix + 1}`);
                  part.status = "partial";
                  addPartitionGap(cp, part, "state_budget");
                  stateBudget = true;
                  await persist();
                  break;
                }
                await persist();
                continue;
              }
            }
            part.status = "partial";
            addPartitionGap(cp, part, "unsplittable_over_cap");
          }
          const expectedFirstPage = Math.min(pageSize, first.found);
          if (first.items.length < expectedFirstPage) {
            part.status = "partial";
            addPartitionGap(cp, part, "short_page");
          }
          if (first.items.length > expectedFirstPage) {
            part.status = "partial";
            addPartitionGap(cp, part, "long_page");
          }
          if (plan.mode === "fast") {
            part.status = "partial";
            addPartitionGap(cp, part, "fast_sample");
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
          const evaluated = evaluatePostFilters(detail, plan.post_filters, plan.filter_mode);
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
  reconcileCoverage();
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

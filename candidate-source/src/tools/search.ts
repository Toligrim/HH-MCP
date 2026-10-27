import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { HhApiError } from "../client.js";
import { createHhRequestBudget } from "../requestBudget.js";
import { explainVacancyQuery, searchVacanciesSchema } from "../search/query.js";
import { resolveSearchDictionary, resolveSearchDictionarySchema } from "../search/dictionaries.js";
import { searchSpecObjectSchema, planSearch } from "../search/planner.js";
import { collectSearch } from "../search/collector.js";
import { fetchVacanciesBatch, getVacanciesBatchSchema } from "./vacancyBatch.js";

export type McpExtra = RequestHandlerExtra<any, any>;

export class SearchToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchToolError";
  }
}

const MCP_LIMITS = {
  max_requests: 25,
  max_items: 500,
  max_duration_sec: 20,
  max_bytes: 2 * 1024 * 1024,
  max_detail_fetches: 25,
} as const;
const limitsInputSchema = z.object({
  max_requests: z.number().int().positive().optional(),
  max_items: z.number().int().positive().optional(),
  max_duration_sec: z.number().finite().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  max_detail_fetches: z.number().int().nonnegative().optional(),
}).strict();
export const planSearchInputSchema = searchSpecObjectSchema.extend({ limits: limitsInputSchema.optional() }).strict();
export const explainSearchInputSchema = searchVacanciesSchema.extend({
  district: z.union([z.string().trim().min(1).max(120), z.array(z.string().trim().min(1).max(120)).min(1).max(20)]).optional(),
}).strict();
export const deepSearchInputSchema = planSearchInputSchema;
export const getVacanciesBatchInputSchema = getVacanciesBatchSchema;
export const resolveDictionaryInputSchema = resolveSearchDictionarySchema;
export const emptyInputSchema = z.object({}).strict();

let deepSearchBusy = false;

function boundedJson(value: unknown, label: string): string {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) throw new SearchToolError("response_too_large", `${label} exceeds the 64 KiB MCP response limit; narrow the query or reduce the requested scope.`);
  return output;
}

function withMcpLimits(input: unknown): Record<string, unknown> {
  const parsed = planSearchInputSchema.parse(input);
  const limits = { ...MCP_LIMITS, ...(parsed.limits ?? {}) };
  return { ...parsed, limits };
}

function assertMcpCaps(limits: Record<string, number>): void {
  for (const key of Object.keys(MCP_LIMITS) as (keyof typeof MCP_LIMITS)[]) {
    if (limits[key]! > MCP_LIMITS[key]) throw new SearchToolError("mcp_limit_exceeded", `MCP limit ${key} exceeds the maximum ${MCP_LIMITS[key]}.`);
  }
}

export async function handlePlanSearch(input: unknown): Promise<string> {
  const prepared = withMcpLimits(input);
  const plan = planSearch(prepared);
  return boundedJson(plan, "Search plan");
}

export async function handleExplainSearch(input: unknown): Promise<string> {
  const parsed = explainSearchInputSchema.parse(input);
  return boundedJson({ ...explainVacancyQuery(parsed), execution: "not_requested" }, "Search explanation");
}

export async function handleResolveSearchDictionary(input: unknown, extra?: McpExtra): Promise<string> {
  const parsed = resolveSearchDictionarySchema.parse(input);
  const budget = createHhRequestBudget({ max_requests: 1, max_duration_sec: 20, max_bytes: 2 * 1024 * 1024 });
  let result: unknown;
  try {
    result = await resolveSearchDictionary(parsed, { request: { budget, signal: extra?.signal } });
  } catch (error) {
    if (error instanceof HhApiError) {
      throw new SearchToolError("hh_api_error", "HH dictionary request failed.", error.status === 429 || error.status >= 500, error.status);
    }
    if (error instanceof Error) throw new Error(error.name === "HhApiError" ? "HH dictionary request failed." : error.message);
    throw new Error("HH dictionary request failed.");
  }
  return boundedJson(result, "Dictionary result");
}

type SearchItem = Awaited<ReturnType<typeof collectSearch>>["items"][number];
type SearchDisposition = "matched" | "review" | "excluded";

function disposition(item: SearchItem): SearchDisposition {
  if (!item.filtering) return "matched";
  if (item.filtering.decision === "exclude") return "excluded";
  if (item.filtering.state === "verified" && item.filtering.decision === "keep") return "matched";
  return "review";
}

function summarizeItem(item: SearchItem, classification: Exclude<SearchDisposition, "excluded">) {
  const raw = item.raw_search;
  const employer = raw.employer && typeof raw.employer === "object" ? raw.employer as Record<string, unknown> : {};
  const area = raw.area && typeof raw.area === "object" ? raw.area as Record<string, unknown> : {};
  const salary = raw.salary && typeof raw.salary === "object" ? raw.salary : undefined;
  const snippet = raw.snippet && typeof raw.snippet === "object" ? raw.snippet as Record<string, unknown> : {};
  return {
    id: item.id,
    classification,
    name: typeof raw.name === "string" ? raw.name : undefined,
    employer: typeof employer.name === "string" ? employer.name : undefined,
    employer_id: employer.id,
    area: typeof area.name === "string" ? area.name : undefined,
    salary,
    requirement: typeof snippet.requirement === "string" ? snippet.requirement : undefined,
    responsibility: typeof snippet.responsibility === "string" ? snippet.responsibility : undefined,
    url: typeof raw.alternate_url === "string" ? raw.alternate_url : undefined,
    filtering: item.filtering,
    provenance: item.provenance,
    first_fetched_at: item.first_fetched_at,
    last_fetched_at: item.last_fetched_at,
  };
}

export async function handleDeepSearch(input: unknown, extra?: McpExtra): Promise<string> {
  const prepared = withMcpLimits(input);
  const limits = prepared.limits as Record<string, number>;
  assertMcpCaps(limits);
  if (deepSearchBusy) throw new SearchToolError("deep_search_busy", "A deep_search call is already running in this process; retry after it completes.", true);
  deepSearchBusy = true;
  try {
    const plan = planSearch(prepared);
    const collected = await collectSearch(plan, { signal: extra?.signal });
    const matched = collected.items.filter((item) => disposition(item) === "matched");
    const review = collected.items.filter((item) => disposition(item) === "review");
    const excluded = collected.items.filter((item) => disposition(item) === "excluded");
    const primary = [...matched.map((item) => ({ item, classification: "matched" as const })), ...review.map((item) => ({ item, classification: "review" as const }))];
    const matchedIds = matched.map((item) => item.id);
    const reviewIds = review.map((item) => item.id);
    const excludedIds = excluded.map((item) => item.id);
    const envelope: Record<string, unknown> = {
      status: collected.status,
      plan: { signature: plan.signature, mode: plan.mode, created_at: plan.created_at, frozen_date_bounds: plan.frozen_date_bounds },
      total_known: collected.manifest.known_items,
      found: collected.manifest.found,
      matched_count: matched.length,
      review_count: review.length,
      excluded_count: excluded.length,
      coverage: { status: collected.manifest.status, branches: collected.manifest.branches, partitions: collected.manifest.partitions, warnings: collected.manifest.warnings },
      applied_filters: {
        base_template: plan.native,
        branches: plan.branches.map(({ name, native, query, overridden_fields }) => ({ name, native, query, overridden_fields })),
        post_filters: plan.post_filters,
        filter_mode: plan.filter_mode,
        details: plan.details,
      },
      unsupported_filters: [],
      matched_ids: matchedIds.slice(0, 500),
      matched_ids_returned: Math.min(matchedIds.length, 500),
      matched_ids_truncated: matchedIds.length > 500,
      review_ids: reviewIds.slice(0, 500),
      review_ids_returned: Math.min(reviewIds.length, 500),
      review_ids_truncated: reviewIds.length > 500,
      excluded_ids: excludedIds.slice(0, 500),
      excluded_ids_returned: Math.min(excludedIds.length, 500),
      excluded_ids_truncated: excludedIds.length > 500,
      summaries: primary.slice(0, 20).map(({ item, classification }) => summarizeItem(item, classification)),
      summaries_total: primary.length,
      summaries_returned: Math.min(primary.length, 20),
      summaries_truncated: primary.length > 20,
      gaps: collected.manifest.gaps,
      errors: collected.manifest.partitions.filter((part) => part.error).map(({ branch, id, error }) => ({ branch, partition_id: id, error })),
      provenance: { source: "hh.ru live search index", snapshot_at: collected.checkpoint.updated_at, limitations: collected.manifest.warnings },
      timestamps: { started_at: collected.checkpoint.started_at, updated_at: collected.checkpoint.updated_at },
      counts: { requests: collected.manifest.requests, retries: collected.manifest.retries, bytes: collected.manifest.bytes, detail_fetches: collected.manifest.detail_fetches },
    };
    let output = JSON.stringify(envelope);
    while (Buffer.byteLength(output, "utf8") > 64 * 1024 && ((envelope.summaries as unknown[]).length || (envelope.matched_ids as unknown[]).length || (envelope.review_ids as unknown[]).length || (envelope.excluded_ids as unknown[]).length)) {
      const summaries = envelope.summaries as unknown[];
      const matchedIds = envelope.matched_ids as unknown[];
      const reviewIds = envelope.review_ids as unknown[];
      const excludedIds = envelope.excluded_ids as unknown[];
      if (summaries.length) { summaries.pop(); envelope.summaries_truncated = true; }
      else if (matchedIds.length) { matchedIds.pop(); envelope.matched_ids_truncated = true; }
      else if (reviewIds.length) { reviewIds.pop(); envelope.review_ids_truncated = true; }
      else { excludedIds.pop(); envelope.excluded_ids_truncated = true; }
      output = JSON.stringify(envelope);
    }
    if (Buffer.byteLength(output, "utf8") > 64 * 1024) throw new SearchToolError("response_too_large", "Deep search metadata exceeds the 64 KiB MCP response limit.");
    envelope.matched_ids_returned = (envelope.matched_ids as unknown[]).length;
    envelope.review_ids_returned = (envelope.review_ids as unknown[]).length;
    envelope.excluded_ids_returned = (envelope.excluded_ids as unknown[]).length;
    envelope.summaries_returned = (envelope.summaries as unknown[]).length;
    output = JSON.stringify(envelope);
    return output;
  } finally {
    deepSearchBusy = false;
  }
}

export async function handleGetVacanciesBatchMcp(input: unknown, extra?: McpExtra): Promise<string> {
  const parsed = getVacanciesBatchSchema.parse(input);
  const result = await fetchVacanciesBatch(parsed.ids, {
    signal: extra?.signal,
    budget: createHhRequestBudget({ max_requests: 25, max_duration_sec: 20, max_bytes: 2 * 1024 * 1024 }),
    max_response_bytes: 64 * 1024,
  });
  return boundedJson(result, "Batch result");
}

export function getSearchCapabilityData(activeToolNames: string[], version: string): Record<string, unknown> {
  const names = new Set(activeToolNames);
  const enabled = [...names].filter((name) => ["plan_search", "explain_search", "deep_search", "get_capabilities", "resolve_search_dictionary", "get_vacancies_batch"].includes(name));
  const localWriterEnabled = names.has("get_resumes") || names.has("collect_vacancy_resumes");
  return {
    implementation: "hh-search-v1",
    schema_version: "hh-search-v1",
    version,
    enabled_tools: enabled,
    api_limits: { max_requests: 25, max_items: 500, max_duration_sec: 20, max_bytes: 2 * 1024 * 1024, max_detail_fetches: 25, max_output_bytes: 64 * 1024, pagination: "unsupported" },
    auth_mode: "external_oauth_proxy",
    export_enabled: false,
    bulk_jobs_enabled: false,
    checkpoint_mode: "local_cli_only",
    rate_limit_scope: "process",
    read_only_mode: !localWriterEnabled,
    full_detail_fetch_enabled: names.has("get_vacancy") || names.has("get_vacancies_batch") || names.has("deep_search"),
  };
}

export const searchToolSchemas = {
  searchVacancies: searchVacanciesSchema,
  planSearch: planSearchInputSchema,
  explainSearch: explainSearchInputSchema,
  deepSearch: deepSearchInputSchema,
  dictionary: resolveDictionaryInputSchema,
  batch: getVacanciesBatchInputSchema,
  capabilities: emptyInputSchema,
};

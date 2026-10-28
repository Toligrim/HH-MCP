import { createHash } from "node:crypto";
import { z } from "zod";
import { searchVacanciesSchema, normalizeVacancySearch, buildVacancyQuery, type VacancySearchParams } from "./query.js";
import { postFilterSchema, type PostFilter } from "./filters.js";

const nativeInputSchema = searchVacanciesSchema.omit({ page: true, per_page: true, raw: true }).strict();
const limitsSchema = z.object({
  max_requests: z.number().int().positive().max(1_000),
  max_items: z.number().int().positive().max(50_000),
  max_duration_sec: z.number().finite().positive().max(1_800),
  max_bytes: z.number().int().positive().max(128 * 1024 * 1024),
  max_detail_fetches: z.number().int().nonnegative().max(50_000),
}).strict();
export const searchSpecObjectSchema = z.object({
  mode: z.enum(["fast", "comprehensive", "exhaustive_within_api"]).default("comprehensive"),
  native: nativeInputSchema,
  branches: z.array(z.object({ name: z.string().trim().min(1).max(64), native: nativeInputSchema }).strict()).min(1).max(8).optional(),
  post_filters: z.array(postFilterSchema).max(20).default([]),
  filter_mode: z.enum(["strict", "inclusive", "review"]).default("inclusive"),
  details: z.enum(["none", "full"]).default("none"),
  limits: limitsSchema,
}).strict();

export const searchSpecSchema = searchSpecObjectSchema.superRefine((spec, ctx) => {
  const names = spec.branches?.map((branch) => branch.name) ?? [];
  if (new Set(names).size !== names.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "branch names must be unique" });
});

export type SearchLimits = z.infer<typeof limitsSchema>;
export type SearchBranch = { name: string; native: VacancySearchParams; query: string; overridden_fields: string[] };
export type SearchPlan = {
  version: "hh-search-v1";
  mode: "fast" | "comprehensive" | "exhaustive_within_api";
  native: VacancySearchParams;
  branches: SearchBranch[];
  post_filters: PostFilter[];
  filter_mode: "strict" | "inclusive" | "review";
  details: "none" | "full";
  limits: SearchLimits;
  effective_detail_fetches: number;
  created_at: string;
  frozen_at: number;
  frozen_date_bounds: { date_from: string; date_to: string; policy: string };
  warnings: string[];
  signature: string;
};

const repeated = new Set(["search_field", "experience", "employment", "schedule", "area", "metro", "professional_role", "industry", "employer_id", "salary_frequency", "label", "part_time", "employment_form", "work_schedule_by_days", "working_hours", "work_format", "education", "driver_license_types"]);
function canonicalNative(value: VacancySearchParams): VacancySearchParams {
  const normalized = { ...value };
  for (const key of repeated) {
    const raw = normalized[key as keyof VacancySearchParams];
    if (raw === undefined) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map((entry) => String(entry));
    const ordered = [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
    (normalized as Record<string, unknown>)[key] = ordered;
  }
  return normalized;
}
function dateMillis(value: string): number {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/^\d{4}-\d\d-\d\d$/.test(normalized)) return Date.parse(`${normalized}T00:00:00Z`);
  return Date.parse(normalized);
}
function toHHDate(ms: number): string { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000"); }
function wireQuery(value: VacancySearchParams): string {
  const query = buildVacancyQuery({ ...value, page: 0, per_page: 100, order_by: value.order_by ?? "publication_time" });
  return query.toString();
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planSearch(input: unknown, now = Date.now()): SearchPlan {
  if (!Number.isFinite(now)) throw new RangeError("now must be finite");
  const spec = searchSpecSchema.parse(input);
  const warnings: string[] = [];
  const base = canonicalNative(normalizeVacancySearch(spec.native));
  const explicitFrom = base.date_from;
  const explicitTo = base.date_to;
  const current = Math.floor(now / 300_000) * 300_000;
  const dayTo = (value: string) => /^\d{4}-\d\d-\d\d$/.test(value) ? dateMillis(value) + 86_400_000 - 1 : dateMillis(value);
  const toExact = explicitTo ? dayTo(explicitTo) : current;
  const fromExact = explicitFrom ? dateMillis(explicitFrom) : explicitTo ? dayTo(explicitTo) - (base.period ?? 30) * 86_400_000 : current - (base.period ?? 30) * 86_400_000;
  if (!explicitFrom && !base.period) warnings.push("Date window defaults to the previous 30 days; coverage applies only to this frozen window.");
  if (explicitFrom?.length === 10 || explicitTo?.length === 10) warnings.push("Date-only inputs use UTC: date_from begins at 00:00 and date_to ends at 23:59:59.999.");
  // HH rounds timestamps to five minutes. Outward alignment plus split overlap avoids introducing boundary gaps.
  const from = Math.floor(fromExact / 300_000) * 300_000;
  const to = Math.ceil(toExact / 300_000) * 300_000;
  if (!(to > from)) throw new Error("search date window must have positive duration");
  const frozenBase = canonicalNative(normalizeVacancySearch({ ...base, date_from: toHHDate(from), date_to: toHHDate(to), period: undefined, page: 0, per_page: 100, order_by: base.order_by ?? "publication_time" }));
  const explicitBranches = spec.branches;
  const branchInputs = explicitBranches?.map((branch) => ({ name: branch.name, native: branch.native })) ?? [{ name: "default", native: {} }];
  const branches = branchInputs.map(({ name, native }) => {
    const overridden = new Set(Object.keys(native).filter((key) => (base as Record<string, unknown>)[key] !== undefined));
    if (native.period !== undefined) for (const key of ["date_from", "date_to"]) if ((base as Record<string, unknown>)[key] !== undefined) overridden.add(key);
    const overridden_fields = [...overridden].sort();
    if (explicitBranches) for (const key of overridden_fields) warnings.push(`Branch ${name} overrides base field ${key}.`);
    // An explicitly supplied branch replaces the base execution path while retaining every unmentioned base constraint.
    if (native.period !== undefined && (native.date_from !== undefined || native.date_to !== undefined)) throw new Error(`branch ${name} period cannot be combined with explicit date bounds`);
    const merged = { ...frozenBase, ...native, page: 0, per_page: 100, order_by: native.order_by ?? frozenBase.order_by ?? "publication_time" } as Record<string, unknown>;
    if (native.period !== undefined) { delete merged.date_from; delete merged.date_to; }
    const normalizedMerged = canonicalNative(normalizeVacancySearch(merged));
    let branchFrom: number;
    let branchTo: number;
    if (native.period !== undefined) {
      // A branch period is a logical window override, ending at the frozen current time.
      branchTo = current;
      branchFrom = branchTo - native.period * 86_400_000;
    } else {
      branchFrom = normalizedMerged.date_from ? dateMillis(String(normalizedMerged.date_from)) : from;
      branchTo = normalizedMerged.date_to ? dayTo(String(normalizedMerged.date_to)) : to;
    }
    if (!(branchTo > branchFrom)) throw new Error(`branch ${name} date window must have positive duration`);
    merged.date_from = toHHDate(Math.floor(branchFrom / 300_000) * 300_000);
    merged.date_to = toHHDate(Math.ceil(branchTo / 300_000) * 300_000);
    const normalized = canonicalNative(normalizeVacancySearch({ ...normalizedMerged, date_from: toHHDate(Math.floor(branchFrom / 300_000) * 300_000), date_to: toHHDate(Math.ceil(branchTo / 300_000) * 300_000), period: undefined }));
    return { name, native: normalized, query: wireQuery(normalized), overridden_fields };
  });
  if (spec.mode === "fast") warnings.push("Fast mode samples at most the first 20 results per branch; it does not establish full branch coverage.");
  else warnings.push("Coverage reflects the live HH index within the frozen query window; it does not cover all historical vacancies.");
  if (spec.post_filters.length && spec.details === "none") warnings.push("Postfilters still require full vacancy-card reads; details=none omits raw detail from saved items but does not avoid that request cost.");
  if (spec.post_filters.length) warnings.push("Postfilter outcomes for missing or unfetched full cards remain unknown.");
  if (spec.mode !== "fast") warnings.push("No geographic, role, or synonym split is inferred; unresolved intervals are reported explicitly.");
  const frozen_date_bounds = { date_from: toHHDate(from), date_to: toHHDate(to), policy: "UTC date-only; outward 5-minute alignment; split children overlap by at least 5 minutes; boundary inclusivity unknown" };
  const signatureInput = { version: "hh-search-v1", host: frozenBase.host ?? "hh.ru", native: frozenBase, branches: branches.map(({ name, native }) => ({ name, native })), post_filters: spec.post_filters, filter_mode: spec.filter_mode, details: spec.details, mode: spec.mode, limits: spec.limits };
  const signature = createHash("sha256").update(canonicalJson(signatureInput)).digest("hex");
  return {
    version: "hh-search-v1", mode: spec.mode, native: frozenBase, branches, post_filters: spec.post_filters,
    filter_mode: spec.filter_mode, details: spec.details, limits: spec.limits,
    effective_detail_fetches: spec.post_filters.length ? Math.min(spec.limits.max_detail_fetches, spec.limits.max_items) : spec.details === "full" ? Math.min(spec.limits.max_detail_fetches, spec.limits.max_items) : 0,
    created_at: new Date(now).toISOString(), frozen_at: now, frozen_date_bounds, warnings, signature,
  };
}

export function verifySearchPlan(plan: SearchPlan): boolean {
  if (!plan || plan.version !== "hh-search-v1" || !Array.isArray(plan.branches) || !Array.isArray(plan.post_filters)) return false;
  const signatureInput = {
    version: "hh-search-v1", host: plan.native?.host ?? "hh.ru", native: plan.native,
    branches: plan.branches.map(({ name, native }) => ({ name, native })), post_filters: plan.post_filters,
    filter_mode: plan.filter_mode, details: plan.details, mode: plan.mode, limits: plan.limits,
  };
  const signature = createHash("sha256").update(canonicalJson(signatureInput)).digest("hex");
  return signature === plan.signature && plan.branches.every((branch) => branch.query === wireQuery(branch.native));
}

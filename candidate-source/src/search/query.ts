import { z } from "zod";
import { assertKnownDictionaryValue, getSearchCatalogueMetadata } from "./dictionaries.js";

const positiveNumericId = z.string().max(120).regex(/^\d+$/, "must be a positive numeric id").refine((value) => BigInt(value) > 0n, "must be a positive numeric id");
const id = z.union([z.number().int().safe().positive(), positiveNumericId]);
const decimalId = z.union([z.number().positive().finite(), z.string().max(120).regex(/^\d+(?:\.\d+)*$/, "must be a positive id").refine((value) => value.split(".").some((part) => BigInt(part) > 0n), "must be a positive id")]);
const numeric = (min: number, max: number) => z.number().finite().min(min).max(max);
const boundedText = z.string().max(500);
const dictionaryField = (catalogue: string, multi = false) => {
  const one = z.string().min(1).max(100).superRefine((value, ctx) => {
    const error = assertKnownDictionaryValue(catalogue, value);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  });
  return multi ? z.union([one, z.array(one).min(1).max(100)]) : one;
};
const dateValue = z.string().refine((value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[6] !== "Z" && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  const normalized = value.endsWith("Z") ? value : value.replace(/([+-]\d{2}):?(\d{2})$/, "$1:$2");
  return Number.isFinite(Date.parse(normalized));
}, "must be YYYY-MM-DD or an ISO date-time with timezone");
const list = <T extends z.ZodTypeAny>(item: T) => z.union([item, z.array(item).min(1).max(100)]);
const bool = z.boolean();
const hostSchema = z.enum(["hh.ru", "rabota.by", "hh1.az", "hh.uz", "hh.kz", "headhunter.ge", "headhunter.kg"]);

export const searchVacanciesSchema = z.object({
  page: z.number().int().min(0).default(0),
  per_page: z.number().int().min(1).max(100).default(20),
  text: boundedText.refine((value) => value.trim().length > 0, "must not be empty or whitespace").optional(),
  search_field: dictionaryField("vacancy_search_fields", true).optional(),
  experience: dictionaryField("experience", true).optional(),
  employment: dictionaryField("employment", true).optional(),
  schedule: dictionaryField("schedule", true).optional(),
  area: list(id).optional(),
  metro: list(decimalId).optional(),
  professional_role: list(id).optional(),
  industry: list(decimalId).optional(),
  employer_id: list(id).optional(),
  currency: dictionaryField("currency").optional(),
  salary: z.number().finite().nonnegative().optional(),
  salary_frequency: dictionaryField("salary_range_frequency", true).optional(),
  salary_mode: dictionaryField("salary_range_mode").optional(),
  label: dictionaryField("vacancy_label", true).optional(),
  only_with_salary: bool.optional(),
  period: z.number().finite().positive().max(365).optional(),
  date_from: dateValue.optional(),
  date_to: dateValue.optional(),
  top_lat: numeric(-90, 90).optional(),
  bottom_lat: numeric(-90, 90).optional(),
  left_lng: numeric(-180, 180).optional(),
  right_lng: numeric(-180, 180).optional(),
  order_by: dictionaryField("vacancy_search_order").optional(),
  sort_point_lat: numeric(-90, 90).optional(),
  sort_point_lng: numeric(-180, 180).optional(),
  clusters: bool.optional(),
  describe_arguments: bool.optional(),
  no_magic: bool.optional(),
  premium: bool.optional(),
  responses_count_enabled: bool.optional(),
  part_time: dictionaryField("part_time", true).optional(),
  accept_temporary: bool.optional(),
  employment_form: dictionaryField("vacancy_search_employment_form", true).optional(),
  work_schedule_by_days: dictionaryField("work_schedule_by_days", true).optional(),
  working_hours: dictionaryField("working_hours", true).optional(),
  work_format: dictionaryField("work_format", true).optional(),
  excluded_text: boundedText.refine((value) => value.trim().length > 0, "must not be empty or whitespace").optional(),
  education: dictionaryField("education", true).optional(),
  driver_license_types: dictionaryField("driver_license_types", true).optional(),
  host: hostSchema.optional(),
  locale: z.string().regex(/^[A-Z]{2,5}(?:-[A-Z0-9]{2,8})?$/).optional(),
  raw: bool.optional(),
  // Compatibility alias; normalized to label=with_salary.
  with_salary: bool.optional(),
}).strict();

export type VacancySearchParams = z.infer<typeof searchVacanciesSchema>;

export function normalizeVacancySearch(input: unknown): VacancySearchParams {
  const value = searchVacanciesSchema.parse(input);
  const normalizeDate = (date: string | undefined) => date?.replace(/Z$/, "+0000").replace(/([+-]\d{2}):(\d{2})$/, "$1$2");
  value.date_from = normalizeDate(value.date_from);
  value.date_to = normalizeDate(value.date_to);
  const { top_lat, bottom_lat, left_lng, right_lng } = value;
  const geo = [top_lat, bottom_lat, left_lng, right_lng];
  if (geo.some((v) => v !== undefined) && geo.some((v) => v === undefined)) throw new Error("all four bounding coordinates are required together");
  if (top_lat !== undefined && bottom_lat !== undefined && top_lat <= bottom_lat) throw new Error("top_lat must be greater than bottom_lat");
  if (left_lng !== undefined && right_lng !== undefined && left_lng >= right_lng) throw new Error("left_lng must be less than right_lng");
  if (value.currency !== undefined && value.salary === undefined) throw new Error("currency requires salary");
  if (value.period !== undefined && (value.date_from !== undefined || value.date_to !== undefined)) throw new Error("period is mutually exclusive with date_from/date_to");
  if (value.date_from && value.date_to && Date.parse(value.date_from.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) > Date.parse(value.date_to.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))) throw new Error("date_to must not precede date_from");
  const point = [value.sort_point_lat, value.sort_point_lng];
  if ((point.some((v) => v !== undefined) && point.some((v) => v === undefined)) || (value.order_by === "distance" && point.some((v) => v === undefined)) || (value.order_by !== "distance" && point.some((v) => v !== undefined))) throw new Error("distance sorting requires both sort points, which are only valid with order_by=distance");
  if ((value.page + 1) * value.per_page > 2000) throw new Error("hh.ru caps pagination depth at 2000 results");
  const labels = value.label === undefined ? [] : Array.isArray(value.label) ? value.label : [value.label];
  const hasSalaryLabel = labels.includes("with_salary");
  const explicitlyExcludeSalary = value.with_salary === false || value.only_with_salary === false;
  const explicitlyRequireSalary = value.with_salary === true || value.only_with_salary === true || hasSalaryLabel;
  if (explicitlyExcludeSalary && explicitlyRequireSalary) throw new Error("conflicting salary filters: with_salary/only_with_salary=false conflicts with only_with_salary=true or label=with_salary");
  if (value.with_salary === true) {
    const combined = [...new Set([...labels, "with_salary"])];
    value.label = labels.length ? combined : "with_salary";
  }
  if (value.with_salary === false) value.only_with_salary = false;
  delete value.with_salary;
  if (value.salary !== undefined && value.currency === undefined) value.currency = "RUR";
  return value;
}

export function buildVacancyQuery(input: unknown): URLSearchParams {
  const value = normalizeVacancySearch(input);
  const query = new URLSearchParams();
  const repeated = new Set(["search_field", "experience", "employment", "schedule", "area", "metro", "professional_role", "industry", "employer_id", "salary_frequency", "label", "part_time", "employment_form", "work_schedule_by_days", "working_hours", "work_format", "education", "driver_license_types"]);
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || key === "raw" || key === "currency" && value.salary === undefined) continue;
    const val = raw;
    if (repeated.has(key)) {
      for (const item of Array.isArray(val) ? val : [val]) query.append(key, String(item));
    } else if (typeof val === "boolean" || typeof val === "number" || typeof val === "string") query.set(key, String(val));
  }
  if (value.salary !== undefined && value.currency === undefined) query.set("currency", "RUR");
  return query;
}

export function explainVacancyQuery(input: unknown): { normalized: VacancySearchParams; query_string: string; applied_filters: Record<string, unknown>; warnings: string[]; unsupported_filters: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("search input must be an object");
  const source = input as Record<string, unknown>;
  const unsupported = Object.keys(source).filter((key) => key === "district");
  const known = { ...source };
  for (const key of unsupported) delete known[key];
  const hadSalaryAlias = source.with_salary === true;
  const normalized = normalizeVacancySearch(known);
  const warnings: string[] = [];
  if (normalized.employment !== undefined || normalized.schedule !== undefined || normalized.part_time !== undefined || normalized.only_with_salary !== undefined || normalized.premium !== undefined) warnings.push("Some supplied filters are deprecated by HH; modern replacements are preferred.");
  if (hadSalaryAlias) warnings.push("with_salary alias normalized to label=with_salary.");
  if (source.with_salary === false) warnings.push("with_salary=false normalizes to the neutral only_with_salary=false flag; it is not a request to exclude vacancies without salary.");
  const catalogue = getSearchCatalogueMetadata();
  const refreshState = catalogue.refreshed_catalogues.length
    ? catalogue.refreshed_catalogues.map((item) => `${item.dictionary}=${item.updated_at}${item.stale ? " (stale)" : " (fresh)"}`).join(", ")
    : "runtime catalogues not refreshed";
  warnings.push(`Dictionary catalogue seeded ${catalogue.seeded_snapshot_date}; ${refreshState}. Opaque region, role, metro, industry and employer IDs are checked by HH.`);
  const labels = normalized.label === undefined ? [] : Array.isArray(normalized.label) ? normalized.label : [normalized.label];
  if (labels.includes("accept_temporary")) warnings.push("label=accept_temporary is retained for compatibility; use the accept_temporary boolean instead.");
  const query = buildVacancyQuery(known);
  const applied_filters = Object.fromEntries(Object.entries(normalized).filter(([key, val]) => val !== undefined && !["page", "per_page", "raw"].includes(key)));
  return { normalized, query_string: query.toString(), applied_filters, warnings, unsupported_filters: unsupported };
}

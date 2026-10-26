import { z } from "zod";
import { hhGet } from "../client.js";

const seed: Record<string, string[]> = {
  vacancy_search_fields: ["name", "company_name", "description"],
  experience: ["noExperience", "between1And3", "between3And6", "moreThan6"],
  employment: ["full", "part", "project", "volunteer", "probation"],
  schedule: ["fullDay", "shift", "flexible", "remote", "flyInFlyOut"],
  currency: ["AZN", "BYR", "EUR", "GEL", "KGS", "KZT", "RUR", "UAH", "USD", "UZS"],
  salary_range_frequency: ["DAILY", "WEEKLY", "TWICE_PER_MONTH", "MONTHLY", "PER_PROJECT"],
  salary_range_mode: ["MONTH", "SHIFT", "HOUR", "FLY_IN_FLY_OUT", "SERVICE"],
  vacancy_label: ["with_address", "accept_handicapped", "not_from_agency", "accept_kids", "accredited_it", "low_performance", "internship", "night_shifts", "with_salary", "accept_teens", "accept_labor_contract", "accept_temporary"],
  vacancy_search_order: ["publication_time", "salary_desc", "salary_asc", "relevance", "distance"],
  part_time: ["only_saturday_and_sunday", "from_four_to_six_hours_in_a_day", "start_after_sixteen", "full", "part", "project", "volunteer", "probation"],
  vacancy_search_employment_form: ["FULL", "PART", "PROJECT", "FLY_IN_FLY_OUT"],
  work_schedule_by_days: ["SIX_ON_ONE_OFF", "FIVE_ON_TWO_OFF", "FOUR_ON_FOUR_OFF", "FOUR_ON_THREE_OFF", "FOUR_ON_TWO_OFF", "THREE_ON_THREE_OFF", "THREE_ON_TWO_OFF", "TWO_ON_TWO_OFF", "TWO_ON_ONE_OFF", "ONE_ON_THREE_OFF", "ONE_ON_TWO_OFF", "WEEKEND", "FLEXIBLE", "OTHER"],
  working_hours: ["HOURS_2", "HOURS_3", "HOURS_4", "HOURS_5", "HOURS_6", "HOURS_7", "HOURS_8", "HOURS_9", "HOURS_10", "HOURS_11", "HOURS_12", "HOURS_24", "FLEXIBLE", "OTHER"],
  work_format: ["ON_SITE", "REMOTE", "HYBRID", "FIELD_WORK"],
  education: ["not_required_or_not_specified", "special_secondary", "higher"],
  driver_license_types: ["A", "B", "C", "D", "E", "BE", "CE", "DE", "TM", "TB"],
};
const catalogueIds = new Map(Object.entries(seed).map(([name, ids]) => [name, new Set(ids)]));
const TTL_MS = 60 * 60 * 1000;
const MAX_CATALOGUES = 8;
type Entry = { items: DictionaryItem[]; updated_at: number; loaded_at: number };
type DictionaryItem = { id: string; name: string; [key: string]: unknown };
const cache = new Map<string, Entry>();

const endpointMap: Record<string, { path: string; key?: string | string[] }> = {
  areas: { path: "/areas" }, metro: { path: "/metro" }, professional_roles: { path: "/professional_roles" },
  industries: { path: "/industries" }, vacancy_search_fields: { path: "/dictionaries", key: "vacancy_search_fields" },
  experience: { path: "/dictionaries", key: "experience" }, employment: { path: "/dictionaries", key: "employment" },
  schedule: { path: "/dictionaries", key: "schedule" }, currency: { path: "/dictionaries", key: "currency" },
  salary_range_frequency: { path: "/dictionaries", key: "salary_range_frequency" }, salary_range_mode: { path: "/dictionaries", key: "salary_range_mode" },
  vacancy_label: { path: "/dictionaries", key: "vacancy_label" }, vacancy_search_order: { path: "/dictionaries", key: "vacancy_search_order" },
  working_days: { path: "/dictionaries", key: "working_days" }, working_time_intervals: { path: "/dictionaries", key: "working_time_intervals" },
  working_time_modes: { path: "/dictionaries", key: "working_time_modes" }, part_time: { path: "/dictionaries", key: ["working_days", "working_time_intervals", "working_time_modes", "employment"] },
  vacancy_search_employment_form: { path: "/dictionaries", key: "vacancy_search_employment_form" }, work_schedule_by_days: { path: "/dictionaries", key: "work_schedule_by_days" },
  working_hours: { path: "/dictionaries", key: "working_hours" }, work_format: { path: "/dictionaries", key: "work_format" },
  education: { path: "/dictionaries", key: "education" }, driver_license_types: { path: "/dictionaries", key: "driver_license_types" },
};

export const resolveSearchDictionarySchema = z.object({
  dictionary: z.enum(Object.keys(endpointMap) as [string, ...string[]]),
  text: z.string().trim().min(1).max(120),
}).strict();

export function assertKnownDictionaryValue(dictionary: string, value: string): string | undefined {
  const ids = catalogueIds.get(dictionary);
  return ids && !ids.has(value) ? `unknown ${dictionary} id; use resolve_search_dictionary to refresh the public catalogue` : undefined;
}

export function getSearchCatalogueMetadata(): { seeded_snapshot_date: string; refreshed_catalogues: Array<{ dictionary: string; updated_at: string; stale: boolean }> } {
  const now = Date.now();
  return {
    seeded_snapshot_date: "2026-10-26",
    refreshed_catalogues: [...cache.entries()].map(([dictionary, entry]) => ({
      dictionary, updated_at: new Date(entry.updated_at).toISOString(), stale: now - entry.loaded_at >= TTL_MS,
    })),
  };
}

function flatten(value: unknown, out: DictionaryItem[] = []): DictionaryItem[] {
  if (Array.isArray(value)) { for (const item of value) flatten(item, out); return out; }
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if ((typeof record.id === "string" || typeof record.id === "number") && typeof record.name === "string") {
    out.push({ ...record, id: String(record.id), name: record.name });
  }
  for (const [key, child] of Object.entries(record)) if (key !== "id" && key !== "name" && (Array.isArray(child) || child && typeof child === "object")) flatten(child, out);
  return out;
}

function upsert(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CATALOGUES) cache.delete(cache.keys().next().value as string);
  if (catalogueIds.has(key)) {
    const values = entry.items.map((item) => item.id);
    if (key === "vacancy_label") values.push("accept_temporary");
    catalogueIds.set(key, new Set(values));
  }
  if (key === "part_time") {
    const vals = entry.items.map((item) => item.id);
    catalogueIds.set("part_time", new Set([...vals, "full", "part", "project", "volunteer", "probation"]));
  }
}

export async function resolveSearchDictionary(input: { dictionary: string; text: string }, options?: { now?: number }): Promise<unknown> {
  const { dictionary, text } = resolveSearchDictionarySchema.parse(input);
  const now = options?.now ?? Date.now();
  let entry = cache.get(dictionary);
  if (!entry || now - entry.loaded_at >= TTL_MS) {
    const endpoint = endpointMap[dictionary]!;
    const response = await hhGet(endpoint.path);
    const keys = endpoint.key === undefined ? [] : Array.isArray(endpoint.key) ? endpoint.key : [endpoint.key];
    const selected = keys.length && response && typeof response === "object"
      ? keys.flatMap((key) => flatten((response as Record<string, unknown>)[key]))
      : flatten(response);
    const items = selected.slice(0, 50_000);
    entry = { items, updated_at: now, loaded_at: now };
    upsert(dictionary, entry);
  } else {
    cache.delete(dictionary);
    cache.set(dictionary, entry);
  }
  const needle = text.toLocaleLowerCase();
  const exact = entry.items.find((item) => item.id.toLocaleLowerCase() === needle || item.name.toLocaleLowerCase() === needle);
  const candidates = exact ? [] : entry.items.filter((item) => item.id.toLocaleLowerCase().includes(needle) || item.name.toLocaleLowerCase().includes(needle)).slice(0, 20);
  return {
    dictionary, status: exact ? "exact" : candidates.length ? "candidates" : "unknown",
    ...(exact ? { id: exact.id, name: exact.name } : {}), candidates,
    catalogue_updated_at: new Date(entry.updated_at).toISOString(), stale: now - entry.loaded_at >= TTL_MS,
    note: "IDs are returned only from the public HH catalogue; opaque IDs in other filters are validated by HH.",
  };
}

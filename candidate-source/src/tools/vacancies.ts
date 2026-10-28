import { z } from "zod";
import { hhGet } from "../client.js";
import { requireToken } from "../auth.js";
import type { Vacancy, VacancyDetail, SearchResult, VacancyStats } from "../types.js";
import {
  formatVacancySearch,
  formatVacancyDetail,
  formatVacancyStats,
} from "../format.js";
import { buildVacancyQuery, normalizeVacancySearch } from "../search/query.js";

export { searchVacanciesSchema } from "../search/query.js";

const rawFlag = z
  .boolean()
  .optional()
  .describe("Return the full raw hh.ru JSON instead of the compact summary.");

// hh vacancy ids are numeric strings — validate to avoid path injection.
const vacancyId = z.string().regex(/^\d+$/, "vacancy_id must be a numeric hh.ru id");

export async function handleSearchVacancies(
  input: unknown,
): Promise<string> {
  const params = normalizeVacancySearch(input);
  const query = buildVacancyQuery(params);

  const result = await hhGet(`/vacancies?${query.toString()}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const getVacancySchema = z.object({
  vacancy_id: vacancyId.describe("Vacancy ID"),
  raw: rawFlag,
});

export async function handleGetVacancy(
  params: z.infer<typeof getVacancySchema>,
): Promise<string> {
  const result = await hhGet(`/vacancies/${encodeURIComponent(params.vacancy_id)}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancyDetail(result as VacancyDetail);
}

export const getSimilarVacanciesSchema = z.object({
  vacancy_id: vacancyId.describe("Vacancy ID to find similar vacancies for"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  raw: rawFlag,
});

export async function handleGetSimilarVacancies(
  params: z.infer<typeof getSimilarVacanciesSchema>,
): Promise<string> {
  const query = new URLSearchParams();
  query.set("per_page", String(params.per_page));
  query.set("page", String(params.page));

  const result = await hhGet(
    `/vacancies/${encodeURIComponent(params.vacancy_id)}/similar_vacancies?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const getRelatedVacanciesSchema = z.object({
  vacancy_id: vacancyId.describe("Vacancy ID to find related vacancies for"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  raw: rawFlag,
});

export async function handleGetRelatedVacancies(
  params: z.infer<typeof getRelatedVacanciesSchema>,
): Promise<string> {
  const query = new URLSearchParams();
  query.set("per_page", String(params.per_page));
  query.set("page", String(params.page));

  const result = await hhGet(
    `/vacancies/${encodeURIComponent(params.vacancy_id)}/related_vacancies?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const getVacancyStatsSchema = z.object({
  vacancy_id: vacancyId.describe("Vacancy ID"),
  raw: rawFlag,
});

export async function handleGetVacancyStats(
  params: z.infer<typeof getVacancyStatsSchema>,
): Promise<string> {
  requireToken();
  const result = await hhGet(`/vacancies/${encodeURIComponent(params.vacancy_id)}/stats`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancyStats(result as VacancyStats);
}

export const getVacancyVisitorsSchema = z.object({
  vacancy_id: vacancyId.describe("Vacancy ID"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  raw: rawFlag,
});

export async function handleGetVacancyVisitors(
  params: z.infer<typeof getVacancyVisitorsSchema>,
): Promise<string> {
  requireToken();
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("per_page", String(params.per_page));
  const result = await hhGet(
    `/vacancies/${encodeURIComponent(params.vacancy_id)}/visitors?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const data = result as {
    found?: number;
    page?: number;
    pages?: number;
    hidden_on_page?: number;
    items?: { id?: string; last_visit?: string; resume?: { id?: string; title?: string } }[];
  };
  const items = data.items ?? [];
  const found = data.found ?? items.length;
  const page = (data.page ?? params.page ?? 0) + 1;
  const pages = data.pages ?? 1;
  const hidden = data.hidden_on_page ?? 0;
  const hiddenBit = hidden ? ` · скрыто ${hidden}` : "";
  const header = `Посетителей: ${found} (страница ${page} из ${pages}, показано ${items.length}${hiddenBit})`;
  if (!items.length) {
    const why = hidden
      ? "\n(пусто — hh.ru скрыл посетителей на этой странице)"
      : "\n(пусто)";
    return `${header}${why}`;
  }
  return (
    `${header}\n\n` +
    items
      .map((v, i) => {
        const title = v.resume?.title ?? "—";
        const rid = v.resume?.id ? ` resume_id=${v.resume.id}` : "";
        return `${i + 1}. ${title}${rid}${v.last_visit ? ` · ${v.last_visit}` : ""}`;
      })
      .join("\n")
  );
}

export const getVacancyConditionsSchema = z.object({
  raw: rawFlag,
});

export async function handleGetVacancyConditions(
  params: z.infer<typeof getVacancyConditionsSchema> = {},
): Promise<string> {
  requireToken();
  const result = await hhGet("/vacancy_conditions");
  if (params.raw) return JSON.stringify(result, null, 2);
  const items =
    (result as { items?: { id?: string; name?: string }[] }).items ??
    (Array.isArray(result) ? (result as { id?: string; name?: string }[]) : []);
  if (!items.length) {
    // Some payloads are keyed objects rather than lists.
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return Object.entries(result as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join("\n");
    }
    return "(пусто)";
  }
  return items.map((c) => `${c.id ?? "—"} — ${c.name ?? "—"}`).join("\n");
}

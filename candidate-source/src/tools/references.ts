import { z } from "zod";
import { hhGet, HhApiError } from "../client.js";
import type { Area } from "../types.js";
import { flattenAreaTree } from "../format.js";

const rawFlag = z
  .boolean()
  .optional()
  .describe("Return the full raw hh.ru JSON instead of the compact id — name listing.");

const rawOnly = z.object({ raw: rawFlag });

// --- Areas ---

export const getAreasSchema = rawOnly;

export async function handleGetAreas(
  params: z.infer<typeof getAreasSchema> = {},
): Promise<string> {
  const result = await hhGet("/areas");
  if (params.raw) return JSON.stringify(result, null, 2);
  return flattenAreaTree(result as Area[]);
}

export const getAreasSubtreeSchema = z.object({
  area_id: z
    .string()
    .regex(/^\d+$/, "area_id must be a numeric hh.ru id")
    .describe(
      "Country/region id to fetch the subtree for (e.g. 113=Russia, 1=Moscow). Lighter than the full /areas tree.",
    ),
  raw: rawFlag,
});

export async function handleGetAreasSubtree(
  params: z.infer<typeof getAreasSubtreeSchema>,
): Promise<string> {
  const result = await hhGet(`/areas/${encodeURIComponent(params.area_id)}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  // /areas/{id} returns a single Area node with nested areas.
  return flattenAreaTree([result as Area]);
}

// --- Professional Roles ---

export const getProfessionalRolesSchema = rawOnly;

interface RoleCategory {
  id: string;
  name: string;
  roles?: { id: string; name: string }[];
}

export async function handleGetProfessionalRoles(
  params: z.infer<typeof getProfessionalRolesSchema> = {},
): Promise<string> {
  const result = (await hhGet("/professional_roles")) as { categories?: RoleCategory[] };
  if (params.raw) return JSON.stringify(result, null, 2);
  const cats = result.categories ?? [];
  return cats
    .map((c) => {
      const roles = (c.roles ?? []).map((r) => `  ${r.id} — ${r.name}`).join("\n");
      return `${c.id} — ${c.name}${roles ? "\n" + roles : ""}`;
    })
    .join("\n");
}

// --- Industries ---

export const getIndustriesSchema = rawOnly;

interface IndustryGroup {
  id: string;
  name: string;
  industries?: { id: string; name: string }[];
}

export async function handleGetIndustries(
  params: z.infer<typeof getIndustriesSchema> = {},
): Promise<string> {
  const result = (await hhGet("/industries")) as IndustryGroup[];
  if (params.raw) return JSON.stringify(result, null, 2);
  return result
    .map((g) => {
      const sub = (g.industries ?? []).map((i) => `  ${i.id} — ${i.name}`).join("\n");
      return `${g.id} — ${g.name}${sub ? "\n" + sub : ""}`;
    })
    .join("\n");
}

// --- Metro ---

export const getMetroSchema = z.object({
  city_id: z
    .string()
    .regex(/^\d+$/, "city_id must be a numeric hh.ru area id")
    .optional()
    .describe("City area id (e.g. 1=Moscow, 2=Saint Petersburg). Omit to list metro for all cities."),
});

export async function handleGetMetro(
  params: z.infer<typeof getMetroSchema>,
): Promise<string> {
  const path = params.city_id ? `/metro/${encodeURIComponent(params.city_id)}` : "/metro";
  const result = await hhGet(path);
  return JSON.stringify(result, null, 2);
}

// --- Dictionaries ---

export async function handleGetDictionaries(): Promise<string> {
  const result = await hhGet("/dictionaries");
  return JSON.stringify(result, null, 2);
}

// --- Current user / token validation ---

interface MeProfile {
  id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  is_admin?: boolean;
  is_applicant?: boolean;
  is_employer?: boolean;
  is_application?: boolean;
}

export const validateTokenSchema = z.object({
  raw: z.boolean().optional().describe("Return the raw /me JSON instead of the summary."),
});

export async function handleValidateToken(
  params: z.infer<typeof validateTokenSchema> = {},
): Promise<string> {
  if (!process.env.HH_ACCESS_TOKEN) {
    return "HH_ACCESS_TOKEN не задан. Доступны только публичные endpoint'ы (вакансии, работодатели, зарплаты, словари). Поиск резюме недоступен — нужен employer-токен.";
  }
  try {
    const me = (await hhGet("/me")) as MeProfile;
    if (params.raw) return JSON.stringify(me, null, 2);
    const name =
      [me.first_name, me.last_name].filter(Boolean).join(" ") || me.email || me.id || "—";
    const roles =
      [me.is_employer && "employer", me.is_applicant && "applicant", me.is_admin && "admin"]
        .filter(Boolean)
        .join(", ") || "—";
    const note = me.is_employer
      ? "Роль employer есть — поиск резюме доступен при наличии платной подписки на базу резюме."
      : "Поиск резюме недоступен: нужен employer-токен + платная подписка на базу резюме.";
    return `Токен валиден. Пользователь: ${name}${me.email ? ` <${me.email}>` : ""}. Роли: ${roles}.\n${note}`;
  } catch (e) {
    if (e instanceof HhApiError && (e.status === 401 || e.status === 403)) {
      return `Токен задан, но недействителен или истёк (HTTP ${e.status}). Получите новый OAuth-токен на https://dev.hh.ru/admin.`;
    }
    throw e;
  }
}

// --- Suggests ---

interface SuggestResponse {
  items?: { id?: string; text?: string }[];
}

function formatSuggests(result: unknown): string {
  const items = (result as SuggestResponse).items ?? [];
  if (!items.length) return "(нет совпадений)";
  return items.map((i) => `${i.text}${i.id != null ? ` (id=${i.id})` : ""}`).join("\n");
}

async function suggestGet(
  path: string,
  text: string,
  raw?: boolean,
): Promise<string> {
  const query = new URLSearchParams();
  query.set("text", text);
  const result = await hhGet(`${path}?${query.toString()}`);
  if (raw) return JSON.stringify(result, null, 2);
  return formatSuggests(result);
}

export const suggestPositionsSchema = z.object({
  text: z.string().describe("Partial job title / position name to autocomplete"),
  raw: rawFlag,
});

/** Autocomplete free-form position titles via /suggests/positions. */
export async function handleSuggestPositions(
  params: z.infer<typeof suggestPositionsSchema>,
): Promise<string> {
  return suggestGet("/suggests/positions", params.text, params.raw);
}

export const suggestProfessionalRolesSchema = z.object({
  text: z.string().describe("Partial professional role name to autocomplete"),
  raw: rawFlag,
});

/** Autocomplete professional role IDs via /suggests/professional_roles. */
export async function handleSuggestProfessionalRoles(
  params: z.infer<typeof suggestProfessionalRolesSchema>,
): Promise<string> {
  return suggestGet("/suggests/professional_roles", params.text, params.raw);
}

export const suggestCompaniesSchema = z.object({
  text: z.string().describe("Partial company name to autocomplete"),
  raw: rawFlag,
});

export async function handleSuggestCompanies(
  params: z.infer<typeof suggestCompaniesSchema>,
): Promise<string> {
  return suggestGet("/suggests/companies", params.text, params.raw);
}

export const suggestAreasSchema = z.object({
  text: z.string().describe("Partial region/city name to autocomplete"),
  raw: rawFlag,
});

export async function handleSuggestAreas(
  params: z.infer<typeof suggestAreasSchema>,
): Promise<string> {
  return suggestGet("/suggests/areas", params.text, params.raw);
}

export const suggestVacancySearchKeywordSchema = z.object({
  text: z.string().describe("Partial vacancy-search keyword"),
  raw: rawFlag,
});

export async function handleSuggestVacancySearchKeyword(
  params: z.infer<typeof suggestVacancySearchKeywordSchema>,
): Promise<string> {
  return suggestGet("/suggests/vacancy_search_keyword", params.text, params.raw);
}

export const suggestResumeSearchKeywordSchema = z.object({
  text: z.string().describe("Partial resume-search keyword"),
  raw: rawFlag,
});

export async function handleSuggestResumeSearchKeyword(
  params: z.infer<typeof suggestResumeSearchKeywordSchema>,
): Promise<string> {
  return suggestGet("/suggests/resume_search_keyword", params.text, params.raw);
}

export const suggestSkillSetSchema = z.object({
  text: z.string().describe("Partial skill name to autocomplete"),
  raw: rawFlag,
});

export async function handleSuggestSkillSet(
  params: z.infer<typeof suggestSkillSetSchema>,
): Promise<string> {
  return suggestGet("/suggests/skill_set", params.text, params.raw);
}

// --- Extra public references ---

function formatIdNameList(result: unknown): string {
  const items = Array.isArray(result)
    ? (result as { id?: string; name?: string; text?: string }[])
    : ((result as { items?: { id?: string; name?: string; text?: string }[] }).items ?? []);
  if (!items.length) return "(пусто)";
  return items
    .map((i) => `${i.id ?? "—"} — ${i.name ?? i.text ?? "—"}`)
    .join("\n");
}

export const getCountriesSchema = rawOnly;

export async function handleGetCountries(
  params: z.infer<typeof getCountriesSchema> = {},
): Promise<string> {
  const result = await hhGet("/areas/countries");
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatIdNameList(result);
}

export const getLanguagesSchema = rawOnly;

export async function handleGetLanguages(
  params: z.infer<typeof getLanguagesSchema> = {},
): Promise<string> {
  const result = await hhGet("/languages");
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatIdNameList(result);
}

export const getSkillsSchema = z.object({
  id: z
    .union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1).max(50),
    ])
    .describe(
      "Skill id(s) to resolve (1–50). hh.ru /skills requires ids — use suggest_skill_set to find them by name.",
    ),
  raw: rawFlag,
});

export async function handleGetSkills(
  params: z.infer<typeof getSkillsSchema>,
): Promise<string> {
  const ids = Array.isArray(params.id) ? params.id : [params.id];
  if (ids.length > 50) {
    throw new Error("get_skills accepts at most 50 skill ids per request.");
  }
  const query = new URLSearchParams();
  for (const id of ids) query.append("id", id);
  const result = await hhGet(`/skills?${query.toString()}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatIdNameList(result);
}

export const getDistrictsSchema = z.object({
  area_id: z
    .string()
    .regex(/^\d+$/, "area_id must be a numeric hh.ru id")
    .optional()
    .describe("Optional city/area id to filter districts"),
  raw: rawFlag,
});

export async function handleGetDistricts(
  params: z.infer<typeof getDistrictsSchema> = {},
): Promise<string> {
  const query = new URLSearchParams();
  if (params.area_id) query.set("area", params.area_id);
  const qs = query.toString();
  const result = await hhGet(`/districts${qs ? `?${qs}` : ""}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatIdNameList(result);
}

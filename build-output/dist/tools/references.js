import { z } from "zod";
import { hhGet, HhApiError } from "../client.js";
import { flattenAreaTree } from "../format.js";
const rawFlag = z
    .boolean()
    .optional()
    .describe("Return the full raw hh.ru JSON instead of the compact id — name listing.");
const rawOnly = z.object({ raw: rawFlag });
// --- Areas ---
export const getAreasSchema = rawOnly;
export async function handleGetAreas(params = {}) {
    const result = await hhGet("/areas");
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return flattenAreaTree(result);
}
export const getAreasSubtreeSchema = z.object({
    area_id: z
        .string()
        .regex(/^\d+$/, "area_id must be a numeric hh.ru id")
        .describe("Country/region id to fetch the subtree for (e.g. 113=Russia, 1=Moscow). Lighter than the full /areas tree."),
    raw: rawFlag,
});
export async function handleGetAreasSubtree(params) {
    const result = await hhGet(`/areas/${encodeURIComponent(params.area_id)}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    // /areas/{id} returns a single Area node with nested areas.
    return flattenAreaTree([result]);
}
// --- Professional Roles ---
export const getProfessionalRolesSchema = rawOnly;
export async function handleGetProfessionalRoles(params = {}) {
    const result = (await hhGet("/professional_roles"));
    if (params.raw)
        return JSON.stringify(result, null, 2);
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
export async function handleGetIndustries(params = {}) {
    const result = (await hhGet("/industries"));
    if (params.raw)
        return JSON.stringify(result, null, 2);
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
export async function handleGetMetro(params) {
    const path = params.city_id ? `/metro/${encodeURIComponent(params.city_id)}` : "/metro";
    const result = await hhGet(path);
    return JSON.stringify(result, null, 2);
}
// --- Dictionaries ---
export async function handleGetDictionaries() {
    const result = await hhGet("/dictionaries");
    return JSON.stringify(result, null, 2);
}
export const validateTokenSchema = z.object({
    raw: z.boolean().optional().describe("Return the raw /me JSON instead of the summary."),
});
export async function handleValidateToken(params = {}) {
    if (!process.env.HH_ACCESS_TOKEN) {
        return "HH_ACCESS_TOKEN не задан. Доступны только публичные endpoint'ы (вакансии, работодатели, зарплаты, словари). Поиск резюме недоступен — нужен employer-токен.";
    }
    try {
        const me = (await hhGet("/me"));
        if (params.raw)
            return JSON.stringify(me, null, 2);
        const name = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.email || me.id || "—";
        const roles = [me.is_employer && "employer", me.is_applicant && "applicant", me.is_admin && "admin"]
            .filter(Boolean)
            .join(", ") || "—";
        const note = me.is_employer
            ? "Роль employer есть — поиск резюме доступен при наличии платной подписки на базу резюме."
            : "Поиск резюме недоступен: нужен employer-токен + платная подписка на базу резюме.";
        return `Токен валиден. Пользователь: ${name}${me.email ? ` <${me.email}>` : ""}. Роли: ${roles}.\n${note}`;
    }
    catch (e) {
        if (e instanceof HhApiError && (e.status === 401 || e.status === 403)) {
            return `Токен задан, но недействителен или истёк (HTTP ${e.status}). Получите новый OAuth-токен на https://dev.hh.ru/admin.`;
        }
        throw e;
    }
}
function formatSuggests(result) {
    const items = result.items ?? [];
    if (!items.length)
        return "(нет совпадений)";
    return items.map((i) => `${i.text}${i.id != null ? ` (id=${i.id})` : ""}`).join("\n");
}
async function suggestGet(path, text, raw) {
    const query = new URLSearchParams();
    query.set("text", text);
    const result = await hhGet(`${path}?${query.toString()}`);
    if (raw)
        return JSON.stringify(result, null, 2);
    return formatSuggests(result);
}
export const suggestPositionsSchema = z.object({
    text: z.string().describe("Partial job title / position name to autocomplete"),
    raw: rawFlag,
});
/** Autocomplete free-form position titles via /suggests/positions. */
export async function handleSuggestPositions(params) {
    return suggestGet("/suggests/positions", params.text, params.raw);
}
export const suggestProfessionalRolesSchema = z.object({
    text: z.string().describe("Partial professional role name to autocomplete"),
    raw: rawFlag,
});
/** Autocomplete professional role IDs via /suggests/professional_roles. */
export async function handleSuggestProfessionalRoles(params) {
    return suggestGet("/suggests/professional_roles", params.text, params.raw);
}
export const suggestCompaniesSchema = z.object({
    text: z.string().describe("Partial company name to autocomplete"),
    raw: rawFlag,
});
export async function handleSuggestCompanies(params) {
    return suggestGet("/suggests/companies", params.text, params.raw);
}
export const suggestAreasSchema = z.object({
    text: z.string().describe("Partial region/city name to autocomplete"),
    raw: rawFlag,
});
export async function handleSuggestAreas(params) {
    return suggestGet("/suggests/areas", params.text, params.raw);
}
export const suggestVacancySearchKeywordSchema = z.object({
    text: z.string().describe("Partial vacancy-search keyword"),
    raw: rawFlag,
});
export async function handleSuggestVacancySearchKeyword(params) {
    return suggestGet("/suggests/vacancy_search_keyword", params.text, params.raw);
}
export const suggestResumeSearchKeywordSchema = z.object({
    text: z.string().describe("Partial resume-search keyword"),
    raw: rawFlag,
});
export async function handleSuggestResumeSearchKeyword(params) {
    return suggestGet("/suggests/resume_search_keyword", params.text, params.raw);
}
export const suggestSkillSetSchema = z.object({
    text: z.string().describe("Partial skill name to autocomplete"),
    raw: rawFlag,
});
export async function handleSuggestSkillSet(params) {
    return suggestGet("/suggests/skill_set", params.text, params.raw);
}
// --- Extra public references ---
function formatIdNameList(result) {
    const items = Array.isArray(result)
        ? result
        : (result.items ?? []);
    if (!items.length)
        return "(пусто)";
    return items
        .map((i) => `${i.id ?? "—"} — ${i.name ?? i.text ?? "—"}`)
        .join("\n");
}
export const getCountriesSchema = rawOnly;
export async function handleGetCountries(params = {}) {
    const result = await hhGet("/areas/countries");
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatIdNameList(result);
}
export const getLanguagesSchema = rawOnly;
export async function handleGetLanguages(params = {}) {
    const result = await hhGet("/languages");
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatIdNameList(result);
}
export const getSkillsSchema = z.object({
    id: z
        .union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1).max(50),
    ])
        .describe("Skill id(s) to resolve (1–50). hh.ru /skills requires ids — use suggest_skill_set to find them by name."),
    raw: rawFlag,
});
export async function handleGetSkills(params) {
    const ids = Array.isArray(params.id) ? params.id : [params.id];
    if (ids.length > 50) {
        throw new Error("get_skills accepts at most 50 skill ids per request.");
    }
    const query = new URLSearchParams();
    for (const id of ids)
        query.append("id", id);
    const result = await hhGet(`/skills?${query.toString()}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
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
export async function handleGetDistricts(params = {}) {
    const query = new URLSearchParams();
    if (params.area_id)
        query.set("area", params.area_id);
    const qs = query.toString();
    const result = await hhGet(`/districts${qs ? `?${qs}` : ""}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatIdNameList(result);
}
//# sourceMappingURL=references.js.map
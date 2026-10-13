import { z } from "zod";
import { hhGet } from "../client.js";
import { requireToken } from "../auth.js";
import { getMeIds } from "../quota.js";
import type { Employer, Vacancy, SearchResult, EmployerManager } from "../types.js";
import {
  formatEmployerSearch,
  formatEmployer,
  formatVacancySearch,
  formatManagerList,
  formatManager,
  formatNegotiationsStatistics,
  formatNamedIdList,
} from "../format.js";

const rawFlag = z
  .boolean()
  .optional()
  .describe("Return the full raw hh.ru JSON instead of the compact summary.");

const employerId = z
  .string()
  .regex(/^[1-9]\d*$/, "employer_id must be a positive numeric hh.ru id");

const managerId = z
  .string()
  .regex(/^[1-9]\d*$/, "manager_id must be a positive numeric hh.ru id");

const accountIdNote =
  "Id of the authenticated employer/manager; omit to resolve from /me. Do not pass 0.";

const MISSING_ACCOUNT_IDS =
  "не удалось определить id аккаунта, вызовите `validate_token {raw:true}`";

export async function resolveAccountIds(
  params: { employer_id?: string; manager_id?: string },
  need: { employer?: boolean; manager?: boolean } = {},
): Promise<{ employerId: string; managerId: string }> {
  const wantEmployer = need.employer !== false;
  const wantManager = need.manager !== false;
  let employerId = params.employer_id;
  let managerId = params.manager_id;
  if ((wantEmployer && !employerId) || (wantManager && !managerId)) {
    const me = await getMeIds();
    employerId = employerId || me.employerId;
    managerId = managerId || me.managerId;
  }
  if (wantEmployer && !employerId) throw new Error(MISSING_ACCOUNT_IDS);
  if (wantManager && !managerId) throw new Error(MISSING_ACCOUNT_IDS);
  return { employerId: employerId ?? "", managerId: managerId ?? "" };
}

export const searchEmployersSchema = z.object({
  text: z.string().describe("Company name to search for"),
  area: z.number().optional().describe("Region code"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  raw: rawFlag,
});

export async function handleSearchEmployers(
  params: z.infer<typeof searchEmployersSchema>,
): Promise<string> {
  const query = new URLSearchParams();
  query.set("text", params.text);
  if (params.area != null) query.set("area", String(params.area));
  query.set("per_page", String(params.per_page));
  query.set("page", String(params.page));

  const result = await hhGet(`/employers?${query.toString()}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatEmployerSearch(result as SearchResult<Employer>);
}

export const getEmployerSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  raw: rawFlag,
});

export async function handleGetEmployer(
  params: z.infer<typeof getEmployerSchema>,
): Promise<string> {
  const result = await hhGet(`/employers/${encodeURIComponent(params.employer_id)}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatEmployer(result as Employer);
}

export const getEmployerVacanciesSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  raw: rawFlag,
});

export async function handleGetEmployerVacancies(
  params: z.infer<typeof getEmployerVacanciesSchema>,
): Promise<string> {
  // Public listing via vacancy search. The employer-management path
  // `/employers/{id}/vacancies/active` requires an employer OAuth token and
  // only works for the authenticated account — not for arbitrary employers.
  const query = new URLSearchParams();
  query.set("employer_id", params.employer_id);
  query.set("per_page", String(params.per_page));
  query.set("page", String(params.page));

  const result = await hhGet(`/vacancies?${query.toString()}`);
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

// --- ATS / employer-scoped GETs (require token) ---

export const listEmployerManagersSchema = z.object({
  employer_id: employerId.optional().describe(accountIdNote),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  raw: rawFlag,
});

export async function handleListEmployerManagers(
  params: z.infer<typeof listEmployerManagersSchema>,
): Promise<string> {
  requireToken();
  const { employerId: eid } = await resolveAccountIds(params, { manager: false });
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("per_page", String(params.per_page));
  const result = await hhGet(
    `/employers/${encodeURIComponent(eid)}/managers?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatManagerList(result as SearchResult<EmployerManager>);
}

export const getEmployerManagerSchema = z.object({
  employer_id: employerId.optional().describe(accountIdNote),
  manager_id: managerId.optional().describe(accountIdNote),
  raw: rawFlag,
});

export async function handleGetEmployerManager(
  params: z.infer<typeof getEmployerManagerSchema>,
): Promise<string> {
  requireToken();
  const ids = await resolveAccountIds(params);
  const result = await hhGet(
    `/employers/${encodeURIComponent(ids.employerId)}/managers/${encodeURIComponent(ids.managerId)}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatManager(result as EmployerManager);
}

export const getManagerResumeLimitsSchema = z.object({
  employer_id: employerId.optional().describe(accountIdNote),
  manager_id: managerId.optional().describe(accountIdNote),
  raw: rawFlag,
});

export async function handleGetManagerResumeLimits(
  params: z.infer<typeof getManagerResumeLimitsSchema>,
): Promise<string> {
  requireToken();
  const ids = await resolveAccountIds(params);
  const result = await hhGet(
    `/employers/${encodeURIComponent(ids.employerId)}/managers/${encodeURIComponent(ids.managerId)}/limits/resume`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatNegotiationsStatistics(result);
}

export const getManagerNegotiationsStatisticsSchema = z.object({
  employer_id: employerId.optional().describe(accountIdNote),
  manager_id: managerId.optional().describe(accountIdNote),
  raw: rawFlag,
});

export async function handleGetManagerNegotiationsStatistics(
  params: z.infer<typeof getManagerNegotiationsStatisticsSchema>,
): Promise<string> {
  requireToken();
  const ids = await resolveAccountIds(params);
  const result = await hhGet(
    `/employers/${encodeURIComponent(ids.employerId)}/managers/${encodeURIComponent(ids.managerId)}/negotiations_statistics`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatNegotiationsStatistics(result);
}

export const listActiveVacanciesSchema = z.object({
  employer_id: employerId.describe("Employer ID of the authenticated account"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  raw: rawFlag,
});

export async function handleListActiveVacancies(
  params: z.infer<typeof listActiveVacanciesSchema>,
): Promise<string> {
  requireToken();
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("per_page", String(params.per_page));
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/vacancies/active?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const listArchivedVacanciesSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  raw: rawFlag,
});

export async function handleListArchivedVacancies(
  params: z.infer<typeof listArchivedVacanciesSchema>,
): Promise<string> {
  requireToken();
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("per_page", String(params.per_page));
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/vacancies/archived?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const listHiddenVacanciesSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
  per_page: z.number().int().min(1).max(100).default(20).describe("Results per page"),
  raw: rawFlag,
});

export async function handleListHiddenVacancies(
  params: z.infer<typeof listHiddenVacanciesSchema>,
): Promise<string> {
  requireToken();
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("per_page", String(params.per_page));
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/vacancies/hidden?${query.toString()}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  return formatVacancySearch(result as SearchResult<Vacancy>);
}

export const getMessageTemplateSchema = z.object({
  template: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "template must be an hh.ru template id")
    .describe("Template id (e.g. invite, interview, discard_after_response)"),
  topic_id: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Negotiation topic id (when template is for an existing application)"),
  resume_id: z.string().optional().describe("Resume id (for invite templates)"),
  vacancy_id: z.string().optional().describe("Vacancy id (for invite templates)"),
  raw: rawFlag,
});

export async function handleGetMessageTemplate(
  params: z.infer<typeof getMessageTemplateSchema>,
): Promise<string> {
  requireToken();
  const query = new URLSearchParams();
  if (params.topic_id) query.set("topic_id", params.topic_id);
  if (params.resume_id) query.set("resume_id", params.resume_id);
  if (params.vacancy_id) query.set("vacancy_id", params.vacancy_id);
  const qs = query.toString();
  const result = await hhGet(
    `/message_templates/${encodeURIComponent(params.template)}${qs ? `?${qs}` : ""}`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const t = result as {
    id?: string;
    name?: string;
    text?: string;
    mail?: string | { text?: string };
    sms?: string | { text?: string };
  };
  const bodyOf = (x?: string | { text?: string }) =>
    typeof x === "string" ? x : x?.text?.trim() ? x.text : null;
  const lines = [
    `# Шаблон ${t.name ?? params.template}${t.id ? ` (id=${t.id})` : ""}`,
  ];
  const text = bodyOf(t.text) ?? bodyOf(t.mail);
  const sms = bodyOf(t.sms);
  if (text) lines.push(`\n${text}`);
  if (sms) lines.push(`\nSMS:\n${sms}`);
  if (!text && !sms) lines.push("\n(пусто)");
  return lines.join("\n");
}

export const listMailTemplatesSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  raw: rawFlag,
});

export async function handleListMailTemplates(
  params: z.infer<typeof listMailTemplatesSchema>,
): Promise<string> {
  requireToken();
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/mail_templates`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const items = (result as { items?: { id?: string; name?: string }[] }).items ??
    (Array.isArray(result) ? (result as { id?: string; name?: string }[]) : []);
  if (!items.length) return "Почтовых шаблонов: 0\n(пусто)";
  return (
    `Почтовых шаблонов: ${items.length}\n` +
    items.map((t, i) => `${i + 1}. ${t.name ?? "—"} (id=${t.id ?? "—"})`).join("\n")
  );
}

export const getEmployerVacancyAreasSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  raw: rawFlag,
});

export async function handleGetEmployerVacancyAreas(
  params: z.infer<typeof getEmployerVacancyAreasSchema>,
): Promise<string> {
  requireToken();
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/vacancy_areas/active`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const items =
    (result as { items?: { id?: string; name?: string }[] }).items ??
    (Array.isArray(result) ? (result as { id?: string; name?: string }[]) : []);
  return formatNamedIdList(
    items.map((a) => ({ id: String(a.id ?? ""), name: a.name ?? "" })),
  );
}

export const getEmployerDepartmentsSchema = z.object({
  employer_id: employerId.optional().describe(accountIdNote),
  raw: rawFlag,
});

export async function handleGetEmployerDepartments(
  params: z.infer<typeof getEmployerDepartmentsSchema>,
): Promise<string> {
  requireToken();
  const { employerId: eid } = await resolveAccountIds(params, { manager: false });
  const result = await hhGet(
    `/employers/${encodeURIComponent(eid)}/departments`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const items =
    (result as { items?: { id?: string; name?: string }[] }).items ??
    (Array.isArray(result) ? (result as { id?: string; name?: string }[]) : []);
  return formatNamedIdList(
    items.map((d) => ({ id: String(d.id ?? ""), name: d.name ?? "" })),
  );
}

export const listEmployerAddressesSchema = z.object({
  employer_id: employerId.describe("Employer ID"),
  raw: rawFlag,
});

export async function handleListEmployerAddresses(
  params: z.infer<typeof listEmployerAddressesSchema>,
): Promise<string> {
  requireToken();
  const result = await hhGet(
    `/employers/${encodeURIComponent(params.employer_id)}/addresses`,
  );
  if (params.raw) return JSON.stringify(result, null, 2);
  const items =
    (
      result as {
        items?: { id?: string; city?: string; street?: string; building?: string; raw?: string }[];
      }
    ).items ??
    (Array.isArray(result)
      ? (result as { id?: string; city?: string; street?: string; building?: string; raw?: string }[])
      : []);
  if (!items.length) return "Адресов: 0\n(пусто)";
  return (
    `Адресов: ${items.length}\n` +
    items
      .map((a, i) => {
        const addr =
          a.raw ||
          [a.city, a.street, a.building].filter(Boolean).join(", ") ||
          "—";
        return `${i + 1}. ${addr} (id=${a.id ?? "—"})`;
      })
      .join("\n")
  );
}

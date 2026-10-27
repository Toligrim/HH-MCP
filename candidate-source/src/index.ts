#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import { type ZodRawShape, type ZodObject } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  ErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  JSONRPCRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./version.js";
import {
  searchVacanciesSchema,
  handleSearchVacancies,
  getVacancySchema,
  handleGetVacancy,
  getSimilarVacanciesSchema,
  handleGetSimilarVacancies,
  getRelatedVacanciesSchema,
  handleGetRelatedVacancies,
  getVacancyStatsSchema,
  handleGetVacancyStats,
  getVacancyVisitorsSchema,
  handleGetVacancyVisitors,
  getVacancyConditionsSchema,
  handleGetVacancyConditions,
} from "./tools/vacancies.js";
import {
  searchEmployersSchema,
  handleSearchEmployers,
  getEmployerSchema,
  handleGetEmployer,
  getEmployerVacanciesSchema,
  handleGetEmployerVacancies,
  listEmployerManagersSchema,
  handleListEmployerManagers,
  getEmployerManagerSchema,
  handleGetEmployerManager,
  getManagerResumeLimitsSchema,
  handleGetManagerResumeLimits,
  getManagerNegotiationsStatisticsSchema,
  handleGetManagerNegotiationsStatistics,
  listActiveVacanciesSchema,
  handleListActiveVacancies,
  listArchivedVacanciesSchema,
  handleListArchivedVacancies,
  listHiddenVacanciesSchema,
  handleListHiddenVacancies,
  getMessageTemplateSchema,
  handleGetMessageTemplate,
  listMailTemplatesSchema,
  handleListMailTemplates,
  getEmployerVacancyAreasSchema,
  handleGetEmployerVacancyAreas,
  getEmployerDepartmentsSchema,
  handleGetEmployerDepartments,
  listEmployerAddressesSchema,
  handleListEmployerAddresses,
} from "./tools/employers.js";
import {
  searchResumesSchema,
  handleSearchResumes,
  getResumeSchema,
  handleGetResume,
  getResumeNegotiationsHistorySchema,
  handleGetResumeNegotiationsHistory,
  listSavedResumeSearchesSchema,
  handleListSavedResumeSearches,
  getSavedResumeSearchSchema,
  handleGetSavedResumeSearch,
} from "./tools/resumes.js";
import {
  listApplicationCollectionsSchema,
  handleListApplicationCollections,
  listApplicationsSchema,
  handleListApplications,
  getApplicationSchema,
  handleGetApplication,
  getApplicationMessagesSchema,
  handleGetApplicationMessages,
  getNegotiationsStatisticsSchema,
  handleGetNegotiationsStatistics,
  getPreferredNegotiationsOrderSchema,
  handleGetPreferredNegotiationsOrder,
} from "./tools/negotiations.js";
import {
  getResumesSchema,
  handleGetResumes,
  collectVacancyResumesSchema,
  handleCollectVacancyResumes,
} from "./tools/batch.js";
import {
  hhUsageReportSchema,
  handleHhUsageReport,
} from "./tools/diagnostics.js";
import {
  getAreasSchema,
  handleGetAreas,
  getAreasSubtreeSchema,
  handleGetAreasSubtree,
  getProfessionalRolesSchema,
  handleGetProfessionalRoles,
  getIndustriesSchema,
  handleGetIndustries,
  getMetroSchema,
  handleGetMetro,
  handleGetDictionaries,
  validateTokenSchema,
  handleValidateToken,
  suggestPositionsSchema,
  handleSuggestPositions,
  suggestProfessionalRolesSchema,
  handleSuggestProfessionalRoles,
  suggestCompaniesSchema,
  handleSuggestCompanies,
  suggestAreasSchema,
  handleSuggestAreas,
  suggestVacancySearchKeywordSchema,
  handleSuggestVacancySearchKeyword,
  suggestResumeSearchKeywordSchema,
  handleSuggestResumeSearchKeyword,
  suggestSkillSetSchema,
  handleSuggestSkillSet,
  getCountriesSchema,
  handleGetCountries,
  getLanguagesSchema,
  handleGetLanguages,
  getSkillsSchema,
  handleGetSkills,
  getDistrictsSchema,
  handleGetDistricts,
} from "./tools/references.js";
import {
  getSalaryStatisticsSchema,
  handleGetSalaryStatistics,
} from "./tools/salary.js";
import { getClientHealth, HhAccessError, HhApiError } from "./client.js";
import { HhBudgetError } from "./requestBudget.js";
import { applyToolFilter, parseToolsCliArgs } from "./toolsFilter.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  deepSearchInputSchema, emptyInputSchema, explainSearchInputSchema,
  getSearchCapabilityData, getVacanciesBatchInputSchema, handleDeepSearch,
  handleExplainSearch, handleGetVacanciesBatchMcp, handlePlanSearch,
  handleResolveSearchDictionary, planSearchInputSchema, resolveDictionaryInputSchema,
  SearchToolError,
} from "./tools/search.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function wrapHandler(
  fn: (params: any, extra?: RequestHandlerExtra<any, any>) => Promise<string>,
  safeErrors = false,
): (params: any, extra?: RequestHandlerExtra<any, any>) => Promise<ToolResult> {
  return async (params, extra) => {
    try {
      const text = await fn(params, extra);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      if (safeErrors) {
        const runtimeError = error instanceof SearchToolError
          ? { code: error.code, retryable: error.retryable, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) }
          : error instanceof HhAccessError
              ? { code: "hh_access_error", retryable: false, status: error.status, message: error.message }
              : error instanceof HhApiError
                ? { code: "hh_api_error", retryable: error.status === 429 || error.status >= 500, status: error.status, message: error.message }
                : error instanceof HhBudgetError
                  ? { code: error.code, retryable: error.code === "cancelled", message: error.message }
                  : error instanceof Error && error.name === "AbortError"
                    ? { code: "cancelled", retryable: true, message: "Search request was cancelled." }
                    : { code: "search_request_failed", retryable: false, message: error instanceof Error ? error.message : "Search request failed." };
        runtimeError.message = runtimeError.message.slice(0, 500);
        return { isError: true, content: [{ type: "text" as const, text: `ERROR: ${JSON.stringify(runtimeError)}` }] };
      }
      if (error instanceof HhAccessError) {
        const structured = JSON.stringify(error.toStructured());
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `ERROR: Error ${error.status}: ${error.message}\n${structured}`,
            },
          ],
        };
      }
      const message = safeErrors
        ? error instanceof Error ? error.message : "Search request failed."
        : error instanceof HhApiError
          ? `Error ${error.status}: ${error.message}${error.body ? `\n${error.body}` : ""}`
          : error instanceof Error
            ? error.message
            : String(error);
      // isError lets the MCP client/LLM distinguish a failure from a normal
      // result so it can self-correct instead of treating it as valid data.
      return {
        isError: true,
        content: [{ type: "text" as const, text: `ERROR: ${message}` }],
      };
    }
  };
}

interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape | ZodObject<any>;
  handler: (params: any, extra?: RequestHandlerExtra<any, any>) => Promise<string>;
  fullSchema?: boolean;
  safeErrors?: boolean;
  readOnly?: boolean;
  group: string;
  groups?: string[];
}

type ToolSeed = Omit<ToolDef, "group" | "groups"> & {
  group?: string;
  groups?: string[];
};

function g(group: string, tools: ToolSeed[]): ToolDef[] {
  return tools.map((t) => ({ ...t, group: t.group ?? group, groups: t.groups }));
}

// Declarative tool registry — DEFAULT_TOOL_COUNT is the unfiltered surface.
const ALL_TOOLS: ToolDef[] = [
  ...g("vacancies", [
    {
      name: "search_vacancies",
      description:
        "Search job vacancies on hh.ru by keywords, region, professional role, industry, metro, salary, experience, employment form, work format, date range and labels. Returns a compact paginated summary (pass raw:true for full JSON).",
      schema: searchVacanciesSchema,
      fullSchema: true,
      handler: handleSearchVacancies,
    },
    {
      name: "get_vacancy",
      description:
        "Get full vacancy details: description, requirements, key skills, contacts, employer info.",
      schema: getVacancySchema.shape,
      handler: handleGetVacancy,
    },
    {
      name: "get_similar_vacancies",
      description:
        "Find vacancies similar to a given one. Useful for expanding a candidate's job search.",
      schema: getSimilarVacanciesSchema.shape,
      handler: handleGetSimilarVacancies,
    },
    {
      name: "get_related_vacancies",
      description:
        "Find vacancies related to a given one (hh.ru related_vacancies endpoint). Public, no token.",
      schema: getRelatedVacanciesSchema.shape,
      handler: handleGetRelatedVacancies,
    },
    {
      name: "get_vacancy_stats",
      description:
        "Get employer-facing vacancy statistics (views/responses/invitations). Requires HH_ACCESS_TOKEN.",
      schema: getVacancyStatsSchema.shape,
      handler: handleGetVacancyStats,
    },
    {
      name: "get_vacancy_visitors",
      description:
        "List visitors who viewed a vacancy. Requires HH_ACCESS_TOKEN.",
      schema: getVacancyVisitorsSchema.shape,
      handler: handleGetVacancyVisitors,
    },
    {
      name: "get_vacancy_conditions",
      description:
        "Get vacancy publication conditions / constraints for the current employer. Requires HH_ACCESS_TOKEN.",
      schema: getVacancyConditionsSchema.shape,
      handler: handleGetVacancyConditions,
    },
  ]),
  ...g("resumes", [
    {
      name: "search_resumes",
      description:
        "Search candidate resumes by keywords, region, professional role, salary, experience. Requires an EMPLOYER OAuth token (HH_ACCESS_TOKEN) AND a paid hh.ru resume-database subscription — applicant/anonymous tokens get 403.",
      schema: searchResumesSchema.shape,
      handler: handleSearchResumes,
    },
    {
      name: "get_resume",
      description:
        "Get full resume details: experience, education, skills, contacts. " +
        "If the resume came through an отклик, always pass topic_id (+vacancy_id): the unscoped read hits the resume database, consumes a paid view and is the call hh.ru captcha-gates. " +
        "When HH_REQUIRE_TOPIC is on, unscoped reads require allow_unscoped:true. " +
        "Requires an EMPLOYER OAuth token + paid resume-database access.",
      schema: getResumeSchema.shape,
      handler: handleGetResume,
    },
    {
      name: "get_resume_negotiations_history",
      description:
        "Get negotiation history for a resume (employer view). Requires HH_ACCESS_TOKEN.",
      schema: getResumeNegotiationsHistorySchema.shape,
      handler: handleGetResumeNegotiationsHistory,
    },
    {
      name: "list_saved_resume_searches",
      description:
        "List saved resume searches for the current employer account. Requires HH_ACCESS_TOKEN.",
      schema: listSavedResumeSearchesSchema.shape,
      handler: handleListSavedResumeSearches,
    },
    {
      name: "get_saved_resume_search",
      description:
        "Get a saved resume search by id. Requires HH_ACCESS_TOKEN.",
      schema: getSavedResumeSearchSchema.shape,
      handler: handleGetSavedResumeSearch,
    },
  ]),
  ...g("batch", [
    {
      name: "get_resumes",
      groups: ["resumes"],
      description:
        "Safely fetch up to 50 resumes sequentially through the resume-view budget (default ~1.5s spacing, 20 reads/60s window). " +
        "Preferred input: items:[{resume_id, topic_id}] + vacancy_id for scoped reads; set require_topic:true to never read the paid database. " +
        "Legacy resume_ids+topics is validated (typo'd keys fail before any request). Reads without topic_id return status unscoped. " +
        "Pass out_dir to persist payloads (raw/*.json + manifest.json + negotiations.csv). stop_on_captcha default true. " +
        "max_wait_ms default 90000 (cap 110000). Requires HH_ACCESS_TOKEN.",
      schema: getResumesSchema.shape,
      handler: handleGetResumes,
    },
    {
      name: "collect_vacancy_resumes",
      description:
        "Walk a vacancy funnel (collection/sub_collection), fetch each resume with topic_id through the gated budget, " +
        "write raw JSON + manifest/csv under out_dir (HH_EXPORT_DIR). Bounded by max (default 25) and max_wait_ms; " +
        "returns an id-based cursor/remaining when truncated (safe when new responses arrive between calls). " +
        "Prefer this over spawning subagents. Requires HH_ACCESS_TOKEN.",
      schema: collectVacancyResumesSchema.shape,
      handler: handleCollectVacancyResumes,
    },
  ]),
  ...g("negotiations", [
    {
      name: "list_application_collections",
      description:
        "Vacancy application funnel: per-stage and per-sub-stage counters plus unread (with_updates). " +
        "Sub-collection ids are inputs for list_applications. Also lists employer_states. " +
        "Start here before list_applications. Requires HH_ACCESS_TOKEN.",
      schema: listApplicationCollectionsSchema.shape,
      handler: handleListApplicationCollections,
    },
    {
      name: "list_applications",
      description:
        "List applications for a vacancy by collection or sub_collection (id/name), with optional " +
        "with_updates_only (scans collection pages for has_updates; page/per_page are the filtered " +
        "stream; capped by HH_MAX_SCAN_PAGES), page/per_page/order_by. raw:true returns one " +
        "unfiltered upstream page. Defaults collection to response. Requires HH_ACCESS_TOKEN.",
      schema: listApplicationsSchema.shape,
      handler: handleListApplications,
    },
    {
      name: "get_application",
      description:
        "Full application card from the negotiations endpoint (candidate, relevant experience, " +
        "funnel stage, message counters) — prefer over get_resume for screening. Requires HH_ACCESS_TOKEN.",
      schema: getApplicationSchema.shape,
      handler: handleGetApplication,
    },
    {
      name: "get_application_messages",
      description:
        "Paginated chat messages for an application topic (page/per_page, max 50). Requires HH_ACCESS_TOKEN.",
      schema: getApplicationMessagesSchema.shape,
      handler: handleGetApplicationMessages,
    },
    {
      name: "get_negotiations_statistics",
      description:
        "Get employer-level negotiations statistics. Requires employer_id and HH_ACCESS_TOKEN.",
      schema: getNegotiationsStatisticsSchema.shape,
      handler: handleGetNegotiationsStatistics,
    },
    {
      name: "get_preferred_negotiations_order",
      description:
        "Get the preferred negotiations sort order for a vacancy. Requires HH_ACCESS_TOKEN.",
      schema: getPreferredNegotiationsOrderSchema.shape,
      handler: handleGetPreferredNegotiationsOrder,
    },
  ]),
  ...g("employers", [
    {
      name: "search_employers",
      description:
        "Search companies/employers on hh.ru by name. Returns company info and open vacancy count.",
      schema: searchEmployersSchema.shape,
      handler: handleSearchEmployers,
    },
    {
      name: "get_employer",
      description:
        "Get detailed employer profile: description, industries, website, vacancy count.",
      schema: getEmployerSchema.shape,
      handler: handleGetEmployer,
    },
    {
      name: "get_employer_vacancies",
      description:
        "List active vacancies for a specific employer via public vacancy search (employer_id filter). No token required.",
      schema: getEmployerVacanciesSchema.shape,
      handler: handleGetEmployerVacancies,
    },
    {
      name: "list_employer_managers",
      description:
        "List managers for an employer account. employer_id of the authenticated account can be omitted (resolved from /me). Requires HH_ACCESS_TOKEN.",
      schema: listEmployerManagersSchema.shape,
      handler: handleListEmployerManagers,
    },
    {
      name: "get_employer_manager",
      description:
        "Get a single employer manager by id. employer_id/manager_id of the authenticated account can be omitted (resolved from /me). Requires HH_ACCESS_TOKEN.",
      schema: getEmployerManagerSchema.shape,
      handler: handleGetEmployerManager,
    },
    {
      name: "get_manager_resume_limits",
      description:
        "Informational resume-view limits for a manager (hh.ru counter may not match real views; 404/zeros are not a captcha signal). " +
        "employer_id/manager_id of the authenticated account can be omitted (resolved from /me). Do not pass 0. Requires HH_ACCESS_TOKEN.",
      schema: getManagerResumeLimitsSchema.shape,
      handler: handleGetManagerResumeLimits,
    },
    {
      name: "get_manager_negotiations_statistics",
      description:
        "Get negotiations statistics for a manager. employer_id/manager_id of the authenticated account can be omitted (resolved from /me). Requires HH_ACCESS_TOKEN.",
      schema: getManagerNegotiationsStatisticsSchema.shape,
      handler: handleGetManagerNegotiationsStatistics,
    },
    {
      name: "list_active_vacancies",
      description:
        "List published (active) vacancies for the authenticated employer account via /employers/{id}/vacancies/active. Requires HH_ACCESS_TOKEN. For any employer's public vacancies use get_employer_vacancies.",
      schema: listActiveVacanciesSchema.shape,
      handler: handleListActiveVacancies,
    },
    {
      name: "list_archived_vacancies",
      description:
        "List archived vacancies for an employer. Requires HH_ACCESS_TOKEN.",
      schema: listArchivedVacanciesSchema.shape,
      handler: handleListArchivedVacancies,
    },
    {
      name: "list_hidden_vacancies",
      description:
        "List hidden vacancies for an employer. Requires HH_ACCESS_TOKEN.",
      schema: listHiddenVacanciesSchema.shape,
      handler: handleListHiddenVacancies,
    },
    {
      name: "get_message_template",
      description:
        "Get a negotiation message template by id (optionally with topic_id / resume_id / vacancy_id). Requires HH_ACCESS_TOKEN.",
      schema: getMessageTemplateSchema.shape,
      handler: handleGetMessageTemplate,
    },
    {
      name: "list_mail_templates",
      description:
        "List employer mail templates. Requires employer_id and HH_ACCESS_TOKEN.",
      schema: listMailTemplatesSchema.shape,
      handler: handleListMailTemplates,
    },
    {
      name: "get_employer_vacancy_areas",
      description:
        "List active vacancy areas for an employer. Requires HH_ACCESS_TOKEN.",
      schema: getEmployerVacancyAreasSchema.shape,
      handler: handleGetEmployerVacancyAreas,
    },
    {
      name: "get_employer_departments",
      description:
        "List departments for an employer. employer_id of the authenticated account can be omitted (resolved from /me). Requires HH_ACCESS_TOKEN.",
      schema: getEmployerDepartmentsSchema.shape,
      handler: handleGetEmployerDepartments,
    },
    {
      name: "list_employer_addresses",
      description:
        "List addresses for an employer. Requires HH_ACCESS_TOKEN.",
      schema: listEmployerAddressesSchema.shape,
      handler: handleListEmployerAddresses,
    },
  ]),
  ...g("references", [
    {
      name: "get_areas",
      description:
        "Get the full tree of regions and cities as `id — name` lines (pass raw:true for nested JSON). Use to find area IDs for search filters.",
      schema: getAreasSchema.shape,
      handler: handleGetAreas,
    },
    {
      name: "get_areas_subtree",
      description:
        "Get the regions/cities subtree under one area id (e.g. 113=Russia) — lighter than the full /areas tree.",
      schema: getAreasSubtreeSchema.shape,
      handler: handleGetAreasSubtree,
    },
    {
      name: "get_countries",
      description: "List countries (id — name) from /areas/countries.",
      schema: getCountriesSchema.shape,
      handler: handleGetCountries,
    },
    {
      name: "get_professional_roles",
      description:
        "Get the tree of professional roles with IDs. Use to find role IDs for vacancy/resume search and salary stats.",
      schema: getProfessionalRolesSchema.shape,
      handler: handleGetProfessionalRoles,
    },
    {
      name: "get_industries",
      description:
        "Get the tree of company industries with IDs. Use to find industry IDs for the search_vacancies `industry` filter.",
      schema: getIndustriesSchema.shape,
      handler: handleGetIndustries,
    },
    {
      name: "get_metro",
      description:
        "Get metro stations and lines with IDs for a city (city_id), or for all cities. Use to find metro IDs for the search_vacancies `metro` filter.",
      schema: getMetroSchema.shape,
      handler: handleGetMetro,
    },
    {
      name: "get_languages",
      description: "List languages (id — name) from /languages.",
      schema: getLanguagesSchema.shape,
      handler: handleGetLanguages,
    },
    {
      name: "get_skills",
      description:
        "Resolve skill names by id via /skills (1–50 ids). Use suggest_skill_set to discover ids by name first.",
      schema: getSkillsSchema.shape,
      handler: handleGetSkills,
    },
    {
      name: "get_districts",
      description:
        "List districts (optionally filtered by area_id). Useful for address/area fine-tuning.",
      schema: getDistrictsSchema.shape,
      handler: handleGetDistricts,
    },
    {
      name: "get_dictionaries",
      description:
        "Get all reference dictionaries: currencies, employment types, schedules, experience levels, vacancy labels, and more.",
      schema: {},
      handler: handleGetDictionaries,
    },
    {
      name: "validate_token",
      group: "validate_token",
      description:
        "Check whether HH_ACCESS_TOKEN is valid via /me and report the user role (applicant/employer). Use to diagnose resume-search and ATS access.",
      schema: validateTokenSchema.shape,
      handler: handleValidateToken,
    },
    {
      name: "suggest_positions",
      description:
        "Autocomplete free-form job titles / positions via /suggests/positions (not role IDs — use suggest_professional_roles for those).",
      schema: suggestPositionsSchema.shape,
      handler: handleSuggestPositions,
    },
    {
      name: "suggest_professional_roles",
      description:
        "Autocomplete professional roles with IDs via /suggests/professional_roles. Use for vacancy/resume search filters and salary stats.",
      schema: suggestProfessionalRolesSchema.shape,
      handler: handleSuggestProfessionalRoles,
    },
    {
      name: "suggest_companies",
      description:
        "Autocomplete company names. Returns matching employer suggestions for partial input.",
      schema: suggestCompaniesSchema.shape,
      handler: handleSuggestCompanies,
    },
    {
      name: "suggest_areas",
      description:
        "Autocomplete region/city names. Returns matching area suggestions for partial input.",
      schema: suggestAreasSchema.shape,
      handler: handleSuggestAreas,
    },
    {
      name: "suggest_vacancy_search_keyword",
      description: "Autocomplete vacancy-search keywords via /suggests/vacancy_search_keyword.",
      schema: suggestVacancySearchKeywordSchema.shape,
      handler: handleSuggestVacancySearchKeyword,
    },
    {
      name: "suggest_resume_search_keyword",
      description: "Autocomplete resume-search keywords via /suggests/resume_search_keyword.",
      schema: suggestResumeSearchKeywordSchema.shape,
      handler: handleSuggestResumeSearchKeyword,
    },
    {
      name: "suggest_skill_set",
      description: "Autocomplete skills via /suggests/skill_set.",
      schema: suggestSkillSetSchema.shape,
      handler: handleSuggestSkillSet,
    },
  ]),
  ...g("search", [
    { name: "plan_search", description: "Build a bounded search plan without making HH requests.", schema: planSearchInputSchema, handler: handlePlanSearch, fullSchema: true, safeErrors: true, readOnly: true },
    { name: "explain_search", description: "Explain how vacancy search inputs map to HH query parameters; does not execute a search.", schema: explainSearchInputSchema, handler: handleExplainSearch, fullSchema: true, safeErrors: true, readOnly: true },
    { name: "deep_search", description: "Collect a bounded, synchronous vacancy search with explicit coverage and uncertainty reporting.", schema: deepSearchInputSchema, handler: handleDeepSearch, fullSchema: true, safeErrors: true, readOnly: true },
    { name: "get_capabilities", description: "Describe enabled search tools, limits, and server capabilities.", schema: emptyInputSchema, handler: async () => JSON.stringify(getSearchCapabilityData(activeTools.map((tool) => tool.name), VERSION)), fullSchema: true, safeErrors: true, readOnly: true },
    { name: "resolve_search_dictionary", description: "Resolve a term against a bounded public HH search dictionary.", schema: resolveDictionaryInputSchema, handler: handleResolveSearchDictionary, fullSchema: true, safeErrors: true, readOnly: true },
    { name: "get_vacancies_batch", description: "Fetch full vacancy cards for up to 20 vacancy IDs.", schema: getVacanciesBatchInputSchema, handler: handleGetVacanciesBatchMcp, fullSchema: true, safeErrors: true, readOnly: true },
  ]),
  ...g("salary", [
    {
      name: "get_salary_statistics",
      description:
        "Salary distribution for a role/region. With HH_ACCESS_TOKEN + area_id, tries paid Банк данных зарплат (/salary_statistics/paid/salary_evaluation/{area_id}); on 401/403/404 or without token/area falls back to sampling vacancy salaries (biased). Optional speciality/employee_level/industry/extend_sources for the bank; text maps to position_name.",
      schema: getSalaryStatisticsSchema.shape,
      handler: handleGetSalaryStatistics,
    },
  ]),
  ...g("diagnostics", [
    {
      name: "hh_usage_report",
      description:
        "Local diagnostics: gated-read ledger / JSONL log summary, captcha breaker state, resume budget, cache hit counts. No network.",
      schema: hhUsageReportSchema.shape,
      handler: handleHhUsageReport,
    },
  ]),
];

/** Unfiltered default surface (compile-time / test assertion). */
export const DEFAULT_TOOL_NAMES = ALL_TOOLS.map((t) => t.name);
export const DEFAULT_TOOL_COUNT = ALL_TOOLS.length;

let activeTools: ToolDef[] = ALL_TOOLS;
let filterMeta = {
  filterActive: false,
  allow: [] as string[],
  exclude: [] as string[],
};

/** Active tool count after HH_TOOLS filter (defaults to DEFAULT_TOOL_COUNT). */
export let TOOL_COUNT = DEFAULT_TOOL_COUNT;

/** Apply HH_TOOLS / CLI filter. Call once from main() before serving. */
export function configureTools(opts?: {
  allow?: string;
  exclude?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const result = applyToolFilter(ALL_TOOLS, opts);
  activeTools = result.tools;
  TOOL_COUNT = result.effectiveCount;
  filterMeta = {
    filterActive: result.filterActive,
    allow: result.allow,
    exclude: result.exclude,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "hh-mcp",
    version: VERSION,
  }, { maxToolInputElements: 20_000 });
  for (const tool of activeTools) {
    if (tool.fullSchema) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.schema as ZodObject<any>,
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      }, async (params, extra) => wrapHandler(tool.handler, tool.safeErrors)(params, extra));
    } else {
      server.tool(tool.name, tool.description, tool.schema as ZodRawShape, wrapHandler(tool.handler));
    }
  }
  return server;
}

export function getHealthPayload(): Record<string, unknown> {
  const client = getClientHealth();
  return {
    status: "ok",
    instance: client.instance,
    tools: TOOL_COUNT,
    defaultTools: DEFAULT_TOOL_COUNT,
    filterActive: filterMeta.filterActive,
    version: VERSION,
    resumeBudget: client.resumeBudget,
    captchaBreaker: client.captchaBreaker,
  };
}

// --- HTTP body reader (stateless transport needs the parsed body) ---

const MAX_BODY = 256 * 1024;
const MAX_JSON_DEPTH = 64;

class HttpInputError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

function assertJsonDepth(raw: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth++;
      if (depth > MAX_JSON_DEPTH) {
        throw new HttpInputError(400, "Request JSON nesting exceeds the maximum depth.");
      }
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const rejectInput = (error: HttpInputError) => {
      if (settled) return;
      settled = true;
      req.pause();
      reject(error);
    };

    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) {
      rejectInput(new HttpInputError(413, "Request body exceeds the 256 KiB limit."));
      return;
    }

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectInput(new HttpInputError(413, "Request body exceeds the 256 KiB limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        settled = true;
        resolve(undefined);
        return;
      }
      try {
        assertJsonDepth(raw);
        settled = true;
        resolve(JSON.parse(raw));
      } catch (error) {
        settled = true;
        reject(error instanceof HttpInputError
          ? error
          : new HttpInputError(400, "Invalid JSON request body."));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

const DEFAULT_HTTP_SESSION_LIMIT = 128;
const DEFAULT_HTTP_SESSION_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_HTTP_SESSION_ACTIVE_LIMIT = 32;
const MCP_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HttpMcpSession = {
  id?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  activeRequests: number;
  controlRequests: number;
  requestGroups: Set<HttpMcpRequestGroup>;
  requestGroupsById: Map<string | number, HttpMcpRequestGroup>;
  reservationHeld: boolean;
  closed: boolean;
  idleTimer?: NodeJS.Timeout;
};

type HttpMcpRequestGroup = {
  response: http.ServerResponse;
  requestIds: Set<string | number>;
  cancelledIds: Set<string | number>;
  completedIds: Set<string | number>;
  cancellationResponsesSent: Set<string | number>;
  cleanupStarted: boolean;
};

export type HttpMcpServerOptions = {
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  maxSessions?: number;
  maxActiveRequestsPerSession?: number;
  sessionIdleTimeoutMs?: number;
};

const httpSessionClosers = new WeakMap<http.Server, () => Promise<void>>();

function messagesFromBody(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function isInitializeBody(body: unknown): boolean {
  return messagesFromBody(body).some((message) => message !== null && typeof message === "object" &&
    (message as Record<string, unknown>).method === "initialize");
}

function requestIdsFromBody(body: unknown): Array<string | number> {
  return messagesFromBody(body).flatMap((message) => {
    const parsed = JSONRPCRequestSchema.safeParse(message);
    return parsed.success ? [parsed.data.id] : [];
  });
}

function validatedCancellationRequestId(message: unknown): string | number | undefined {
  if (!isJSONRPCNotification(message)) return undefined;
  const parsed = CancelledNotificationSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const requestId = parsed.data.params.requestId;
  return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

function isCancellationOnlyPayload(body: unknown): boolean {
  const messages = messagesFromBody(body);
  return messages.length === 1 && validatedCancellationRequestId(messages[0]) !== undefined;
}

function writeJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(status === 413 ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), () => {
    if (status === 413) res.req.destroy();
  });
}

export async function closeHttpMcpSessions(server: http.Server): Promise<void> {
  await httpSessionClosers.get(server)?.();
}

export function createHttpServer(options: HttpMcpServerOptions = {}): http.Server {
  const port = options.port ?? Number(process.env.HTTP_PORT || process.env.PORT || 3000);
  const allowedHosts = options.allowedHosts ?? (process.env.HH_ALLOWED_HOSTS || `127.0.0.1:${port},localhost:${port}`)
    .split(",").map((value) => value.trim()).filter(Boolean);
  const configuredOrigins = options.allowedOrigins ?? (process.env.HH_ALLOWED_ORIGINS
    ? process.env.HH_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined);
  const maxSessions = options.maxSessions ?? DEFAULT_HTTP_SESSION_LIMIT;
  const maxActiveRequestsPerSession = options.maxActiveRequestsPerSession ?? DEFAULT_HTTP_SESSION_ACTIVE_LIMIT;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_HTTP_SESSION_IDLE_MS;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new RangeError("maxSessions must be a positive safe integer");
  if (!Number.isSafeInteger(maxActiveRequestsPerSession) || maxActiveRequestsPerSession < 1) throw new RangeError("maxActiveRequestsPerSession must be a positive safe integer");
  if (!Number.isSafeInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1) throw new RangeError("sessionIdleTimeoutMs must be a positive safe integer");

  const sessions = new Map<string, HttpMcpSession>();
  const trackedSessions = new Set<HttpMcpSession>();
  let pendingSessionInitializations = 0;
  let shuttingDown = false;

  const removeSessionEntry = (session: HttpMcpSession): void => {
    if (session.id && sessions.get(session.id) === session) sessions.delete(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    if (session.reservationHeld) {
      pendingSessionInitializations = Math.max(0, pendingSessionInitializations - 1);
      session.reservationHeld = false;
    }
    session.closed = true;
    trackedSessions.delete(session);
  };

  const disposeSession = async (session: HttpMcpSession): Promise<void> => {
    if (session.closed) return;
    removeSessionEntry(session);
    await session.server.close().catch(() => undefined);
  };

  const scheduleSessionExpiry = (session: HttpMcpSession): void => {
    if (!session.id || session.activeRequests + session.controlRequests > 0 || session.closed || sessions.get(session.id) !== session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { void disposeSession(session); }, sessionIdleTimeoutMs);
    session.idleTimer.unref?.();
  };

  const createStatefulSession = (): HttpMcpSession => {
    const server = createServer();
    const sessionRef: { current?: HttpMcpSession } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        const session = sessionRef.current!;
        if (session.reservationHeld) {
          pendingSessionInitializations = Math.max(0, pendingSessionInitializations - 1);
          session.reservationHeld = false;
        }
        if (shuttingDown || session.closed) return;
        session.id = id;
        sessions.set(id, session);
      },
      onsessionclosed: async () => {
        const session = sessionRef.current;
        if (!session) return;
        removeSessionEntry(session);
        await session.server.close().catch(() => undefined);
      },
      enableDnsRebindingProtection: true,
      maxRequestBodySize: MAX_BODY,
      allowedHosts,
      ...(configuredOrigins ? { allowedOrigins: configuredOrigins } : {}),
    });
    const session: HttpMcpSession = {
      server,
      transport,
      activeRequests: 0,
      controlRequests: 0,
      requestGroups: new Set(),
      requestGroupsById: new Map(),
      reservationHeld: true,
      closed: false,
    };
    sessionRef.current = session;
    trackedSessions.add(session);
    return session;
  };

  const removeRequestGroup = (session: HttpMcpSession, group: HttpMcpRequestGroup): void => {
    session.requestGroups.delete(group);
    for (const requestId of group.requestIds) {
      if (session.requestGroupsById.get(requestId) === group) session.requestGroupsById.delete(requestId);
    }
  };

  const cancelledRequestError = (requestId: string | number) => ({
    jsonrpc: "2.0" as const,
    id: requestId,
    error: { code: ErrorCode.ConnectionClosed, message: "Request cancelled." },
  });

  const settleCancelledGroup = async (session: HttpMcpSession, group: HttpMcpRequestGroup): Promise<void> => {
    if (group.cleanupStarted || group.cancelledIds.size === 0) return;
    const pendingSiblingIds = [...group.requestIds].filter((id) => !group.cancelledIds.has(id) && !group.completedIds.has(id));
    const transportSend = session.transport.send.bind(session.transport);

    if (pendingSiblingIds.length > 0 && !group.response.destroyed && !group.response.writableFinished) {
      for (const requestId of group.cancelledIds) {
        if (group.cancellationResponsesSent.has(requestId)) continue;
        group.cancellationResponsesSent.add(requestId);
        try {
          await transportSend(cancelledRequestError(requestId));
        } catch {
          group.cancellationResponsesSent.delete(requestId);
        }
      }
      if ([...group.requestIds].every((id) => group.completedIds.has(id) || group.cancellationResponsesSent.has(id))) {
        removeRequestGroup(session, group);
      }
      return;
    }

    group.cleanupStarted = true;
    for (const requestId of group.cancelledIds) session.transport.closeSSEStream(requestId);
    for (const requestId of group.cancelledIds) {
      if (group.cancellationResponsesSent.has(requestId)) continue;
      try {
        // The stream is already closed, so this releases SDK request correlation without writing after cancellation.
        await transportSend(cancelledRequestError(requestId));
      } catch {
        // The SDK's public send path removes correlations before reporting that the stream is gone.
      }
    }
    removeRequestGroup(session, group);
  };

  const handleSessionRequest = async (session: HttpMcpSession, req: http.IncomingMessage, res: http.ServerResponse, body?: unknown, readBody = false): Promise<void> => {
    const isDelete = req.method === "DELETE";
    let countedAsActive = false;
    let reservedControlSlot = false;
    if (!isDelete) {
      if (session.activeRequests >= maxActiveRequestsPerSession) {
        if (session.controlRequests > 0) {
          writeJsonRpcError(res, 429, -32000, "This MCP session has reached its active request limit.");
          return;
        }
        session.controlRequests++;
        reservedControlSlot = true;
      } else {
        session.activeRequests++;
        countedAsActive = true;
      }
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    try {
      const payload = readBody && req.method === "POST" ? await readJsonBody(req) : body;
      if (reservedControlSlot && !isCancellationOnlyPayload(payload)) {
        writeJsonRpcError(res, 429, -32000, "This MCP session has reached its active request limit.");
        return;
      }
      if (res.destroyed) return;
      const requestIds = requestIdsFromBody(payload);
      if (requestIds.some((requestId) => session.requestGroupsById.has(requestId))) {
        writeJsonRpcError(res, 400, -32600, "A JSON-RPC request ID is already active in this MCP session.");
        return;
      }
      const requestGroup: HttpMcpRequestGroup | undefined = requestIds.length > 0
        ? {
            response: res,
            requestIds: new Set(requestIds),
            cancelledIds: new Set(),
            completedIds: new Set(),
            cancellationResponsesSent: new Set(),
            cleanupStarted: false,
          }
        : undefined;
      if (requestGroup) {
        session.requestGroups.add(requestGroup);
        for (const requestId of requestGroup.requestIds) session.requestGroupsById.set(requestId, requestGroup);
      }
      res.once("close", () => {
        if (res.writableFinished) {
          if (requestGroup && [...requestGroup.requestIds].every((id) => requestGroup.completedIds.has(id) || requestGroup.cancellationResponsesSent.has(id))) {
            removeRequestGroup(session, requestGroup);
          }
          return;
        }
        if (requestGroup) {
          for (const requestId of requestGroup.requestIds) {
            if (requestGroup.completedIds.has(requestId) || requestGroup.cancelledIds.has(requestId)) continue;
            session.transport.onmessage?.({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId, reason: "HTTP response closed" },
            });
          }
          if (requestGroup.cancelledIds.size > 0) queueMicrotask(() => { void settleCancelledGroup(session, requestGroup); });
        }
      });
      await session.transport.handleRequest(req, res, payload);
      if (requestGroup && res.writableFinished && [...requestGroup.requestIds].every((id) => requestGroup.completedIds.has(id) || requestGroup.cancellationResponsesSent.has(id))) {
        removeRequestGroup(session, requestGroup);
      }
    } finally {
      if (countedAsActive) session.activeRequests = Math.max(0, session.activeRequests - 1);
      if (reservedControlSlot) session.controlRequests = Math.max(0, session.controlRequests - 1);
      if (!isDelete) scheduleSessionExpiry(session);
    }
  };

  const installCancellationStreamCleanup = (session: HttpMcpSession): void => {
    const dispatchMessage = session.transport.onmessage;
    const dispatchSend = session.transport.send.bind(session.transport);
    session.transport.send = async (message, options) => {
      const result = await dispatchSend(message, options);
      if (isJSONRPCErrorResponse(message) || isJSONRPCResultResponse(message)) {
        const responseId = message.id;
        if (typeof responseId === "string" || typeof responseId === "number") {
          const group = session.requestGroupsById.get(responseId);
          if (group) {
            group.completedIds.add(responseId);
            if (group.cancelledIds.size > 0) {
              queueMicrotask(() => { void settleCancelledGroup(session, group); });
            } else if ([...group.requestIds].every((id) => group.completedIds.has(id))) {
              removeRequestGroup(session, group);
            }
          }
        }
      }
      return result;
    };
    session.transport.onmessage = (message, extra) => {
      dispatchMessage?.(message, extra);
      const requestId = validatedCancellationRequestId(message);
      if (requestId === undefined) return;
      const group = session.requestGroupsById.get(requestId);
      if (!group || group.completedIds.has(requestId) || group.cancelledIds.has(requestId)) return;
      group.cancelledIds.add(requestId);
      queueMicrotask(() => { void settleCancelledGroup(session, group); });
    };
  };

  const handleStatelessRequest = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      maxRequestBodySize: MAX_BODY,
      allowedHosts,
      ...(configuredOrigins ? { allowedOrigins: configuredOrigins } : {}),
    });
    res.once("close", () => {
      if (!res.writableFinished) void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      await server.close().catch(() => undefined);
    }
  };

  const httpServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      writeJsonRpcError(res, 400, -32700, "Invalid request target.");
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getHealthPayload()));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found. Use POST /mcp for the MCP protocol or GET /health for a health check.");
      return;
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST /mcp." }, id: null }));
      return;
    }

    const requestHost = req.headers.host;
    const origin = req.headers.origin;
    if (allowedHosts.length > 0 && (!requestHost || !allowedHosts.includes(requestHost))) {
      writeJsonRpcError(res, 403, -32000, "Invalid Host header.");
      return;
    }
    if (configuredOrigins && origin && !configuredOrigins.includes(origin)) {
      writeJsonRpcError(res, 403, -32000, "Invalid Origin header.");
      return;
    }
    if (shuttingDown) {
      writeJsonRpcError(res, 503, -32000, "MCP server is shutting down.");
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    let session: HttpMcpSession | undefined;
    if (rawSessionId !== undefined) {
      if (typeof rawSessionId !== "string" || !MCP_SESSION_ID_PATTERN.test(rawSessionId)) {
        writeJsonRpcError(res, 400, -32000, "Invalid MCP session identifier.");
        return;
      }
      session = sessions.get(rawSessionId);
      if (!session || session.closed) {
        writeJsonRpcError(res, 404, -32001, "Session not found.");
        return;
      }
    }

    try {
      if (req.method === "DELETE") {
        if (!session) {
          res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "A session identifier is required." }, id: null }));
          return;
        }
        await handleSessionRequest(session, req, res);
        return;
      }

      if (session) {
        await handleSessionRequest(session, req, res, undefined, true);
        return;
      }
      const body = await readJsonBody(req);
      if (isInitializeBody(body)) {
        if (shuttingDown || sessions.size + pendingSessionInitializations >= maxSessions) {
          writeJsonRpcError(res, 503, -32000, "MCP session capacity is temporarily full.");
          return;
        }
        pendingSessionInitializations++;
        const newSession = createStatefulSession();
        try {
          await newSession.server.connect(newSession.transport);
          installCancellationStreamCleanup(newSession);
          await handleSessionRequest(newSession, req, res, body);
        } finally {
          if (newSession.reservationHeld) {
            pendingSessionInitializations = Math.max(0, pendingSessionInitializations - 1);
            newSession.reservationHeld = false;
          }
          if (!newSession.id && !newSession.closed) await disposeSession(newSession);
        }
        return;
      }
      await handleStatelessRequest(req, res, body);
    } catch (error) {
      const inputError = error instanceof HttpInputError ? error : undefined;
      if (!inputError) console.error("[hh-mcp] HTTP request failed.");
      writeJsonRpcError(res, inputError?.status ?? 500,
        inputError?.status === 400 ? -32700 : inputError?.status === 413 ? -32000 : -32603,
        inputError?.message ?? "Internal server error");
    }
  });

  const closeSessions = async (): Promise<void> => {
    shuttingDown = true;
    await Promise.all([...trackedSessions].map((session) => disposeSession(session)));
  };
  httpSessionClosers.set(httpServer, closeSessions);
  httpServer.once("close", () => { void closeSessions(); });
  return httpServer;
}

// --- Start ---

async function main() {
  const parsed = parseToolsCliArgs(process.argv.slice(2));
  const args = parsed.rest;
  if (parsed.tools) process.env.HH_TOOLS = parsed.tools;
  if (parsed.toolsExclude) process.env.HH_TOOLS_EXCLUDE = parsed.toolsExclude;
  configureTools();

  // Only `--http` enables HTTP mode. Do not key off HTTP_PORT alone — that
  // variable often appears in copied .env files and would hijack stdio MCP hosts.
  const httpMode = args.includes("--http");
  const port = Number(process.env.HTTP_PORT || process.env.PORT || 3000);
  const budget = getClientHealth().resumeBudget;

  if (httpMode) {
    const host = process.env.HOST || "127.0.0.1";
    const allowedHosts = (
      process.env.HH_ALLOWED_HOSTS ||
      `127.0.0.1:${port},localhost:${port}`
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedOrigins = process.env.HH_ALLOWED_ORIGINS
      ? process.env.HH_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const httpServer = createHttpServer({ port, allowedHosts, allowedOrigins });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[hh-mcp] Port ${port} is already in use. Set HTTP_PORT/PORT to a free port.`);
      } else {
        console.error("[hh-mcp] HTTP server error:", err);
      }
      process.exit(1);
    });

    httpServer.listen(port, host, () => {
      console.error(
        `[hh-mcp] HTTP mode on ${host}:${port} (${TOOL_COUNT} tools` +
          `${filterMeta.filterActive ? ", filtered" : ""}). ` +
          `resumeBudget minIntervalMs=${budget.minIntervalMs} maxConcurrency=${budget.maxConcurrency} shared=${budget.shared}. ` +
          `Endpoint: POST /mcp, health: GET /health`,
      );
    });

    const shutdown = () => {
      void closeHttpMcpSessions(httpServer).finally(() => httpServer.close(() => process.exit(0)));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `[hh-mcp] Server started (stdio). ${TOOL_COUNT} tools` +
        `${filterMeta.filterActive ? " (filtered)" : ""}. ` +
        `resumeBudget minIntervalMs=${budget.minIntervalMs} maxConcurrency=${budget.maxConcurrency} shared=${budget.shared}. ` +
        `Auth: ${process.env.HH_ACCESS_TOKEN ? "token set" : "no token (public endpoints only)"}`,
    );
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error("[hh-mcp] Fatal error:", error);
    process.exit(1);
  });
}

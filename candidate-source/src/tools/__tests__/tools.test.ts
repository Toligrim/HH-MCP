import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the client module before importing tools.
vi.mock("../../client.js", () => ({
  hhGet: vi.fn(),
  HhApiError: class HhApiError extends Error {
    status: number;
    statusText: string;
    body?: string;
    constructor(status: number, statusText: string, body?: string) {
      super(`hh.ru HTTP ${status}: ${statusText}`);
      this.name = "HhApiError";
      this.status = status;
      this.statusText = statusText;
      this.body = body;
    }
  },
}));

import { hhGet, HhApiError } from "../../client.js";
import {
  handleSearchVacancies,
  handleGetVacancy,
  handleGetSimilarVacancies,
  handleGetRelatedVacancies,
  handleGetVacancyStats,
  handleGetVacancyVisitors,
  handleGetVacancyConditions,
  getVacancySchema,
} from "../vacancies.js";
import {
  handleSearchEmployers,
  handleGetEmployer,
  handleGetEmployerVacancies,
  handleListEmployerManagers,
  handleGetEmployerManager,
  handleListActiveVacancies,
  handleListArchivedVacancies,
  handleListHiddenVacancies,
  handleGetMessageTemplate,
  handleListMailTemplates,
  handleGetEmployerVacancyAreas,
  handleGetEmployerDepartments,
  handleListEmployerAddresses,
  handleGetManagerResumeLimits,
  handleGetManagerNegotiationsStatistics,
} from "../employers.js";
import {
  handleSearchResumes,
  handleGetResume,
  handleGetResumeNegotiationsHistory,
  handleListSavedResumeSearches,
  handleGetSavedResumeSearch,
} from "../resumes.js";
import {
  handleListApplicationCollections,
  handleListApplications,
  handleGetApplication,
  handleGetApplicationMessages,
  handleGetNegotiationsStatistics,
  handleGetPreferredNegotiationsOrder,
  scanApplicationsWithUpdates,
  getMaxScanPages,
  DEFAULT_MAX_SCAN_PAGES,
} from "../negotiations.js";
import {
  handleGetAreas,
  handleGetAreasSubtree,
  handleGetProfessionalRoles,
  handleGetIndustries,
  handleGetMetro,
  handleGetDictionaries,
  handleValidateToken,
  handleSuggestPositions,
  handleSuggestProfessionalRoles,
  handleSuggestCompanies,
  handleSuggestAreas,
  handleSuggestVacancySearchKeyword,
  handleSuggestResumeSearchKeyword,
  handleSuggestSkillSet,
  handleGetCountries,
  handleGetLanguages,
  handleGetSkills,
  handleGetDistricts,
} from "../references.js";
import { handleGetSalaryStatistics } from "../salary.js";
import { TOOL_COUNT } from "../../index.js";

const mockHhGet = vi.mocked(hhGet);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HH_ACCESS_TOKEN;
  delete process.env.HH_MAX_SCAN_PAGES;
  process.env.HH_RESUME_MIN_INTERVAL_MS = "0";
  process.env.HH_RESUME_MAX_CONCURRENCY = "5";
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_QUOTA_CHECK = "off";
  process.env.HH_LEDGER_FILE = "off";
  process.env.HH_LOG_DIR = "off";
});
afterEach(() => {
  delete process.env.HH_ACCESS_TOKEN;
  delete process.env.HH_MAX_SCAN_PAGES;
});

function lastUrl(): string {
  return mockHhGet.mock.calls[mockHhGet.mock.calls.length - 1]![0] as string;
}

describe("search_vacancies", () => {
  const sample = {
    items: [
      {
        id: "123",
        name: "Python Developer",
        salary: { from: 200000, to: 300000, currency: "RUR", gross: false },
        employer: { id: "1", name: "Yandex" },
        area: { id: "1", name: "Москва" },
        snippet: { requirement: "<highlighttext>Python</highlighttext> 3+" },
        alternate_url: "https://hh.ru/vacancy/123",
      },
    ],
    found: 1,
    pages: 1,
    per_page: 20,
    page: 0,
  };

  it("builds the full filter surface and returns a compact summary by default", async () => {
    mockHhGet.mockResolvedValueOnce(sample);
    const result = await handleSearchVacancies({
      text: "python",
      area: 1,
      professional_role: 96,
      industry: "7",
      metro: "1.5",
      salary: 200000,
      currency: "RUR",
      experience: "between1And3",
      work_format: "REMOTE",
      period: 7,
      per_page: 20,
      page: 0,
    });
    const url = lastUrl();
    expect(url).toContain("/vacancies?");
    expect(url).toContain("text=python");
    expect(url).toContain("area=1");
    expect(url).toContain("professional_role=96");
    expect(url).toContain("industry=7");
    expect(url).toContain("work_format=REMOTE");
    expect(url).toContain("period=7");
    expect(url).toContain("salary=200000");
    expect(url).toContain("currency=RUR");
    // compact output, not raw JSON
    expect(result).toContain("Найдено вакансий: 1");
    expect(result).toContain("Python Developer");
    expect(result).toContain("Yandex");
    expect(() => JSON.parse(result)).toThrow();
  });

  it("returns raw JSON when raw:true", async () => {
    mockHhGet.mockResolvedValueOnce(sample);
    const result = await handleSearchVacancies({ raw: true, per_page: 20, page: 0 });
    expect(JSON.parse(result).items[0].name).toBe("Python Developer");
  });

  it("omits currency when no salary is given", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleSearchVacancies({ text: "go", per_page: 20, page: 0 });
    const url = lastUrl();
    expect(url).not.toContain("currency=");
    expect(url).not.toContain("salary=");
  });

  it("rejects period together with date_from/date_to", async () => {
    await expect(
      handleSearchVacancies({ period: 7, date_from: "2026-01-01", per_page: 20, page: 0 }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(mockHhGet).not.toHaveBeenCalled();
  });

  it("rejects pagination beyond the 2000-result depth cap", async () => {
    await expect(
      handleSearchVacancies({ per_page: 100, page: 20, raw: true }),
    ).rejects.toThrow(/2000/);
    expect(mockHhGet).not.toHaveBeenCalled();
  });
});

describe("get_vacancy", () => {
  it("formats a compact detail and encodes the id", async () => {
    mockHhGet.mockResolvedValueOnce({
      id: "456",
      name: "Senior Dev",
      employer: { id: "1", name: "Acme" },
      area: { id: "1", name: "Москва" },
      key_skills: [{ name: "Go" }],
      description: "<p>Great job</p>",
      alternate_url: "https://hh.ru/vacancy/456",
    });
    const result = await handleGetVacancy({ vacancy_id: "456" });
    expect(mockHhGet).toHaveBeenCalledWith("/vacancies/456");
    expect(result).toContain("Senior Dev");
    expect(result).toContain("Go");
    expect(result).toContain("Great job");
  });

  it("rejects a non-numeric vacancy id at the schema level", () => {
    expect(getVacancySchema.safeParse({ vacancy_id: "abc" }).success).toBe(false);
    expect(getVacancySchema.safeParse({ vacancy_id: "123" }).success).toBe(true);
  });
});

describe("get_similar_vacancies", () => {
  it("hits the similar endpoint", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 10, page: 0 });
    await handleGetSimilarVacancies({ vacancy_id: "456", per_page: 10, page: 0 });
    expect(lastUrl()).toContain("/vacancies/456/similar_vacancies");
  });
});

describe("employers", () => {
  it("search_employers builds query and formats output", async () => {
    mockHhGet.mockResolvedValueOnce({
      items: [{ id: "1740", name: "Yandex", open_vacancies: 500, alternate_url: "u" }],
      found: 1,
      pages: 1,
      per_page: 20,
      page: 0,
    });
    const result = await handleSearchEmployers({ text: "Yandex", per_page: 20, page: 0 });
    expect(lastUrl()).toContain("text=Yandex");
    expect(result).toContain("Yandex");
    expect(result).toContain("id=1740");
  });

  it("get_employer fetches by id (raw)", async () => {
    mockHhGet.mockResolvedValueOnce({ id: "1740", name: "Yandex" });
    const result = await handleGetEmployer({ employer_id: "1740", raw: true });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740");
    expect(JSON.parse(result).name).toBe("Yandex");
  });

  it("get_employer_vacancies lists via public vacancy search", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleGetEmployerVacancies({ employer_id: "1740", per_page: 20, page: 0 });
    expect(lastUrl()).toContain("/vacancies?");
    expect(lastUrl()).toContain("employer_id=1740");
  });
});

describe("resumes (token-gated)", () => {
  it("search_resumes fails fast without a token", async () => {
    await expect(handleSearchResumes({ text: "python", per_page: 20, page: 0 })).rejects.toThrow(
      /HH_ACCESS_TOKEN/,
    );
    expect(mockHhGet).not.toHaveBeenCalled();
  });

  it("search_resumes works with a token set", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleSearchResumes({ text: "java", professional_role: 96, per_page: 20, page: 0 });
    const url = lastUrl();
    expect(url).toContain("/resumes?");
    expect(url).toContain("professional_role=96");
  });

  it("get_resume fails fast without a token", async () => {
    await expect(handleGetResume({ resume_id: "abc123" })).rejects.toThrow(/HH_ACCESS_TOKEN/);
  });

  it("get_resume fetches with a token (raw)", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ id: "abc123", title: "Backend Dev" });
    const result = await handleGetResume({ resume_id: "abc123", raw: true });
    expect(mockHhGet).toHaveBeenCalledWith(
      "/resumes/abc123",
      expect.objectContaining({ resumeId: "abc123" }),
    );
    expect(JSON.parse(result).title).toBe("Backend Dev");
  });

  it("get_resume passes topic_id and vacancy_id", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ id: "abc123", title: "Backend Dev" });
    await handleGetResume({
      resume_id: "abc123",
      topic_id: "5586031291",
      vacancy_id: "136230668",
      raw: true,
    });
    expect(mockHhGet).toHaveBeenCalledWith(
      "/resumes/abc123?topic_id=5586031291&vacancy_id=136230668",
      expect.any(Object),
    );
  });
});

describe("references", () => {
  it("get_areas flattens the tree to id — name", async () => {
    mockHhGet.mockResolvedValueOnce([
      { id: "113", name: "Россия", areas: [{ id: "1", name: "Москва" }] },
    ]);
    const result = await handleGetAreas();
    expect(result).toContain("113 — Россия");
    expect(result).toContain("1 — Москва");
  });

  it("get_areas_subtree fetches a single node", async () => {
    mockHhGet.mockResolvedValueOnce({ id: "113", name: "Россия", areas: [] });
    const result = await handleGetAreasSubtree({ area_id: "113" });
    expect(mockHhGet).toHaveBeenCalledWith("/areas/113");
    expect(result).toContain("113 — Россия");
  });

  it("get_professional_roles flattens categories and roles", async () => {
    mockHhGet.mockResolvedValueOnce({
      categories: [{ id: "11", name: "IT", roles: [{ id: "96", name: "Программист" }] }],
    });
    const result = await handleGetProfessionalRoles();
    expect(mockHhGet).toHaveBeenCalledWith("/professional_roles");
    expect(result).toContain("96 — Программист");
  });

  it("get_industries flattens groups", async () => {
    mockHhGet.mockResolvedValueOnce([
      { id: "7", name: "IT", industries: [{ id: "7.538", name: "Системная интеграция" }] },
    ]);
    const result = await handleGetIndustries();
    expect(mockHhGet).toHaveBeenCalledWith("/industries");
    expect(result).toContain("7.538 — Системная интеграция");
  });

  it("get_metro builds the city path", async () => {
    mockHhGet.mockResolvedValueOnce({ lines: [] });
    await handleGetMetro({ city_id: "1" });
    expect(mockHhGet).toHaveBeenCalledWith("/metro/1");
  });

  it("get_dictionaries fetches the bundle", async () => {
    mockHhGet.mockResolvedValueOnce({ currency: [], experience: [] });
    await handleGetDictionaries();
    expect(mockHhGet).toHaveBeenCalledWith("/dictionaries");
  });

  it("suggest_positions hits /suggests/positions", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [{ text: "Python developer" }] });
    const result = await handleSuggestPositions({ text: "python" });
    expect(lastUrl()).toContain("/suggests/positions");
    expect(result).toContain("Python developer");
  });

  it("suggest_professional_roles hits /suggests/professional_roles", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [{ id: "96", text: "Программист" }] });
    const result = await handleSuggestProfessionalRoles({ text: "прог" });
    expect(lastUrl()).toContain("/suggests/professional_roles");
    expect(result).toContain("Программист (id=96)");
  });

  it("suggest_companies and suggest_areas hit the right endpoints", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [] });
    await handleSuggestCompanies({ text: "yan" });
    expect(lastUrl()).toContain("/suggests/companies");
    mockHhGet.mockResolvedValueOnce({ items: [] });
    await handleSuggestAreas({ text: "mos" });
    expect(lastUrl()).toContain("/suggests/areas");
  });

  it("keyword and skill suggests hit the right endpoints", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [] });
    await handleSuggestVacancySearchKeyword({ text: "py" });
    expect(lastUrl()).toContain("/suggests/vacancy_search_keyword");
    mockHhGet.mockResolvedValueOnce({ items: [] });
    await handleSuggestResumeSearchKeyword({ text: "java" });
    expect(lastUrl()).toContain("/suggests/resume_search_keyword");
    mockHhGet.mockResolvedValueOnce({ items: [] });
    await handleSuggestSkillSet({ text: "sql" });
    expect(lastUrl()).toContain("/suggests/skill_set");
  });

  it("get_countries / get_languages / get_skills / get_districts", async () => {
    mockHhGet.mockResolvedValueOnce([{ id: "113", name: "Россия" }]);
    expect(await handleGetCountries()).toContain("113 — Россия");
    expect(mockHhGet).toHaveBeenCalledWith("/areas/countries");

    mockHhGet.mockResolvedValueOnce([{ id: "rus", name: "Русский" }]);
    expect(await handleGetLanguages()).toContain("Русский");
    expect(mockHhGet).toHaveBeenCalledWith("/languages");

    mockHhGet.mockResolvedValueOnce({ items: [{ id: "2716", text: "Python" }] });
    expect(await handleGetSkills({ id: ["2716"] })).toContain("Python");
    expect(lastUrl()).toContain("/skills?");
    expect(lastUrl()).toContain("id=2716");

    mockHhGet.mockResolvedValueOnce([{ id: "1", name: "ЦАО" }]);
    await handleGetDistricts({ area_id: "1" });
    expect(lastUrl()).toContain("/districts?");
    expect(lastUrl()).toContain("area=1");
  });

  it("get_skills accepts a single id string and rejects oversized batches at runtime", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [{ id: "1", text: "SQL" }] });
    await handleGetSkills({ id: "1" });
    expect(lastUrl()).toBe("/skills?id=1");

    const tooMany = Array.from({ length: 51 }, (_, i) => String(i));
    await expect(handleGetSkills({ id: tooMany })).rejects.toThrow(/50/);
    // zod also caps arrays at 50 when parsed via the schema
  });
});

describe("ATS negotiations (token-gated)", () => {
  it("list_application_collections fails without token", async () => {
    await expect(handleListApplicationCollections({ vacancy_id: "1" })).rejects.toThrow(
      /HH_ACCESS_TOKEN/,
    );
  });

  it("list_application_collections builds query and formats", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      collections: [
        {
          id: "response",
          name: "Неразобранные",
          description: "Откликов не найдено.",
          counters: { total: 3, with_updates: 1 },
          sub_collections: [
            {
              id: "response_1",
              name: "Подходят",
              root_collection: "response",
              counters: { total: 3, with_updates: 1 },
            },
          ],
        },
      ],
      employer_states: [{ id: "response", name: "Отклик" }],
    });
    const result = await handleListApplicationCollections({ vacancy_id: "123" });
    expect(lastUrl()).toBe("/negotiations?vacancy_id=123");
    expect(result).toContain("response");
    expect(result).toContain("Неразобранные");
    expect(result).toContain("всего 3");
    expect(result).toContain("с изменениями 1");
    expect(result).not.toMatch(/Откликов не найдено/);
  });

  it("list_applications hits collection path with order_by", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [
        {
          id: "9",
          employer_state: { id: "response", name: "Отклик" },
          resume: { id: "abc", title: "Backend", first_name: "Ivan", last_name: "Petrov" },
        },
      ],
      found: 1,
      pages: 1,
      page: 0,
      per_page: 20,
    });
    const result = await handleListApplications({
      collection: "response",
      vacancy_id: "123",
      page: 0,
      per_page: 20,
      order_by: "created_at",
    });
    expect(lastUrl()).toContain("/negotiations/response?");
    expect(lastUrl()).toContain("vacancy_id=123");
    expect(lastUrl()).toContain("order_by=created_at");
    expect(result).toContain("Backend");
    expect(result).toContain("resume_id=abc");
  });

  it("list_applications resolves sub_collection by name", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet
      .mockResolvedValueOnce({
        collections: [
          {
            id: "response",
            name: "Все неразобранные",
            sub_collections: [
              {
                id: "response_107261719",
                name: "Подходят",
                root_collection: "response",
                counters: { total: 9 },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [{ id: "1", resume: { title: "A" } }],
        found: 9,
        pages: 1,
        page: 0,
        per_page: 2,
      });
    const result = await handleListApplications({
      vacancy_id: "136826013",
      sub_collection: "Подходят",
      page: 0,
      per_page: 2,
    });
    expect(mockHhGet.mock.calls[0]![0]).toContain("/negotiations?vacancy_id=136826013");
    expect(mockHhGet.mock.calls[1]![0]).toContain("/negotiations/response_107261719?");
    expect(result).toContain("9 найдено");
  });

  it("list_applications resolves bare sub-collection id", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet
      .mockResolvedValueOnce({
        collections: [
          {
            id: "response",
            name: "Все неразобранные",
            sub_collections: [
              {
                id: "response_107261719",
                name: "Подходят",
                root_collection: "response",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [],
        found: 0,
        pages: 0,
        page: 0,
        per_page: 20,
      });
    await handleListApplications({
      vacancy_id: "136826013",
      sub_collection: "107261719",
      page: 0,
      per_page: 20,
    });
    expect(mockHhGet.mock.calls[1]![0]).toContain("/negotiations/response_107261719?");
  });

  it("list_applications unknown sub_collection enumerates available stages", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      collections: [
        {
          id: "response",
          name: "Все неразобранные",
          sub_collections: [
            {
              id: "response_107261719",
              name: "Подходят",
              root_collection: "response",
            },
          ],
        },
      ],
    });
    await expect(
      handleListApplications({
        vacancy_id: "136826013",
        sub_collection: "НетТакого",
        page: 0,
        per_page: 20,
      }),
    ).rejects.toThrow(
      /Подэтап воронки "НетТакого" не найден.*"Подходят" \(id response_107261719, в «Все неразобранные»\).*list_application_collections/,
    );
  });

  it("list_applications scopes sub_collection when root_collection is boolean true", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet
      .mockResolvedValueOnce({
        collections: [
          {
            id: "response",
            name: "Все неразобранные",
            sub_collections: [
              { id: "response_1", name: "Остальные", root_collection: true },
            ],
          },
          {
            id: "consider",
            name: "Подумать",
            sub_collections: [
              { id: "consider_1", name: "Остальные", root_collection: true },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [{ id: "42", resume: { title: "Dev" } }],
        found: 1,
        pages: 1,
        page: 0,
        per_page: 20,
      });
    const result = await handleListApplications({
      vacancy_id: "136826013",
      collection: "consider",
      sub_collection: "Остальные",
      page: 0,
      per_page: 20,
    });
    expect(mockHhGet.mock.calls[1]![0]).toContain("/negotiations/consider_1?");
    expect(result).toContain("Подумать");
    expect(result).toContain("1 найдено");
  });

  it("list_applications with_updates_only scans pages for matches", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet
      .mockResolvedValueOnce({
        items: [
          { id: "1", has_updates: false, resume: { title: "A" } },
          { id: "2", has_updates: false, resume: { title: "B" } },
        ],
        found: 90,
        pages: 3,
        page: 0,
        per_page: 50,
      })
      .mockResolvedValueOnce({
        items: [
          { id: "3", has_updates: true, resume: { title: "C" } },
          { id: "4", has_updates: true, resume: { title: "D" } },
        ],
        found: 90,
        pages: 3,
        page: 1,
        per_page: 50,
      })
      .mockResolvedValueOnce({
        items: [{ id: "5", has_updates: false, resume: { title: "E" } }],
        found: 90,
        pages: 3,
        page: 2,
        per_page: 50,
      });
    const result = await handleListApplications({
      vacancy_id: "123",
      collection: "response",
      with_updates_only: true,
      page: 0,
      per_page: 20,
    });
    expect(mockHhGet).toHaveBeenCalledTimes(3);
    expect(String(mockHhGet.mock.calls[0]?.[0])).toContain("per_page=50");
    expect(result).toContain("после фильтра 2 из 90");
    expect(result).toContain("просмотрено 3 страницы");
    expect(result).toContain("тема 3");
    expect(result).toContain("тема 4");
    expect(result).not.toContain("(пусто)");
  });

  it("list_applications with_updates_only exhaustive empty prints (пусто)", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [
        { id: "1", has_updates: false, resume: { title: "A" } },
        { id: "2", has_updates: false, resume: { title: "B" } },
      ],
      found: 2,
      pages: 1,
      page: 0,
      per_page: 50,
    });
    const result = await handleListApplications({
      vacancy_id: "123",
      collection: "response",
      with_updates_only: true,
      page: 0,
      per_page: 20,
    });
    expect(result).toContain("после фильтра 0 из 2");
    expect(result).toContain("(пусто)");
  });

  it("list_applications with_updates_only capped scan omits (пусто)", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    process.env.HH_MAX_SCAN_PAGES = "2";
    mockHhGet
      .mockResolvedValueOnce({
        items: [{ id: "1", has_updates: false, resume: { title: "A" } }],
        found: 90,
        pages: 5,
        page: 0,
        per_page: 50,
      })
      .mockResolvedValueOnce({
        items: [{ id: "2", has_updates: false, resume: { title: "B" } }],
        found: 90,
        pages: 5,
        page: 1,
        per_page: 50,
      });
    const result = await handleListApplications({
      vacancy_id: "123",
      collection: "response",
      with_updates_only: true,
      page: 0,
      per_page: 20,
    });
    expect(mockHhGet).toHaveBeenCalledTimes(2);
    expect(result).toContain("просмотр не завершён — есть ещё страницы");
    expect(result).not.toContain("(пусто)");
  });

  it("list_applications with_updates_only page/per_page slice the filtered stream", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [
        { id: "1", has_updates: true, resume: { title: "A" } },
        { id: "2", has_updates: false, resume: { title: "B" } },
        { id: "3", has_updates: true, resume: { title: "C" } },
        { id: "4", has_updates: true, resume: { title: "D" } },
        { id: "5", has_updates: true, resume: { title: "E" } },
      ],
      found: 5,
      pages: 1,
      page: 0,
      per_page: 50,
    });
    const result = await handleListApplications({
      vacancy_id: "123",
      collection: "response",
      with_updates_only: true,
      page: 1,
      per_page: 2,
    });
    expect(result).toContain("страница фильтра 2");
    expect(result).toContain("тема 4");
    expect(result).toContain("тема 5");
    expect(result).not.toContain("тема 1");
    expect(result).not.toContain("тема 3");
  });

  it("list_applications raw:true stays single-page and unfiltered", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [
        { id: "1", has_updates: false },
        { id: "2", has_updates: true },
      ],
      found: 90,
      pages: 5,
      page: 0,
      per_page: 20,
    });
    const result = await handleListApplications({
      vacancy_id: "123",
      collection: "response",
      with_updates_only: true,
      raw: true,
      page: 0,
      per_page: 20,
    });
    expect(mockHhGet).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toContain("per_page=20");
    expect(lastUrl()).not.toContain("per_page=50");
    const parsed = JSON.parse(result) as { items: { id: string }[] };
    expect(parsed.items).toHaveLength(2);
  });

  it("getMaxScanPages defaults and validates", () => {
    expect(getMaxScanPages({})).toBe(DEFAULT_MAX_SCAN_PAGES);
    expect(getMaxScanPages({ HH_MAX_SCAN_PAGES: "3" })).toBe(3);
    expect(getMaxScanPages({ HH_MAX_SCAN_PAGES: "0" })).toBe(DEFAULT_MAX_SCAN_PAGES);
    expect(getMaxScanPages({ HH_MAX_SCAN_PAGES: "nope" })).toBe(DEFAULT_MAX_SCAN_PAGES);
  });

  it("scanApplicationsWithUpdates stops early once filtered page is full", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, i) => ({
          id: String(i),
          has_updates: true,
          resume: { title: `T${i}` },
        })),
        found: 200,
        pages: 4,
        page: 0,
        per_page: 50,
      })
      .mockResolvedValueOnce({
        items: [{ id: "x", has_updates: true }],
        found: 200,
        pages: 4,
        page: 1,
        per_page: 50,
      });

    const scan = await scanApplicationsWithUpdates({
      collection: "response",
      vacancyId: "123",
      filteredPage: 0,
      filteredPerPage: 20,
      maxScanPages: 10,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(scan.items).toHaveLength(20);
    expect(scan.exhausted).toBe(false);
    expect(scan.capped).toBe(false);
    expect(scan.hasMoreFiltered).toBe(true);
  });

  it("get_application and messages", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      id: "9",
      employer_state: { name: "Отклик" },
      resume: { id: "abc", title: "Dev", last_name: "Ivanov", age: 30 },
      counters: { messages: 2, unread_messages: 1 },
    });
    const app = await handleGetApplication({ id: "9" });
    expect(mockHhGet).toHaveBeenCalledWith("/negotiations/9");
    expect(app).toContain("Отклик");
    expect(app).toContain("Сообщений: 2 (новых 1)");

    mockHhGet.mockResolvedValueOnce({
      items: [
        {
          text: "Hello",
          author: { participant_type: "employer" },
          created_at: "2026-01-01T12:00:00+0300",
          viewed_by_me: true,
        },
      ],
      found: 1,
      page: 0,
      pages: 1,
    });
    const msgs = await handleGetApplicationMessages({ nid: "9", page: 0, per_page: 20 });
    expect(mockHhGet).toHaveBeenCalledWith("/negotiations/9/messages?page=0&per_page=20");
    expect(msgs).toContain("Hello");
    expect(msgs).toContain("работодатель");
  });

  it("get_application_messages paginates", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [{ text: "a", author: { participant_type: "applicant" } }],
      found: 23,
      page: 0,
      pages: 5,
    });
    const msgs = await handleGetApplicationMessages({ nid: "5569910826", page: 0, per_page: 5 });
    expect(lastUrl()).toBe("/negotiations/5569910826/messages?page=0&per_page=5");
    expect(msgs).toContain("страница 1 из 5, показано 1");
    expect(msgs).toContain("Следующая страница: page=1");
  });

  it("get_negotiations_statistics and preferred order", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ responses: 10, invitations: 2 });
    const stats = await handleGetNegotiationsStatistics({ employer_id: "1740" });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/negotiations_statistics");
    expect(stats).toContain("responses");

    mockHhGet.mockResolvedValueOnce({ order_type: { id: "relevance", name: "Лучшие" } });
    const order = await handleGetPreferredNegotiationsOrder({ vacancy_id: "123" });
    expect(mockHhGet).toHaveBeenCalledWith("/vacancies/123/preferred_negotiations_order");
    expect(order).toBe("Предпочтительная сортировка: Лучшие (relevance)");
  });

  it("returns raw JSON when raw:true", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ collections: [] });
    const result = await handleListApplicationCollections({ vacancy_id: "1", raw: true });
    expect(JSON.parse(result).collections).toEqual([]);
  });
});

describe("employer ATS tools", () => {
  it("managers and limits require token and hit paths", async () => {
    await expect(handleListEmployerManagers({ employer_id: "1", page: 0, per_page: 20 })).rejects.toThrow(
      /HH_ACCESS_TOKEN/,
    );
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [
        {
          id: "5",
          full_name: "HR",
          email: "hr@x.io",
          phone: { formatted: "79295710948", country: "7", city: "929", number: "5710948" },
        },
      ],
      found: 1,
    });
    const list = await handleListEmployerManagers({ employer_id: "1740", page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/employers/1740/managers?");
    expect(list).toContain("HR");
    expect(list).toContain("+79295710948");
    expect(list).not.toContain("[object Object]");

    mockHhGet.mockResolvedValueOnce({ id: "5", full_name: "HR" });
    await handleGetEmployerManager({ employer_id: "1740", manager_id: "5", raw: true });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/managers/5");

    mockHhGet.mockResolvedValueOnce({ left: 10 });
    await handleGetManagerResumeLimits({ employer_id: "1740", manager_id: "5", raw: true });
    expect(lastUrl()).toContain("/limits/resume");

    mockHhGet.mockResolvedValueOnce({ responses: 1 });
    await handleGetManagerNegotiationsStatistics({
      employer_id: "1740",
      manager_id: "5",
      raw: true,
    });
    expect(lastUrl()).toContain("/negotiations_statistics");
  });

  it("list_active_vacancies requires token", async () => {
    await expect(
      handleListActiveVacancies({ employer_id: "1740", page: 0, per_page: 20 }),
    ).rejects.toThrow(/HH_ACCESS_TOKEN/);
  });

  it("archived/hidden vacancies and templates/addresses", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleListActiveVacancies({ employer_id: "1740", page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/vacancies/active");

    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleListArchivedVacancies({ employer_id: "1740", page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/vacancies/archived");

    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 20, page: 0 });
    await handleListHiddenVacancies({ employer_id: "1740", page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/vacancies/hidden");

    mockHhGet.mockResolvedValueOnce({
      mail: { text: "Здравствуйте! Позвоните, пожалуйста.", employer_state: "PHONE_INTERVIEW" },
      sms: { text: "SMS body" },
    });
    const tpl = await handleGetMessageTemplate({ template: "invite", topic_id: "9" });
    expect(lastUrl()).toContain("/message_templates/invite?");
    expect(lastUrl()).toContain("topic_id=9");
    expect(tpl).toContain("Здравствуйте!");
    expect(tpl).toContain("SMS body");
    expect(tpl).not.toContain("[object Object]");

    mockHhGet.mockResolvedValueOnce({ items: [{ id: "1", name: "Offer" }] });
    const mails = await handleListMailTemplates({ employer_id: "1740" });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/mail_templates");
    expect(mails).toContain("Offer");

    mockHhGet.mockResolvedValueOnce([{ id: "1", name: "Москва" }]);
    await handleGetEmployerVacancyAreas({ employer_id: "1740" });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/vacancy_areas/active");

    mockHhGet.mockResolvedValueOnce([{ id: "d1", name: "IT" }]);
    await handleGetEmployerDepartments({ employer_id: "1740" });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/departments");

    mockHhGet.mockResolvedValueOnce({ items: [{ id: "a1", city: "Москва", street: "Тверская" }] });
    const addrs = await handleListEmployerAddresses({ employer_id: "1740" });
    expect(mockHhGet).toHaveBeenCalledWith("/employers/1740/addresses");
    expect(addrs).toContain("Тверская");
  });
});

describe("vacancy extras + saved searches", () => {
  it("get_related_vacancies is public", async () => {
    mockHhGet.mockResolvedValueOnce({ items: [], found: 0, pages: 0, per_page: 10, page: 0 });
    await handleGetRelatedVacancies({ vacancy_id: "456", per_page: 10, page: 0 });
    expect(lastUrl()).toContain("/vacancies/456/related_vacancies");
  });

  it("vacancy stats/visitors/conditions require token", async () => {
    await expect(handleGetVacancyStats({ vacancy_id: "1" })).rejects.toThrow(/HH_ACCESS_TOKEN/);
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({ views: { total: 100 }, responses: { total: 5 } });
    const stats = await handleGetVacancyStats({ vacancy_id: "1" });
    expect(mockHhGet).toHaveBeenCalledWith("/vacancies/1/stats");
    expect(stats).toContain("views");

    mockHhGet.mockResolvedValueOnce({
      items: [{ resume: { id: "r1", title: "Dev" }, last_visit: "2026-01-01" }],
      found: 1,
      page: 0,
      pages: 1,
      per_page: 20,
    });
    const visitors = await handleGetVacancyVisitors({ vacancy_id: "1", page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/vacancies/1/visitors?");
    expect(visitors).toContain("Dev");

    mockHhGet.mockResolvedValueOnce({
      items: [],
      found: 140,
      page: 0,
      pages: 70,
      per_page: 2,
      hidden_on_page: 2,
    });
    const hidden = await handleGetVacancyVisitors({ vacancy_id: "1", page: 0, per_page: 2 });
    expect(hidden).toContain("Посетителей: 140 (страница 1 из 70, показано 0 · скрыто 2)");
    expect(hidden).toContain("скрыл посетителей");

    mockHhGet.mockResolvedValueOnce([{ id: "c1", name: "Условие" }]);
    const cond = await handleGetVacancyConditions();
    expect(mockHhGet).toHaveBeenCalledWith("/vacancy_conditions");
    expect(cond).toContain("Условие");
  });

  it("saved resume searches require token", async () => {
    await expect(
      handleListSavedResumeSearches({ page: 0, per_page: 20 }),
    ).rejects.toThrow(/HH_ACCESS_TOKEN/);
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      items: [{ id: "7", name: "Python", items: { count: 10 }, new_items: { count: 2 } }],
      found: 1,
    });
    const list = await handleListSavedResumeSearches({ page: 0, per_page: 20 });
    expect(lastUrl()).toContain("/saved_searches/resumes?");
    expect(list).toContain("Python");

    mockHhGet.mockResolvedValueOnce({ id: "7", name: "Python" });
    const one = await handleGetSavedResumeSearch({ id: "7", raw: true });
    expect(mockHhGet).toHaveBeenCalledWith("/saved_searches/resumes/7");
    expect(JSON.parse(one).name).toBe("Python");
  });

  it("get_resume_negotiations_history", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      negotiations: [{ employer_state: { name: "Отклик" }, created_at: "2026-01-01" }],
    });
    const result = await handleGetResumeNegotiationsHistory({ resume_id: "abc123" });
    expect(mockHhGet).toHaveBeenCalledWith("/resumes/abc123/negotiations_history");
    expect(result).toContain("Отклик");
  });
});

describe("tool registry", () => {
  it("exposes 52 tools", () => {
    expect(TOOL_COUNT).toBe(55);
  });
});

describe("validate_token", () => {
  it("reports public-only mode without a token", async () => {
    const result = await handleValidateToken();
    expect(result).toContain("не задан");
    expect(mockHhGet).not.toHaveBeenCalled();
  });

  it("reports a valid token and role via /me", async () => {
    process.env.HH_ACCESS_TOKEN = "t";
    mockHhGet.mockResolvedValueOnce({
      id: "9",
      email: "hr@acme.io",
      first_name: "HR",
      is_employer: true,
    });
    const result = await handleValidateToken();
    expect(mockHhGet).toHaveBeenCalledWith("/me");
    expect(result).toContain("Токен валиден");
    expect(result).toContain("employer");
  });

  it("reports an invalid token on 403", async () => {
    process.env.HH_ACCESS_TOKEN = "bad";
    mockHhGet.mockRejectedValueOnce(new HhApiError(403, "Forbidden"));
    const result = await handleValidateToken();
    expect(result).toContain("недействителен");
  });
});

describe("salary statistics", () => {
  it("samples vacancies when no token (client-side distribution)", async () => {
    mockHhGet.mockResolvedValueOnce({ found: 1000, items: [{}], pages: 1000, per_page: 1, page: 0 });
    mockHhGet.mockResolvedValueOnce({
      found: 580,
      pages: 6,
      per_page: 100,
      page: 0,
      items: [
        { salary: { from: 100000, to: 200000, currency: "RUR" } },
        { salary: { from: 150000, currency: "RUR" } },
        { salary: { from: 200000, to: 300000, currency: "RUR" } },
        { salary: { to: 250000, currency: "RUR" } },
      ],
    });
    const result = await handleGetSalaryStatistics({
      professional_role_id: 96,
      area_id: 1,
      sample_pages: 1,
    });
    const firstUrl = mockHhGet.mock.calls[0]![0] as string;
    const secondUrl = mockHhGet.mock.calls[1]![0] as string;
    expect(firstUrl).toContain("/vacancies?");
    expect(firstUrl).toContain("professional_role=96");
    expect(firstUrl).toContain("area=1");
    expect(secondUrl).toContain("label=with_salary");
    expect(result).toContain("Медиана");
    expect(result).toContain("Смещённая оценка");
  });

  it("uses paid salary bank when token + area_id succeed", async () => {
    process.env.HH_ACCESS_TOKEN = "tok";
    mockHhGet.mockResolvedValueOnce({
      market_salary: {
        average: 50054,
        bottom: 28500,
        maximum: 52643,
        median: 35000,
        minimum: 20000,
        upper: 50000,
      },
      resulting_parameters: {
        areas: [{ id: "1", name: "Москва" }],
        employers_count: 21,
        positions_count: 1648,
        sources: ["SALARIES"],
        specialities: [{ id: "1200000", name: "Эксплуатация информационных систем" }],
      },
    });
    const result = await handleGetSalaryStatistics({
      professional_role_id: 96,
      area_id: 1,
      text: "python",
      speciality: "1200000",
      sample_pages: 1,
    });
    expect(mockHhGet).toHaveBeenCalledTimes(1);
    const url = mockHhGet.mock.calls[0]![0] as string;
    expect(url).toContain("/salary_statistics/paid/salary_evaluation/1?");
    expect(url).toContain("position_name=python");
    expect(url).toContain("speciality=1200000");
    expect(result).toContain("Банк данных зарплат");
    expect(result).toContain("Медиана");
    expect(result).toMatch(/35/);
  });

  it("falls back to vacancy sample on paid 403", async () => {
    process.env.HH_ACCESS_TOKEN = "tok";
    mockHhGet
      .mockRejectedValueOnce(new HhApiError(403, "Forbidden"))
      .mockResolvedValueOnce({ found: 100, items: [{}] })
      .mockResolvedValueOnce({
        found: 50,
        items: [
          { salary: { from: 100000, currency: "RUR" } },
          { salary: { from: 300000, currency: "RUR" } },
        ],
      });
    const result = await handleGetSalaryStatistics({
      professional_role_id: 96,
      area_id: 1,
      sample_pages: 1,
    });
    expect(mockHhGet.mock.calls[0]![0]).toContain("/salary_statistics/paid/");
    expect(mockHhGet.mock.calls[1]![0]).toContain("/vacancies?");
    expect(result).toContain("Смещённая оценка");
  });

  it("returns the stats object with raw:true (vacancy path)", async () => {
    mockHhGet.mockResolvedValueOnce({ found: 100, items: [{}] });
    mockHhGet.mockResolvedValueOnce({
      found: 50,
      items: [
        { salary: { from: 100000, currency: "RUR" } },
        { salary: { from: 300000, currency: "RUR" } },
      ],
    });
    const result = await handleGetSalaryStatistics({
      professional_role_id: 96,
      raw: true,
      sample_pages: 1,
    });
    const stats = JSON.parse(result);
    expect(stats.source).toBe("vacancy_sample");
    expect(stats.median).toBe(200000);
    expect(stats.currency).toBe("RUR");
    expect(stats.sample_size).toBe(2);
  });

  it("throws when no salaried vacancies are found", async () => {
    mockHhGet.mockResolvedValueOnce({ found: 0, items: [] });
    mockHhGet.mockResolvedValueOnce({ found: 0, items: [] });
    await expect(
      handleGetSalaryStatistics({ professional_role_id: 96, sample_pages: 1 }),
    ).rejects.toThrow(/Нет вакансий/);
  });
});

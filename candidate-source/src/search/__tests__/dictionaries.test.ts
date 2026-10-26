import { describe, expect, it, vi } from "vitest";
vi.mock("../../client.js", () => ({ hhGet: vi.fn() }));
import { resolveSearchDictionary, resolveSearchDictionarySchema } from "../dictionaries.js";
import { normalizeVacancySearch } from "../query.js";

describe("search dictionary resolution", () => {
  it("strictly bounds dictionary inputs and rejects arbitrary URLs", () => {
    expect(resolveSearchDictionarySchema.safeParse({ dictionary: "areas", text: "Москва" }).success).toBe(true);
    expect(resolveSearchDictionarySchema.safeParse({ dictionary: "https://evil.test", text: "x" }).success).toBe(false);
    expect(resolveSearchDictionarySchema.safeParse({ dictionary: "areas", text: "x", url: "https://evil.test" }).success).toBe(false);
  });

  it("returns only exact matches, bounded candidates, or unknown", async () => {
    const { hhGet } = await import("../../client.js");
    const get = vi.mocked(hhGet);
    get.mockResolvedValueOnce([{ id: "1", name: "Москва" }, { id: "2", name: "Московская область" }]);
    const result = await resolveSearchDictionary({ dictionary: "areas", text: "Москва" }, { now: 1_000_000 });
    expect(result).toMatchObject({ status: "exact", id: "1", name: "Москва" });
  });

  it("checks known enum membership synchronously at the field level", () => {
    expect(() => normalizeVacancySearch({ work_format: "NOT_A_PUBLIC_VALUE" })).toThrow(/unknown work_format id/);
  });

  it("refreshes a dynamic catalogue explicitly so new official values are accepted", async () => {
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce({ work_format: [{ id: "NEW_KIND", name: "New Kind" }] });
    const result = await resolveSearchDictionary({ dictionary: "work_format", text: "New Kind" }, { now: 2_000_000 });
    expect(result).toMatchObject({ status: "exact", id: "NEW_KIND" });
    expect(() => normalizeVacancySearch({ work_format: "NEW_KIND" })).not.toThrow();
  });

  it("limits part_time employment values to part/project and keeps accept_temporary through refresh", async () => {
    expect(() => normalizeVacancySearch({ part_time: "accept_temporary" })).not.toThrow();
    for (const value of ["full", "volunteer", "probation"]) {
      expect(() => normalizeVacancySearch({ part_time: value })).toThrow(/unknown part_time/);
    }
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce({
      working_days: [{ id: "NEW_DAY", name: "New Day" }],
      working_time_intervals: [{ id: "NEW_INTERVAL", name: "New Interval" }],
      working_time_modes: [{ id: "NEW_MODE", name: "New Mode" }],
      employment: [{ id: "full", name: "Полная" }, { id: "part", name: "Частичная" }, { id: "project", name: "Проектная" }, { id: "volunteer", name: "Волонтерство" }, { id: "probation", name: "Стажировка" }],
    });
    await resolveSearchDictionary({ dictionary: "part_time", text: "NEW_DAY" }, { now: 3_000_000 });
    for (const value of ["accept_temporary", "NEW_DAY", "NEW_INTERVAL", "NEW_MODE", "part", "project"]) {
      expect(() => normalizeVacancySearch({ part_time: value })).not.toThrow();
    }
    for (const value of ["full", "volunteer", "probation"]) {
      expect(() => normalizeVacancySearch({ part_time: value })).toThrow(/unknown part_time/);
    }
  });

  it("filters employment-only part_time values without dropping IDs from other source dictionaries", async () => {
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce({
      working_days: [{ id: "full", name: "Full workday" }],
      working_time_intervals: [], working_time_modes: [],
      employment: [{ id: "full", name: "Полная занятость" }],
    });
    const result = await resolveSearchDictionary({ dictionary: "part_time", text: "Full workday" }, { now: 7_000_000 });
    expect(result).toMatchObject({ status: "exact", id: "full", name: "Full workday" });
    expect(() => normalizeVacancySearch({ part_time: "full" })).not.toThrow();
  });

  it("resolves currency codes and keeps refreshed currency valid for a subsequent search", async () => {
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce({ currency: [{ code: "RUR", name: "Рубли" }] });
    const result = await resolveSearchDictionary({ dictionary: "currency", text: "Рубли" }, { now: 4_000_000 });
    expect(result).toMatchObject({ status: "exact", id: "RUR", name: "Рубли" });
    expect(normalizeVacancySearch({ salary: 90_000, currency: "RUR" }).currency).toBe("RUR");
  });

  it("resolves only professional role leaves, never category nodes", async () => {
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce({ categories: [{ id: "cat-1", name: "A category", roles: [{ id: "role-1", name: "A role" }] }] });
    expect(await resolveSearchDictionary({ dictionary: "professional_roles", text: "A category" }, { now: 6_000_000 })).toMatchObject({ status: "unknown" });
    vi.mocked(hhGet).mockResolvedValueOnce({ categories: [{ id: "cat-1", name: "A category", roles: [{ id: "role-2", name: "Target role" }] }] });
    expect(await resolveSearchDictionary({ dictionary: "professional_roles", text: "Target role" }, { now: 10_000_000 })).toMatchObject({ status: "exact", id: "role-2", name: "Target role" });
  });

  it("returns compact area candidates and metro lines/stations without city containers", async () => {
    const { hhGet } = await import("../../client.js");
    vi.mocked(hhGet).mockResolvedValueOnce([{ id: "area-1", name: "Moscow", areas: [{ id: "area-2", name: "Moscow center" }] }]);
    const areas = await resolveSearchDictionary({ dictionary: "areas", text: "Mos" }, { now: 20_000_000 });
    expect(areas).toMatchObject({ status: "candidates" });
    const areaCandidates = (areas as { candidates: unknown[] }).candidates;
    expect(JSON.stringify(areaCandidates)).not.toContain("areas");
    expect(areaCandidates.every((item) => Object.keys(item as object).sort().join(",") === "id,name")).toBe(true);

    vi.mocked(hhGet).mockResolvedValueOnce({ areas: [{ id: "city-1", name: "Moscow", lines: [{ id: "line-1", name: "Red line", stations: [{ id: "station-1", name: "Central" }] }] }] });
    const metro = await resolveSearchDictionary({ dictionary: "metro", text: "Moscow" }, { now: 30_000_000 });
    expect(metro).toMatchObject({ status: "unknown" });
    vi.mocked(hhGet).mockResolvedValueOnce({ areas: [{ id: "city-1", name: "Moscow", lines: [{ id: "line-1", name: "Red line", stations: [{ id: "station-1", name: "Central" }] }] }] });
    const metroCandidates = await resolveSearchDictionary({ dictionary: "metro", text: "line" }, { now: 40_000_000 });
    expect(metroCandidates).toMatchObject({ status: "candidates", candidates: [{ id: "line-1", name: "Red line" }] });
    expect(JSON.stringify(metroCandidates)).not.toContain("stations");
    expect(JSON.stringify(metroCandidates)).not.toContain("city-1");
  });

  it("keeps seeds after unavailable catalogues and resolves inline education without HTTP", async () => {
    const { hhGet } = await import("../../client.js");
    const get = vi.mocked(hhGet);
    get.mockClear();
    const education = await resolveSearchDictionary({ dictionary: "education", text: "higher" }, { now: 50_000_000 });
    expect(education).toMatchObject({ status: "exact", id: "higher", catalogue_available: true });
    expect(get).not.toHaveBeenCalled();
    expect(() => normalizeVacancySearch({ education: "higher" })).not.toThrow();

    get.mockResolvedValueOnce({ vacancy_search_employment_form: "unexpected malformed value" });
    const unavailable = await resolveSearchDictionary({ dictionary: "vacancy_search_employment_form", text: "FULL" }, { now: 60_000_000 });
    expect(unavailable).toMatchObject({ status: "unknown", catalogue_available: false });
    expect(() => normalizeVacancySearch({ employment_form: "FULL" })).not.toThrow();
    expect(() => normalizeVacancySearch({ employment_form: "UNSEEN_FORM" })).toThrow(/unknown vacancy_search_employment_form/);
    get.mockResolvedValueOnce({});
    const missing = await resolveSearchDictionary({ dictionary: "vacancy_search_employment_form", text: "PART" }, { now: 120_000_000 });
    expect(missing).toMatchObject({ status: "unknown", catalogue_available: false });
    expect(() => normalizeVacancySearch({ employment_form: "FULL" })).not.toThrow();
  });
});

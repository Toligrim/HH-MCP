import { describe, expect, it } from "vitest";
import {
  buildVacancyQuery,
  explainVacancyQuery,
  normalizeVacancySearch,
  searchVacanciesSchema,
} from "../query.js";

describe("native vacancy query", () => {
  it("preserves scalar compatibility, raw, and HH query text", () => {
    const query = buildVacancyQuery({ text: 'C++ "Go разработчик"', area: 1, raw: true });
    expect(query.get("text")).toBe('C++ "Go разработчик"');
    expect(query.get("area")).toBe("1");
    expect(query.get("page")).toBe("0");
    expect(query.get("per_page")).toBe("20");
    expect(query.get("raw")).toBeNull();
  });

  it("accepts standard ISO timezone forms and canonicalizes without changing the instant", () => {
    const normalized = normalizeVacancySearch({
      date_from: "2026-10-26T00:00:00Z",
      date_to: "2026-10-26T03:00:00+03:00",
    });
    expect(normalized.date_from).toBe("2026-10-26T00:00:00+0000");
    expect(normalized.date_to).toBe("2026-10-26T03:00:00+0300");
    const query = buildVacancyQuery({ date_from: "2026-10-26T00:00:00Z" });
    expect(query.get("date_from")).toBe("2026-10-26T00:00:00+0000");
    expect(normalizeVacancySearch({ date_from: "2026-10-26T03:00:00+0300" }).date_from).toBe("2026-10-26T03:00:00+0300");
    expect(normalizeVacancySearch({ date_from: new Date("2026-10-26T00:00:00.000Z").toISOString() }).date_from).toBe("2026-10-26T00:00:00.000+0000");
  });

  it("requires numeric HH ids and rejects empty text while preserving valid query text", () => {
    for (const input of [{ area: "garbage_name" }, { professional_role: "role_x" }, { employer_id: "company_x" }, { area: Number.MAX_SAFE_INTEGER + 1 }, { text: "  \t " }, { excluded_text: " \n " }]) {
      expect(() => normalizeVacancySearch(input), JSON.stringify(input)).toThrow();
    }
    expect(buildVacancyQuery({ area: "123", professional_role: 96, employer_id: "456", text: "  Go AND Rust  " }).get("text")).toBe("  Go AND Rust  ");
    expect(buildVacancyQuery({ metro: "1.2.3", industry: "2.4.6" }).get("metro")).toBe("1.2.3");
  });

  it("normalizes with_salary aliases without losing labels and rejects contradictory salary flags", () => {
    const combined = normalizeVacancySearch({ with_salary: true, label: ["night_shifts", "with_salary"] });
    expect(combined.label).toEqual(["night_shifts", "with_salary"]);
    const added = normalizeVacancySearch({ with_salary: true, label: "night_shifts" });
    expect(added.label).toEqual(["night_shifts", "with_salary"]);
    expect(normalizeVacancySearch({ with_salary: false })).toMatchObject({ only_with_salary: false });
    for (const input of [
      { with_salary: false, label: "with_salary" },
      { with_salary: false, only_with_salary: true },
      { only_with_salary: false, label: "with_salary" },
      { with_salary: true, only_with_salary: false },
    ]) expect(() => normalizeVacancySearch(input), JSON.stringify(input)).toThrow(/salary/i);
    const explanation = explainVacancyQuery({ with_salary: false });
    expect(explanation.query_string).toContain("only_with_salary=false");
    expect(explanation.warnings.join(" ")).toMatch(/not a request to exclude vacancies without salary/i);
  });

  it("serializes documented multi-value filters as repeated query keys", () => {
    const query = buildVacancyQuery({
      area: [1, "2"], professional_role: [96, "97"], search_field: ["name", "description"],
      experience: ["noExperience", "between1And3"], label: ["with_salary", "night_shifts"],
      work_format: ["REMOTE", "HYBRID"],
    });
    expect(query.getAll("area")).toEqual(["1", "2"]);
    expect(query.getAll("professional_role")).toEqual(["96", "97"]);
    expect(query.getAll("search_field")).toEqual(["name", "description"]);
    expect(query.getAll("experience")).toEqual(["noExperience", "between1And3"]);
    expect(query.getAll("label")).toEqual(["with_salary", "night_shifts"]);
    expect(query.getAll("work_format")).toEqual(["REMOTE", "HYBRID"]);
  });

  it("emits modern and boolean fields including explicit false", () => {
    const query = buildVacancyQuery({
      working_hours: ["HOURS_4", "HOURS_8"], work_schedule_by_days: "TWO_ON_TWO_OFF",
      clusters: false, describe_arguments: false, only_with_salary: false, accept_temporary: false,
    });
    expect(query.getAll("working_hours")).toEqual(["HOURS_4", "HOURS_8"]);
    expect(query.get("work_schedule_by_days")).toBe("TWO_ON_TWO_OFF");
    expect(query.get("clusters")).toBe("false");
    expect(query.get("describe_arguments")).toBe("false");
    expect(query.get("only_with_salary")).toBe("false");
    expect(query.get("accept_temporary")).toBe("false");
  });

  it("accounts for all 44 official query fields and excludes the required header", () => {
    const keys = Object.keys(searchVacanciesSchema.shape);
    const official = ["page", "per_page", "text", "search_field", "experience", "employment", "schedule", "area", "metro", "professional_role", "industry", "employer_id", "currency", "salary", "salary_frequency", "salary_mode", "label", "only_with_salary", "period", "date_from", "date_to", "top_lat", "bottom_lat", "left_lng", "right_lng", "order_by", "sort_point_lat", "sort_point_lng", "clusters", "describe_arguments", "no_magic", "premium", "responses_count_enabled", "part_time", "accept_temporary", "employment_form", "work_schedule_by_days", "working_hours", "work_format", "excluded_text", "education", "driver_license_types", "host", "locale"];
    expect(keys.filter((key) => key !== "raw" && key !== "with_salary").sort()).toEqual(official.sort());
  });

  it("rejects unknown keys and invalid cross-field/geographic/date inputs", () => {
    for (const input of [
      { mystery: "x" }, { area: [] }, { area: ["1", ""] }, { area: "0" }, { page: -1 }, { per_page: 101 },
      { salary: Number.POSITIVE_INFINITY }, { currency: "USD" }, { date_from: "2026-02-30" }, { date_from: "2026-02-30T00:00:00Z" },
      { date_from: "2026-01-01T10:00:00" }, { date_from: "2026-01-01T10:00:00+2500" }, { period: 366 },
      { top_lat: 55 }, { top_lat: 50, bottom_lat: 55, left_lng: 30, right_lng: 40 },
      { order_by: "distance", sort_point_lat: 55 }, { order_by: "distance", sort_point_lat: 91, sort_point_lng: 30 },
    ]) expect(() => normalizeVacancySearch(input), JSON.stringify(input)).toThrow();
  });

  it("explains aliases, deprecations and explicit unsupported fields", () => {
    const explanation = explainVacancyQuery({ with_salary: true, premium: true, district: "1" });
    expect(explanation.normalized.label).toBe("with_salary");
    expect(explanation.warnings.join(" ")).toMatch(/premium|deprecated/i);
    expect(explanation.unsupported_filters).toContain("district");
    expect(explanation.query_string).toContain("label=with_salary");
  });
});

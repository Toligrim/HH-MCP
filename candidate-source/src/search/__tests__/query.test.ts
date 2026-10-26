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
      { salary: Number.POSITIVE_INFINITY }, { currency: "USD" }, { date_from: "2026-02-30" },
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

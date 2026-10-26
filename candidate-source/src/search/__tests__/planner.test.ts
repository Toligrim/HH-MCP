import { describe, expect, it } from "vitest";
import { planSearch, searchSpecSchema } from "../planner.js";

describe("search planning", () => {
  it("rejects forbidden pagination/raw fields and canonicalizes frozen wire values", () => {
    expect(() => searchSpecSchema.parse({ native: { text: "x", page: 0 } })).toThrow();
    expect(() => searchSpecSchema.parse({ native: { raw: true } })).toThrow();
    const first = planSearch({ native: { text: "dev", area: [2, 1, 2] }, limits: { max_requests: 50, max_items: 500, max_duration_sec: 300, max_bytes: 4_000_000, max_detail_fetches: 20 } }, Date.UTC(2026, 0, 2));
    const again = planSearch({ native: { text: "dev", area: ["1", "2"] }, limits: first.limits }, first.frozen_at);
    expect(first.signature).toBe(again.signature);
    const scalarArea = planSearch({ native: { area: "1" }, limits: first.limits }, first.frozen_at);
    const listArea = planSearch({ native: { area: [1] }, limits: first.limits }, first.frozen_at);
    expect(scalarArea.signature).toBe(listArea.signature);
    expect(first.warnings.join(" ")).toMatch(/30 days/);
    expect(first.effective_detail_fetches).toBe(0);
  });

  it("treats supplied branches as execution branches while inheriting template constraints", () => {
    const plan = planSearch({ native: { area: 1, salary: 100, currency: "RUR" }, branches: [{ name: "remote", native: { work_format: "REMOTE", area: 2 } }], limits: { max_requests: 10, max_items: 10, max_duration_sec: 30, max_bytes: 100_000, max_detail_fetches: 0 } }, 1000);
    expect(plan.branches).toHaveLength(1);
    expect(plan.branches[0]!.native.area).toEqual(["2"]);
    expect(plan.branches[0]!.native.salary).toBe(100);
    expect(plan.branches[0]!.overridden_fields).toContain("area");
  });

  it("freezes date-only bounds to UTC day edges and records fast sampling", () => {
    const plan = planSearch({ mode: "fast", native: { date_from: "2026-01-01", date_to: "2026-01-02" }, limits: { max_requests: 10, max_items: 20, max_duration_sec: 30, max_bytes: 100_000, max_detail_fetches: 0 } }, Date.UTC(2026, 0, 3));
    expect(plan.frozen_date_bounds.date_from).toBe("2026-01-01T00:00:00+0000");
    expect(plan.frozen_date_bounds.date_to).toBe("2026-01-03T00:00:00+0000");
    expect(plan.warnings.join(" ")).toMatch(/samples at most the first 20/);
  });

  it("preserves explicit ordering while defaulting only omitted order_by to publication_time", () => {
    const limits = { max_requests: 10, max_items: 20, max_duration_sec: 30, max_bytes: 100_000, max_detail_fetches: 0 };
    const explicit = planSearch({ native: { order_by: "salary_desc" }, limits }, 1000);
    const implicit = planSearch({ native: {}, limits }, 1000);
    expect(explicit.branches[0]!.native.order_by).toBe("salary_desc");
    expect(implicit.branches[0]!.native.order_by).toBe("publication_time");
  });

  it("freezes branch-specific period into its own absolute bounds", () => {
    const plan = planSearch({ native: {}, branches: [{ name: "recent", native: { period: 7 } }], limits: { max_requests: 10, max_items: 20, max_duration_sec: 30, max_bytes: 100_000, max_detail_fetches: 0 } }, Date.UTC(2026, 0, 8));
    expect(Date.parse(plan.branches[0]!.native.date_to!) - Date.parse(plan.branches[0]!.native.date_from!)).toBeLessThanOrEqual(7 * 86_400_000 + 300_000);
  });

  it("validates branch partial overrides against inherited cross-field constraints", () => {
    const limits = { max_requests: 10, max_items: 20, max_duration_sec: 30, max_bytes: 100_000, max_detail_fetches: 0 };
    const salary = planSearch({ native: { salary: 100 }, branches: [{ name: "rubles", native: { currency: "RUR" } }], limits }, Date.UTC(2026, 0, 8));
    expect(salary.branches[0]!.native.salary).toBe(100);
    expect(salary.branches[0]!.native.currency).toBe("RUR");
    const distance = planSearch({ native: { order_by: "distance", sort_point_lat: 55, sort_point_lng: 37 }, branches: [{ name: "role", native: { text: "engineer" } }], limits }, Date.UTC(2026, 0, 8));
    expect(distance.branches[0]!.native.order_by).toBe("distance");
    expect(distance.branches[0]!.native.sort_point_lat).toBe(55);
  });
});

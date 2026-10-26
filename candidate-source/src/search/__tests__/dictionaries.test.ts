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
});

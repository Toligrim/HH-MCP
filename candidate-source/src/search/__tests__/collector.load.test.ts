import { describe, expect, it } from "vitest";
import { collectSearch } from "../collector.js";
import { planSearch } from "../planner.js";

const start = Date.UTC(2025, 0, 1);
const end = Date.UTC(2026, 0, 1);
const duration = end - start;

describe("collector synthetic scale correctness", () => {
  it.each([5_000, 20_000])("keeps %i distinct lightweight hits complete across split leaves", async (count) => {
    const rows = Array.from({ length: count }, (_, i) => {
      const n = count - 1 - i;
      return {
        id: String(700_000_000 + n),
        name: `Synthetic vacancy ${n}`,
        published_at: new Date(start + Math.floor((n + 0.5) * duration / count)).toISOString(),
      };
    });
    const timestamps = rows.map((item) => Date.parse(item.published_at));
    const plan = planSearch({
      mode: "comprehensive",
      native: { date_from: "2025-01-01", date_to: "2025-12-31" },
      limits: { max_requests: 1000, max_items: 25_000, max_duration_sec: 1800, max_bytes: 64 * 1024 * 1024, max_detail_fetches: 0 },
    }, Date.UTC(2026, 0, 2));
    const get = async (path: string): Promise<unknown> => {
      const url = new URL(path, "https://api.hh.ru");
      const from = Date.parse(url.searchParams.get("date_from") ?? "");
      const to = Date.parse(url.searchParams.get("date_to") ?? "");
      const pageNo = Number(url.searchParams.get("page") ?? 0);
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timestamps[mid]! > to) lo = mid + 1;
        else hi = mid;
      }
      const firstIndex = lo;
      lo = firstIndex;
      hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timestamps[mid]! >= from) lo = mid + 1;
        else hi = mid;
      }
      const selected = rows.slice(firstIndex, lo);
      return { found: selected.length, pages: Math.min(20, Math.ceil(selected.length / 100)), items: selected.slice(pageNo * 100, (pageNo + 1) * 100) };
    };

    const result = await collectSearch(plan, { get: get as never });

    expect(result.status).toBe("COMPLETE");
    expect(result.manifest.found).toBe(count);
    expect(result.manifest.known_items).toBe(count);
    expect(result.items).toHaveLength(count);
    expect(result.manifest.gaps).toEqual([]);
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { evaluatePostFilters, postFilterSchema } from "../filters.js";

describe("post filters", () => {
  it("requires strict discriminated rules and bounds their count", () => {
    expect(postFilterSchema.safeParse({ rule: "night_shifts", value: false }).success).toBe(true);
    expect(postFilterSchema.safeParse({ rule: "night_shifts", value: "no" }).success).toBe(false);
    expect(postFilterSchema.safeParse({ rule: "no_mandatory_phone_calls", value: true }).success).toBe(false);
  });

  it("keeps missing night-shift evidence unknown and matches explicit false", () => {
    const rule = { rule: "night_shifts", value: false } as const;
    expect(evaluatePostFilters({}, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ schedule: { night_shifts: false } }, [rule], "strict").rules[0]?.state).toBe("match");
  });

  it("treats silence as unknown, chat-only as a match, and mandatory calls as no_match", () => {
    const rule = { rule: "no_mandatory_phone_calls" } as const;
    expect(evaluatePostFilters({ description: "Тихий офис и дружная команда" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Общение только в чате, телефонных звонков нет" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Общение только в чате" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Обязательные входящие звонки клиентам" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Без холодных звонков" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Без холодных звонков, обязательные входящие звонки" }, [rule], "strict").rules[0]?.state).toBe("no_match");
  });

  it("returns unknown for contradictory work format and handles optional/required/negated technology conservatively", () => {
    expect(evaluatePostFilters({ description: "Удалённо или в гибридном формате" }, [{ rule: "work_format", value: "remote" }], "strict").rules[0]?.state).toBe("unknown");
    const rule = { rule: "required_technology", value: "Python" } as const;
    expect(evaluatePostFilters({ key_skills: [{ name: "Python" }] }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Обязательное знание Pythonic стиль разработки" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Python будет преимуществом" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательное знание Python" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Знание Python не требуется" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательное знание Python, но Python не требуется" }, [rule], "strict").rules[0]?.state).toBe("unknown");
  });

  it("applies strict, inclusive and review decision policies", () => {
    const rules = [{ rule: "night_shifts", value: false }] as const;
    expect(evaluatePostFilters({}, [...rules], "strict").decision).toBe("exclude");
    expect(evaluatePostFilters({}, [...rules], "inclusive").decision).toBe("keep");
    expect(evaluatePostFilters({}, [...rules], "review").decision).toBe("review");
    expect(() => evaluatePostFilters({}, Array.from({ length: 21 }, () => rules[0]!), "review")).toThrow(/20/);
  });
});

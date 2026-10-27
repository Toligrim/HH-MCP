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
    expect(evaluatePostFilters({ schedule: { night_shifts: false } }, [rule], "strict").rules[0]?.source).toBe("schedule.night_shifts");
    expect(evaluatePostFilters({ night_shifts: false }, [rule], "strict").rules[0]?.source).toBe("night_shifts");
  });

  it("treats silence as unknown, chat-only as a match, and mandatory calls as no_match", () => {
    const rule = { rule: "no_mandatory_phone_calls" } as const;
    expect(evaluatePostFilters({ description: "Тихий офис и дружная команда" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Общение только в чате, телефонных звонков нет" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Общение только в чате" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Обязательные входящие звонки клиентам" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Без холодных звонков" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Без холодных звонков, обязательные входящие звонки" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Работа по телефону; обработка входящих заявок" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Звонки не обязательны" }, [rule], "strict").rules[0]?.state).not.toBe("no_match");
    expect(evaluatePostFilters({ description: "Работа без звонков" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Общение только в чате. Иногда нужно звонить клиентам" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательное знание Python; телефон по согласованию" }, [rule], "strict").rules[0]?.state).toBe("unknown");
  });

  it("does not treat compact Russian call negations as mandatory", () => {
    const rule = { rule: "no_mandatory_phone_calls" } as const;
    expect(evaluatePostFilters({ description: "Звонки необязательны" }, [rule], "strict").rules[0]?.state).not.toBe("no_match");
    expect(evaluatePostFilters({ description: "Необязательные звонки" }, [rule], "strict").rules[0]?.state).not.toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательные звонки" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Работа без звонков" }, [rule], "strict").rules[0]?.state).toBe("match");
  });

  it("returns unknown for contradictory work format and handles optional/required/negated technology conservatively", () => {
    expect(evaluatePostFilters({ description: "Удалённо или в гибридном формате" }, [{ rule: "work_format", value: "remote" }], "strict").rules[0]?.state).toBe("unknown");
    const remote = { rule: "work_format", value: "REMOTE" } as const;
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE" }], description: "remote work is not available" }, [remote], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE" }], description: "Mandatory office attendance" }, [remote], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "No remote work." }, [remote], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE" }], description: "No remote work." }, [remote], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Remote work is unavailable." }, [remote], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "Our office is in Moscow" }, [remote], "strict").rules[0]?.state).toBe("unknown");
    const days = { rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" } as const;
    expect(evaluatePostFilters({ description: "График работы обсудим" }, [days], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Смены обсуждаются индивидуально" }, [days], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "График работы 5/2" }, [days], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "График не 2/2, а 5/2." }, [days], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "Schedule is not 2/2." }, [days], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "We do not work 2/2." }, [days], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "2/2 is not offered." }, [days], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ work_schedule_by_days: ["TWO_ON_TWO_OFF"], description: "Schedule is not 2/2." }, [days], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "We work 2/2." }, [days], "strict").rules[0]?.state).toBe("match");
    const rule = { rule: "required_technology", value: "Python" } as const;
    expect(evaluatePostFilters({ key_skills: [{ name: "Python" }] }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Обязательное знание Pythonic стиль разработки" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Python будет преимуществом" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательное знание Python" }, [rule], "strict").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Знание Python не требуется" }, [rule], "strict").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ description: "Обязательное знание Python, но Python не требуется" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Python is not mandatory" }, [rule], "strict").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "Python is not mandatory and Linux is required" }, [rule], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "Python is discussed while excellent communication is required" }, [rule], "strict").rules[0]?.state).not.toBe("match");
    expect(evaluatePostFilters({ description: "Требуется Windows или Linux" }, [{ rule: "required_technology", value: "Linux" }], "strict").rules[0]?.state).not.toBe("match");
  });

  it("applies strict, inclusive and review decision policies", () => {
    const rules = [{ rule: "night_shifts", value: false }] as const;
    expect(evaluatePostFilters({}, [...rules], "strict").decision).toBe("exclude");
    expect(evaluatePostFilters({}, [...rules], "inclusive").decision).toBe("keep");
    expect(evaluatePostFilters({}, [...rules], "review").decision).toBe("review");
    expect(() => evaluatePostFilters({}, Array.from({ length: 21 }, () => rules[0]!), "review")).toThrow(/20/);
  });
});

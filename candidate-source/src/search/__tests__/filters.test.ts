import { describe, expect, it } from "vitest";
import { evaluatePostFilters, postFilterSchema } from "../filters.js";

describe("post filters", () => {
  const scheduleIds = [
    "SIX_ON_ONE_OFF", "FIVE_ON_TWO_OFF", "FOUR_ON_FOUR_OFF", "FOUR_ON_THREE_OFF",
    "FOUR_ON_TWO_OFF", "THREE_ON_THREE_OFF", "THREE_ON_TWO_OFF", "TWO_ON_TWO_OFF",
    "TWO_ON_ONE_OFF", "ONE_ON_THREE_OFF", "ONE_ON_TWO_OFF", "WEEKEND", "FLEXIBLE", "OTHER",
  ];
  const formatIds = ["ON_SITE", "REMOTE", "HYBRID", "FIELD_WORK"];
  const scheduleLabels: Record<string, string> = {
    SIX_ON_ONE_OFF: "6/1", FIVE_ON_TWO_OFF: "5/2", FOUR_ON_FOUR_OFF: "4/4", FOUR_ON_THREE_OFF: "4/3",
    FOUR_ON_TWO_OFF: "4/2", THREE_ON_THREE_OFF: "3/3", THREE_ON_TWO_OFF: "3/2", TWO_ON_TWO_OFF: "2/2",
    TWO_ON_ONE_OFF: "2/1", ONE_ON_THREE_OFF: "1/3", ONE_ON_TWO_OFF: "1/2", WEEKEND: "По выходным",
    FLEXIBLE: "Свободный", OTHER: "Другое",
  };
  const formatLabels: Record<string, string> = { ON_SITE: "На месте работодателя", REMOTE: "Удалённо", HYBRID: "Гибрид", FIELD_WORK: "Разъездной" };

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

  it("matches every official structured schedule ID as a string or {id,name}", () => {
    for (const id of scheduleIds) {
      const rule = { rule: "work_schedule_by_days", value: id } as const;
      expect(evaluatePostFilters({ work_schedule_by_days: id }, [rule], "review").rules[0]?.state, id).toBe("match");
      expect(evaluatePostFilters({ work_schedule_by_days: [{ id, name: scheduleLabels[id] }] }, [rule], "review").rules[0]?.state, id).toBe("match");
      for (const otherId of scheduleIds.filter((candidate) => candidate !== id)) {
        expect(evaluatePostFilters({ work_schedule_by_days: [{ id, name: scheduleLabels[otherId] }] }, [rule], "review").rules[0]?.state, `${id}/${otherId}`).toBe("unknown");
      }
    }
  });

  it("matches every official structured work format ID without merging on-site and field work", () => {
    for (const id of formatIds) {
      const rule = { rule: "work_format", value: id } as const;
      expect(evaluatePostFilters({ work_format: id }, [rule], "review").rules[0]?.state, id).toBe("match");
      expect(evaluatePostFilters({ work_format: [{ id, name: formatLabels[id] }] }, [rule], "review").rules[0]?.state, id).toBe("match");
      for (const otherId of formatIds.filter((candidate) => candidate !== id)) {
        expect(evaluatePostFilters({ work_format: [{ id, name: formatLabels[otherId] }] }, [rule], "review").rules[0]?.state, `${id}/${otherId}`).toBe("unknown");
      }
    }
    expect(evaluatePostFilters({ work_format: [{ id: "FIELD_WORK" }] }, [{ rule: "work_format", value: "ON_SITE" }], "review").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ work_format: [{ id: "ON_SITE" }] }, [{ rule: "work_format", value: "FIELD_WORK" }], "review").rules[0]?.state).toBe("no_match");
  });

  it("keeps unknown requested or actual structured IDs unknown and accepts known alternatives", () => {
    expect(evaluatePostFilters({ work_schedule_by_days: "THREE_ON_THREE_OFF", description: "Работа 3/3" }, [{ rule: "work_schedule_by_days", value: "FUTURE_SCHEDULE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "FUTURE_SCHEDULE", name: "2/2" }], description: "Работа 2/2" }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [{ id: "FUTURE_FORMAT", name: "Remote" }], description: "Remote work" }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: "REMOTE" }, [{ rule: "work_format", value: "FUTURE_REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: ["FIVE_ON_TWO_OFF", "TWO_ON_TWO_OFF"] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ work_schedule_by_days: ["TWO_ON_TWO_OFF", "FUTURE_SCHEDULE"] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: ["REMOTE", "HYBRID"] }, [{ rule: "work_format", value: "HYBRID" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ work_format: ["REMOTE", "FUTURE_FORMAT"] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [{ name: "Remote" }] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
  });

  it("keeps structured ID/name and description contradictions unknown while allowing missing-field heuristics", () => {
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "TWO_ON_TWO_OFF", name: "5/2" }] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "TWO_ON_TWO_OFF", name: "Индивидуально" }] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ work_format: [{ id: "ON_SITE", name: "Удалённо" }] }, [{ rule: "work_format", value: "ON_SITE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE", name: "На месте работодателя" }] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE", name: "На\u00a0месте работодателя" }] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: [{ id: "REMOTE", name: "Индивидуально" }] }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ work_schedule_by_days: "TWO_ON_TWO_OFF", description: "График 5/2" }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_format: "REMOTE", description: "Работа в офисе" }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ description: "График работы 2/2" }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Remote work" }, [{ rule: "work_format", value: "REMOTE" }], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Разъездной характер работы" }, [{ rule: "work_format", value: "FIELD_WORK" }], "review").rules[0]?.state).toBe("match");
  });

  it("keeps denied numeric schedule labels unknown in structured and description-only evidence", () => {
    const numericSchedules = Object.entries(scheduleLabels).filter(([id]) => id !== "WEEKEND" && id !== "FLEXIBLE" && id !== "OTHER");
    for (const [index, [id, label]] of numericSchedules.entries()) {
      const rule = { rule: "work_schedule_by_days", value: id } as const;
      const denial = index % 2 === 0 ? `График ${label} не предлагается.` : `Schedule ${label} is not available.`;
      expect(evaluatePostFilters({ work_schedule_by_days: [{ id }], description: denial }, [rule], "review").rules[0]?.state, `structured ${id}`).toBe("unknown");
      expect(evaluatePostFilters({ description: denial }, [rule], "review").rules[0]?.state, `description ${id}`).toBe("unknown");
      expect(evaluatePostFilters({ work_schedule_by_days: [{ id }], description: `График ${label}.` }, [rule], "review").rules[0]?.state, `affirmative ${id}`).toBe("match");
    }
    expect(evaluatePostFilters({ description: "Schedule 2/2 is not offered." }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: ["FIVE_ON_TWO_OFF", "TWO_ON_TWO_OFF"] }, [{ rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" }], "review").rules[0]?.state).toBe("match");
  });

  it("requires digit boundaries around numeric schedule descriptions", () => {
    const numericSchedules = Object.entries(scheduleLabels).filter(([id]) => id !== "WEEKEND" && id !== "FLEXIBLE" && id !== "OTHER");
    for (const [id, label] of numericSchedules) {
      const rule = { rule: "work_schedule_by_days", value: id } as const;
      const [on, off] = label.split("/");
      expect(evaluatePostFilters({ description: `Schedule ${label}.` }, [rule], "review").rules[0]?.state, `affirmative ${id}`).toBe("match");
      expect(evaluatePostFilters({ description: `Schedule 1${on}/${off}.` }, [rule], "review").rules[0]?.state, `long numerator ${id}`).toBe("unknown");
      expect(evaluatePostFilters({ description: `Schedule ${on}/${off}0.` }, [rule], "review").rules[0]?.state, `long denominator ${id}`).toBe("unknown");
    }
    const structuredRule = { rule: "work_schedule_by_days", value: "SIX_ON_ONE_OFF" } as const;
    const result = evaluatePostFilters({ work_schedule_by_days: [{ id: "SIX_ON_ONE_OFF" }], description: "Schedule 16/1." }, [structuredRule], "review").rules[0];
    expect(result?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "SIX_ON_ONE_OFF" }], description: "График 6/10." }, [structuredRule], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "SIX_ON_ONE_OFF" }], description: "Schedule 6/1." }, [structuredRule], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Schedule 16/1." }, [structuredRule], "review").rules[0]?.state).toBe("unknown");
    expect(evaluatePostFilters({ work_schedule_by_days: [{ id: "SIX_ON_ONE_OFF" }], description: "The report lists a ratio of 16/1." }, [structuredRule], "review").rules[0]?.state).toBe("match");
  });

  it("keeps denied work formats unknown in structured and description-only evidence", () => {
    const denials: Record<string, string[]> = {
      REMOTE: ["Удалённая работа не предлагается.", "Remote work is not available."],
      HYBRID: ["Гибридный формат не предлагается.", "No hybrid work is offered."],
      FIELD_WORK: ["Разъездной характер работы не предусмотрен.", "Field work is not available."],
      ON_SITE: ["Работа на месте работодателя не предлагается.", "Onsite work is not available."],
    };
    for (const id of formatIds) {
      for (const denial of denials[id]!) {
        const rule = { rule: "work_format", value: id } as const;
        expect(evaluatePostFilters({ work_format: [{ id }], description: denial }, [rule], "review").rules[0]?.state, `structured ${id}: ${denial}`).toBe("unknown");
        expect(evaluatePostFilters({ description: denial }, [rule], "review").rules[0]?.state, `description ${id}: ${denial}`).toBe("unknown");
      }
      expect(evaluatePostFilters({ work_format: [{ id }], description: formatLabels[id] }, [{ rule: "work_format", value: id }], "review").rules[0]?.state, `affirmative ${id}`).toBe("match");
    }
  });

  it("does not mistake a negated format-related qualification for a format denial", () => {
    const rule = { rule: "work_format", value: "HYBRID" } as const;
    const description = "No hybrid experience required; hybrid work is available.";
    expect(evaluatePostFilters({ description }, [rule], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ work_format: [{ id: "HYBRID" }], description }, [rule], "review").rules[0]?.state).toBe("match");
    expect(evaluatePostFilters({ description: "Гибридный опыт не требуется; гибридный формат доступен." }, [rule], "review").rules[0]?.state).toBe("match");
  });

  it("detects contradictions for nonnumeric supported schedules", () => {
    const cases = [
      { id: "WEEKEND", denied: "Работа по выходным не предлагается.", affirmative: "Работа по выходным." },
      { id: "FLEXIBLE", denied: "Flexible schedule is not available.", affirmative: "Flexible schedule." },
      { id: "OTHER", denied: "Other schedule is not available.", affirmative: "Other schedule." },
    ];
    for (const { id, denied, affirmative } of cases) {
      const rule = { rule: "work_schedule_by_days", value: id } as const;
      expect(evaluatePostFilters({ work_schedule_by_days: [{ id }], description: denied }, [rule], "review").rules[0]?.state, `structured ${id}`).toBe("unknown");
      expect(evaluatePostFilters({ description: denied }, [rule], "review").rules[0]?.state, `description ${id}`).toBe("unknown");
      expect(evaluatePostFilters({ work_schedule_by_days: [{ id }], description: affirmative }, [rule], "review").rules[0]?.state, `structured affirmative ${id}`).toBe("match");
      expect(evaluatePostFilters({ description: affirmative }, [rule], "review").rules[0]?.state, `description affirmative ${id}`).toBe("match");
    }
  });

  it("keeps denied non-target schedules and formats unknown in every filter mode", () => {
    const cases: Array<{ vacancy: Record<string, unknown>; rule: { rule: "work_schedule_by_days" | "work_format"; value: string } }> = [
      { vacancy: { work_schedule_by_days: "THREE_ON_THREE_OFF", description: "График не 3/3." }, rule: { rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" } },
      { vacancy: { work_schedule_by_days: "FIVE_ON_TWO_OFF", description: "Schedule 5/2 is not offered." }, rule: { rule: "work_schedule_by_days", value: "FOUR_ON_FOUR_OFF" } },
      { vacancy: { work_schedule_by_days: "FLEXIBLE", description: "Гибкий график не доступен." }, rule: { rule: "work_schedule_by_days", value: "OTHER" } },
      { vacancy: { work_schedule_by_days: "WEEKEND", description: "Weekend schedule is unavailable." }, rule: { rule: "work_schedule_by_days", value: "FLEXIBLE" } },
      { vacancy: { description: "График не 3/3." }, rule: { rule: "work_schedule_by_days", value: "TWO_ON_TWO_OFF" } },
      { vacancy: { description: "Schedule 5/2 is not offered." }, rule: { rule: "work_schedule_by_days", value: "FOUR_ON_FOUR_OFF" } },
      { vacancy: { description: "Гибкий график не доступен." }, rule: { rule: "work_schedule_by_days", value: "OTHER" } },
      { vacancy: { description: "Weekend schedule is unavailable." }, rule: { rule: "work_schedule_by_days", value: "FLEXIBLE" } },
    ];
    const denials: Record<string, [string, string]> = {
      REMOTE: ["Удалённая работа не предлагается.", "Remote work is not available."],
      HYBRID: ["Гибридный формат не предлагается.", "Hybrid work is not available."],
      FIELD_WORK: ["Разъездной формат работы не предлагается.", "Field work is not available."],
      ON_SITE: ["Работа на месте работодателя не предлагается.", "Onsite work is not available."],
    };
    for (const [index, id] of formatIds.entries()) {
      const wanted = formatIds[(index + 1) % formatIds.length]!;
      for (const description of denials[id]!) {
        cases.push({ vacancy: { work_format: id, description }, rule: { rule: "work_format", value: wanted } });
        cases.push({ vacancy: { description }, rule: { rule: "work_format", value: wanted } });
      }
    }

    for (const { vacancy, rule } of cases) {
      const strict = evaluatePostFilters(vacancy, [rule], "strict");
      const inclusive = evaluatePostFilters(vacancy, [rule], "inclusive");
      const review = evaluatePostFilters(vacancy, [rule], "review");
      expect(strict.rules[0]?.state, JSON.stringify({ vacancy, rule })).toBe("unknown");
      expect(inclusive.rules[0]?.state, JSON.stringify({ vacancy, rule })).toBe("unknown");
      expect(review.rules[0]?.state, JSON.stringify({ vacancy, rule })).toBe("unknown");
      expect(strict.decision).toBe("exclude");
      expect(inclusive.decision).toBe("keep");
      expect(review.decision).toBe("review");
    }

    expect(evaluatePostFilters({ work_schedule_by_days: "FIVE_ON_TWO_OFF", description: "Schedule 5/2." }, [{ rule: "work_schedule_by_days", value: "FOUR_ON_FOUR_OFF" }], "review").rules[0]?.state).toBe("no_match");
    expect(evaluatePostFilters({ work_format: "HYBRID", description: "Hybrid work." }, [{ rule: "work_format", value: "ON_SITE" }], "review").rules[0]?.state).toBe("no_match");
  });

  it("applies strict, inclusive and review decision policies", () => {
    const rules = [{ rule: "night_shifts", value: false }] as const;
    expect(evaluatePostFilters({}, [...rules], "strict").decision).toBe("exclude");
    expect(evaluatePostFilters({}, [...rules], "inclusive").decision).toBe("keep");
    expect(evaluatePostFilters({}, [...rules], "review").decision).toBe("review");
    expect(() => evaluatePostFilters({}, Array.from({ length: 21 }, () => rules[0]!), "review")).toThrow(/20/);
  });
});

import { describe, it, expect } from "vitest";
import {
  formatApplicationCollections,
  formatApplication,
  formatNegotiationListItem,
  formatApplicationList,
  formatApplicationMessages,
  formatPreferredOrder,
  formatNegotiationsStatistics,
  formatManager,
  formatManagerListItem,
  formatPhone,
  fmtAge,
  fmtMonths,
  fmtDateTime,
} from "../format.js";
import type {
  NegotiationsCollectionsResponse,
  NegotiationItem,
  NegotiationMessagesResponse,
  SearchResult,
} from "../types.js";

const funnelFixture: NegotiationsCollectionsResponse = {
  collections: [
    {
      id: "response",
      name: "Все неразобранные",
      description: "Откликов не найдено.",
      hidden: false,
      counters: { total: 90, with_updates: 4 },
      sub_collections: [
        {
          id: "response_107261704",
          name: "Остальные",
          root_collection: "response",
          counters: { total: 1, with_updates: 0 },
        },
        {
          id: "response_107261719",
          name: "Подходят",
          root_collection: "response",
          counters: { total: 9, with_updates: 1 },
        },
        {
          id: "response_107261721",
          name: "Не сейчас",
          root_collection: "response",
          counters: { total: 74, with_updates: 4 },
        },
        {
          id: "response_110661713",
          name: "В обработке",
          root_collection: "response",
          counters: { total: 0, with_updates: 0 },
        },
      ],
    },
    {
      id: "consider",
      name: "Подумать",
      description: "advice text",
      counters: { total: 1, with_updates: 0 },
      sub_collections: [
        {
          id: "consider_107261705",
          name: "Остальные",
          root_collection: "consider",
          counters: { total: 1 },
        },
      ],
    },
    {
      id: "hidden_col",
      name: "Скрытая",
      hidden: true,
      counters: { total: 99, with_updates: 9 },
      sub_collections: [
        { id: "hidden_1", name: "X", counters: { total: 99 } },
      ],
    },
  ],
  employer_states: [{ id: "response", name: "Отклик" }],
};

describe("fmt helpers", () => {
  it("fmtAge pluralises", () => {
    expect(fmtAge(1)).toBe("1 год");
    expect(fmtAge(2)).toBe("2 года");
    expect(fmtAge(5)).toBe("5 лет");
    expect(fmtAge(21)).toBe("21 год");
    expect(fmtAge(48)).toBe("48 лет");
  });

  it("fmtMonths", () => {
    expect(fmtMonths(27)).toBe("2 г. 3 мес.");
    expect(fmtMonths(24)).toBe("2 г.");
    expect(fmtMonths(3)).toBe("3 мес.");
  });

  it("fmtDateTime", () => {
    expect(fmtDateTime("2026-09-12T10:54:21+0300")).toBe("12.09.2026 10:54");
    expect(fmtDateTime("2026-09-12T07:54:21Z")).toBe("12.09.2026 10:54");
    expect(fmtDateTime(null)).toBe("—");
  });
});

describe("formatApplicationCollections", () => {
  it("renders counters and sub-collections, skips hidden, never uses description as count", () => {
    const out = formatApplicationCollections(funnelFixture, "136826013");
    expect(out).toContain("Воронка откликов по вакансии 136826013: всего 91");
    expect(out).toContain("Итого откликов: 91");
    expect(out).toContain("• Все неразобранные [response]: 90 · с изменениями 4");
    expect(out).toContain(
      "– Подходят (sub_collection id response_107261719): 9 · с изменениями 1",
    );
    expect(out).toContain("– В обработке (sub_collection id response_110661713): 0");
    expect(out).toContain("• Подумать [consider]: 1");
    expect(out).not.toMatch(/Откликов не найдено/);
    expect(out).not.toContain("Скрытая");
    expect(out).not.toContain("с изменениями 0");
    expect(out).toContain("Состояния работодателя:");
    expect(out).toContain("response — Отклик");
  });

  it("empty / missing collections message", () => {
    expect(formatApplicationCollections({ collections: [] }, "1")).toBe(
      "Воронка откликов по вакансии 1: данных нет (вакансия не ваша или не найдена)",
    );
  });
});

describe("formatApplication / list item", () => {
  const item: NegotiationItem = {
    id: "5569910826",
    created_at: "2026-09-12T10:54:21+0300",
    updated_at: "2026-09-19T08:37:11+0300",
    has_updates: true,
    viewed_by_opponent: false,
    source: "RESPOND",
    employer_state: { id: "response", name: "Отклик" },
    funnel_stage: {
      id: "107261719",
      name: "response",
      substate: { id: "response_107261719", name: "Подходят" },
    },
    relevant_experience: { total_months: 36, vacancy_requirements_match: true },
    counters: { messages: 20, unread_messages: 1 },
    vacancy: { id: "136826013", name: "Дежурный сантехник" },
    resume: {
      id: "e36692ae",
      title: "Слесарь",
      last_name: "АЛИЯРОВ",
      first_name: "МАРУФ",
      age: 48,
      gender: { id: "male", name: "Мужской" },
      area: { id: "1", name: "Москва" },
      salary: { amount: 80000, currency: "RUR" },
      citizenship: [{ id: "113", name: "Россия" }],
      total_experience: { months: 120 },
      alternate_url: "https://hh.ru/resume/e36692ae",
      experience: [
        { position: "Слесарь", company: "ООО Ромашка", start: "2020-01-01", end: "2022-01-01" },
      ],
      education: {
        primary: [{ name: "Колледж", organization: "ПТУ", year: 2000 }],
      },
      skill_set: ["сантехника", "сварка"],
    },
  };

  it("formatApplication renders recruiter card fields", () => {
    const out = formatApplication(item);
    expect(out).toContain("# АЛИЯРОВ МАРУФ, 48 лет — Слесарь");
    expect(out).toContain("Этап: Отклик / Подходят · тема 5569910826 · источник RESPOND");
    expect(out).toContain("есть изменения");
    expect(out).toContain("соискатель не читал");
    expect(out).toContain("Кандидат: Москва · Мужской · 80\u00a0000 ₽ · опыт 10 г. · гражданство: Россия");
    expect(out).toContain("Релевантный опыт: 3 г. · соответствует требованиям вакансии");
    expect(out).toContain("Сообщений: 20 (новых 1)");
    expect(out).toContain("Опыт работы:");
    expect(out).toContain("Образование:");
    expect(out).toContain("Навыки: сантехника, сварка");
    expect(out).toContain('Переписка: get_application_messages(nid="5569910826")');
    expect(out).toContain("Резюме: Слесарь (id=e36692ae)");
    expect(out).toContain(
      "(полное резюме: get_resume resume_id=e36692ae topic_id=5569910826 vacancy_id=136826013)",
    );
  });

  it("formatApplication omits optional blocks when absent", () => {
    const out = formatApplication({ id: "1", employer_state: { name: "Отклик" } });
    expect(out).toContain("# Без имени — без должности");
    expect(out).not.toContain("Кандидат:");
    expect(out).not.toContain("Релевантный опыт:");
    expect(out).not.toContain("Опыт работы:");
    expect(out).toContain('Переписка: get_application_messages(nid="1")');
  });

  it("formatNegotiationListItem includes triage fields", () => {
    const out = formatNegotiationListItem(item, 1);
    expect(out).toContain("Отклик / Подходят");
    expect(out).toContain("сообщений 20 (новых 1)");
    expect(out).toContain("опыт 10 г.");
    expect(out).toContain("релевантный 3 г.");
    expect(out).toContain("тема 5569910826");
    expect(out).toContain("80\u00a0000 ₽");
  });

  it("formatApplicationList with_updates_only header split", () => {
    const result: SearchResult<NegotiationItem> = {
      items: [item],
      found: 90,
      pages: 5,
      page: 0,
      per_page: 20,
    };
    const out = formatApplicationList(result, {
      vacancyId: "136826013",
      collection: "response",
      onlyWithUpdates: true,
      updatesScan: {
        pagesScanned: 5,
        capped: false,
        exhausted: true,
        filteredPage: 0,
      },
    });
    expect(out).toContain("после фильтра 1 из 90");
    expect(out).toContain("просмотрено 5 страниц");
    expect(out).toContain("фильтр: только отклики с изменениями");
    expect(out).not.toContain("просмотр не завершён");
  });

  it("formatApplicationList capped scan omits (пусто) and marks incomplete", () => {
    const out = formatApplicationList(
      { items: [], found: 90, page: 0, pages: 5, per_page: 20 },
      {
        vacancyId: "136826013",
        collection: "response",
        onlyWithUpdates: true,
        updatesScan: {
          pagesScanned: 10,
          capped: true,
          exhausted: false,
          filteredPage: 0,
        },
      },
    );
    expect(out).toContain("после фильтра 0 из 90");
    expect(out).toContain("просмотр не завершён — есть ещё страницы");
    expect(out).not.toContain("(пусто)");
  });

  it("formatApplicationList exhaustive empty allows (пусто)", () => {
    const out = formatApplicationList(
      { items: [], found: 90, page: 0, pages: 5, per_page: 20 },
      {
        vacancyId: "136826013",
        collection: "response",
        onlyWithUpdates: true,
        updatesScan: {
          pagesScanned: 5,
          capped: false,
          exhausted: true,
          filteredPage: 0,
        },
      },
    );
    expect(out).toContain("(пусто)");
  });
});

describe("formatApplicationMessages", () => {
  it("pagination header, unread, truncation, empty text, next-page hint", () => {
    const long = "x".repeat(900);
    const data: NegotiationMessagesResponse = {
      found: 23,
      page: 0,
      pages: 5,
      items: [
        {
          created_at: "2026-09-12T10:54:21+0300",
          author: { participant_type: "applicant" },
          viewed_by_me: false,
          text: long,
        },
        {
          created_at: "2026-09-12T11:00:00+0300",
          author: { participant_type: "employer" },
          viewed_by_me: true,
          text: "",
        },
      ],
    };
    const out = formatApplicationMessages(data, "5569910826");
    expect(out).toContain(
      "Переписка по отклику 5569910826: 23 сообщений (страница 1 из 5, показано 2)",
    );
    expect(out).toContain("соискатель не прочитано:");
    expect(out).toContain("работодатель: (без текста)");
    expect(out).toContain("Следующая страница: page=1");
    const textLine = out.split("\n").find((l) => l.includes("соискатель"));
    expect(textLine!.length).toBeLessThan(900);
    expect(textLine).toMatch(/…$/);
  });

  it("no next-page hint on last page", () => {
    const out = formatApplicationMessages(
      { found: 2, page: 1, pages: 2, items: [{ text: "hi", author: { participant_type: "employer" } }] },
      "9",
    );
    expect(out).not.toContain("Следующая страница");
  });
});

describe("formatter notes from live sweep", () => {
  it("formatPhone uses formatted / composed number, never [object Object]", () => {
    expect(formatPhone({ formatted: "79295710948", city: "929", number: "5710948", country: "7" })).toBe(
      "+79295710948",
    );
    expect(formatPhone({ country: "7", city: "495", number: "1234567" })).toBe("+74951234567");
    expect(formatPhone("+7 495 123-45-67")).toBe("+7 495 123-45-67");
  });

  it("formatManager renders object phone", () => {
    const m = {
      id: "1",
      full_name: "HR",
      email: "hr@x.io",
      phone: { formatted: "79295710948" },
      manager_type: { id: "admin", name: "Админ" },
    };
    expect(formatManager(m)).toContain("Телефон: +79295710948");
    expect(formatManager(m)).not.toContain("[object Object]");
    expect(formatManagerListItem(m, 1)).toContain("+79295710948");
  });

  it("formatNegotiationsStatistics flattens nested politeness", () => {
    const out = formatNegotiationsStatistics({
      manager_statistics: {
        received: 207,
        politeness: { index: 76, index_change: 0, hint: "выше среднего" },
      },
    });
    expect(out).toContain("received=207");
    expect(out).toContain("index=76");
    expect(out).toContain("hint=выше среднего");
    expect(out).not.toContain("[object Object]");
  });

  it("formatPreferredOrder reads order_type.id/name", () => {
    expect(formatPreferredOrder({ order_type: { id: "relevance", name: "Лучшие" } })).toBe(
      "Предпочтительная сортировка: Лучшие (relevance)",
    );
    expect(formatPreferredOrder({ order_by: "created_at" })).toBe(
      "Предпочтительная сортировка: created_at",
    );
  });
});

import { z } from "zod";
import { hhGet, HhApiError } from "../client.js";
import type { Vacancy, SearchResult } from "../types.js";
import { formatSalary } from "../format.js";

// Prefer paid «Банк данных зарплат» when the token has access
// (GET /salary_statistics/paid/salary_evaluation/{area_id}).
// On missing token, missing area_id, or 401/403/404 from the bank — fall back to
// client-side sampling of posted vacancy salaries (biased estimate).

const rawFlag = z
  .boolean()
  .optional()
  .describe("Return the stats object / paid bank JSON instead of the formatted summary.");

export const getSalaryStatisticsSchema = z.object({
  professional_role_id: z
    .number()
    .describe(
      "Professional role ID for vacancy-based fallback. Use get_professional_roles or suggest_professional_roles. Not the same id space as salary-bank `speciality`.",
    ),
  area_id: z
    .number()
    .optional()
    .describe(
      "Region code. Required to try the paid salary bank (path param). For vacancies fallback this is a regular /areas id (1=Moscow). Salary-bank areas usually match major regions.",
    ),
  text: z
    .string()
    .optional()
    .describe(
      "Keyword / job title. Used as vacancy text filter in fallback, and as `position_name` for the paid bank when set.",
    ),
  speciality: z
    .string()
    .optional()
    .describe(
      "Salary-bank speciality id (from /salary_statistics/dictionaries/professional_areas). Improves paid-bank queries.",
    ),
  employee_level: z
    .string()
    .optional()
    .describe(
      "Salary-bank employee level id (from /salary_statistics/dictionaries/employee_levels), e.g. specialist.",
    ),
  industry: z
    .string()
    .optional()
    .describe(
      "Salary-bank industry id (from /salary_statistics/dictionaries/salary_industries).",
    ),
  extend_sources: z
    .boolean()
    .optional()
    .describe(
      "Paid bank only: if true, allow resumes/vacancies when bank sample is thin (extend_sources=true).",
    ),
  sample_pages: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe(
      "Vacancy-fallback only: pages of 100 salaried vacancies to sample (1-5).",
    ),
  raw: rawFlag,
});

interface SalaryStats {
  source: "vacancy_sample";
  professional_role_id: number;
  area_id?: number;
  currency: string;
  total_vacancies: number;
  with_salary: number;
  coverage_pct: number | null;
  sample_size: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  mean: number;
  other_currencies: Record<string, number>;
}

interface PaidMarketSalary {
  average?: number;
  bottom?: number;
  maximum?: number;
  median?: number;
  minimum?: number;
  upper?: number;
}

interface PaidIdName {
  id?: string;
  name?: string;
}

interface PaidEvaluation {
  market_salary?: PaidMarketSalary;
  resulting_parameters?: {
    areas?: PaidIdName[];
    employee_levels?: PaidIdName[] | null;
    employers_count?: number;
    positions_count?: number;
    sources?: string[];
    specialities?: PaidIdName[] | null;
    industries?: PaidIdName[] | null;
    indirect_calculation?: unknown;
  };
}

function midpoint(s: { from?: number | null; to?: number | null }): number | null {
  if (s.from != null && s.to != null) return (s.from + s.to) / 2;
  if (s.from != null) return s.from;
  if (s.to != null) return s.to;
  return null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function canAttemptPaidBank(
  params: z.infer<typeof getSalaryStatisticsSchema>,
): boolean {
  // Paid endpoint requires area_id in the path and an OAuth token with bank access.
  return Boolean(process.env.HH_ACCESS_TOKEN) && params.area_id != null;
}

function isPaidUnavailable(error: unknown): boolean {
  return (
    error instanceof HhApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

async function fetchPaidEvaluation(
  params: z.infer<typeof getSalaryStatisticsSchema>,
): Promise<PaidEvaluation> {
  const query = new URLSearchParams();
  if (params.speciality) query.set("speciality", params.speciality);
  if (params.employee_level) query.set("employee_level", params.employee_level);
  if (params.industry) query.set("industry", params.industry);
  if (params.text) query.set("position_name", params.text);
  if (params.extend_sources === true) query.set("extend_sources", "true");

  const qs = query.toString();
  const path =
    `/salary_statistics/paid/salary_evaluation/${encodeURIComponent(String(params.area_id!))}` +
    (qs ? `?${qs}` : "");
  return (await hhGet(path)) as PaidEvaluation;
}

function formatPaidEvaluation(
  data: PaidEvaluation,
  params: z.infer<typeof getSalaryStatisticsSchema>,
): string {
  if (params.raw) {
    return JSON.stringify({ source: "salary_bank", ...data }, null, 2);
  }

  const ms = data.market_salary ?? {};
  const rp = data.resulting_parameters ?? {};
  const sal = (n: number | undefined) =>
    n == null ? "—" : formatSalary({ from: n, currency: "RUR" });

  const areaNames = (rp.areas ?? []).map((a) => a.name ?? a.id).filter(Boolean);
  const specialityNames = (rp.specialities ?? [])
    .map((s) => s.name ?? s.id)
    .filter(Boolean);
  const levelNames = (rp.employee_levels ?? [])
    .map((l) => l.name ?? l.id)
    .filter(Boolean);

  const lines = [
    "Зарплатная статистика — Банк данных зарплат (официальная оценка)",
    `Регион (area_id): ${params.area_id}` +
      (areaNames.length ? ` · ${areaNames.join(", ")}` : ""),
  ];
  if (specialityNames.length) lines.push(`Специализации: ${specialityNames.join(", ")}`);
  if (levelNames.length) lines.push(`Уровни: ${levelNames.join(", ")}`);
  if (params.text) lines.push(`Должность (position_name): ${params.text}`);
  if (rp.positions_count != null || rp.employers_count != null) {
    lines.push(
      `Выборка банка: ${rp.positions_count ?? "—"} позиций, ${rp.employers_count ?? "—"} работодателей` +
        (rp.sources?.length ? ` · источники: ${rp.sources.join(", ")}` : ""),
    );
  }
  lines.push(
    "",
    `Медиана: ${sal(ms.median)}`,
    `P25–P75 (bottom–upper): ${sal(ms.bottom)} – ${sal(ms.upper)}`,
    `P10–P90 (minimum–maximum): ${sal(ms.minimum)} – ${sal(ms.maximum)}`,
    `Среднее: ${sal(ms.average)}`,
  );
  return lines.join("\n");
}

async function computeVacancySample(
  params: z.infer<typeof getSalaryStatisticsSchema>,
): Promise<string> {
  const base = new URLSearchParams();
  base.set("professional_role", String(params.professional_role_id));
  if (params.area_id != null) base.set("area", String(params.area_id));
  if (params.text) base.set("text", params.text);

  const totalQ = new URLSearchParams(base);
  totalQ.set("per_page", "1");
  totalQ.set("page", "0");
  const totalRes = (await hhGet(`/vacancies?${totalQ.toString()}`)) as SearchResult<Vacancy>;
  const totalVacancies = totalRes.found ?? 0;

  const perPage = 100;
  const byCurrency = new Map<string, number[]>();
  let withSalaryFound = 0;
  let sampled = 0;

  for (let page = 0; page < params.sample_pages; page++) {
    if ((page + 1) * perPage > 2000) break;
    const q = new URLSearchParams(base);
    q.set("label", "with_salary");
    q.set("per_page", String(perPage));
    q.set("page", String(page));
    const res = (await hhGet(`/vacancies?${q.toString()}`)) as SearchResult<Vacancy>;
    if (page === 0) withSalaryFound = res.found ?? 0;
    const items = res.items ?? [];
    for (const v of items) {
      const value = v.salary ? midpoint(v.salary) : null;
      if (value == null) continue;
      const cur = v.salary?.currency || "RUR";
      if (!byCurrency.has(cur)) byCurrency.set(cur, []);
      byCurrency.get(cur)!.push(value);
      sampled++;
    }
    if (items.length < perPage) break;
  }

  if (sampled === 0) {
    const msg =
      `Нет вакансий с указанной зарплатой для professional_role=${params.professional_role_id}` +
      (params.area_id != null ? `, area=${params.area_id}` : "") +
      (params.text ? `, text="${params.text}"` : "") +
      `. Всего вакансий по фильтру: ${totalVacancies}.`;
    throw new Error(msg);
  }

  const sortedCurrencies = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length);
  const [currency, values] = sortedCurrencies[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const otherCurrencies: Record<string, number> = {};
  for (const [cur, vals] of sortedCurrencies.slice(1)) otherCurrencies[cur] = vals.length;

  const stats: SalaryStats = {
    source: "vacancy_sample",
    professional_role_id: params.professional_role_id,
    area_id: params.area_id,
    currency,
    total_vacancies: totalVacancies,
    with_salary: withSalaryFound,
    coverage_pct: totalVacancies > 0 ? Math.round((withSalaryFound / totalVacancies) * 100) : null,
    sample_size: sorted.length,
    median: Math.round(percentile(sorted, 50)),
    p25: Math.round(percentile(sorted, 25)),
    p75: Math.round(percentile(sorted, 75)),
    min: Math.round(sorted[0]!),
    max: Math.round(sorted[sorted.length - 1]!),
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    other_currencies: otherCurrencies,
  };

  if (params.raw) return JSON.stringify(stats, null, 2);

  const sal = (n: number) => formatSalary({ from: n, currency });
  const lines = [
    "Зарплатная статистика — оценка по объявлениям hh.ru",
    `Роль (professional_role): ${stats.professional_role_id}` +
      (stats.area_id != null ? ` · регион: ${stats.area_id}` : ""),
    `Вакансий всего: ${stats.total_vacancies.toLocaleString("ru-RU")}, с зарплатой: ${stats.with_salary.toLocaleString("ru-RU")}` +
      (stats.coverage_pct != null ? ` (${stats.coverage_pct}%)` : ""),
    `Выборка: ${stats.sample_size} вакансий, валюта ${currency}`,
    "",
    `Медиана: ${sal(stats.median)}`,
    `P25–P75: ${sal(stats.p25)} – ${sal(stats.p75)}`,
    `Мин–Макс: ${sal(stats.min)} – ${sal(stats.max)}`,
    `Среднее: ${sal(stats.mean)}`,
  ];
  if (Object.keys(otherCurrencies).length) {
    const others = Object.entries(otherCurrencies)
      .map(([c, n]) => `${c}: ${n}`)
      .join(", ");
    lines.push(`Другие валюты в выборке (исключены из расчёта): ${others}`);
  }
  lines.push(
    "",
    "⚠ Смещённая оценка из объявлений, не официальная статистика рынка:",
    "учитываются только вакансии с указанной зарплатой; gross и net смешаны;",
    "hh.ru ограничивает выборку 2000 результатами. Для официальных данных нужен",
    "платный сервис «Банк данных зарплат» (salary.hh.ru) и HH_ACCESS_TOKEN с доступом.",
  );
  return lines.join("\n");
}

export async function handleGetSalaryStatistics(
  params: z.infer<typeof getSalaryStatisticsSchema>,
): Promise<string> {
  if (canAttemptPaidBank(params)) {
    try {
      const paid = await fetchPaidEvaluation(params);
      return formatPaidEvaluation(paid, params);
    } catch (error) {
      if (!isPaidUnavailable(error)) throw error;
      // No bank access (401/403) or no data for filters (404) → vacancy sample.
    }
  }
  return computeVacancySample(params);
}

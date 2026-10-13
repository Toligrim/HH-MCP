import { z } from "zod";
export declare const searchVacanciesSchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    area: z.ZodOptional<z.ZodNumber>;
    professional_role: z.ZodOptional<z.ZodNumber>;
    industry: z.ZodOptional<z.ZodString>;
    metro: z.ZodOptional<z.ZodString>;
    employer_id: z.ZodOptional<z.ZodString>;
    salary: z.ZodOptional<z.ZodNumber>;
    currency: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodEnum<["with_salary", "not_from_agency", "accept_handicapped", "accept_kids", "accept_temporary"]>>;
    experience: z.ZodOptional<z.ZodEnum<["noExperience", "between1And3", "between3And6", "moreThan6"]>>;
    employment_form: z.ZodOptional<z.ZodEnum<["FULL", "PART", "PROJECT", "FLY_IN_FLY_OUT"]>>;
    work_format: z.ZodOptional<z.ZodEnum<["ON_SITE", "REMOTE", "HYBRID", "FIELD_WORK"]>>;
    employment: z.ZodOptional<z.ZodEnum<["full", "part", "project", "volunteer", "probation"]>>;
    schedule: z.ZodOptional<z.ZodEnum<["fullDay", "shift", "flexible", "remote", "flyInFlyOut"]>>;
    search_field: z.ZodOptional<z.ZodEnum<["name", "company_name", "description"]>>;
    excluded_text: z.ZodOptional<z.ZodString>;
    period: z.ZodOptional<z.ZodNumber>;
    date_from: z.ZodOptional<z.ZodString>;
    date_to: z.ZodOptional<z.ZodString>;
    order_by: z.ZodOptional<z.ZodEnum<["relevance", "publication_time", "salary_desc", "salary_asc"]>>;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    currency?: string | undefined;
    text?: string | undefined;
    area?: number | undefined;
    professional_role?: number | undefined;
    industry?: string | undefined;
    metro?: string | undefined;
    employer_id?: string | undefined;
    salary?: number | undefined;
    label?: "with_salary" | "not_from_agency" | "accept_handicapped" | "accept_kids" | "accept_temporary" | undefined;
    experience?: "noExperience" | "between1And3" | "between3And6" | "moreThan6" | undefined;
    employment_form?: "FULL" | "PART" | "PROJECT" | "FLY_IN_FLY_OUT" | undefined;
    work_format?: "ON_SITE" | "REMOTE" | "HYBRID" | "FIELD_WORK" | undefined;
    employment?: "full" | "part" | "project" | "volunteer" | "probation" | undefined;
    schedule?: "shift" | "fullDay" | "flexible" | "remote" | "flyInFlyOut" | undefined;
    search_field?: "name" | "company_name" | "description" | undefined;
    excluded_text?: string | undefined;
    period?: number | undefined;
    date_from?: string | undefined;
    date_to?: string | undefined;
    order_by?: "relevance" | "publication_time" | "salary_desc" | "salary_asc" | undefined;
    raw?: boolean | undefined;
}, {
    page?: number | undefined;
    per_page?: number | undefined;
    currency?: string | undefined;
    text?: string | undefined;
    area?: number | undefined;
    professional_role?: number | undefined;
    industry?: string | undefined;
    metro?: string | undefined;
    employer_id?: string | undefined;
    salary?: number | undefined;
    label?: "with_salary" | "not_from_agency" | "accept_handicapped" | "accept_kids" | "accept_temporary" | undefined;
    experience?: "noExperience" | "between1And3" | "between3And6" | "moreThan6" | undefined;
    employment_form?: "FULL" | "PART" | "PROJECT" | "FLY_IN_FLY_OUT" | undefined;
    work_format?: "ON_SITE" | "REMOTE" | "HYBRID" | "FIELD_WORK" | undefined;
    employment?: "full" | "part" | "project" | "volunteer" | "probation" | undefined;
    schedule?: "shift" | "fullDay" | "flexible" | "remote" | "flyInFlyOut" | undefined;
    search_field?: "name" | "company_name" | "description" | undefined;
    excluded_text?: string | undefined;
    period?: number | undefined;
    date_from?: string | undefined;
    date_to?: string | undefined;
    order_by?: "relevance" | "publication_time" | "salary_desc" | "salary_asc" | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleSearchVacancies(params: z.infer<typeof searchVacanciesSchema>): Promise<string>;
export declare const getVacancySchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetVacancy(params: z.infer<typeof getVacancySchema>): Promise<string>;
export declare const getSimilarVacanciesSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetSimilarVacancies(params: z.infer<typeof getSimilarVacanciesSchema>): Promise<string>;
export declare const getRelatedVacanciesSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetRelatedVacancies(params: z.infer<typeof getRelatedVacanciesSchema>): Promise<string>;
export declare const getVacancyStatsSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetVacancyStats(params: z.infer<typeof getVacancyStatsSchema>): Promise<string>;
export declare const getVacancyVisitorsSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetVacancyVisitors(params: z.infer<typeof getVacancyVisitorsSchema>): Promise<string>;
export declare const getVacancyConditionsSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetVacancyConditions(params?: z.infer<typeof getVacancyConditionsSchema>): Promise<string>;

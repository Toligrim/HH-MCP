import { z } from "zod";
export declare function resolveAccountIds(params: {
    employer_id?: string;
    manager_id?: string;
}, need?: {
    employer?: boolean;
    manager?: boolean;
}): Promise<{
    employerId: string;
    managerId: string;
}>;
export declare const searchEmployersSchema: z.ZodObject<{
    text: z.ZodString;
    area: z.ZodOptional<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    text: string;
    area?: number | undefined;
    raw?: boolean | undefined;
}, {
    text: string;
    page?: number | undefined;
    per_page?: number | undefined;
    area?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleSearchEmployers(params: z.infer<typeof searchEmployersSchema>): Promise<string>;
export declare const getEmployerSchema: z.ZodObject<{
    employer_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetEmployer(params: z.infer<typeof getEmployerSchema>): Promise<string>;
export declare const getEmployerVacanciesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetEmployerVacancies(params: z.infer<typeof getEmployerVacanciesSchema>): Promise<string>;
export declare const listEmployerManagersSchema: z.ZodObject<{
    employer_id: z.ZodOptional<z.ZodString>;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    employer_id?: string | undefined;
    raw?: boolean | undefined;
}, {
    page?: number | undefined;
    per_page?: number | undefined;
    employer_id?: string | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleListEmployerManagers(params: z.infer<typeof listEmployerManagersSchema>): Promise<string>;
export declare const getEmployerManagerSchema: z.ZodObject<{
    employer_id: z.ZodOptional<z.ZodString>;
    manager_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}>;
export declare function handleGetEmployerManager(params: z.infer<typeof getEmployerManagerSchema>): Promise<string>;
export declare const getManagerResumeLimitsSchema: z.ZodObject<{
    employer_id: z.ZodOptional<z.ZodString>;
    manager_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}>;
export declare function handleGetManagerResumeLimits(params: z.infer<typeof getManagerResumeLimitsSchema>): Promise<string>;
export declare const getManagerNegotiationsStatisticsSchema: z.ZodObject<{
    employer_id: z.ZodOptional<z.ZodString>;
    manager_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
    manager_id?: string | undefined;
}>;
export declare function handleGetManagerNegotiationsStatistics(params: z.infer<typeof getManagerNegotiationsStatisticsSchema>): Promise<string>;
export declare const listActiveVacanciesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleListActiveVacancies(params: z.infer<typeof listActiveVacanciesSchema>): Promise<string>;
export declare const listArchivedVacanciesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleListArchivedVacancies(params: z.infer<typeof listArchivedVacanciesSchema>): Promise<string>;
export declare const listHiddenVacanciesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleListHiddenVacancies(params: z.infer<typeof listHiddenVacanciesSchema>): Promise<string>;
export declare const getMessageTemplateSchema: z.ZodObject<{
    template: z.ZodString;
    topic_id: z.ZodOptional<z.ZodString>;
    resume_id: z.ZodOptional<z.ZodString>;
    vacancy_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    template: string;
    resume_id?: string | undefined;
    topic_id?: string | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
}, {
    template: string;
    resume_id?: string | undefined;
    topic_id?: string | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
}>;
export declare function handleGetMessageTemplate(params: z.infer<typeof getMessageTemplateSchema>): Promise<string>;
export declare const listMailTemplatesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleListMailTemplates(params: z.infer<typeof listMailTemplatesSchema>): Promise<string>;
export declare const getEmployerVacancyAreasSchema: z.ZodObject<{
    employer_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetEmployerVacancyAreas(params: z.infer<typeof getEmployerVacancyAreasSchema>): Promise<string>;
export declare const getEmployerDepartmentsSchema: z.ZodObject<{
    employer_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
}, {
    employer_id?: string | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetEmployerDepartments(params: z.infer<typeof getEmployerDepartmentsSchema>): Promise<string>;
export declare const listEmployerAddressesSchema: z.ZodObject<{
    employer_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleListEmployerAddresses(params: z.infer<typeof listEmployerAddressesSchema>): Promise<string>;

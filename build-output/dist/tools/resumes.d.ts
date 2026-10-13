import { z } from "zod";
export declare function buildResumePath(resume_id: string, topic_id?: string, vacancy_id?: string): {
    path: string;
    warning?: string;
};
export declare const searchResumesSchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    area: z.ZodOptional<z.ZodNumber>;
    professional_role: z.ZodOptional<z.ZodNumber>;
    salary: z.ZodOptional<z.ZodNumber>;
    experience: z.ZodOptional<z.ZodEnum<["noExperience", "between1And3", "between3And6", "moreThan6"]>>;
    per_page: z.ZodDefault<z.ZodNumber>;
    page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    text?: string | undefined;
    area?: number | undefined;
    professional_role?: number | undefined;
    salary?: number | undefined;
    experience?: "noExperience" | "between1And3" | "between3And6" | "moreThan6" | undefined;
    raw?: boolean | undefined;
}, {
    page?: number | undefined;
    per_page?: number | undefined;
    text?: string | undefined;
    area?: number | undefined;
    professional_role?: number | undefined;
    salary?: number | undefined;
    experience?: "noExperience" | "between1And3" | "between3And6" | "moreThan6" | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleSearchResumes(params: z.infer<typeof searchResumesSchema>): Promise<string>;
export declare const getResumeSchema: z.ZodObject<{
    resume_id: z.ZodString;
    topic_id: z.ZodOptional<z.ZodString>;
    vacancy_id: z.ZodOptional<z.ZodString>;
    allow_unscoped: z.ZodOptional<z.ZodBoolean>;
    no_cache: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    resume_id: string;
    no_cache: boolean;
    topic_id?: string | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
    allow_unscoped?: boolean | undefined;
}, {
    resume_id: string;
    topic_id?: string | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
    allow_unscoped?: boolean | undefined;
    no_cache?: boolean | undefined;
}>;
export interface FetchResumeResult {
    payload: unknown;
    path: string;
    cached: boolean;
    /** Served by another in-flight read of the same (resume, topic, vacancy). */
    coalesced?: boolean;
    /** `unscoped` = resume-database read without topic_id (paid view). */
    scope: "scoped" | "unscoped";
    fetchedAt?: number;
    warning?: string;
}
export interface FetchResumeOptions {
    resume_id: string;
    topic_id?: string;
    vacancy_id?: string;
    no_cache?: boolean;
    /** Caller explicitly opted into an unscoped (paid) view. */
    scopeExplicit?: boolean;
    /** Force gated budget even for scoped reads (batch tools). */
    forceGated?: boolean;
    /** Epoch ms: throw GatedDeadlineError instead of waiting for a slot past it. */
    deadline?: number;
}
/** Shared fetch used by get_resume and batch tools. */
export declare function fetchResume(opts: FetchResumeOptions): Promise<FetchResumeResult>;
export declare function handleGetResume(params: z.infer<typeof getResumeSchema>): Promise<string>;
export declare const getResumeNegotiationsHistorySchema: z.ZodObject<{
    resume_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    resume_id: string;
    raw?: boolean | undefined;
}, {
    resume_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetResumeNegotiationsHistory(params: z.infer<typeof getResumeNegotiationsHistorySchema>): Promise<string>;
export declare const listSavedResumeSearchesSchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    raw?: boolean | undefined;
}, {
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleListSavedResumeSearches(params: z.infer<typeof listSavedResumeSearchesSchema>): Promise<string>;
export declare const getSavedResumeSearchSchema: z.ZodObject<{
    id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    raw?: boolean | undefined;
}, {
    id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetSavedResumeSearch(params: z.infer<typeof getSavedResumeSearchSchema>): Promise<string>;

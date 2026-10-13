import { z } from "zod";
import type { NegotiationItem } from "../types.js";
/** Parsed payload of an existing raw export, or null if missing/empty/corrupt. */
export declare function readValidRawFile(file: string): Record<string, unknown> | null;
export declare const getResumesSchema: z.ZodObject<{
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        resume_id: z.ZodString;
        topic_id: z.ZodOptional<z.ZodString>;
        vacancy_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        resume_id: string;
        topic_id?: string | undefined;
        vacancy_id?: string | undefined;
    }, {
        resume_id: string;
        topic_id?: string | undefined;
        vacancy_id?: string | undefined;
    }>, "many">>;
    resume_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    vacancy_id: z.ZodOptional<z.ZodString>;
    require_topic: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    out_dir: z.ZodOptional<z.ZodString>;
    no_cache: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    max_wait_ms: z.ZodDefault<z.ZodNumber>;
    stop_on_captcha: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    no_cache: boolean;
    require_topic: boolean;
    max_wait_ms: number;
    stop_on_captcha: boolean;
    items?: {
        resume_id: string;
        topic_id?: string | undefined;
        vacancy_id?: string | undefined;
    }[] | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
    resume_ids?: string[] | undefined;
    topics?: Record<string, string> | undefined;
    out_dir?: string | undefined;
}, {
    items?: {
        resume_id: string;
        topic_id?: string | undefined;
        vacancy_id?: string | undefined;
    }[] | undefined;
    raw?: boolean | undefined;
    vacancy_id?: string | undefined;
    no_cache?: boolean | undefined;
    resume_ids?: string[] | undefined;
    topics?: Record<string, string> | undefined;
    require_topic?: boolean | undefined;
    out_dir?: string | undefined;
    max_wait_ms?: number | undefined;
    stop_on_captcha?: boolean | undefined;
}>;
type GetResumesParams = z.infer<typeof getResumesSchema>;
export interface BatchItem {
    resume_id: string;
    topic_id?: string;
    vacancy_id?: string;
}
/**
 * Resolve items vs legacy resume_ids+topics and validate before any network call.
 * Throws with every mismatched id listed so typos are visible.
 */
export declare function normalizeGetResumesInput(params: GetResumesParams): BatchItem[];
export declare function handleGetResumes(params: GetResumesParams): Promise<string>;
export declare const collectVacancyResumesSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    collection: z.ZodOptional<z.ZodString>;
    sub_collection: z.ZodOptional<z.ZodString>;
    max: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    out_dir: z.ZodOptional<z.ZodString>;
    stop_on_captcha: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    max_wait_ms: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    vacancy_id: string;
    max_wait_ms: number;
    stop_on_captcha: boolean;
    max: number;
    raw?: boolean | undefined;
    collection?: string | undefined;
    sub_collection?: string | undefined;
    out_dir?: string | undefined;
    cursor?: string | undefined;
}, {
    vacancy_id: string;
    raw?: boolean | undefined;
    collection?: string | undefined;
    sub_collection?: string | undefined;
    out_dir?: string | undefined;
    max_wait_ms?: number | undefined;
    stop_on_captcha?: boolean | undefined;
    max?: number | undefined;
    cursor?: string | undefined;
}>;
/** Dedupe by negotiation id and order deterministically (created_at, then id). */
export declare function orderNegotiations(items: NegotiationItem[]): {
    items: NegotiationItem[];
    duplicates: number;
};
export declare function handleCollectVacancyResumes(params: z.infer<typeof collectVacancyResumesSchema>): Promise<string>;
export {};

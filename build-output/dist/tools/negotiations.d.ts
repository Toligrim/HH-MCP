import { z } from "zod";
import type { NegotiationItem } from "../types.js";
export declare const listApplicationCollectionsSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleListApplicationCollections(params: z.infer<typeof listApplicationCollectionsSchema>): Promise<string>;
export interface ResolvedSubCollection {
    collection: string;
    label: string;
}
/** Resolve a sub-stage by id, bare numeric id, exact name, or name substring. */
export declare function resolveSubCollection(vacancyIdValue: string, wanted: string, collectionScope?: string): Promise<ResolvedSubCollection>;
export declare const listApplicationsSchema: z.ZodObject<{
    collection: z.ZodOptional<z.ZodString>;
    sub_collection: z.ZodOptional<z.ZodString>;
    vacancy_id: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    order_by: z.ZodOptional<z.ZodString>;
    with_updates_only: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    vacancy_id: string;
    with_updates_only: boolean;
    order_by?: string | undefined;
    raw?: boolean | undefined;
    collection?: string | undefined;
    sub_collection?: string | undefined;
}, {
    vacancy_id: string;
    page?: number | undefined;
    per_page?: number | undefined;
    order_by?: string | undefined;
    raw?: boolean | undefined;
    collection?: string | undefined;
    sub_collection?: string | undefined;
    with_updates_only?: boolean | undefined;
}>;
/** Default / documented cap for with_updates_only collection walks. */
export declare const DEFAULT_MAX_SCAN_PAGES = 10;
/** Resolve HH_MAX_SCAN_PAGES; invalid/empty → default. */
export declare function getMaxScanPages(env?: NodeJS.ProcessEnv): number;
export interface UpdatesScanResult {
    items: NegotiationItem[];
    /** Collection `found` from the last upstream page. */
    found: number;
    pagesScanned: number;
    /** All upstream pages were visited. */
    exhausted: boolean;
    /** Stopped because HH_MAX_SCAN_PAGES was hit before the last upstream page. */
    capped: boolean;
    filteredPage: number;
    filteredPerPage: number;
    /** More filtered matches may exist after this page. */
    hasMoreFiltered: boolean;
}
/**
 * Walk upstream pages and collect has_updates items so page/per_page address
 * the filtered stream. hh.ru has no order_by that isolates has_updates.
 */
export declare function scanApplicationsWithUpdates(opts: {
    collection: string;
    vacancyId: string;
    orderBy?: string;
    filteredPage: number;
    filteredPerPage: number;
    maxScanPages?: number;
    fetchPage?: (path: string) => Promise<unknown>;
}): Promise<UpdatesScanResult>;
export declare function handleListApplications(params: z.infer<typeof listApplicationsSchema>): Promise<string>;
export declare const getApplicationSchema: z.ZodObject<{
    id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    raw?: boolean | undefined;
}, {
    id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetApplication(params: z.infer<typeof getApplicationSchema>): Promise<string>;
export declare const getApplicationMessagesSchema: z.ZodObject<{
    nid: z.ZodString;
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    page: number;
    per_page: number;
    nid: string;
    raw?: boolean | undefined;
}, {
    nid: string;
    page?: number | undefined;
    per_page?: number | undefined;
    raw?: boolean | undefined;
}>;
export declare function handleGetApplicationMessages(params: z.infer<typeof getApplicationMessagesSchema>): Promise<string>;
export declare const getNegotiationsStatisticsSchema: z.ZodObject<{
    employer_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    employer_id: string;
    raw?: boolean | undefined;
}, {
    employer_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetNegotiationsStatistics(params: z.infer<typeof getNegotiationsStatisticsSchema>): Promise<string>;
export declare const getPreferredNegotiationsOrderSchema: z.ZodObject<{
    vacancy_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    vacancy_id: string;
    raw?: boolean | undefined;
}, {
    vacancy_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetPreferredNegotiationsOrder(params: z.infer<typeof getPreferredNegotiationsOrderSchema>): Promise<string>;

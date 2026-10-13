import type { Vacancy, VacancyDetail, Employer, Resume, Area, SearchResult, NegotiationsCollectionsResponse, NegotiationItem, NegotiationMessagesResponse, NegotiationsHistory, EmployerManager, VacancyStats, SavedResumeSearch, NamedId } from "./types.js";
export interface SalaryLike {
    from?: number | null;
    to?: number | null;
    currency?: string | null;
    gross?: boolean | null;
}
export declare function formatSalary(salary?: SalaryLike | null): string;
export declare function formatVacancyListItem(v: Vacancy, idx: number): string;
export declare function formatVacancySearch(result: SearchResult<Vacancy>): string;
export declare function formatVacancyDetail(v: VacancyDetail): string;
export declare function formatEmployerListItem(e: Employer, idx: number): string;
export declare function formatEmployerSearch(result: SearchResult<Employer>): string;
export declare function formatEmployer(e: Employer): string;
export declare function formatResumeListItem(r: Resume, idx: number): string;
export declare function formatResumeSearch(result: SearchResult<Resume>): string;
export declare function formatResume(r: Resume): string;
/** Flatten the (large) /areas or /professional_roles tree into "id — name" lines. */
export declare function flattenAreaTree(areas: Area[], depth?: number): string;
export declare function formatNamedIdList(items: NamedId[] | undefined, empty?: string): string;
/** Compact Moscow datetime: `12.09.2026 10:54`. Independent of the host timezone. */
export declare function fmtDateTime(value?: string | null): string;
/** Russian duration: `2 г. 3 мес.` / `2 г.` / `3 мес.`. */
export declare function fmtMonths(months?: number | null): string | null;
/** Russian age with pluralisation: `48 лет` / `1 год` / `2 года`. */
export declare function fmtAge(age?: number | null): string | null;
export declare function formatApplicationCollections(data: NegotiationsCollectionsResponse, vacancyId: string): string;
export declare function formatNegotiationListItem(n: NegotiationItem, idx: number): string;
export interface UpdatesScanFormatMeta {
    pagesScanned: number;
    /** Stopped at HH_MAX_SCAN_PAGES before the last upstream page. */
    capped: boolean;
    /** Every upstream page was visited. */
    exhausted: boolean;
    hasMoreFiltered?: boolean;
    /** 0-based page into the filtered stream. */
    filteredPage?: number;
}
export interface FormatApplicationListOptions {
    vacancyId?: string;
    collection?: string;
    label?: string;
    onlyWithUpdates?: boolean;
    updatesScan?: UpdatesScanFormatMeta;
}
export declare function formatApplicationList(result: SearchResult<NegotiationItem>, options?: FormatApplicationListOptions): string;
export declare function formatApplication(n: NegotiationItem, opts?: {
    vacancyId?: string;
}): string;
export declare function formatApplicationMessages(data: NegotiationMessagesResponse, topicId: string): string;
export declare function formatNegotiationsHistory(data: NegotiationsHistory): string;
export declare function formatNegotiationsStatistics(data: unknown): string;
export declare function formatPreferredOrder(data: unknown): string;
export declare function formatPhone(phone?: string | {
    formatted?: string;
    country?: string;
    city?: string;
    number?: string;
} | null): string | null;
export declare function formatManagerListItem(m: EmployerManager, idx: number): string;
export declare function formatManagerList(result: SearchResult<EmployerManager> | {
    items?: EmployerManager[];
}): string;
export declare function formatManager(m: EmployerManager): string;
export declare function formatVacancyStats(stats: VacancyStats): string;
export declare function formatSavedResumeSearchList(result: SearchResult<SavedResumeSearch> | {
    items?: SavedResumeSearch[];
}): string;
export declare function formatSavedResumeSearch(s: SavedResumeSearch): string;

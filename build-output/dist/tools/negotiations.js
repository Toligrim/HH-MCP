import { z } from "zod";
import { hhGet } from "../client.js";
import { requireToken } from "../auth.js";
import { formatApplicationCollections, formatApplicationList, formatApplication, formatApplicationMessages, formatNegotiationsStatistics, formatPreferredOrder, } from "../format.js";
const rawFlag = z
    .boolean()
    .optional()
    .describe("Return the full raw hh.ru JSON instead of the compact summary.");
const vacancyId = z.string().regex(/^\d+$/, "vacancy_id must be a numeric hh.ru id");
const employerId = z.string().regex(/^\d+$/, "employer_id must be a numeric hh.ru id");
const negotiationId = z
    .string()
    .regex(/^\d+$/, "id must be a numeric hh.ru negotiation id");
const collectionId = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "collection must be an hh.ru collection id");
export const listApplicationCollectionsSchema = z.object({
    vacancy_id: vacancyId.describe("Vacancy ID to list negotiation collections for"),
    raw: rawFlag,
});
export async function handleListApplicationCollections(params) {
    requireToken();
    const query = new URLSearchParams();
    query.set("vacancy_id", params.vacancy_id);
    const result = await hhGet(`/negotiations?${query.toString()}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatApplicationCollections(result, params.vacancy_id);
}
/** Resolve a sub-stage by id, bare numeric id, exact name, or name substring. */
export async function resolveSubCollection(vacancyIdValue, wanted, collectionScope) {
    const root = (await hhGet(`/negotiations?vacancy_id=${encodeURIComponent(vacancyIdValue)}`));
    const available = [];
    for (const collection of root.collections ?? []) {
        for (const sub of collection.sub_collections ?? []) {
            // hh.ru sometimes sends root_collection as a boolean `true` instead of the
            // parent collection id string — fall back to the enclosing collection.id.
            const rootId = typeof sub.root_collection === "string" && sub.root_collection
                ? sub.root_collection
                : collection.id;
            available.push({
                id: String(sub.id),
                name: sub.name,
                parent: collection.name,
                root: rootId,
            });
        }
    }
    const scoped = collectionScope
        ? available.filter((s) => s.root === collectionScope)
        : available;
    const shortId = (id) => String(id).replace(/^[a-z_]+_/, "");
    const needle = String(wanted).trim().toLowerCase();
    const match = scoped.find((s) => s.id.toLowerCase() === needle) ??
        scoped.find((s) => shortId(s.id).toLowerCase() === needle) ??
        scoped.find((s) => s.name?.toLowerCase() === needle) ??
        scoped.find((s) => s.name?.toLowerCase().includes(needle));
    if (!match) {
        const list = available
            .map((s) => `"${s.name}" (id ${s.id}, в «${s.parent}»)`)
            .join(", ");
        throw new Error(`Подэтап воронки "${wanted}" не найден. Доступны: ${list || "нет"} ` +
            `(полный список — через list_application_collections)`);
    }
    return { collection: match.id, label: `${match.name} (${match.parent})` };
}
export const listApplicationsSchema = z.object({
    collection: collectionId
        .optional()
        .describe("Collection id or sub-collection id from list_application_collections " +
        '(e.g. "response", "invited", or "response_107261719"). Defaults to "response" ' +
        "when sub_collection is not set."),
    sub_collection: z
        .string()
        .optional()
        .describe('Sub-stage id ("response_107261719"), bare funnel-stage id ("107261719"), ' +
        'or a name / name substring ("Подходят"), case-insensitive; account-specific — ' +
        "see list_application_collections."),
    vacancy_id: vacancyId.describe("Vacancy ID"),
    page: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Page number (0-based). With with_updates_only, pages the filtered match stream " +
        "(not a single hh.ru API page)."),
    per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Results per page. With with_updates_only, size of each filtered page " +
        "(scan uses up to 50 items per upstream request)."),
    order_by: z
        .string()
        .optional()
        .describe("Sort order (e.g. created_at, relevance, last_change_time_except_employer_inbox). Use get_preferred_negotiations_order for the vacancy default."),
    with_updates_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return only items with has_updates by scanning collection pages " +
        "(capped by HH_MAX_SCAN_PAGES, default 10). page/per_page apply to the " +
        "filtered stream. raw:true still returns one unfiltered upstream page."),
    raw: rawFlag,
});
/** Default / documented cap for with_updates_only collection walks. */
export const DEFAULT_MAX_SCAN_PAGES = 10;
/** Upstream page size while scanning for has_updates (hh.ru max). */
const SCAN_API_PER_PAGE = 50;
/** Resolve HH_MAX_SCAN_PAGES; invalid/empty → default. */
export function getMaxScanPages(env = process.env) {
    const raw = env.HH_MAX_SCAN_PAGES;
    if (raw == null || String(raw).trim() === "")
        return DEFAULT_MAX_SCAN_PAGES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1)
        return DEFAULT_MAX_SCAN_PAGES;
    return Math.floor(n);
}
function collectionQuery(vacancyId, page, perPage, orderBy) {
    const query = new URLSearchParams();
    query.set("vacancy_id", vacancyId);
    query.set("page", String(page));
    query.set("per_page", String(perPage));
    if (orderBy)
        query.set("order_by", orderBy);
    return query.toString();
}
/**
 * Walk upstream pages and collect has_updates items so page/per_page address
 * the filtered stream. hh.ru has no order_by that isolates has_updates.
 */
export async function scanApplicationsWithUpdates(opts) {
    const maxScanPages = opts.maxScanPages ?? getMaxScanPages();
    const fetchPage = opts.fetchPage ?? hhGet;
    const skipTarget = opts.filteredPage * opts.filteredPerPage;
    const matched = [];
    let skipped = 0;
    let pagesScanned = 0;
    let found = 0;
    let capped = false;
    let exhausted = false;
    let sawExtraMatch = false;
    for (let apiPage = 0; apiPage < maxScanPages; apiPage++) {
        const qs = collectionQuery(opts.vacancyId, apiPage, SCAN_API_PER_PAGE, opts.orderBy);
        const result = (await fetchPage(`/negotiations/${encodeURIComponent(opts.collection)}?${qs}`));
        pagesScanned++;
        if (typeof result.found === "number")
            found = result.found;
        const apiPages = result.pages ?? 1;
        for (const item of result.items ?? []) {
            if (!item.has_updates)
                continue;
            if (skipped < skipTarget) {
                skipped++;
                continue;
            }
            if (matched.length < opts.filteredPerPage) {
                matched.push(item);
            }
            else {
                sawExtraMatch = true;
            }
        }
        if (apiPage + 1 >= apiPages) {
            exhausted = true;
            break;
        }
        // Enough for this filtered page — stop; more upstream pages may still hold matches.
        if (matched.length >= opts.filteredPerPage && skipped >= skipTarget) {
            break;
        }
    }
    if (!exhausted && pagesScanned >= maxScanPages) {
        capped = true;
    }
    const filled = matched.length >= opts.filteredPerPage;
    const hasMoreFiltered = sawExtraMatch || (filled && !exhausted) || (capped && filled);
    return {
        items: matched,
        found,
        pagesScanned,
        exhausted,
        capped,
        filteredPage: opts.filteredPage,
        filteredPerPage: opts.filteredPerPage,
        hasMoreFiltered,
    };
}
export async function handleListApplications(params) {
    requireToken();
    let collection = params.collection;
    let label;
    if (params.sub_collection) {
        const resolved = await resolveSubCollection(params.vacancy_id, params.sub_collection, params.collection);
        collection = resolved.collection;
        label = resolved.label;
    }
    else {
        collection = collection ?? "response";
    }
    const page = params.page ?? 0;
    const perPage = params.per_page ?? 20;
    // raw: one untouched upstream page (no client filter, no multi-page scan).
    if (params.raw) {
        const qs = collectionQuery(params.vacancy_id, page, perPage, params.order_by);
        const result = await hhGet(`/negotiations/${encodeURIComponent(collection)}?${qs}`);
        return JSON.stringify(result, null, 2);
    }
    if (params.with_updates_only === true) {
        const scan = await scanApplicationsWithUpdates({
            collection,
            vacancyId: params.vacancy_id,
            orderBy: params.order_by,
            filteredPage: page,
            filteredPerPage: perPage,
        });
        return formatApplicationList({
            items: scan.items,
            found: scan.found,
            page: scan.filteredPage,
            pages: 1,
            per_page: scan.filteredPerPage,
        }, {
            vacancyId: params.vacancy_id,
            collection,
            label,
            onlyWithUpdates: true,
            updatesScan: {
                pagesScanned: scan.pagesScanned,
                capped: scan.capped,
                exhausted: scan.exhausted,
                hasMoreFiltered: scan.hasMoreFiltered,
                filteredPage: scan.filteredPage,
            },
        });
    }
    const qs = collectionQuery(params.vacancy_id, page, perPage, params.order_by);
    const result = (await hhGet(`/negotiations/${encodeURIComponent(collection)}?${qs}`));
    return formatApplicationList(result, {
        vacancyId: params.vacancy_id,
        collection,
        label,
        onlyWithUpdates: false,
    });
}
export const getApplicationSchema = z.object({
    id: negotiationId.describe("Negotiation / application topic ID"),
    raw: rawFlag,
});
export async function handleGetApplication(params) {
    requireToken();
    const result = await hhGet(`/negotiations/${encodeURIComponent(params.id)}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatApplication(result);
}
export const getApplicationMessagesSchema = z.object({
    nid: negotiationId.describe("Negotiation / application topic ID"),
    page: z.number().int().min(0).default(0).describe("Page number (0-based)"),
    per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Messages per page (hh.ru caps at 50)"),
    raw: rawFlag,
});
export async function handleGetApplicationMessages(params) {
    requireToken();
    const query = new URLSearchParams();
    query.set("page", String(params.page ?? 0));
    query.set("per_page", String(params.per_page ?? 20));
    const result = await hhGet(`/negotiations/${encodeURIComponent(params.nid)}/messages?${query.toString()}`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatApplicationMessages(result, params.nid);
}
export const getNegotiationsStatisticsSchema = z.object({
    employer_id: employerId.describe("Employer ID"),
    raw: rawFlag,
});
export async function handleGetNegotiationsStatistics(params) {
    requireToken();
    const result = await hhGet(`/employers/${encodeURIComponent(params.employer_id)}/negotiations_statistics`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatNegotiationsStatistics(result);
}
export const getPreferredNegotiationsOrderSchema = z.object({
    vacancy_id: vacancyId.describe("Vacancy ID"),
    raw: rawFlag,
});
export async function handleGetPreferredNegotiationsOrder(params) {
    requireToken();
    const result = await hhGet(`/vacancies/${encodeURIComponent(params.vacancy_id)}/preferred_negotiations_order`);
    if (params.raw)
        return JSON.stringify(result, null, 2);
    return formatPreferredOrder(result);
}
//# sourceMappingURL=negotiations.js.map
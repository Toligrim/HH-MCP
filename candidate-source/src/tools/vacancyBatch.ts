import { createHash } from "node:crypto";
import { z } from "zod";
import { hhGet, HhAccessError, HhApiError, HhNotFoundError } from "../client.js";
import { createHhRequestBudget, HhBudgetError, type HhRequestBudget } from "../requestBudget.js";

const vacancyId = z.string().max(20).regex(/^[0-9]+$/).refine((value) => /[1-9]/.test(value), "vacancy ID must be positive");
export const getVacanciesBatchSchema = z.object({
  ids: z.array(vacancyId).min(1).max(20),
}).strict();

type BatchError = { code: string; status?: number };
type BatchItem =
  | { id: string; status: "ok"; raw: Record<string, unknown>; description_html: string; description_text: string; fetched_at: string; hash: string }
  | { id: string; status: "not_found" | "forbidden" | "error"; error: BatchError };
export type BatchResult = { items: BatchItem[]; fetched_at: string };
export type FetchVacanciesBatchOptions = { budget?: HhRequestBudget; signal?: AbortSignal; max_response_bytes?: number };

function stripHtml(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

function safeError(error: unknown): BatchError {
  if (error instanceof HhNotFoundError) return { code: "not_found", status: 404 };
  if (error instanceof HhAccessError) return { code: error.kind === "captcha" ? "captcha" : "forbidden", status: 403 };
  if (error instanceof HhApiError) return { code: error.status === 404 ? "not_found" : "http_error", status: error.status };
  if (error instanceof HhBudgetError) return { code: error.code };
  return { code: "request_failed" };
}

function outputBytes(result: BatchResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

export async function fetchVacanciesBatch(ids: string[], options: FetchVacanciesBatchOptions = {}): Promise<BatchResult> {
  const parsed = getVacanciesBatchSchema.parse({ ids });
  const uniqueIds = [...new Set(parsed.ids)];
  const cap = options.max_response_bytes ?? 64 * 1024;
  if (!Number.isSafeInteger(cap) || cap < 1024 || cap > 128 * 1024) throw new RangeError("max_response_bytes must be between 1024 and 131072");
  const budget = options.budget ?? createHhRequestBudget({ max_requests: 25, max_duration_sec: 20, max_bytes: 2 * 1024 * 1024 });
  const rows: Array<BatchItem | undefined> = Array(uniqueIds.length).fill(undefined);
  let cursor = 0;
  let stopped: "forbidden" | "budget" | undefined;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= uniqueIds.length) return;
      const id = uniqueIds[index]!;
      if (stopped) {
        rows[index] = { id, status: "error", error: { code: stopped === "forbidden" ? "stopped_forbidden" : "stopped_budget" } };
        continue;
      }
      try {
        const response = await hhGet(`/vacancies/${encodeURIComponent(id)}`, { budget, signal: options.signal });
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          rows[index] = { id, status: "error", error: { code: "malformed_response" } };
          continue;
        }
        const raw = response as Record<string, unknown>;
        if (typeof raw.id !== "string" || raw.id !== id) {
          rows[index] = { id, status: "error", error: { code: "id_mismatch" } };
          continue;
        }
        const jsonBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
        if (jsonBytes > cap) {
          rows[index] = { id, status: "error", error: { code: "response_too_large" } };
          continue;
        }
        const descriptionHtml = typeof raw.description === "string" ? raw.description : "";
        const descriptionText = stripHtml(descriptionHtml);
        const fetchedAt = new Date().toISOString();
        rows[index] = {
          id,
          status: "ok",
          raw,
          description_html: descriptionHtml,
          description_text: descriptionText,
          fetched_at: fetchedAt,
          hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
        };
      } catch (error) {
        const safe = safeError(error);
        rows[index] = { id, status: safe.status === 404 ? "not_found" : safe.status === 403 ? "forbidden" : "error", error: safe };
        if (safe.status === 403) stopped = "forbidden";
        else if (safe.code.includes("budget") || safe.code === "cancelled") stopped = "budget";
      }
    }
  };

  await Promise.all([worker(), worker()]);
  const items = rows.map((row, index) => row ?? ({ id: uniqueIds[index]!, status: "error", error: { code: "request_failed" } } as const));
  const result: BatchResult = { items, fetched_at: new Date().toISOString() };
  // Keep the envelope under its output cap while preserving an explicit row for every ID.
  for (let index = items.length - 1; outputBytes(result) > cap && index >= 0; index--) {
    const item = items[index]!;
    if (item.status === "ok") items[index] = { id: item.id, status: "error", error: { code: "response_too_large" } };
  }
  return result;
}

export async function handleGetVacanciesBatch(input: unknown): Promise<string> {
  const parsed = getVacanciesBatchSchema.parse(input);
  return JSON.stringify(await fetchVacanciesBatch(parsed.ids));
}

import { z } from "zod";

const boundedValue = z.string().trim().min(1).max(80).refine((value) => !/[<>]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32), "value must be plain bounded text");

export const postFilterSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("night_shifts"), value: z.boolean() }).strict(),
  z.object({ rule: z.literal("work_format"), value: boundedValue }).strict(),
  z.object({ rule: z.literal("work_schedule_by_days"), value: boundedValue }).strict(),
  z.object({ rule: z.literal("required_technology"), value: boundedValue }).strict(),
  z.object({ rule: z.literal("no_mandatory_phone_calls") }).strict(),
]);

export type PostFilter = z.infer<typeof postFilterSchema>;
type RuleState = "match" | "no_match" | "unknown";
type RuleResult = { rule_id: string; rule_version: string; state: RuleState; confidence: number; source: string; evidence: string };

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return [record.name, record.id].filter((part): part is string => typeof part === "string");
    }
    return [];
  });
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.name, record.id].filter((part): part is string => typeof part === "string");
  }
  return [];
}

function clauses(value: string): string[] {
  return value.split(/[.!?;,\n]|(?<!\p{L})(?:но|but|and|а|while|whereas)(?!\p{L})|при\s+этом|в\s+то\s+время\s+как/giu).map((part) => part.trim()).filter(Boolean);
}

function canonicalSchedule(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase("ru").replace(/[_\s-]+/g, "");
  if (["2/2", "twoontwooff", "2через2", "двачерездва"].includes(normalized)) return "TWO_ON_TWO_OFF";
  if (["5/2", "fiveontwooff", "пятьчерездва"].includes(normalized)) return "FIVE_ON_TWO_OFF";
  return undefined;
}

function formatKind(value: string): "remote" | "hybrid" | "office" | undefined {
  const normalized = value.toLocaleLowerCase("ru");
  if (/удал[её]н|remote|дистанцион/.test(normalized)) return "remote";
  if (/гибрид|hybrid/.test(normalized)) return "hybrid";
  if (/офис|onsite|on-site|on site/.test(normalized)) return "office";
  return undefined;
}

function ruleEvidence(vacancy: Record<string, unknown>, rule: PostFilter): Omit<RuleResult, "rule_id" | "rule_version"> {
  const description = text(vacancy.description);
  if (rule.rule === "night_shifts") {
    const schedule = vacancy.schedule && typeof vacancy.schedule === "object" ? vacancy.schedule as Record<string, unknown> : {};
    const values = [schedule.night_shifts, vacancy.night_shifts];
    if (values.some((value) => typeof value === "boolean") && values.filter((value) => typeof value === "boolean").some((value) => value !== values.find((v) => typeof v === "boolean"))) {
      return { state: "unknown", confidence: 0, source: "schedule", evidence: "Conflicting explicit night shift values" };
    }
    const found = values.find((value): value is boolean => typeof value === "boolean");
    const source = typeof schedule.night_shifts === "boolean" ? "schedule.night_shifts" : "night_shifts";
    return found === undefined
      ? { state: "unknown", confidence: 0, source: "schedule", evidence: "No explicit night shift field" }
      : { state: found === rule.value ? "match" : "no_match", confidence: 1, source, evidence: `Explicit night_shifts=${found}` };
  }
  if (rule.rule === "work_format") {
    const values = stringsFrom(vacancy.work_format);
    const wanted = formatKind(rule.value);
    const structured = values.map(formatKind).filter((value): value is NonNullable<typeof value> => value !== undefined);
    const descClauses = clauses(description);
    const remoteDenied = descClauses.some((part) => /(?:remote|удал[её]н|дистанцион).{0,45}(?:not\s+available|unavailable|not\s+offered|not\s+allowed|не\s+доступ|не\s+предусмотр|нельзя)/i.test(part));
    const mandatoryOffice = descClauses.some((part) => /(?:mandatory|обязательн|требуется).{0,45}(?:office|офис)|(?:office|офис).{0,45}(?:mandatory|required|обязательн)/i.test(part));
    const descriptionKinds = descClauses.flatMap((part) => {
      if (/(?:remote\s+(?:work|position|format)|work\s+remotely|удал[её]н(?:ная)?\s+(?:работа|формат)|работа\s+(?:удал[её]нно|дистанционно))/i.test(part)) return ["remote" as const];
      if (/(?:hybrid\s+(?:work|format)|гибридн\w*\s+(?:формат|работа))/i.test(part)) return ["hybrid" as const];
      if (/(?:office[- ]based|onsite\s+(?:work|position)|work\s+from\s+(?:the\s+)?office|работа\s+в\s+офисе|офисный\s+формат|обязательное\s+присутствие\s+в\s+офисе)/i.test(part)) return ["office" as const];
      return [];
    });
    const evidenced = [...new Set([...structured, ...descriptionKinds])];
    if (remoteDenied && (structured.includes("remote") || descriptionKinds.includes("remote"))) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description) };
    if ((structured.includes("remote") || descriptionKinds.includes("remote")) && mandatoryOffice) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description) };
    if (evidenced.length > 1) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description || values.join(" ")) };
    if (!evidenced.length || !wanted) return { state: "unknown", confidence: 0, source: "work_format", evidence: "No explicit work format evidence" };
    return { state: evidenced[0] === wanted ? "match" : "no_match", confidence: values.length ? 0.95 : 0.7, source: values.length ? "work_format" : "description", evidence: excerpt(description || values.join(" ")) };
  }
  if (rule.rule === "work_schedule_by_days") {
    const values = stringsFrom(vacancy.work_schedule_by_days);
    const wanted = canonicalSchedule(rule.value);
    if (values.length) {
      const actual = values.map(canonicalSchedule);
      if (actual.some((value) => value === undefined)) return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: excerpt(values.join(", ")) };
      const match = actual.includes(wanted);
      return { state: match ? "match" : "no_match", confidence: 0.95, source: "work_schedule_by_days", evidence: excerpt(values.join(", ")) };
    }
    const scheduleAliases = clauses(description).flatMap((part) => {
      const numeric = part.match(/\b(\d\s*(?:\/|-)\s*\d)\b/);
      if (numeric) return [canonicalSchedule(numeric[1]!.replace(/\s/g, ""))].filter((value): value is string => value !== undefined);
      if (/пятиднев\w*/i.test(part)) return ["FIVE_ON_TWO_OFF"];
      return [];
    });
    if (!scheduleAliases.length || !wanted) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(description || "No schedule evidence") };
    return { state: scheduleAliases.includes(wanted) ? "match" : "no_match", confidence: 0.7, source: "description", evidence: excerpt(description) };
  }
  if (rule.rule === "required_technology") {
    const tech = rule.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const technologyPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${tech}(?![\\p{L}\\p{N}_])`, "iu");
    const mentions = clauses(description).filter((part) => technologyPattern.test(part));
    if (mentions.length === 0) return { state: "unknown", confidence: 0, source: "description", evidence: "Technology not mentioned in description" };
    const alternatives = mentions.some((mention) => /(?<!\p{L})(?:или|or)(?!\p{L})/iu.test(mention));
    if (alternatives) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(mentions.join(" … ")) };
    const negatives = mentions.filter((mention) => /не\s+треб|не\s+обязател|не\s+нуж|not\s+required|no\s+need|no\b.*\brequired|optional|опциональн|будет\s+преимуществ|желательно|по\s+желанию|nice\s+to\s+have/i.test(mention));
    const positives = mentions.filter((mention) => /обязательн|требу(?:ется|ем)|необходим|must\s+have|required|requirement/i.test(mention) && !/не\s+треб|не\s+обязател|не\s+нуж|not\s+required|no\s+need|no\b.*\brequired/i.test(mention));
    if (positives.length && negatives.length) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(mentions.join(" … ")) };
    if (negatives.length) return { state: "no_match", confidence: 0.85, source: "description", evidence: excerpt(negatives[0]!) };
    if (positives.length) return { state: "match", confidence: 0.85, source: "description", evidence: excerpt(positives[0]!) };
    return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(mentions.join(" … ")) };
  }

  const phoneClauses = clauses(description).filter((part) => /звон\w*|позвон\w*|телефон\w*|call\w*|phone\w*/iu.test(part));
  const chatOnly = /(?:общени\w*|communication|контакт\w*).{0,50}(?:только\s+в\s+чат|только\s+через\s+чат|chat\s+only)|(?:чат\s+единственн|only\s+(?:via\s+)?chat)/i.test(description);
  if (!phoneClauses.length) return chatOnly
    ? { state: "match", confidence: 0.85, source: "description", evidence: excerpt(description) }
    : { state: "unknown", confidence: 0, source: "description", evidence: "No phone call evidence" };
  const obligation = /(?<!не)обязательн|необходим|постоянн|ежедневн|(?:входящ\w*|исходящ\w*)\s+звон|must\s+call|required\s+call|need\s+to\s+call|phone\s+calls?\s+(?:are\s+)?required|mandatory\s+(?:(?:inbound|outbound)\s+)?calls?|(?:inbound|outbound)\s+calls?\s+(?:are\s+)?mandatory|нужно\s+(?:позвон\w*|звон\w*)|требуется\s+(?:позвон\w*|звон\w*)/i;
  const negation = /(?:звон\w*|позвон\w*|calls?|phone\s+calls?).{0,35}(?:не\s+обязател|не\s+треб|not\s+mandatory|not\s+required)|(?:не\s+обязател|не\s+треб|не\s+нужно|not\s+mandatory|not\s+required).{0,35}(?:звон\w*|позвон\w*|calls?|phone\s+calls?)/i;
  const mandatory = phoneClauses.filter((part) => obligation.test(part) && !negation.test(part));
  const explicitNoCalls = phoneClauses.some((part) => /без\s+(?:телефонных\s+)?звон|работа\s+без\s+звон|звон\w*.{0,25}не\s+обязател|звон\w*.{0,25}не\s+треб|не\s+нужно\s+звон|calls?\s+not\s+mandatory|calls?\s+not\s+required/i.test(part) && !/cold|холодн/i.test(part));
  const negatedObligation = phoneClauses.some((part) => negation.test(part));
  if (mandatory.length && negatedObligation) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(phoneClauses.join(" … ")) };
  if (mandatory.length) return { state: "no_match", confidence: 0.9, source: "description", evidence: excerpt(mandatory[0]!) };
  if (explicitNoCalls) return { state: "match", confidence: 0.9, source: "description", evidence: excerpt(phoneClauses.join(" … ")) };
  if (chatOnly) return { state: "match", confidence: 0.85, source: "description", evidence: excerpt(description) };
  return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(phoneClauses.join(" … ")) };
}

function excerpt(value: string): string {
  return value.slice(0, 240);
}

export function evaluatePostFilters(
  vacancy: Record<string, unknown>,
  rules: PostFilter[],
  mode: "strict" | "inclusive" | "review",
): { decision: "keep" | "exclude" | "review"; rules: RuleResult[] } {
  if (rules.length > 20) throw new RangeError("At most 20 post filters are allowed");
  const results = rules.map((rule) => ({ rule_id: rule.rule, rule_version: "1", ...ruleEvidence(vacancy, rule) }));
  const hasNoMatch = results.some((result) => result.state === "no_match");
  const hasUnknown = results.some((result) => result.state === "unknown");
  const decision = hasNoMatch || (mode === "strict" && hasUnknown)
    ? "exclude"
    : mode === "review" && hasUnknown ? "review" : "keep";
  return { decision, rules: results };
}

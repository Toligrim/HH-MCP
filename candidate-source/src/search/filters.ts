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

function ruleEvidence(vacancy: Record<string, unknown>, rule: PostFilter): Omit<RuleResult, "rule_id" | "rule_version"> {
  const description = text(vacancy.description);
  if (rule.rule === "night_shifts") {
    const schedule = vacancy.schedule && typeof vacancy.schedule === "object" ? vacancy.schedule as Record<string, unknown> : {};
    const values = [schedule.night_shifts, vacancy.night_shifts];
    if (values.some((value) => typeof value === "boolean") && values.filter((value) => typeof value === "boolean").some((value) => value !== values.find((v) => typeof v === "boolean"))) {
      return { state: "unknown", confidence: 0, source: "schedule", evidence: "Conflicting explicit night shift values" };
    }
    const found = values.find((value): value is boolean => typeof value === "boolean");
    return found === undefined
      ? { state: "unknown", confidence: 0, source: "schedule", evidence: "No explicit night shift field" }
      : { state: found === rule.value ? "match" : "no_match", confidence: 1, source: "schedule.night_shifts", evidence: `Explicit night_shifts=${found}` };
  }
  if (rule.rule === "work_format") {
    const values = stringsFrom(vacancy.work_format);
    const haystack = [...values, description].join(" ").toLocaleLowerCase("ru");
    const wanted = rule.value.toLocaleLowerCase("ru");
    const remote = /удал[её]н|remote|дистанцион/.test(haystack);
    const hybrid = /гибрид|hybrid/.test(haystack);
    const office = /офис|на\s+месте|onsite|on-site/.test(haystack);
    if (remote && hybrid) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description || values.join(" ")) };
    const match = values.some((value) => value.toLocaleLowerCase("ru") === wanted) || haystack.includes(wanted);
    if (!values.length && !remote && !hybrid && !office) return { state: "unknown", confidence: 0, source: "work_format", evidence: "No explicit work format evidence" };
    return { state: match ? "match" : "no_match", confidence: values.length ? 0.95 : 0.7, source: values.length ? "work_format" : "description", evidence: excerpt(description || values.join(" ")) };
  }
  if (rule.rule === "work_schedule_by_days") {
    const values = stringsFrom(vacancy.work_schedule_by_days);
    const haystack = [...values, description].join(" ").toLocaleLowerCase("ru");
    const match = values.some((value) => value.toLocaleLowerCase("ru") === rule.value.toLocaleLowerCase("ru")) || haystack.includes(rule.value.toLocaleLowerCase("ru"));
    const hasScheduleEvidence = /\b\d\s*[/хx-]\s*\d\b|пятиднев|шестиднев|график\s+работ|выходн\w*|смен\w*|schedule|weekend|weekdays/i.test(haystack);
    if (!values.length && !hasScheduleEvidence) return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: "No schedule evidence" };
    return { state: match ? "match" : "no_match", confidence: values.length ? 0.95 : 0.65, source: values.length ? "work_schedule_by_days" : "description", evidence: excerpt(description || values.join(" ")) };
  }
  if (rule.rule === "required_technology") {
    const tech = rule.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const technologyPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${tech}(?![\\p{L}\\p{N}_])`, "iu");
    const mentions = description.split(/[.!?;,\n]|\b(?:но|but)\b/giu).map((part) => part.trim()).filter((part) => technologyPattern.test(part));
    if (mentions.length === 0) return { state: "unknown", confidence: 0, source: "description", evidence: "Technology not mentioned in description" };
    const negatives = mentions.filter((mention) => /не\s+треб|не\s+обязател|не\s+нуж|not\s+required|no\s+need|no\b.*\brequired|optional|опциональн|будет\s+преимуществ|желательно|по\s+желанию|nice\s+to\s+have/i.test(mention));
    const positives = mentions.filter((mention) => /обязательн|требу(?:ется|ем)|необходим|must\s+have|required|requirement/i.test(mention) && !/не\s+треб|не\s+обязател|не\s+нуж|not\s+required|no\s+need|no\b.*\brequired/i.test(mention));
    if (positives.length && negatives.length) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(mentions.join(" … ")) };
    if (negatives.length) return { state: "no_match", confidence: 0.85, source: "description", evidence: excerpt(negatives[0]!) };
    if (positives.length) return { state: "match", confidence: 0.85, source: "description", evidence: excerpt(positives[0]!) };
    return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(mentions.join(" … ")) };
  }

  const phoneMentions = [...description.matchAll(/.{0,100}(?:звонк\w*|телефон\w*|call\w*|phone\w*).{0,100}/giu)].map((match) => match[0]);
  const chatOnly = /(?:общени\w*|communication|контакт\w*).{0,50}(?:только\s+в\s+чат|только\s+через\s+чат|chat\s+only)|(?:чат\s+единственн|only\s+(?:via\s+)?chat)/i.test(description);
  if (!phoneMentions.length) return chatOnly
    ? { state: "match", confidence: 0.85, source: "description", evidence: excerpt(description) }
    : { state: "unknown", confidence: 0, source: "description", evidence: "No phone call evidence" };
  const mandatory = phoneMentions.filter((part) => /обязательн|необходим|постоянн|ежедневн|входящ\w*|исходящ\w* звон|must\s+call|required\s+call|phone\s+calls?\s+(?:are\s+)?required|mandatory\s+(?:(?:inbound|outbound)\s+)?calls?|(?:inbound|outbound)\s+calls?\s+(?:are\s+)?mandatory/i.test(part));
  if (mandatory.length) return { state: "no_match", confidence: 0.9, source: "description", evidence: excerpt(mandatory[0]!) };
  if (chatOnly) return { state: "match", confidence: 0.85, source: "description", evidence: excerpt(description) };
  return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(phoneMentions.join(" … ")) };
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

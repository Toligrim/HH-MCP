import { z } from "zod";
import { getSearchDictionaryIds } from "./dictionaries.js";

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

const scheduleIds = new Set(getSearchDictionaryIds("work_schedule_by_days"));
const formatIds = new Set(getSearchDictionaryIds("work_format"));
const scheduleLabels: Record<string, string> = {
  SIX_ON_ONE_OFF: "6/1", FIVE_ON_TWO_OFF: "5/2", FOUR_ON_FOUR_OFF: "4/4", FOUR_ON_THREE_OFF: "4/3",
  FOUR_ON_TWO_OFF: "4/2", THREE_ON_THREE_OFF: "3/3", THREE_ON_TWO_OFF: "3/2", TWO_ON_TWO_OFF: "2/2",
  TWO_ON_ONE_OFF: "2/1", ONE_ON_THREE_OFF: "1/3", ONE_ON_TWO_OFF: "1/2",
  WEEKEND: "По выходным", FLEXIBLE: "Свободный", OTHER: "Другое",
};
const supportedNumericScheduleLabels = new Set([...scheduleIds].flatMap((id) => {
  const label = scheduleLabels[id];
  return label && /^\d\/\d$/.test(label) ? [label] : [];
}));
const scheduleLabelIds = new Map(Object.entries(scheduleLabels).map(([id, label]) => [label.toLocaleLowerCase("ru"), id]));
function canonicalSchedule(value: string): string | undefined {
  if (scheduleIds.has(value)) return value;
  const normalized = value.toLocaleLowerCase("ru").replace(/[_\s-]+/g, "");
  const compactLabels = new Map([...scheduleLabelIds].map(([label, id]) => [label.replace(/\s/g, ""), id]));
  return compactLabels.get(normalized) ?? scheduleLabelIds.get(value.toLocaleLowerCase("ru")) ??
    ({ "2/2": "TWO_ON_TWO_OFF", twoontwooff: "TWO_ON_TWO_OFF", "2через2": "TWO_ON_TWO_OFF", двачерездва: "TWO_ON_TWO_OFF",
      "5/2": "FIVE_ON_TWO_OFF", fiveontwooff: "FIVE_ON_TWO_OFF", пятьчерездва: "FIVE_ON_TWO_OFF" } as Record<string, string>)[normalized];
}

function schedulePattern(id: string): string | undefined {
  const numeric = scheduleLabels[id];
  if (/^\d\/\d$/.test(numeric ?? "")) return `(?<!\\d)${(numeric ?? "").replace("/", "\\s*[/\\-]\\s*")}(?!\\d)`;
  if (id === "WEEKEND") return "(?:weekends?(?:\\s+schedule)?|(?:работа\\s+)?по\\s+выходным|выходн[а-яё]*\\s+(?:график|работа))";
  if (id === "FLEXIBLE") return "(?:flexible\\s+(?:work\\s+)?schedule|гибк[а-яё]*\\s+(?:график|расписание)|свободн[а-яё]*\\s+(?:график|расписание))";
  if (id === "OTHER") return "(?:other\\s+(?:work\\s+)?schedule|(?:другой|иной)\\s+(?:график|режим|расписание)|другое\\s+(?:расписание|график))";
  return undefined;
}

function schedulesInDescription(value: string): string[] {
  return clauses(value).flatMap((part) => [...scheduleIds].filter((id) => {
    const pattern = schedulePattern(id);
    return pattern ? new RegExp(pattern, "iu").test(part) : false;
  }));
}

function hasUnsupportedNumericSchedule(value: string): boolean {
  const scheduleContext = /\b(?:work\s+)?schedule\b|график[а-яё]*|расписани[а-яё]*|режим(?:\s+работы)?/iu;
  return clauses(value).some((part) => {
    for (const match of part.matchAll(/(?<!\d)(\d+)\s*([/-])\s*(\d+)(?!\d)/gu)) {
      const normalized = `${match[1]}/${match[3]}`;
      if (supportedNumericScheduleLabels.has(normalized)) continue;
      const index = match.index ?? 0;
      const context = part.slice(Math.max(0, index - 32), Math.min(part.length, index + match[0].length + 32));
      if (scheduleContext.test(context)) return true;
    }
    return false;
  });
}

function formatKind(value: string): "remote" | "hybrid" | "office" | "field" | undefined {
  if (formatIds.has(value)) return value === "REMOTE" ? "remote" : value === "HYBRID" ? "hybrid" : value === "ON_SITE" ? "office" : "field";
  const normalized = value.toLocaleLowerCase("ru");
  if (/удал[её]н|remote|дистанцион/.test(normalized)) return "remote";
  if (/гибрид|hybrid/.test(normalized)) return "hybrid";
  if (/разъезд|field\s*work/.test(normalized)) return "field";
  if (/офис|onsite|on-site|on site|на месте работодател/.test(normalized)) return "office";
  return undefined;
}

function formatAliasKind(value: string): ReturnType<typeof formatKind> {
  if (formatIds.has(value)) return formatKind(value);
  const normalized = value.toLocaleLowerCase("ru").replace(/[\s_-]+/g, "");
  const aliases: Record<string, NonNullable<ReturnType<typeof formatKind>>> = {
    remote: "remote", удаленно: "remote", удалённо: "remote", дистанционно: "remote",
    hybrid: "hybrid", гибрид: "hybrid", office: "office", офис: "office", onsite: "office", наместеработодателя: "office",
    fieldwork: "field", разъездной: "field",
  };
  return aliases[normalized];
}

function formatDenied(kind: NonNullable<ReturnType<typeof formatKind>>, clause: string): boolean {
  const term = kind === "remote" ? "(?:remote|удал[её]н[а-яё]*|дистанцион[а-яё]*)"
    : kind === "hybrid" ? "(?:hybrid|гибрид[а-яё]*)"
      : kind === "field" ? "(?:field\\s*work|разъезд[а-яё]*)"
        : "(?:office|офис[а-яё]*|onsite|on-site|on\\s+site|на\\s+месте\\s+работодател[а-яё]*)";
  const denial = "(?:not\\s+(?:available|offered|allowed|provided|possible)|unavailable|isn't\\s+(?:available|offered)|не\\s+(?:доступ[а-яё]*|предусмотр[а-яё]*|предлага[а-яё]*|разреш[а-яё]*)|недоступ[а-яё]*|непредусмотр[а-яё]*|непредлага[а-яё]*|нельзя)";
  const formatContext = "(?:work|format|position|option|arrangement|работ[аы]|формат|позици[яи]|вариант)";
  return new RegExp(`(?:no\\s+${term}\\s+${formatContext}|${term}.{0,25}${formatContext}.{0,30}(?:${denial})|${term}\\s+(?:is\\s+)?(?:${denial})|(?:${denial}).{0,30}${term})`, "iu").test(clause);
}

type StructuredValue = { id?: string; name?: string; valid: boolean };
function structuredValues(value: unknown): StructuredValue[] {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === "string") return { id: item, valid: true };
    if (!item || typeof item !== "object" || Array.isArray(item)) return { valid: false };
    const record = item as Record<string, unknown>;
    return { id: typeof record.id === "string" ? record.id : undefined, name: typeof record.name === "string" ? record.name : undefined,
      valid: typeof record.id === "string" && (record.name === undefined || typeof record.name === "string") };
  });
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
    const entries = structuredValues(vacancy.work_format);
    const values = stringsFrom(vacancy.work_format);
    const wanted = formatAliasKind(rule.value);
    const structuredKinds: Array<NonNullable<ReturnType<typeof formatKind>>> = [];
    if (entries.length) {
      for (const entry of entries) {
        if (!entry.valid || !entry.id) return { state: "unknown", confidence: 0, source: "work_format", evidence: excerpt("Malformed work format") };
        if (!formatIds.has(entry.id)) {
          const alias = entry.name === undefined ? formatAliasKind(entry.id) : undefined;
          if (alias) { structuredKinds.push(alias); continue; }
          return { state: "unknown", confidence: 0, source: "work_format", evidence: excerpt(entry.id) };
        }
        const kind = formatKind(entry.id)!;
        const namedKind = entry.name ? formatAliasKind(entry.name) : undefined;
        if (namedKind && namedKind !== kind) return { state: "unknown", confidence: 0, source: "work_format", evidence: excerpt(`${entry.id}: ${entry.name}`) };
        structuredKinds.push(kind);
      }
    }
    const descClauses = clauses(description);
    if (wanted && descClauses.some((part) => formatDenied(wanted, part))) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description) };
    const remoteDenied = descClauses.some((part) => /(?:remote|удал[её]н|дистанцион).{0,45}(?:not\s+available|unavailable|not\s+offered|not\s+allowed|не\s+доступ|не\s+предусмотр|нельзя)/i.test(part)
      || /(?:\bno\s+remote\b|\bremote\s+(?:work|work\s+format)\s+(?:is\s+)?(?:not\s+available|unavailable|not\s+offered|not\s+allowed)|не\s+(?:предусмотрена\s+)?удал[её]н|удал[её]н\w*.{0,30}не\s+(?:доступ|предусмотр|разреш))/i.test(part));
    const mandatoryOffice = descClauses.some((part) => /(?:mandatory|обязательн|требуется).{0,45}(?:office|офис)|(?:office|офис).{0,45}(?:mandatory|required|обязательн)/i.test(part));
    const descriptionKinds = descClauses.flatMap((part) => {
      const kinds: Array<"remote" | "hybrid" | "field" | "office"> = [];
      if (/(?:remote\s+(?:work|position|format)|work\s+remotely|удал[её]н[а-яё]*\s+(?:работа|формат|или)|работа\s+(?:удал[её]нно|дистанционно))/iu.test(part)) kinds.push("remote");
      if (/(?:hybrid\s+(?:work|format)|гибридн[а-яё]*\s+(?:формат|работа))/iu.test(part)) kinds.push("hybrid");
      if (/(?:field\s*work|разъездн[а-яё]*\s+(?:формат|работа|характер)|работа\s+разъездн[а-яё]*)/iu.test(part)) kinds.push("field");
      if (/(?:office[- ]based|onsite\s+(?:work|position)|work\s+from\s+(?:the\s+)?office|работа\s+в\s+офисе|офисный\s+формат|обязательное\s+присутствие\s+в\s+офисе)/iu.test(part)) kinds.push("office");
      return kinds;
    });
    const evidenced = [...new Set([...structuredKinds, ...descriptionKinds])];
    if (remoteDenied && (structuredKinds.includes("remote") || descriptionKinds.includes("remote"))) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description) };
    if ((structuredKinds.includes("remote") || descriptionKinds.includes("remote")) && mandatoryOffice) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description) };
    if ((!structuredKinds.length && evidenced.length > 1) || (structuredKinds.length && descriptionKinds.some((kind) => !structuredKinds.includes(kind)))) return { state: "unknown", confidence: 0, source: values.length ? "work_format,description" : "description", evidence: excerpt(description || values.join(" ")) };
    if (!evidenced.length || !wanted) return { state: "unknown", confidence: 0, source: "work_format", evidence: "No explicit work format evidence" };
    const hasStructured = structuredKinds.length > 0;
    const found = hasStructured ? structuredKinds : descriptionKinds;
    return { state: found.includes(wanted) ? "match" : "no_match", confidence: hasStructured ? 0.95 : 0.7, source: hasStructured ? "work_format" : "description", evidence: excerpt(description || values.join(" ")) };
  }
  if (rule.rule === "work_schedule_by_days") {
    const entries = structuredValues(vacancy.work_schedule_by_days);
    const values = stringsFrom(vacancy.work_schedule_by_days);
    const wanted = canonicalSchedule(rule.value);
    if (!wanted || !scheduleIds.has(wanted)) return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: "Unknown requested schedule" };
    const wantedPattern = wanted === "TWO_ON_TWO_OFF" ? `(?:${schedulePattern(wanted)}|two\\s+on\\s+two\\s+off|2\\s+через\\s+2|два\\s+через\\s+два)`
      : wanted === "FIVE_ON_TWO_OFF" ? `(?:${schedulePattern(wanted)}|five\\s+on\\s+two\\s+off|5\\s+через\\s+2|пять\\s+через\\s+два)`
        : schedulePattern(wanted);
    const negatedWanted = wantedPattern && clauses(description).some((part) => {
      const negatedBefore = new RegExp(`(?:\\b(?:not|do not|does not|don't|doesn't)(?:\\s+(?:work|offer|use|follow|schedule)){0,3}\\s+|\\bno\\s+|не\\s+(?:работаем\\s+)?)(?:schedule\\s+)?${wantedPattern}`, "iu");
      const negatedAfter = new RegExp(`${wantedPattern}\\s+(?:(?:is|was)\\s+)?(?:not\\s+(?:offered|available|used|followed)|isn't\\s+(?:offered|available)|не\\s+(?:предлагается|доступен|используется))`, "iu");
      return negatedBefore.test(part) || negatedAfter.test(part);
    });
    if (negatedWanted) return { state: "unknown", confidence: 0, source: values.length ? "work_schedule_by_days,description" : "description", evidence: excerpt(description) };
    if (entries.length) {
      const actual: string[] = [];
      for (const entry of entries) {
        if (!entry.valid || !entry.id) return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: excerpt("Malformed work schedule") };
        if (!scheduleIds.has(entry.id)) {
          const alias = entry.name === undefined ? canonicalSchedule(entry.id) : undefined;
          if (alias) { actual.push(alias); continue; }
          return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: excerpt(entry.id) };
        }
        if (entry.name) {
          const namedSchedule = canonicalSchedule(entry.name);
          if (namedSchedule && namedSchedule !== entry.id) return { state: "unknown", confidence: 0, source: "work_schedule_by_days", evidence: excerpt(`${entry.id}: ${entry.name}`) };
        }
        actual.push(entry.id);
      }
      const descriptionConflict = hasUnsupportedNumericSchedule(description) || clauses(description).some((part) => {
        const described = [...scheduleIds].filter((id) => {
          const pattern = schedulePattern(id);
          return pattern ? new RegExp(pattern, "iu").test(part) : false;
        });
        return described.some((id) => !actual.includes(id));
      });
      if (descriptionConflict) return { state: "unknown", confidence: 0, source: "work_schedule_by_days,description", evidence: excerpt(description) };
      const match = actual.includes(wanted);
      return { state: match ? "match" : "no_match", confidence: 0.95, source: "work_schedule_by_days", evidence: excerpt(values.join(", ")) };
    }
    const scheduleAliases = schedulesInDescription(description).concat(/пятиднев[а-яё]*/iu.test(description) ? ["FIVE_ON_TWO_OFF"] : []);
    if (!scheduleAliases.length) return { state: "unknown", confidence: 0, source: "description", evidence: excerpt(description || "No schedule evidence") };
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

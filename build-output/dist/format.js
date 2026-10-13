// Compact, LLM-friendly formatters for hh.ru responses.
//
// hh.ru payloads are large and deeply nested; dumping raw JSON for every search
// result burns tokens and buries the signal. These helpers render concise text.
// Every tool that uses them still exposes `raw: true` to get the full JSON.
//
// Inputs are typed against ./types.ts (which was previously dead code) but kept
// defensive — the API returns more fields than we model, and some are optional.
const RU = "ru-RU";
function stripTags(s) {
    return s
        .replace(/<\/?[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 1).trimEnd() + "…";
}
export function formatSalary(salary) {
    if (!salary || (salary.from == null && salary.to == null)) {
        return "з/п не указана";
    }
    const cur = salary.currency || "RUR";
    const sym = cur === "RUR" ? "₽" : cur;
    const fmt = (n) => n.toLocaleString(RU);
    let range;
    if (salary.from != null && salary.to != null) {
        range = `${fmt(salary.from)}–${fmt(salary.to)}`;
    }
    else if (salary.from != null) {
        range = `от ${fmt(salary.from)}`;
    }
    else {
        range = `до ${fmt(salary.to)}`;
    }
    const gross = salary.gross === true
        ? " (до вычета налога)"
        : salary.gross === false
            ? " (на руки)"
            : "";
    return `${range} ${sym}${gross}`;
}
function paginationHeader(noun, result) {
    const found = typeof result.found === "number" ? result.found.toLocaleString(RU) : "?";
    const page = (result.page ?? 0) + 1;
    const pages = result.pages ?? 1;
    const shown = result.items?.length ?? 0;
    return `Найдено ${noun}: ${found} (страница ${page} из ${pages}, показано ${shown})`;
}
export function formatVacancyListItem(v, idx) {
    const lines = [];
    lines.push(`${idx}. ${v.name} — ${v.employer?.name ?? "—"}`);
    const meta = [
        formatSalary(v.salary),
        v.area?.name,
        v.schedule?.name,
        v.experience?.name,
    ].filter(Boolean);
    lines.push(`   ${meta.join(" · ")}`);
    const snippet = [v.snippet?.requirement, v.snippet?.responsibility]
        .filter(Boolean)
        .map((s) => stripTags(String(s)))
        .join(" ")
        .trim();
    if (snippet)
        lines.push(`   ${truncate(snippet, 220)}`);
    lines.push(`   id=${v.id} · ${v.alternate_url ?? ""}`.trimEnd());
    return lines.join("\n");
}
export function formatVacancySearch(result) {
    const header = paginationHeader("вакансий", result);
    if (!result.items?.length)
        return `${header}\n(пусто)`;
    return (header +
        "\n\n" +
        result.items.map((v, i) => formatVacancyListItem(v, i + 1)).join("\n\n"));
}
export function formatVacancyDetail(v) {
    const lines = [];
    lines.push(`# ${v.name}`);
    lines.push(`Работодатель: ${v.employer?.name ?? "—"}` +
        (v.employer?.alternate_url ? ` (${v.employer.alternate_url})` : ""));
    lines.push(`Зарплата: ${formatSalary(v.salary)}`);
    if (v.area?.name)
        lines.push(`Регион: ${v.area.name}`);
    const conditions = [v.experience?.name, v.employment?.name, v.schedule?.name].filter(Boolean);
    if (conditions.length)
        lines.push(`Условия: ${conditions.join(" · ")}`);
    if (v.key_skills?.length) {
        lines.push(`Ключевые навыки: ${v.key_skills.map((s) => s.name).join(", ")}`);
    }
    if (v.description) {
        lines.push(`\nОписание:\n${truncate(stripTags(v.description), 4000)}`);
    }
    if (v.contacts) {
        const phones = v.contacts.phones?.map((p) => p.number).filter(Boolean).join(", ");
        const contact = [v.contacts.name, v.contacts.email, phones].filter(Boolean).join(" · ");
        if (contact)
            lines.push(`\nКонтакты: ${contact}`);
    }
    lines.push(`\nСсылка: ${v.alternate_url ?? ""}  ·  id=${v.id}`);
    return lines.join("\n");
}
export function formatEmployerListItem(e, idx) {
    const meta = [
        e.area?.name,
        typeof e.open_vacancies === "number" ? `${e.open_vacancies} вакансий` : null,
    ].filter(Boolean);
    const tail = meta.length ? `\n   ${meta.join(" · ")}` : "";
    return `${idx}. ${e.name} (id=${e.id})${tail}\n   ${e.alternate_url ?? ""}`.trimEnd();
}
export function formatEmployerSearch(result) {
    const header = paginationHeader("работодателей", result);
    if (!result.items?.length)
        return `${header}\n(пусто)`;
    return (header +
        "\n\n" +
        result.items.map((e, i) => formatEmployerListItem(e, i + 1)).join("\n"));
}
export function formatEmployer(e) {
    const lines = [];
    lines.push(`# ${e.name} (id=${e.id})`);
    if (e.area?.name)
        lines.push(`Регион: ${e.area.name}`);
    if (typeof e.open_vacancies === "number") {
        lines.push(`Открытых вакансий: ${e.open_vacancies}`);
    }
    if (e.industries?.length) {
        lines.push(`Отрасли: ${e.industries.map((i) => i.name).join(", ")}`);
    }
    if (e.site_url)
        lines.push(`Сайт: ${e.site_url}`);
    if (e.description)
        lines.push(`\n${truncate(stripTags(e.description), 1500)}`);
    lines.push(`\nСсылка: ${e.alternate_url ?? ""}`);
    return lines.join("\n");
}
export function formatResumeListItem(r, idx) {
    const meta = [
        r.area?.name,
        r.age ? `${r.age} лет` : null,
        r.total_experience ? `опыт ${Math.round(r.total_experience.months / 12)} лет` : null,
        r.salary ? formatSalary({ from: r.salary.amount, currency: r.salary.currency }) : null,
    ].filter(Boolean);
    const tail = meta.length ? `\n   ${meta.join(" · ")}` : "";
    return `${idx}. ${r.title} (id=${r.id})${tail}\n   ${r.alternate_url ?? ""}`.trimEnd();
}
export function formatResumeSearch(result) {
    const header = paginationHeader("резюме", result);
    if (!result.items?.length)
        return `${header}\n(пусто)`;
    return (header +
        "\n\n" +
        result.items.map((r, i) => formatResumeListItem(r, i + 1)).join("\n"));
}
export function formatResume(r) {
    const lines = [];
    lines.push(`# ${r.title} (id=${r.id})`);
    const head = [
        r.area?.name,
        r.age ? `${r.age} лет` : null,
        r.gender?.name,
        r.salary ? formatSalary({ from: r.salary.amount, currency: r.salary.currency }) : null,
    ].filter(Boolean);
    if (head.length)
        lines.push(head.join(" · "));
    if (r.total_experience) {
        lines.push(`Общий опыт: ${Math.round(r.total_experience.months / 12)} лет`);
    }
    if (r.experience?.length) {
        lines.push("\nОпыт работы:");
        for (const e of r.experience.slice(0, 10)) {
            const period = [e.start, e.end ?? "по наст. время"].filter(Boolean).join(" – ");
            lines.push(`  • ${[e.position, e.company].filter(Boolean).join(" @ ")} (${period})`);
        }
    }
    if (r.education?.primary?.length) {
        lines.push("\nОбразование:");
        for (const ed of r.education.primary.slice(0, 5)) {
            lines.push(`  • ${[ed.name, ed.organization, ed.year].filter(Boolean).join(", ")}`);
        }
    }
    if (r.skill_set?.length)
        lines.push(`\nНавыки: ${r.skill_set.join(", ")}`);
    lines.push(`\nСсылка: ${r.alternate_url ?? ""}`);
    return lines.join("\n");
}
/** Flatten the (large) /areas or /professional_roles tree into "id — name" lines. */
export function flattenAreaTree(areas, depth = 0) {
    const out = [];
    for (const a of areas) {
        out.push(`${"  ".repeat(depth)}${a.id} — ${a.name}`);
        if (a.areas?.length)
            out.push(flattenAreaTree(a.areas, depth + 1));
    }
    return out.join("\n");
}
export function formatNamedIdList(items, empty = "(пусто)") {
    if (!items?.length)
        return empty;
    return items.map((i) => `${i.id} — ${i.name}`).join("\n");
}
const MOSCOW_DT = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});
/** Compact Moscow datetime: `12.09.2026 10:54`. Independent of the host timezone. */
export function fmtDateTime(value) {
    if (!value)
        return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return String(value);
    const parts = MOSCOW_DT.formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}`;
}
/** Russian duration: `2 г. 3 мес.` / `2 г.` / `3 мес.`. */
export function fmtMonths(months) {
    if (months == null)
        return null;
    const years = Math.floor(months / 12);
    const rest = months % 12;
    if (years && rest)
        return `${years} г. ${rest} мес.`;
    if (years)
        return `${years} г.`;
    return `${rest} мес.`;
}
/** Russian age with pluralisation: `48 лет` / `1 год` / `2 года`. */
export function fmtAge(age) {
    if (age == null)
        return null;
    const abs = Math.abs(age) % 100;
    const last = abs % 10;
    const form = abs > 10 && abs < 20 ? "лет" : last === 1 ? "год" : last >= 2 && last <= 4 ? "года" : "лет";
    return `${age} ${form}`;
}
function fmtAmountSalary(salary) {
    if (!salary || salary.amount == null)
        return null;
    const sym = !salary.currency || salary.currency === "RUR" ? "₽" : salary.currency;
    return `${Number(salary.amount).toLocaleString(RU)} ${sym}`;
}
function fullName(resume) {
    const name = [resume?.last_name, resume?.first_name, resume?.middle_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    return name || "Без имени";
}
export function formatApplicationCollections(data, vacancyId) {
    const lines = [];
    let total = 0;
    for (const c of data.collections ?? []) {
        if (c.hidden)
            continue;
        const count = c.counters?.total ?? 0;
        const updates = c.counters?.with_updates ?? 0;
        total += count;
        lines.push(`• ${c.name} [${c.id}]: ${count}${updates ? ` · с изменениями ${updates}` : ""}`);
        for (const sub of c.sub_collections ?? []) {
            const n = sub.counters?.total ?? 0;
            const u = sub.counters?.with_updates ?? 0;
            lines.push(`    – ${sub.name} (sub_collection id ${sub.id}): ${n}${u ? ` · с изменениями ${u}` : ""}`);
        }
    }
    let body;
    if (!lines.length) {
        body = `Воронка откликов по вакансии ${vacancyId}: данных нет (вакансия не ваша или не найдена)`;
    }
    else {
        body = [
            `Воронка откликов по вакансии ${vacancyId}: всего ${total}`,
            "",
            ...lines,
            "",
            `Итого откликов: ${total}`,
        ].join("\n");
    }
    const states = data.employer_states ?? [];
    if (!states.length)
        return body;
    return `${body}\n\nСостояния работодателя:\n${formatNamedIdList(states)}`;
}
export function formatNegotiationListItem(n, idx) {
    const r = n.resume ?? {};
    const head = [fullName(r), fmtAge(r.age)].filter(Boolean).join(", ");
    const lines = [`${idx}. ${head} — ${r.title ?? "без должности"}`];
    const state = n.employer_state?.name ?? n.state?.name ?? "—";
    const substage = n.funnel_stage?.substate?.name;
    lines.push(`   ${[
        substage ? `${state} / ${substage}` : state,
        `отклик ${fmtDateTime(n.created_at)}`,
        n.has_updates ? `изменения ${fmtDateTime(n.updated_at)}` : null,
        n.counters?.messages != null
            ? `сообщений ${n.counters.messages}${n.counters.unread_messages ? ` (новых ${n.counters.unread_messages})` : ""}`
            : null,
    ]
        .filter(Boolean)
        .join(" · ")}`);
    lines.push(`   ${[
        r.total_experience?.months != null ? `опыт ${fmtMonths(r.total_experience.months)}` : null,
        n.relevant_experience?.total_months != null
            ? `релевантный ${fmtMonths(n.relevant_experience.total_months)}`
            : null,
        r.area?.name,
        fmtAmountSalary(r.salary),
        `тема ${n.id}`,
        r.id ? `resume_id=${r.id}` : null,
        r.alternate_url,
    ]
        .filter(Boolean)
        .join(" · ")}`);
    return lines.join("\n");
}
/** `1 страница` / `2 страницы` / `5 страниц` for scan headers. */
function fmtScannedPages(n) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    const word = abs > 10 && abs < 20
        ? "страниц"
        : last === 1
            ? "страница"
            : last >= 2 && last <= 4
                ? "страницы"
                : "страниц";
    return `${n} ${word}`;
}
function updatesFilterSummary(itemsLength, found, scan) {
    const summary = `после фильтра ${itemsLength} из ${found}`;
    if (!scan)
        return summary;
    const parts = [`просмотрено ${fmtScannedPages(scan.pagesScanned)}`];
    if (scan.filteredPage != null && scan.filteredPage > 0) {
        parts.unshift(`страница фильтра ${scan.filteredPage + 1}`);
    }
    if (scan.capped) {
        parts.push("просмотр не завершён — есть ещё страницы");
    }
    return `${summary} (${parts.join("; ")})`;
}
export function formatApplicationList(result, options = {}) {
    const items = result.items ?? [];
    const found = typeof result.found === "number" ? result.found : items.length;
    const page = (result.page ?? 0) + 1;
    const pages = result.pages ?? 1;
    const collection = options.collection ?? "response";
    const label = options.label ?? collection;
    let header;
    if (options.vacancyId) {
        header =
            `Отклики по вакансии ${options.vacancyId} — ${label} [${collection}]: ` +
                (options.onlyWithUpdates
                    ? updatesFilterSummary(items.length, found, options.updatesScan)
                    : `${found} найдено (страница ${page} из ${pages}, показано ${items.length})`);
    }
    else {
        header = options.onlyWithUpdates
            ? `Найдено откликов: ${updatesFilterSummary(items.length, found, options.updatesScan)}`
            : paginationHeader("откликов", result);
    }
    const note = options.onlyWithUpdates
        ? "\n(фильтр: только отклики с изменениями от соискателя)"
        : "";
    // (пусто) only after an exhaustive scan (or when not scanning). A capped
    // zero-hit must not read as "inbox clear".
    const allowEmptyMarker = !options.onlyWithUpdates ||
        !options.updatesScan ||
        (options.updatesScan.exhausted && !options.updatesScan.capped);
    if (!items.length) {
        return allowEmptyMarker ? `${header}${note}\n(пусто)` : `${header}${note}`;
    }
    const nextHint = options.onlyWithUpdates && options.updatesScan?.hasMoreFiltered
        ? `\n\nСледующая страница фильтра: page=${(options.updatesScan.filteredPage ?? 0) + 1}`
        : "";
    return (`${header}${note}\n\n` +
        items.map((n, i) => formatNegotiationListItem(n, i + 1)).join("\n\n") +
        nextHint);
}
export function formatApplication(n, opts = {}) {
    const r = n.resume ?? {};
    const lines = [];
    const head = [fullName(r), fmtAge(r.age)].filter(Boolean).join(", ");
    lines.push(`# ${head} — ${r.title ?? "без должности"}`);
    const vacId = n.vacancy?.id ?? opts.vacancyId;
    lines.push(`Вакансия: ${n.vacancy?.name ?? "—"}${vacId ? ` (id=${vacId})` : ""}`);
    const stage = [n.employer_state?.name ?? n.state?.name, n.funnel_stage?.substate?.name]
        .filter(Boolean)
        .join(" / ");
    lines.push(`Этап: ${stage || "—"} · тема ${n.id} · источник ${n.source ?? "—"}`);
    lines.push(`Создан: ${fmtDateTime(n.created_at)} · активность: ${fmtDateTime(n.updated_at)}` +
        (n.has_updates ? " · есть изменения" : "") +
        (n.viewed_by_opponent === false ? " · соискатель не читал" : ""));
    const candidate = [
        r.area?.name,
        r.gender?.name,
        fmtAmountSalary(r.salary),
        r.total_experience?.months != null ? `опыт ${fmtMonths(r.total_experience.months)}` : null,
        r.citizenship?.length
            ? `гражданство: ${r.citizenship.map((c) => c.name).join(", ")}`
            : null,
    ].filter(Boolean);
    if (candidate.length)
        lines.push(`Кандидат: ${candidate.join(" · ")}`);
    const rel = n.relevant_experience;
    if (rel?.total_months != null) {
        lines.push(`Релевантный опыт: ${fmtMonths(rel.total_months)}` +
            (rel.vacancy_requirements_match
                ? " · соответствует требованиям вакансии"
                : " · по требованиям вакансии не совпадает"));
    }
    if (n.counters) {
        lines.push(`Сообщений: ${n.counters.messages ?? 0}` +
            (n.counters.unread_messages ? ` (новых ${n.counters.unread_messages})` : ""));
    }
    if (r.experience?.length) {
        lines.push("", "Опыт работы:");
        for (const e of r.experience.slice(0, 8)) {
            lines.push(`  • ${[e.position, e.company].filter(Boolean).join(" @ ")} (${e.start ?? "?"} – ${e.end ?? "по наст. время"})`);
        }
    }
    if (r.education?.primary?.length) {
        lines.push("", "Образование:");
        for (const ed of r.education.primary.slice(0, 4)) {
            lines.push(`  • ${[ed.name, ed.organization, ed.result, ed.year].filter(Boolean).join(", ")}`);
        }
    }
    if (r.skill_set?.length) {
        lines.push("", `Навыки: ${r.skill_set.slice(0, 20).join(", ")}`);
    }
    if (r.id || r.alternate_url || r.title) {
        lines.push("", `Резюме: ${r.title ?? ""} (id=${r.id ?? "—"})` +
            (r.alternate_url ? ` · ${r.alternate_url}` : ""));
    }
    if (r.id) {
        const vac = n.vacancy?.id ?? opts.vacancyId;
        lines.push(`(полное резюме: get_resume resume_id=${r.id} topic_id=${n.id}` +
            (vac ? ` vacancy_id=${vac}` : "") +
            `)`);
    }
    lines.push("", `Переписка: get_application_messages(nid="${n.id}")`);
    return lines.join("\n");
}
export function formatApplicationMessages(data, topicId) {
    const items = data.items ?? [];
    const found = data.found ?? items.length;
    const page = (data.page ?? 0) + 1;
    const pages = data.pages ?? 1;
    const header = `Переписка по отклику ${topicId}: ${found} сообщений (страница ${page} из ${pages}, показано ${items.length})`;
    if (!items.length)
        return `${header}\n(пусто)`;
    const WHO = {
        applicant: "соискатель",
        employer: "работодатель",
    };
    const body = items
        .map((m) => {
        const who = WHO[m.author?.participant_type ?? ""] ?? m.author?.participant_type ?? "—";
        const flags = m.viewed_by_me === false ? " не прочитано" : "";
        const raw = m.text ? stripTags(m.text) : "";
        const text = raw ? truncate(raw, 800) : "(без текста)";
        return `${fmtDateTime(m.created_at)} · ${who}${flags}: ${text}`;
    })
        .join("\n");
    const next = (data.page ?? 0) + 1 < pages
        ? `\n\nСледующая страница: page=${(data.page ?? 0) + 1}`
        : "";
    return `${header}\n\n${body}${next}`;
}
export function formatNegotiationsHistory(data) {
    const items = data.negotiations ?? data.items ?? [];
    const vac = data.vacancy?.name
        ? `Вакансия: ${data.vacancy.name}${data.vacancy.id ? ` (id=${data.vacancy.id})` : ""}\n`
        : "";
    if (!items.length)
        return `${vac}История откликов: (пусто)`;
    const lines = items.map((h, i) => {
        const state = h.employer_state?.name ?? "—";
        const v = h.vacancy?.name
            ? ` · ${h.vacancy.name}${h.vacancy.id ? ` (${h.vacancy.id})` : ""}`
            : "";
        return `${i + 1}. ${state}${v}${h.created_at ? ` · ${h.created_at}` : ""}`;
    });
    return `${vac}История откликов (${items.length}):\n` + lines.join("\n");
}
function fmtStatValue(v) {
    if (v == null)
        return "—";
    if (typeof v !== "object")
        return String(v);
    if (Array.isArray(v))
        return `${v.length} записей`;
    const entries = Object.entries(v).filter(([, x]) => x != null && x !== "");
    return entries.map(([k, x]) => `${k}=${fmtStatValue(x)}`).join(", ");
}
export function formatNegotiationsStatistics(data) {
    if (data == null || typeof data !== "object")
        return String(data);
    const obj = data;
    const lines = ["Статистика откликов:"];
    for (const [k, v] of Object.entries(obj)) {
        if (v != null && typeof v === "object" && !Array.isArray(v)) {
            lines.push(`• ${k}: ${fmtStatValue(v)}`);
        }
        else if (Array.isArray(v)) {
            lines.push(`• ${k}: ${v.length} записей`);
        }
        else {
            lines.push(`• ${k}: ${v}`);
        }
    }
    return lines.join("\n");
}
export function formatPreferredOrder(data) {
    if (data == null || typeof data !== "object")
        return String(data);
    const obj = data;
    const ot = obj.order_type;
    if (ot?.name && ot.id)
        return `Предпочтительная сортировка: ${ot.name} (${ot.id})`;
    if (ot?.name || ot?.id)
        return `Предпочтительная сортировка: ${ot.name ?? ot.id}`;
    if (obj.order_by)
        return `Предпочтительная сортировка: ${obj.order_by}`;
    if (obj.preferred)
        return `Предпочтительная сортировка: ${obj.preferred}`;
    if (obj.id || obj.name)
        return `Предпочтительная сортировка: ${obj.id ?? obj.name}`;
    return JSON.stringify(data, null, 2);
}
export function formatPhone(phone) {
    if (!phone)
        return null;
    if (typeof phone === "string")
        return phone;
    if (phone.formatted) {
        const f = String(phone.formatted);
        return f.startsWith("+") ? f : `+${f}`;
    }
    const parts = [phone.country, phone.city, phone.number].filter(Boolean);
    return parts.length ? `+${parts.join("")}` : null;
}
export function formatManagerListItem(m, idx) {
    const meta = [
        m.email,
        formatPhone(m.phone) ?? formatPhone(m.additional_phone),
        m.manager_type?.name,
    ].filter(Boolean);
    const flag = m.is_main_contact_person ? " · основной контакт" : "";
    return `${idx}. ${m.full_name ?? "—"} (id=${m.id})${flag}${meta.length ? `\n   ${meta.join(" · ")}` : ""}`;
}
export function formatManagerList(result) {
    const items = result.items ?? [];
    const found = "found" in result && typeof result.found === "number" ? result.found : items.length;
    if (!items.length)
        return `Менеджеров: ${found}\n(пусто)`;
    return (`Менеджеров: ${found}\n\n` +
        items.map((m, i) => formatManagerListItem(m, i + 1)).join("\n"));
}
export function formatManager(m) {
    const lines = [`# ${m.full_name ?? "Менеджер"} (id=${m.id})`];
    if (m.email)
        lines.push(`Email: ${m.email}`);
    const phone = formatPhone(m.phone) ?? formatPhone(m.additional_phone);
    if (phone)
        lines.push(`Телефон: ${phone}`);
    if (m.manager_type?.name)
        lines.push(`Тип: ${m.manager_type.name}`);
    if (m.is_main_contact_person)
        lines.push("Основной контакт: да");
    return lines.join("\n");
}
export function formatVacancyStats(stats) {
    const lines = ["Статистика вакансии:"];
    const known = ["views", "responses", "invitations"];
    for (const key of known) {
        const block = stats[key];
        if (block && typeof block === "object") {
            const b = block;
            const prev = b.previous != null ? ` (ранее ${b.previous})` : "";
            lines.push(`• ${key}: ${b.total ?? "—"}${prev}`);
        }
    }
    for (const [k, v] of Object.entries(stats)) {
        if (known.includes(k))
            continue;
        if (v != null && typeof v !== "object")
            lines.push(`• ${k}: ${v}`);
    }
    return lines.length > 1 ? lines.join("\n") : JSON.stringify(stats, null, 2);
}
export function formatSavedResumeSearchList(result) {
    const items = result.items ?? [];
    const found = "found" in result && typeof result.found === "number" ? result.found : items.length;
    if (!items.length)
        return `Сохранённых поисков: ${found}\n(пусто)`;
    return (`Сохранённых поисков: ${found}\n\n` +
        items
            .map((s, i) => {
            const meta = [
                s.subscription ? "подписка" : null,
                s.items?.count != null ? `всего ${s.items.count}` : null,
                s.new_items?.count != null ? `новых ${s.new_items.count}` : null,
                s.created_at,
            ].filter(Boolean);
            return `${i + 1}. ${s.name ?? "—"} (id=${s.id})${meta.length ? `\n   ${meta.join(" · ")}` : ""}`;
        })
            .join("\n"));
}
export function formatSavedResumeSearch(s) {
    const lines = [`# ${s.name ?? "Поиск"} (id=${s.id})`];
    if (s.created_at)
        lines.push(`Создан: ${s.created_at}`);
    if (s.subscription != null)
        lines.push(`Подписка: ${s.subscription ? "да" : "нет"}`);
    if (s.items?.count != null)
        lines.push(`Всего результатов: ${s.items.count}`);
    if (s.new_items?.count != null)
        lines.push(`Новых: ${s.new_items.count}`);
    return lines.join("\n");
}
//# sourceMappingURL=format.js.map
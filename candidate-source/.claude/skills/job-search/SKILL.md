---
name: job-search
description: Поиск вакансий на hh.ru с анализом зарплат по специальности и региону; для ATS — разбор откликов по вакансии
argument-hint: <специальность> [город] [зарплата от]
allowed-tools:
  - Bash
  - Read
---

# /job-search — Поиск вакансий с аналитикой

## Алгоритм (поиск вакансий)

1. При необходимости определи `professional_role_id` через `suggest_professional_roles` (по названию специальности) и `area`-код через `suggest_areas` (по городу). Для свободных названий должностей — `suggest_positions`.
2. Вызови `search_vacancies` с ключевыми словами, регионом (`area`), зарплатой.
3. Вызови `get_salary_statistics` (`professional_role_id`, опц. `area_id`) — вернёт медиану/перцентили по выборке вакансий с зарплатой.
4. Покажи топ вакансий + медианную зарплату (с пометкой, что это оценка по объявлениям, не официальные данные рынка).

## Алгоритм (ATS / отклики) — нужен `HH_ACCESS_TOKEN`

1. `validate_token` — убедись, что токен employer.
2. `list_application_collections` (`vacancy_id`) — папки inbox.
3. `list_applications` (`collection`, `vacancy_id`, опц. `order_by` из `get_preferred_negotiations_order`).
4. `get_application` → при необходимости `get_application_messages` и/или `get_resume`.

## Формат ответа

```
## Вакансии: Python разработчик в Москве

Найдено: 1 234 вакансии
Медиана (оценка по объявлениям): ~250 000 ₽ (P25–P75: 180 000–320 000 ₽)

### Топ-5 вакансий
1. Senior Python Developer — Яндекс — 300 000–400 000 ₽
2. ...
```

## Примеры

```
/job-search Python Москва 200000
/job-search DevOps Петербург
```

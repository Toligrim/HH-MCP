# MCP-сервер для hh.ru API — 55 инструментов для ИИ-агента: вакансии, резюме, ATS/отклики, зарплаты

Если вы искали, как подключить hh.ru к Claude или другому ИИ-агенту, — этот сервер даёт агенту поиск по вакансиям и резюме, inbox откликов (ATS), карточки работодателей, статистику зарплат и справочники hh.ru по России и СНГ. Спрашиваете «найди Python-вакансии в Москве от 250 000 ₽ на удалёнке» — агент возвращает готовый список с зарплатами и опытом, а не ссылку на выдачу. Поиск вакансий работает без токена; токен нужен для базы резюме и ATS.

[![npm](https://img.shields.io/npm/v/@andrey-tepaykin/hh-mcp)](https://www.npmjs.com/package/@andrey-tepaykin/hh-mcp)
[![CI](https://github.com/AndreyTepaykin/hh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AndreyTepaykin/hh-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

![Демонстрация: вопрос «найди Python-вакансии в Москве от 250 000 ₽ на удалёнке» — агент вызывает search_vacancies и отвечает списком вакансий](https://raw.githubusercontent.com/theYahia/WWmcp/main/servers/hh/assets/demo.svg)

По умолчанию ответы приходят компактными сводками, удобными для LLM — передайте `raw: true` любому инструменту поиска или карточки, чтобы получить полный JSON hh.ru.

Основано на [@theyahia/hh-mcp](https://github.com/theYahia/hh-mcp) от [@theYahia](https://github.com/theYahia).

## Два режима

| Режим | Что доступно | Нужен токен? |
|------|-----------------|:-------------:|
| **Без токена** | Поиск вакансий, вакансия по ID, похожие/связанные вакансии, работодатели, статистика зарплат, регионы, роли, отрасли, метро, страны/языки/навыки/районы, справочники, подсказки, проверка токена | нет |
| **С токеном** | Всё перечисленное + поиск резюме, ATS/отклики, менеджеры, лимиты, архив/скрытые вакансии, статистика вакансий, сохранённые поиски | да (`HH_ACCESS_TOKEN`) |

Токен выдаётся на [dev.hh.ru/admin](https://dev.hh.ru/admin). Важно: поиск резюме дополнительно требует аккаунт **работодателя** с **оплаченной подпиской на базу резюме** — токены соискателя и анонимные получают 403. ATS/negotiations требуют employer-токен. Проверить возможности своего токена можно инструментом `validate_token`.

## Установка

### Claude Desktop

```json
{
  "mcpServers": {
    "hh": {
      "command": "npx",
      "args": ["-y", "@andrey-tepaykin/hh-mcp"],
      "env": {
        "HH_ACCESS_TOKEN": "optional-oauth-token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add hh -- npx -y @andrey-tepaykin/hh-mcp
# С токеном:
claude mcp add hh -e HH_ACCESS_TOKEN=your-token -- npx -y @andrey-tepaykin/hh-mcp
```

### VS Code / Cursor

```json
{
  "servers": {
    "hh": {
      "command": "npx",
      "args": ["-y", "@andrey-tepaykin/hh-mcp"]
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "hh": {
      "command": "npx",
      "args": ["-y", "@andrey-tepaykin/hh-mcp"]
    }
  }
}
```

### Режим HTTP (Streamable HTTP)

```bash
npx @andrey-tepaykin/hh-mcp --http
# или
HTTP_PORT=8080 npx @andrey-tepaykin/hh-mcp --http
```

Эндпоинт: `http://localhost:3000/mcp` (POST) · Проверка состояния: `http://localhost:3000/health` (GET)

HTTP-режим stateless, по умолчанию слушает `127.0.0.1` с включённой защитой от DNS-rebinding. Чтобы открыть его наружу, задайте `HOST=0.0.0.0`, добавьте свой host/origin в `HH_ALLOWED_HOSTS` / `HH_ALLOWED_ORIGINS` и поставьте перед ним собственную аутентификацию.

## Переменные окружения

| Переменная | Обяз. | Описание |
|----------|----------|-------------|
| `HH_ACCESS_TOKEN` | нет | Bearer-токен OAuth 2.0. Нужен для резюме, ATS/откликов и employer-scoped endpoint'ов. |
| `HH_USER_AGENT` | нет | Свой `HH-User-Agent` (hh.ru его требует). Рекомендуемый формат: `your-app/1.0 (you@example.com)`. |
| `HH_MAX_SCAN_PAGES` | нет | Лимит страниц hh.ru при `list_applications(with_updates_only)` (по умолчанию 10). |
| `HH_RESUME_MAX_CONCURRENCY` | нет | Параллельных гейтед-просмотров резюме (по умолчанию 1). |
| `HH_RESUME_MIN_INTERVAL_MS` | нет | Мин. интервал между стартами гейтед-чтений (по умолчанию 1500). |
| `HH_RESUME_MAX_PER_WINDOW` | нет | Макс. гейтед-чтений в скользящем окне (по умолчанию 20; `0` — выкл.). Общий для инстансов при `HH_BUDGET_FILE`. |
| `HH_RESUME_WINDOW_MS` | нет | Длина скользящего окна (по умолчанию 60000). |
| `HH_BUDGET_FILE` | нет | Shared lock-файл бюджета, окна и breaker'а между процессами; `off` — только in-process. |
| `HH_CAPTCHA_COOLDOWN_MS` | нет | Начальный cooldown breaker'а при captcha (по умолчанию 60000). |
| `HH_CAPTCHA_COOLDOWN_MAX_MS` | нет | Потолок cooldown (по умолчанию 600000). |
| `HH_CAPTCHA_RETRY_S` | нет | Лестница пауз, сек (по умолчанию `45,120,300`). |
| `HH_CAPTCHA_RECOVERY_MS` | нет | Длительность осторожного режима после капчи (по умолчанию 600000): интервал ×2, окно ÷2 на 10 чтений. |
| `HH_CAPTCHA_RECOVERY_STEP_MS` | нет | Пауза после пробного чтения и мин. пауза перед повтором 404 в recovery (по умолчанию 5000). |
| `HH_CACHE_DIR` / `HH_CACHE_TTL_MS` | нет | Кэш резюме на диске (TTL 24ч; `0` отключает). Ключ — `sha256(resume_id, topic_id, vacancy_id)`; `HH_CACHE_DIR=off` выключает. |
| `HH_LEDGER_FILE` / `HH_LOG_DIR` | нет | JSONL-ledger гейтед-чтений и лог запросов (по умолчанию выкл.). |
| `HH_INSTANCE` | нет | Метка инстанса в ledger, `/health` и `hh_usage_report` (иначе `HH_USER_AGENT`, иначе `HTTP_PORT`). |
| `HH_REQUIRE_TOPIC` | нет | `1`/`true`/`on` — `get_resume` без `topic_id` не ходит в сеть, пока не передан `allow_unscoped: true`. |
| `HH_EXPORT_DIR` | нет | Каталог экспорта для `collect_vacancy_resumes`. |
| `HH_QUOTA_CHECK` | нет | `off` — не запрашивать лимит просмотров для строки в ответе. |
| `HH_QUOTA_PATH_TTL_MS` | нет | Сколько помнить рабочий путь квоты, не пробуя другой (по умолчанию 3600000). |
| `HH_QUOTA_STALE_MS` | нет | Когда `hh_usage_report` считает квоту устаревшей и обновляет её (по умолчанию 1800000). |
| `HH_DEBUG` | нет | `1` — писать `quota.path.probe` (иначе probe-404 не логируются). |
| `HH_API_BASE_URL` | нет | Базовый URL API (по умолчанию `https://api.hh.ru`) — для тестов на мок-сервере. |
| `HH_TOOLS` / `HH_TOOLS_EXCLUDE` | нет | Allow/deny список имён и групп инструментов. CLI: `--tools` / `--tools-exclude`. |
| `HTTP_PORT` / `PORT` | нет | Порт HTTP-режима (по умолчанию 3000). HTTP включается только флагом `--http`. |
| `HOST` | нет | Интерфейс привязки в HTTP-режиме (по умолчанию `127.0.0.1`). |
| `HH_ALLOWED_HOSTS` | нет | Список разрешённых Host через запятую для HTTP-режима (по умолчанию loopback). |
| `HH_ALLOWED_ORIGINS` | нет | Список разрешённых Origin через запятую для HTTP-режима. |

См. [`.env.example`](.env.example).

## Инструменты (55)

Любой инструмент поиска или карточки принимает `raw: true` — тогда вернётся полный JSON hh.ru вместо компактной сводки.

Поверхность режется через `HH_TOOLS` / `HH_TOOLS_EXCLUDE` (имена и группы: `vacancies`, `resumes`, `batch`, `negotiations`, `employers`, `references`, `salary`, `diagnostics`, `validate_token`). Профиль для разбора откликов: `HH_TOOLS=negotiations,resumes,batch,validate_token,diagnostics`.

### Вакансии

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `search_vacancies` | Поиск по ключевым словам, региону, профессиональной роли, отрасли, метро, работодателю, зарплате, опыту, формату работы и типу занятости, периоду (`period` или `date_from`/`date_to`), меткам и полю поиска, с сортировкой и пагинацией | нет |
| `get_vacancy` | Полная карточка вакансии: описание, требования, ключевые навыки, контакты | нет |
| `get_similar_vacancies` | Найти вакансии, похожие на заданную | нет |
| `get_related_vacancies` | Связанные вакансии (`/related_vacancies`) | нет |
| `get_vacancy_stats` | Статистика просмотров/откликов по вакансии | **да** |
| `get_vacancy_visitors` | Посетители вакансии | **да** |
| `get_vacancy_conditions` | Условия публикации вакансий | **да** |

### Резюме (токен работодателя + оплаченная база резюме)

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `search_resumes` | Поиск резюме кандидатов по ключевым словам, региону, роли, зарплате, опыту | **да** |
| `get_resume` | Полное резюме. Если резюме из отклика — всегда передавайте `topic_id` (+`vacancy_id`): иначе бьёте в базу резюме и ловите captcha. При `HH_REQUIRE_TOPIC` без `topic_id` нужен `allow_unscoped: true` | **да** |
| `get_resumes` | Пакетное чтение до 50 резюме через бюджет. Предпочтительно `items: [{resume_id, topic_id}]` (старый `resume_ids` + `topics` поддерживается, опечатка в ключе — ошибка до сети). `require_topic: true` — без `topic_id` не читать (`skipped`). `out_dir` — raw-файлы + `manifest.json` / `negotiations.csv`. Статусы: `ok`, `cached`, `unscoped`, `captcha`, `not_found`, `failed`, `skipped`, `not_attempted` | **да** |
| `collect_vacancy_resumes` | Сбор резюме по воронке вакансии → raw JSON + `manifest.json` / `negotiations.csv`; `cursor` по id откликов (устойчив к новым откликам между вызовами) при обрезке по `max`/`max_wait_ms`/окну | **да** |
| `get_resume_negotiations_history` | История откликов по резюме | **да** |
| `list_saved_resume_searches` | Список сохранённых поисков резюме | **да** |
| `get_saved_resume_search` | Сохранённый поиск резюме по ID | **да** |
| `hh_usage_report` | Локальный отчёт: ledger/лог, breaker, бюджет, кэш; квота обновляется, если отсутствует или старше `HH_QUOTA_STALE_MS` (не гейтед) | нет |

### ATS / отклики (токен работодателя)

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `list_application_collections` | Воронка: счётчики по этапам и подэтапам + `with_updates`; ids подэтапов для `list_applications` | **да** |
| `list_applications` | Список откликов: `collection` (по умолчанию `response`) или `sub_collection` (id/имя), `with_updates_only` (скан страниц, `page`/`per_page` — по отфильтрованным; лимит `HH_MAX_SCAN_PAGES`), `order_by`. `raw: true` — одна сырая страница без фильтра | **да** |
| `get_application` | Полная карточка отклика (опыт, релевантность, этап, счётчики сообщений) — без платного `get_resume` | **да** |
| `get_application_messages` | Переписка с пагинацией (`page` / `per_page`, max 50) | **да** |
| `get_negotiations_statistics` | Статистика откликов по работодателю (`employer_id`) | **да** |
| `get_preferred_negotiations_order` | Предпочтительная сортировка откликов по вакансии | **да** |

Типичный flow: `list_application_collections` → `list_applications` → `get_application` → при необходимости `collect_vacancy_resumes` / `get_resumes` с `topic_id` (не фан-аут субагентов на голый `get_resume`). `get_application` печатает готовую подсказку `get_resume … topic_id=…`.

## Просмотры резюме: rate, captcha, budget

hh.ru антифродом закрывает быстрые пакетные `GET /resumes/{id}` капчей (`403 captcha_required`, `type: employer_resume_view`). Это **не** исчерпание квоты `resume_view_limits` и **не** проблема OAuth-scope.

Правила сервера (3.0.0+):

1. Передавайте `topic_id` (+`vacancy_id`) для резюме из отклика — scoped-URL; нескоупленный путь считается гейтед. Чтение без `topic_id` в батче помечается статусом `unscoped` (платная база), а не `ok`.
2. Гейтед-трафик идёт через бюджет: concurrency 1, интервал 1500 мс (±20% jitter) **и** скользящее окно 20 чтений / 60 с; опционально общий файл `HH_BUDGET_FILE` на два инстанса. Ретраи 429/5xx/404 заново проходят breaker и берут слот.
3. При captcha открывается breaker: следующие гейтед-вызовы fail-fast с `retry_after_s`, без молотьбы API. Состояние breaker'а в общем файле монотонно — один инстанс не может «закрыть» cooldown другого.
4. После снятия breaker'а — осторожный режим (`HH_CAPTCHA_RECOVERY_MS`): интервал ×2, окно ÷2 на 10 чтений.
5. 404 на чтение резюме повторяется один раз с паузой; повторный 404 — статус `not_found` (в кэш не пишется).
6. Успешные ответы кэшируются на диск (`HH_CACHE_DIR`); повтор не бьёт в сеть.
7. Массовый разбор — `collect_vacancy_resumes` / `get_resumes`, а не 12 параллельных `get_resume`.

Капча **не** решается автоматизацией браузера в этом пакете: подождите 45–120 с или откройте `fallback_url` вручную.

## Ограничение частоты запросов

Обычный трафик: 5 запросов/с. Гейтед-просмотры резюме — отдельный более строгий бюджет (см. выше). Автоповтор на 429/5xx (до 3 попыток); captcha **не** ретраится циклом 5xx.

### Работодатели

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `search_employers` | Поиск компаний по названию и региону | нет |
| `get_employer` | Профиль работодателя: описание, отрасли, сайт, число вакансий | нет |
| `get_employer_vacancies` | Активные вакансии работодателя (публичный поиск с `employer_id`) | нет |
| `list_employer_managers` | Менеджеры аккаунта (`employer_id`) | **да** |
| `get_employer_manager` | Менеджер по ID | **да** |
| `get_manager_resume_limits` | Информативные лимиты просмотра резюме менеджера (счётчик hh.ru может не совпадать с фактом; 404/нули — не сигнал капчи). `employer_id`/`manager_id` можно не передавать | **да** |
| `get_manager_negotiations_statistics` | Статистика откликов менеджера | **да** |
| `list_active_vacancies` | Опубликованные вакансии своего аккаунта (`/employers/{id}/vacancies/active`) | **да** |
| `list_archived_vacancies` | Архивные вакансии | **да** |
| `list_hidden_vacancies` | Скрытые вакансии | **да** |
| `get_message_template` | Шаблон сообщения по отклику | **да** |
| `list_mail_templates` | Почтовые шаблоны работодателя | **да** |
| `get_employer_vacancy_areas` | Активные регионы вакансий | **да** |
| `get_employer_departments` | Подразделения | **да** |
| `list_employer_addresses` | Адреса | **да** |

### Справочники и подсказки

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `get_areas` | Дерево регионов и городов (`id — название`) | нет |
| `get_areas_subtree` | Регионы и города внутри одного региона — легче, чем всё дерево | нет |
| `get_countries` | Список стран | нет |
| `get_professional_roles` | Дерево профессиональных ролей с ID | нет |
| `get_industries` | Дерево отраслей компаний с ID | нет |
| `get_metro` | Станции и линии метро с ID по городу | нет |
| `get_languages` | Справочник языков | нет |
| `get_skills` | Названия навыков по id (`/skills`, 1–50 id; для поиска по имени — `suggest_skill_set`) | нет |
| `get_districts` | Районы (опционально по `area_id`) | нет |
| `get_dictionaries` | Все справочные данные: валюты, типы занятости, графики, опыт, метки | нет |
| `suggest_positions` | Автодополнение названий должностей (`/suggests/positions`) | нет |
| `suggest_professional_roles` | Автодополнение проф. ролей с ID (для фильтров поиска) | нет |
| `suggest_companies` | Автодополнение названий компаний | нет |
| `suggest_areas` | Автодополнение названий регионов и городов | нет |
| `suggest_vacancy_search_keyword` | Подсказки ключевых слов поиска вакансий | нет |
| `suggest_resume_search_keyword` | Подсказки ключевых слов поиска резюме | нет |
| `suggest_skill_set` | Автодополнение навыков | нет |

### Зарплаты и аккаунт

| Инструмент | Описание | Токен? |
|------|-------------|:------:|
| `get_salary_statistics` | При `HH_ACCESS_TOKEN` + `area_id` сначала пробует платный Банк данных (`/salary_statistics/paid/...`); при 401/403/404 или без токена/региона — оценка по зарплатам в вакансиях (смещённая выборка). | для банка — да |
| `validate_token` | Проверить, действителен ли `HH_ACCESS_TOKEN` (через `/me`), и показать роль аккаунта | нет |

## Демо-промпты

```
Найди удалённые вакансии Python-разработчика в Москве от 300 000 рублей
```

```
Покажи все открытые вакансии Яндекса и дай статистику зарплат по основным ролям
```

```
Сравни зарплаты Senior Backend в Москве и Санкт-Петербурге и предложи вакансии, похожие на самую высокооплачиваемую
```

```
Покажи коллекции откликов по вакансии 123456 и список неразобранных откликов
```

## Разработка

```bash
git clone https://github.com/AndreyTepaykin/hh-mcp.git
cd hh-mcp
npm install
npm run build
npm test
```

## Справочник API

- [Документация API hh.ru](https://api.hh.ru/)
- [API hh.ru на GitHub](https://github.com/hhru/api)

## Лицензия

MIT

---

Репозиторий: [AndreyTepaykin/hh-mcp](https://github.com/AndreyTepaykin/hh-mcp) · npm: [@andrey-tepaykin/hh-mcp](https://www.npmjs.com/package/@andrey-tepaykin/hh-mcp)

## Поисковый движок (development candidate)

Локальный запуск bounded search и восстановление checkpoint описаны в [руководстве поискового движка](./docs/search-engine.md). После сборки `npm run search:collect -- --spec <localfile> --checkpoint <localfile>` запускает compiled CLI; MCP background jobs, exports и analytics пока не реализованы.

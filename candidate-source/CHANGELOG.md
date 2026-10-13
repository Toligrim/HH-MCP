# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.1.0] - 2026-10-05

Residual hardening after the 2026-10-02 live-instance review (no captcha/breaker
events that day; one model error was `employer_id`/`manager_id` `"0"`).

### Changed
- **`hh_usage_report` text/JSON**: separate `viewsToday` (resume-id views) and
  `searchReadsToday` (gated `/resumes?...`); `gatedReadsToday` is their sum with
  a per-`instance` breakdown. Missing quota prints `Квота: н/д` instead of
  omitting the line. `raw` adds `quota.refreshedAt` / `quota.stale` and
  `instance`. This is a diagnostics format change, not a tool-behaviour change.
- **`get_manager_resume_limits`** (and the same pattern on
  `get_manager_negotiations_statistics`, `get_employer_manager`,
  `list_employer_managers`, `get_employer_departments`): `employer_id` /
  `manager_id` are optional (resolved from `/me`) and must be a positive integer
  (`"0"` fails validation before any request).

### Added
- `HH_REQUIRE_TOPIC` (`1`/`true`/`on`): `get_resume` without `topic_id` returns
  before the network unless `allow_unscoped: true`. The refusal is ledger
  `skipped` / `reason: "no topic_id"`, not `unscoped`. Default off.
- Ledger rows carry `instance` (`HH_INSTANCE`, else `HH_USER_AGENT`, else
  `HTTP_PORT`). Gated `search_resumes` writes `kind: "search"` ledger rows.
- `HH_QUOTA_STALE_MS` (default 1800000): `hh_usage_report` refreshes quota when
  missing/stale (`cost: normal`, not gated). Failed quota path probes are
  remembered for `HH_QUOTA_PATH_TTL_MS` and logged only with `HH_DEBUG=1`.
- `/health` includes `instance`. Shared breaker `writers` drop pids not seen in
  24 hours.

## [3.0.0] - 2026-09-30

Fixes from the 2026-09-29 incident review (captcha on the 31st read of a
30-reads-in-49-seconds burst, five silent paid unscoped reads, five transient 404s).

### Breaking
- **New row/ledger statuses** — parsers matching on `ok`/`failed` must be updated:
  - reads without `topic_id` are `unscoped` (was `ok`) in `get_resumes` rows and
    in the ledger;
  - a resume read that returns 404 twice is `not_found` (was `failed`);
  - `get_resumes` can also return `skipped` (with `require_topic: true`).
- **`get_resumes` validates `topics`**: a key that is not in `resume_ids`, or a
  non-numeric topic id, fails the whole call before any network request (was: the
  id was silently read unscoped from the paid database).
- `hh_usage_report`: `gatedReadsToday`/`gatedReads7d` no longer count cache hits;
  captcha is counted once per `request_id`, with `breaker.open` reported separately
  as `breakerOpens`.
- `collect_vacancy_resumes` cursor format changed to id-based (old `{offset}`
  cursors are still accepted).

### Added
- `get_resumes`: `items: [{resume_id, topic_id, vacancy_id?}]` (preferred input),
  `require_topic`, `out_dir` (writes `raw/<resume_id>__<topic_id>.json`,
  `manifest.json`, `negotiations.csv`; existing valid files are reused without a
  network read), `files` list in raw output, `counts.unscoped` with a header
  warning, per-row `error_fields` (`status, kind, value, type, request_id,
  fallback_url, retry_after_s`).
- **Sliding-window limiter** for gated reads: `HH_RESUME_MAX_PER_WINDOW` (default
  20) per `HH_RESUME_WINDOW_MS` (default 60000), shared across instances. Batch
  tools stop with `stoppedForWindow` + cursor instead of sleeping past
  `max_wait_ms`.
- **Recovery mode** after a captcha (`HH_CAPTCHA_RECOVERY_MS`, default 600000;
  `HH_CAPTCHA_RECOVERY_STEP_MS`, default 5000): interval ×2 and window ÷2 for the
  next 10 reads; ledger rows carry `recovery: true`.
- **404 retry** for resume reads: one paced retry (through the breaker and a fresh
  gated slot); `HhNotFoundError` never written to cache.
- `hh_usage_report`: `unscoped`, `notFound`, `retried`, `perHour`,
  `cacheMisses`, `failedByStatus`, `breakerDenied`, `coverage`, cache stats,
  last known quota, breaker `lastWriter`/recovery.
- Ledger rows for failures carry `http_status`, `attempt`, `retry`.
- `HH_API_BASE_URL` to point the client at a mock server.
- `HH_QUOTA_PATH_TTL_MS`: the working quota endpoint is remembered; failed probes
  are logged as `quota.path.probe` events instead of request errors.
- Identical concurrent resume reads are coalesced into one network call.

### Fixed
- **Breaker desync between instances**: shared state is merged monotonically
  (`openUntil` never decreases; a `closed` write cannot erase another instance's
  cooldown); the half-open probe is shared (first instance wins); fast-fail errors
  keep the original `fallback_url` / `request_id`.
- Retries of 429/5xx/timeouts re-check the breaker and re-take the gated slot on
  every attempt (they used to bypass both).
- A half-open probe that ended in a non-captcha error no longer leaves the breaker
  stuck in "probe in flight".
- `get_resume` `raw: true` now includes `hh_mcp_warning` / `hh_mcp_scope` for
  unscoped reads instead of only logging to stderr.
- `collect_vacancy_resumes`: deterministic order (created_at, id), deduped listing
  (`skipped_duplicates`), empty/corrupt raw files are re-read, failures are kept in
  the manifest.
- 403 scope/unknown messages include `errors[].value`, `type`, `request_id`.
- 403 with `type: oauth` (e.g. `bad_authorization`) is classified as `auth` —
  invalid/expired/revoked token — instead of "possible missing OAuth scope".
- Bearer tokens are redacted from log/ledger text fields.

## [2.2.4] - 2026-09-25

### Added
- **`get_resume` `topic_id` / `vacancy_id`**: scoped reads via
  `/resumes/{id}?topic_id=&vacancy_id=` (hh.ru marks the negotiation viewed when
  `topic_id` is present; OpenAPI documents this in the method description even
  though the formal parameter list omits it). Unscoped behaviour is unchanged.
- **Batch tools** `get_resumes` and `collect_vacancy_resumes` — sequential paced
  resume reads with `max_wait_ms` (cap 110s for DSH's 120s tool timeout), captcha
  stop, cache, manifest/csv export.
- **Resume-view budget**: `HH_RESUME_MAX_CONCURRENCY` (default 1),
  `HH_RESUME_MIN_INTERVAL_MS` (default 1500), optional shared lock file
  `HH_BUDGET_FILE` across processes on one host.
- **Captcha circuit breaker** with cooldown ladder (`HH_CAPTCHA_COOLDOWN_MS`,
  `HH_CAPTCHA_COOLDOWN_MAX_MS`, `HH_CAPTCHA_RETRY_S`); fail-fast while open.
- **Disk cache** for resume payloads (`HH_CACHE_DIR`, `HH_CACHE_TTL_MS`,
  `no_cache` override).
- **Honest 403 classification** (`HhAccessError`): `captcha` / `quota` / `scope` /
  `unknown` with structured `{ hh: { kind, request_id, … } }` and Russian pause
  instructions — no longer claims "token lacks required scope" for captcha.
- **Quota line** on resume reads (informational; `HH_QUOTA_CHECK=off` to disable).
  Observed 2026-09-25: manager `resume_view` counter can stay at `spend: 0` after
  successful views — never treat it as the captcha gate.
- **Ledger / JSONL logs**: `HH_LEDGER_FILE`, `HH_LOG_DIR`; tool `hh_usage_report`.
- **Tool surface filter**: `HH_TOOLS` / `HH_TOOLS_EXCLUDE` and CLI `--tools` /
  `--tools-exclude` (names + groups, case-insensitive). Default surface is now
  **55** tools (52 + 3). Suggested triage profile:
  `HH_TOOLS=negotiations,resumes,batch,validate_token,diagnostics`.
- `/health` exposes `resumeBudget`, `captchaBreaker`, effective tool count.

### Changed
- Default gated resume pacing is slower than the old global 5 req/s (restore old
  aggressiveness with `HH_RESUME_MIN_INTERVAL_MS=0` + `HH_RESUME_MAX_CONCURRENCY=5`
  — unsupported against captcha).
- `get_application` prints a ready `get_resume … topic_id=… vacancy_id=…` hint.

### Task 0 (mechanism) — no live token on this host
- OpenAPI `get-resume` description explicitly requires `topic_id` to mark a
  negotiation as viewed; examples use `?topic_id=`. Formal `parameters` list does
  not declare `topic_id`/`vacancy_id`, but both are empirically accepted
  (incident 2026-09-24: scoped bulk script, 166 resumes, zero captcha at 1200 ms).
- Live paired plain-vs-scoped rate experiment was **not** re-run here (no
  `HH_ACCESS_TOKEN` / DeepSeekHarness deployment on this machine). Design treats
  unscoped `/resumes/{id}` as gated and scoped `?topic_id=` as normal; batch tools
  still force the gated budget for safety.

## [2.2.3] - 2026-09-22

### Fixed
- **`list_applications` `with_updates_only`**: no longer filters a single upstream page
  in memory (which could print `(пусто)` while unread applications sat on later pages).
  When set, the tool scans collection pages (upstream `per_page=50`) and applies
  `page` / `per_page` to the **filtered** stream. Headers report pages scanned; a capped
  incomplete walk says `просмотр не завершён — есть ещё страницы` and never pretends the
  inbox is empty. Cap: `HH_MAX_SCAN_PAGES` (default 10). `raw: true` remains one
  unfiltered upstream page. hh.ru has no `order_by` that isolates `has_updates`, so the
  scan is required regardless of sort.
- `fmtDateTime` uses `Europe/Moscow` so hh.ru timestamps stay `DD.MM.YYYY HH:MM`
  on UTC hosts (CI was showing `07:54` instead of `10:54`).
- Manager phone, message-template email/SMS, and nested statistics (e.g. politeness
  index) no longer render as `[object Object]`.
- **`get_vacancy_visitors`** reports pagination and `hidden_on_page` instead of
  «140 / (пусто)» when hh.ru hides visitor resumes.
- **`get_preferred_negotiations_order`** reads `order_type.id` / `order_type.name`
  (`Лучшие (relevance)`).

## [2.2.2] - 2026-09-19

### Fixed
- **`list_application_collections`** no longer prints hh.ru static `description` (e.g.
  «Откликов не найдено.») as if it were a count. Output is a funnel with per-stage and
  per-sub-stage `counters.total` / `with_updates`, skipping `hidden` collections.
- **`get_application`** / list rows again include recruiter-relevant fields from the
  negotiations payload (age, salary, citizenship, relevant experience + vacancy match,
  funnel sub-stage, message counters) so screening need not call paid `get_resume`.
- **`list_applications` `sub_collection` scoping** when `collection` is also set: hh.ru
  may send `root_collection: true` (boolean) instead of a parent id string — we now
  fall back to the enclosing collection id so names like «Остальные» resolve under
  `consider` / other stages.

### Added
- **`list_applications`**: optional `sub_collection` (id, bare stage id, or name/substring)
  with self-correcting error that enumerates available sub-stages; optional
  `with_updates_only`; `collection` defaults to `response` and accepts sub-collection ids.
- **`get_application_messages`**: `page` / `per_page` (default 20, max 50), pagination
  header, unread marker, 800-char truncation, next-page hint.
- Shared `fmtDateTime` / `fmtMonths` / `fmtAge` for compact Russian dates and durations
  in negotiations formatters.

### Changed
- Negotiations compact dates use `DD.MM.YYYY HH:MM` instead of raw ISO strings.

## [2.2.1] - 2026-09-18

### Fixed
- **`get_skills`** now requires skill `id`(s) (1–50); bare `/skills` is invalid per hh.ru.
- **`get_employer_vacancies`** uses public `/vacancies?employer_id=` instead of the
  employer-only `/employers/{id}/vacancies/active` path.
- HTTP mode is enabled only by `--http` (not by a bare `HTTP_PORT` env var).
- In-process rate limiter serializes waiters so concurrent calls cannot exceed 5 req/s.

### Added
- **`list_active_vacancies`** — employer-token listing of published vacancies via
  `/employers/{id}/vacancies/active` (pair with public `get_employer_vacancies`).
  Tool count is now **52**.

### Changed
- Published as **`@andrey-tepaykin/hh-mcp`** (npm scope `andrey-tepaykin`).
- **`get_salary_statistics`** tries paid Банк данных
  (`GET /salary_statistics/paid/salary_evaluation/{area_id}`) when `HH_ACCESS_TOKEN`
  and `area_id` are set; on 401/403/404 falls back to vacancy salary sampling.
  Optional bank params: `speciality`, `employee_level`, `industry`, `extend_sources`
  (`text` → `position_name`).

## [2.2.0] - 2026-09-17

### Added
- **ATS / negotiations GET tools** (employer token): `list_application_collections`,
  `list_applications`, `get_application`, `get_application_messages`,
  `get_negotiations_statistics`, `get_resume_negotiations_history`,
  `get_preferred_negotiations_order`.
- **Employer ops:** managers, resume limits, manager negotiations stats, archived/hidden
  vacancies, message/mail templates, vacancy areas, departments, addresses.
- **Vacancy extras:** `get_vacancy_stats`, `get_vacancy_visitors`, `get_vacancy_conditions`,
  `get_related_vacancies`.
- **Saved resume searches:** `list_saved_resume_searches`, `get_saved_resume_search`.
- **References:** `suggest_professional_roles`, keyword/skill suggests, `get_countries`,
  `get_languages`, `get_skills`, `get_districts`.
- Shared `requireToken()` in `src/auth.ts` for resume + ATS tools.
- Tool count is now **51** (was 19).

### Changed
- **`suggest_positions`** now calls `/suggests/positions` (free-form titles). Role IDs
  live under the new `suggest_professional_roles` tool (`/suggests/professional_roles`).
- Schema hints for role IDs point to `suggest_professional_roles`.

## [2.1.0] - 2026-06-23

### Fixed
- **HTTP mode crashed on Node 18.** `crypto.randomUUID()` was used as a bare
  global (stable only on Node 19+) while `engines`/CI include Node 18. HTTP mode
  is now stateless and no longer references the global.
- **HTTP concurrency bug.** A single shared `StreamableHTTPServerTransport` was
  connected once at startup (a documented anti-pattern that collides across
  concurrent clients). Each request now gets a fresh stateless server+transport.
- **Tool errors now set `isError: true`** so MCP clients/LLMs can distinguish a
  failure from a normal result and self-correct.
- **`get_salary_statistics` was mislabeled** — it advertised "salary
  distribution" but returned only a count. hh.ru has no free distribution
  endpoint, so the tool now samples posted salaries and computes
  median/P25/P75/min/max client-side, clearly labelled as a biased estimate.
- **`search_vacancies` no longer forces `currency=RUR`** on every query — the
  currency is sent only together with a salary filter.
- **Required `HH-User-Agent` header** is now sent (hh.ru requires it; missing it
  risks blocks/captcha). Configurable via `HH_USER_AGENT`.
- Server version, the User-Agent and `/health` are single-sourced from
  `package.json` (was hardcoded and drifting at `2.0.0`).
- Removed a stale, broken duplicate test file referencing a long-gone 8-tool API.
- Test files are no longer compiled into `dist/` / published to npm.

### Added
- **Compact, LLM-friendly output by default** for vacancy/employer/resume search
  and detail tools, with `raw: true` to get the full hh.ru JSON.
- **Expanded `search_vacancies` filters:** `professional_role`, `industry`,
  `metro`, `employer_id`, `period` / `date_from` / `date_to` (mutually
  exclusive), `search_field`, `excluded_text`, `label`, plus modern
  `work_format` / `employment_form` (the legacy `employment`/`schedule` remain
  accepted but are marked deprecated). Pagination depth is capped at 2000.
- **New tools:** `get_industries`, `get_metro`, `get_areas_subtree`, and
  `validate_token` (checks `HH_ACCESS_TOKEN` via `/me` and reports the role).
- Dictionary/suggest tools now return compact `id — name` listings (raw via `raw`).
- HTTP mode: DNS-rebinding protection (allow-lists via `HH_ALLOWED_HOSTS` /
  `HH_ALLOWED_ORIGINS`), binds to `127.0.0.1` by default (`HOST`), `/health`
  reports version, graceful shutdown and a friendly `EADDRINUSE` message.
- ESLint + `lint`/`typecheck` scripts wired into CI; `.env.example`.

### Changed
- Resume tools now fail fast with an actionable message and clarify that they
  require an **employer** token **and a paid resume-database subscription**.
- Bumped `@modelcontextprotocol/sdk` floor to `^1.28.0`.
- Tool count is derived from the registry (now 19 tools) and can no longer drift.

## [2.0.x]
- 16-tool release: vacancies, resumes, employers, salary, dictionaries,
  suggests; rate limiter, retry/backoff, stdio + HTTP transports.

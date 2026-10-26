# HH vacancy search coverage

Captured from the official HH public API on 2026-10-26. The query inventory below has 44 fields; the required `HH-User-Agent` is a header supplied by the existing client and is not a query field. Dictionary IDs are seeded from the official public OpenAPI extract (`parameters.json`); no live vacancy query was made for this implementation.

Sources: [HH public OpenAPI](https://api.hh.ru/openapi/specification/public), [HH OpenAPI Redoc](https://api.hh.ru/openapi/redoc), [public dictionaries endpoint](https://api.hh.ru/dictionaries). The separately captured `dictionaries-public.json` was unavailable in the worktree environment, so observed IDs come from the enum snapshots embedded in `parameters.json`.

The earlier recon coverage note incorrectly marked several existing fields as missing. Inspection of the baseline `src/tools/vacancies.ts` confirmed that `text`, `area`, `professional_role`, `industry`, `metro`, `employer_id`, `salary`, `currency`, `label`, `experience`, `employment_form`, `work_format`, `employment`, `schedule`, `search_field`, `excluded_text`, `period`, `date_from`, `date_to`, `order_by`, `per_page`, and `page` were already implemented as scalars. The other 22 official fields were not exposed there.

| HH field | Baseline support | Target type / multi | Constraints and behavior | Status / test evidence |
|---|---|---|---|---|
| `page` | scalar number, default 0 | integer scalar | `>=0`; combined depth cap 2,000 | Implemented; defaults/depth tests |
| `per_page` | scalar number, default 20 | integer scalar | 1..100; `0` unsupported pending live evidence | Implemented; schema tests |
| `text` | scalar string | string scalar | Max 500 chars; HH query text retained | Implemented; encoding test |
| `search_field` | enum scalar | string or list | Snapshot: `name`, `company_name`, `description` | Implemented; repeated-key test |
| `experience` | enum scalar | string or list | Public dictionary catalogue; refreshable | Implemented; schema/query tests |
| `employment` | enum scalar | string or list | Deprecated; prefer `employment_form` | Implemented with warning |
| `schedule` | enum scalar | string or list | Deprecated; prefer modern work filters | Implemented with warning |
| `area` | numeric scalar | positive numeric/lexical ID or list | Opaque ID checked by HH | Implemented; repeated-key and invalid-array tests |
| `metro` | string scalar | positive decimal-component ID or list | Opaque ID checked by HH | Implemented; schema validation |
| `professional_role` | numeric scalar | positive numeric/lexical ID or list | Multiple roles enabled per issue; wire semantics require live smoke | Implemented; repeated-key test |
| `industry` | string scalar | positive decimal-component ID or list | Snapshot backed; opaque ID checked by HH | Implemented |
| `employer_id` | string scalar | positive lexical ID or list | Opaque ID checked by HH | Implemented |
| `currency` | conditional scalar | dictionary ID scalar | Requires `salary`; amount-only keeps legacy RUR default | Implemented; currency-only rejected |
| `salary` | scalar number | finite nonnegative scalar | RUR default if currency omitted | Implemented; finite/range tests |
| `salary_frequency` | absent | dictionary ID or list | Public dictionary values, refreshable | Implemented |
| `salary_mode` | absent | dictionary ID scalar | Public dictionary values, refreshable | Implemented |
| `label` | narrow enum scalar | dictionary ID or list | Dynamic catalogue; legacy `accept_temporary` label retained | Implemented; boolean alias test |
| `only_with_salary` | absent | boolean scalar | Deprecated replacement is `label=with_salary` | Implemented; explicit false serialized |
| `period` | integer 1..30 | finite positive number | Local safety cap 365 days; exclusive with date bounds | Implemented; combination tests |
| `date_from` | unvalidated string | ISO date/date-time scalar | Calendar-valid date or seconds + explicit timezone; exclusive with period | Implemented; invalid calendar/timezone tests |
| `date_to` | unvalidated string | ISO date/date-time scalar | Must not precede `date_from`; inclusivity unknown | Implemented |
| `top_lat` | absent | bounded number scalar | -90..90; all four bbox coordinates required | Implemented; bbox tests |
| `bottom_lat` | absent | bounded number scalar | -90..90; must be below top | Implemented; bbox tests |
| `left_lng` | absent | bounded number scalar | -180..180; must be left of right | Implemented; bbox tests |
| `right_lng` | absent | bounded number scalar | -180..180; must be right of left | Implemented; bbox tests |
| `order_by` | enum scalar | dictionary ID scalar | Includes `distance`; refreshable catalogue | Implemented; distance tests |
| `sort_point_lat` | absent | bounded number scalar | -90..90; only with distance and paired longitude | Implemented; distance tests |
| `sort_point_lng` | absent | bounded number scalar | -180..180; only with distance and paired latitude | Implemented; distance tests |
| `clusters` | absent | boolean scalar | Explicit `false` is preserved | Implemented; boolean test |
| `describe_arguments` | absent | boolean scalar | Explicit `false` is preserved | Implemented; boolean test |
| `no_magic` | absent | boolean scalar | Explicit boolean | Implemented |
| `premium` | absent | boolean scalar | Deprecated/no effect; retained with warning | Implemented |
| `responses_count_enabled` | absent | boolean scalar | Explicit boolean | Implemented |
| `part_time` | absent | dictionary ID or list | Deprecated; refresh unions `working_days`, `working_time_intervals`, and `working_time_modes`, plus only `part`, `project`, and `accept_temporary` | Implemented with warning; other `employment` values rejected |
| `accept_temporary` | absent | boolean scalar | Retained as documented boolean | Implemented |
| `employment_form` | enum scalar | dictionary ID or list | Dynamic public catalogue | Implemented; multi-value test |
| `work_schedule_by_days` | absent | dictionary ID or list | Dynamic public catalogue | Implemented; modern filter test |
| `working_hours` | absent | dictionary ID or list | Dynamic public catalogue | Implemented; modern filter test |
| `work_format` | enum scalar | dictionary ID or list | Dynamic public catalogue | Implemented; refresh test |
| `excluded_text` | scalar string | string scalar | Max 500 chars | Implemented |
| `education` | absent | documented ID or list | `not_required_or_not_specified`, `special_secondary`, `higher` | Implemented |
| `driver_license_types` | absent | dictionary ID or list | Dynamic public catalogue | Implemented |
| `host` | absent | fixed enum scalar | Official allowlist only | Implemented; strict schema |
| `locale` | absent | uppercase locale scalar | Bounded uppercase locale syntax; URL rejected | Implemented; strict schema |

`district` is intentionally excluded: it is not a query parameter of the official vacancy search operation. `explainVacancyQuery` reports it under `unsupported_filters`; ordinary search rejects it as an unknown key. `with_salary=true` is accepted as a compatibility alias and merged into `label=with_salary`, preserving other labels. `with_salary=false` becomes the neutral `only_with_salary=false` flag and is explained as not excluding vacancies without salary. Contradictory explicit salary flags are rejected before HH. Deprecated `employment`, `schedule`, `part_time`, `only_with_salary`, and `premium` remain available with warnings.

Multi-value fields use repeated query keys. The public schema describes scalar primitives even where descriptions permit several values, so server serialization is not formally specified. Professional-role lists are supported per issue requirements; their HH wire semantics still need a controlled live smoke test. Date bounds accept date-only values and timezone-bearing ISO timestamps (`Z`, `±HH:MM`, or HH's `±HHMM` form); timezone spellings normalize to the HH form without changing the instant. HH rounds date bounds to five minutes; exact inclusivity and timezone semantics for date-only input remain unknown. `per_page=0` is explicitly unsupported until behavior is verified. Period has a local finite 365-day safety cap because HH publishes no bound. Regular search performs no dictionary lookup; explicit resolution uses only fixed public HH endpoints, has a one-hour TTL and an eight-catalogue cache cap. A missing or malformed dictionary payload is reported as unavailable and preserves existing validation values; `education` resolves from the operation's inline enum without HTTP. Area, professional-role, and employer IDs require positive numeric strings or safe integers; metro and industry IDs allow positive decimal components. HH validates opaque ID existence.

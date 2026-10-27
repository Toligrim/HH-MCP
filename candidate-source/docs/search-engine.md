# Search engine MCP API

This development candidate exposes the search engine through six MCP tools. Its version is `3.2.0-search.1`; it is a development snapshot and has not been published or deployed. Search coverage assumptions and known limits are described in [search-coverage.md](./search-coverage.md). The implementation follows the public [HH API](https://api.hh.ru/openapi/specification/public) and [HH dictionary endpoint](https://api.hh.ru/dictionaries).

## Tools

- `plan_search` validates and freezes a search plan. It makes no HH request and performs no writes.
- `explain_search` shows how search arguments normalize to HH query parameters. It makes no HH request. A supplied `district` is reported as unsupported.
- `deep_search` synchronously collects a bounded result set and reports coverage, applied and unsupported filters, uncertainty, gaps, provenance, and timestamps.
- `resolve_search_dictionary` looks up a term in a public HH dictionary. This is the only plan/explain companion that calls HH.
- `get_vacancies_batch` fetches full cards for up to 20 vacancy IDs. IDs can be copied from the `matched_ids` and `review_ids` in a deep-search response.
- `get_capabilities` reports the active tool inventory and implemented limits.

The six new tools can be enabled with the `search` group or individually by name, for example `HH_TOOLS=search` or `HH_TOOLS=plan_search,deep_search`. This filter is an explicit allowlist; it does not change the default production inventory. Under this safe search-only inventory, `read_only_mode` is true. An unrestricted legacy inventory includes tools that can write local resume files, so its capability response reports `read_only_mode: false`.

## Examples

### Quick search

Use `deep_search` in `fast` mode for a small first-page collection. Search plans default to comprehensive mode; the fast mode choice is explicit.

```json
{
  "mode": "fast",
  "native": { "text": "Python developer", "area": "1", "period": 14 },
  "limits": { "max_requests": 4, "max_items": 60 }
}
```

### Multi-region search

Branches preserve shared base criteria while overriding their own region. Branch names must be unique.

```json
{
  "native": { "text": "data analyst", "period": 30 },
  "branches": [
    { "name": "moscow", "native": { "area": "1" } },
    { "name": "saint-petersburg", "native": { "area": "2" } }
  ],
  "limits": { "max_requests": 12, "max_items": 250 }
}
```

### Two-on-two and three-on-three schedules

HH schedule values can be passed as a list. These filters are sent to HH; the engine does not infer a schedule from free text.

```json
{
  "native": {
    "text": "warehouse operator",
    "work_schedule_by_days": ["TWO_ON_TWO_OFF", "THREE_ON_THREE_OFF"]
  }
}
```

### No-call planning and explanation

Use `plan_search` to inspect the frozen plan and `explain_search` to inspect normalization without making any HH requests.

```json
{ "native": { "text": "Go developer", "area": "1", "period": 30 } }
```

The `plan_search` response includes the resolved limits, date bounds, query branches, warnings, and plan signature. The planner requires a complete limits contract internally; the MCP tool supplies defaults for omitted limit fields.

### Bounded deep collection

`deep_search` returns at most 20 vacancy summaries, plus bounded matched and review ID lists for follow-up batch calls. For example:

```json
{
  "mode": "comprehensive",
  "native": { "text": "backend engineer", "area": "1", "period": 14 },
  "post_filters": [{ "rule": "required_technology", "value": "PostgreSQL" }],
  "filter_mode": "inclusive",
  "limits": {
    "max_requests": 25,
    "max_items": 500,
    "max_duration_sec": 20,
    "max_bytes": 2097152,
    "max_detail_fetches": 25
  }
}
```

Each explicit limit can be omitted and receives its default. Smaller caller values are preserved. Requests above the MCP caps fail before collection. One deep call may run per server process; a concurrent call receives a retryable busy error. The MCP call is synchronous and honors request cancellation. It does not create a background job or persist results/checkpoints.

## Limits and result meaning

The current MCP caps are 25 HH requests/attempts, 500 collected items, 20 seconds of active collection time, 2 MiB of HH response bytes, 25 detail fetches, and 64 KiB of serialized MCP output. Plan, explanation, dictionary, batch, and deep-search responses are bounded. If a complete plan or explanation exceeds the output limit, the tool returns a clear size error instead of dropping criteria. Deep-search output can trim summaries and ID lists; returned and truncated counts describe the final envelope. Pagination cursors are unsupported.

The `applied_filters` response labels the shared criteria as `base_template` and lists each executed branch with its effective native filters, serialized query, and overridden fields. A base template is not itself an extra search when explicit branches are present. `found` is the sum of observed HH totals across root branches, so it can count the same vacancy more than once. `total_known` is the deduplicated number of collected items. The reported coverage and gaps describe work actually completed under the request limits; they do not imply exhaustive coverage of all HH vacancies. Search results can change while collection runs, and HH pagination or indexing may omit or reorder records.

Without post-filters, collected records are native HH query matches. When post-filters are used, only verified `keep` decisions appear under `matched_ids`; unknown or review decisions appear under `review_ids`, including inclusive-mode items retained for coverage. Post-filter decisions use the configured field evidence and are heuristic; inspect the evidence and vacancy card before treating a match as definitive. The search summaries omit full descriptions. Use `get_vacancies_batch` for selected full cards.

Authentication is provided by the surrounding OAuth proxy (`auth_mode: external_oauth_proxy`). The MCP server does not implement OAuth or expose credentials in tool results. `export_enabled` and `bulk_jobs_enabled` are false for this search engine; `checkpoint_mode` is `local_cli_only`, so MCP requests do not accept or create checkpoints.

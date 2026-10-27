# PR 2 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Address the owner's independent-review findings in existing PR #2 with verified security, completeness, structured-filter and performance fixes.

**Architecture:** Keep the existing MCP, in-memory collector, checkpoint and local CLI interfaces. Bound untrusted input before schema validation; distinguish per-leaf coverage from global deduplication; normalize structured HH IDs separately from description heuristics; use an ID index and page-sized undo records.

**Tech Stack:** TypeScript, Node, MCP TypeScript SDK, Zod, Vitest.

**Spec:** Owner's 2026-10-27 request in this session; this plan records its executable acceptance criteria. Prior design: `docs/superpowers/specs/2026-10-26-hh-search-design.md`.

## Global Constraints

- Work only in `/home/toligrim/projects/HH-MCP/product-issue1`, branch `feat/issue-1-search-engine`, existing draft PR #2. Previous HEAD `21e096539e128660bdf00c403998d8b015d2c2c7`; base `ops/preflight-2026-10-13` at `f3f1dcfd4f6cc36c26b52d027d38ded8c86e2468`.
- No merge, deployment, production changes, Actions, main/base modifications, secrets, service/network/OAuth/Tunnel changes, server exports, SQLite, jobs or unrelated features.
- Preserve `search_vacancies`, `get_vacancy`, `deep_search`, `raw:true`, scalar calls, provenance, cumulative budgets, checkpoint limit 32 MiB and honest tri-state semantics.
- No automatic `npm audit fix`. Each dependency change needs advisory/compatibility evidence. All load tests use synthetic data and mocked HH.
- Implementers and reviewers must not delegate further. One implementation agent at a time; reviewers are read-only.
- Independently review each task and the actual whole-branch diff at the final exact published HEAD. Keep PR draft; push only this feature branch.

## Review Focus

- Overlarge arrays, deep unknown keys and non-tool JSON-RPC envelopes must fail safely before expensive schema validation (Task 1).
- Unknown structured IDs and contradictory ID/name/description evidence must remain unknown rather than become false matches/exclusions (Task 2).
- Same-ID overlaps between leaf partitions are legitimate; duplicates within one leaf and index drift must prevent false COMPLETE (Task 3).
- Rollback after state overflow must restore rows, index, provenance and partition coverage together (Task 3).
- Resume must retain coverage diagnostics, support older valid checkpoints conservatively, and not exceed cumulative budgets (Task 3).

### Task 1: SDK and input safety

**Files:** `candidate-source/package.json`, `package-lock.json`, `src/index.ts`, relevant HTTP/input helper if extraction makes tests practical, `src/**/__tests__/*mcp*.test.ts` and focused security transport tests. Migration-only Zod call sites may change if required by a justified safe Zod update.

**Interfaces:** Preserve `createServer()`, tool schemas and Streamable HTTP; provide exported internal input-limit constants/helper only if needed for shared protection/tests.

- [x] Confirm GHSA-46jr-4wx8-v453 against installed code and current official advisory; inspect current SDK/Zod/runtime advisories and package engines.
- [x] Add a bounded failing regression for element count, deep nesting and HTTP size; use actual SDK transport. Demonstrate zero handler/HH calls on rejection.
- [x] Upgrade to a compatible safe SDK 1.x release >=1.32.0, enable its documented `maxToolInputElements`, justify a reduced HTTP-body limit from actual tool schemas (target 256 KiB unless inspection warrants a different bound), and protect depth before recursive validation. Review direct Zod and runtime transitives; make only evidenced compatible upgrades.
- [x] Test normal initialize/list/call, raw/scalar compatibility, schema publication/validation, cancellation, oversized arrays, deep nested objects and malformed/oversize HTTP bodies. Use local ephemeral HTTP only, never production.
- [x] Run focused tests, typecheck/lint, dependency audit with sanitized reporting. Commit exact scoped files and write task report with versions, limits, sources, red/green evidence and remaining advisories.

### Task 2: Structured schedule and work-format postfilters

**Files:** `candidate-source/src/search/filters.ts`, `src/search/dictionaries.ts` only if shared official ID metadata needs exporting, `src/search/__tests__/filters.test.ts`.

**Interfaces:** Preserve `evaluatePostFilters`, `postFilterSchema`, rule names and match/no_match/unknown. Use existing official dictionary catalogue as the single supported-ID set; no automatic network fetch in filter evaluation.

- [x] Reproduce failures for `THREE_ON_THREE_OFF`, `ONE_ON_THREE_OFF`, `ON_SITE`, `FIELD_WORK`, and unknown requested schedule.
- [x] Normalize exact supported IDs independently from bounded display aliases and description heuristics. Cover all current 14 schedule IDs and 4 work formats. Preserve legacy aliases 2/2, 5/2, remote/office; never merge ON_SITE and FIELD_WORK.
- [x] Known structured arrays represent supported alternatives: a requested member may match. Missing/empty fields use conservative description evidence; unknown/malformed values, conflicting ID/name or description remain unknown. An unknown requested value is always unknown.
- [x] Add parameterized tests for every structured ID (string and `{id,name}`), missing/empty fields, future IDs, multi-value arrays, work-format separation, description contradictions and existing RU/EN negations. Do not let descriptive regex override unknown structured IDs.
- [x] Run focused filters and MCP regression tests, typecheck/lint; commit scoped files, report red/green evidence and official source/date.

### Task 3: Collector completeness and measured performance

**Files:** `candidate-source/src/search/collector.ts`, `src/search/__tests__/collector.test.ts`, relevant CLI tests, a reusable synthetic benchmark under `candidate-source/scripts/` and a focused load-test file if appropriate.

**Interfaces:** Preserve `collectSearch`, manifest and checkpoint interfaces; additive optional coverage fields are allowed. Keep checkpoint v1 compatibility conservatively; do not silently declare old/inconsistent completed coverage trustworthy.

- [x] Before edits record same-harness baseline for 5,000 and 20,000 synthetic jobs: elapsed, process maxRSS, serialized checkpoint bytes, dataset/options/sample count. No real HH. Preserve harness for after measurement.
- [x] Add failing regressions for found150/150 unique COMPLETE versus found150/145 unique PARTIAL, legitimate child overlap, changing index, and checkpoint/resume after missing coverage. Confirm current linear ID lookup and page clone costs.
- [x] Maintain per-terminal-partition unique IDs, duplicates and expected-count observations. At completion detect unique-count mismatch and report bounded diagnostic gaps; mutable-index warnings remain. A stable duplicate deficit can never become COMPLETE on resume. Ignore parent probe overlap when judging leaf completeness.
- [x] Replace global linear lookup with a per-run Map reconstructed on resume. Replace full per-page item clones with page-sized undo records restoring modified metadata/provenance and appended rows if state exceeds 32 MiB. Keep checkpoint snapshots private when handed to callbacks; full serialization/persistence costs remain explicit.
- [x] Test rollback with pre-existing hits/provenance plus new IDs, invalid or old coverage state, index drift both directions, 32 MiB boundary, and CLI persistence/resume. Verify 5,000/20,000 load cases in the common test set without fragile speed assertions.
- [x] Re-run identical benchmark after changes in isolated processes and report actual times/maxRSS/bytes, not an assumed speedup. Run focused tests/typecheck/lint, commit scoped files and report.

## Final validation and publication

- [x] Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `git diff --check`; audit runtime and full tree, listing remaining advisories and any audit-service failure accurately.
- [x] Validate updated SDK transport/input limits and CLI checkpoint/resume with compiled runtime where unit coverage does not suffice. No mass/live production probes.
- [x] Update `candidate-source/docs/issue-1-verification.md` and relevant operator limits, recording real results and historical evidence separately.
- [ ] Commit and push to the same feature branch. Fetch live PR exact HEAD and independently review actual diff from base; fix confirmed findings in the same branch and re-review the new HEAD.
- [ ] Update existing PR body with final SHA/evidence; keep draft. Confirm protected paths/base unchanged, clean tree, MERGE:NO and DEPLOY:NO.

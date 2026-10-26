# HH-MCP search engine update — design
Date: 2026-10-26. Authority: issue #1 and the owner's explicit request to implement through Luna 6 agents.

## Goal and scope
Deliver the recommended stages 0–3: current HH public vacancy search coverage, truthful detail filtering, and bounded deep collection with recoverable checkpoints. Preserve existing tools and raw:true. Export and background jobs stay disabled until the storage, identity, download and action-surface decisions in issue §14 are settled. Stage 4–5 analytics/export remain separate roadmap work, not claimed complete.

## Repository and production baseline
Remote/local ops base: f3f1dcfd4f6cc36c26b52d027d38ded8c86e2468, default ops/preflight-2026-10-13; no open PRs. Source snapshot and running production: upstream 98f9930a1bbeeed44572986c7d72b197cacc93e2, version 3.1.0, MIT. Source snapshot src matches the separate source checkout byte for byte.
Fresh read-only local production check: backend/proxy/tunnel active, health ok with 24 tools, anonymous public MCP HTTP 401. No credentials read. npm ci/typecheck/lint/134 tests/build PASS at baseline; audit already reports 20 vulnerabilities (1 low, 4 moderate, 12 high, 3 critical); do not auto-fix.

## Approaches and selected implementation
1. Keep product changes under candidate-source/ on a new feature branch: minimal diff, ops history intact, no directory relocation.
2. Promote product to repository root: cleaner eventual product layout, but disruptive and requires the owner's explicit restructuring choice.
3. Separate upstream fork: good long-term separation, requires a separate repository decision and migration.
Coordinator choice for this reversible implementation: option 1, feature feat/issue-1-search-engine in a linked worktree. Owner confirmed option1 (branch in Toligrim/HH-MCP, structure preserved). Original ops/source checkouts and default branch are unchanged.

## Components and files
- src/requestBudget.ts + client.ts: attempt-counted request/byte/deadline budgets, cancellation through rate waits/retries/body consumption; existing limiter remains the common in-process gateway.
- src/search/query.ts: strict native schema, normalization, exact repeated-key serialization, validation/explanation. tools/vacancies.ts delegates its search handler.
- src/search/dictionaries.ts: public lookup catalogue with bounded TTL and no invented HH codes.
- src/search/filters.ts and tools/vacancyBatch.ts: conservative match/no_match/unknown rules with evidence, bounded public-card reads.
- src/search/planner.ts and collector.ts: frozen time window, multiple strategies, dedup/provenance, inclusive time splits, unresolved partitions, retry-aware budgets and versioned checkpoint state.
- src/tools/search.ts: plan_search, explain_search, deep_search, get_capabilities, dictionary resolution; actual registry and safe allowlist tests.
- src/search/cli.ts: explicitly invoked local operator workflow, atomic checkpoints and resume, no HTTP download/job surface.
- docs/search-coverage.md and docs/search-engine.md: official API inventory, exclusions, contracts, examples, limits and operator guide.

## Behavior and limits
Quick search preserves compact and raw formats. New search inputs reject unknown keys; no arbitrary URL/host/path passthrough.
Deep MCP calls are synchronous/read-only, do not create files or background jobs, enforce max 20 seconds / 25 HTTP attempts / 500 unique items / 2 MiB received / 64 KiB response and return at most 20 compact items.
Local CLI supports explicit persistence with default 500 attempts / 20,000 items / 600 seconds / 64 MiB received; hard caps 1,000 attempts / 50,000 items / 1,800 seconds / 128 MiB. One local job at a time, process-local shared limiter; multi-process/distributed collection unsupported.
No safe split means PARTIAL with unsplittable_over_cap. Completed means only all reachable planned partitions completed; mutable live index always warned, never historical/global completeness.
Postfilters always fetch details within budget; details:none suppresses retention, not necessary evidence reads. Checkpoints persist active_elapsed_ms and restore only remaining duration; serialized state is capped at32MiB with PARTIAL state_budget before overflow; missing fields are unknown. Rules: night_shifts, work_format, schedule/day pattern, required technology, no mandatory calls. HTML is untrusted source data, raw preserved and text separately cleaned.
No exports, signed downloads, server job store, remote checkpoint/cursor IDs, employer/resume feature expansion, service/network/config changes or GitHub Actions. Capabilities explicitly report unavailable features and external-proxy auth.

## Verification
Test each behavior before implementing (RED/GREEN evidence), run focused checks during iteration, whole suite before each task commit. Each task gets a separate read-only Luna 6 spec+quality review. Coordinator runs fresh required npm checks, a bounded public HH smoke and final whole-branch review. No merge without “Мержи”; deployment is a separate workflow.


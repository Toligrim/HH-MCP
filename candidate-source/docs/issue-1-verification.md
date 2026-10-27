# Issue 1 verification record

This is a development candidate at version `3.2.0-search.1`. Stages 0–3 are implemented in the candidate. Server-side exports, background jobs, and analytics (stages 4–5) are deferred. This record supports review of the feature branch; no merge or deployment is claimed. The root `build-output/` and `SOURCE-CANDIDATE.txt` remain the historical deployment baseline; `candidate-source/dist/` is generated output for this candidate. Existing upstream attribution and MIT license are retained.

## Local verification

Coordinator verification recorded 2026-10-27 in `candidate-source/`. Final typecheck, lint, tests, build, and compiled integration probes ran on product commit `ea7a215ee6d17e219817c270e53992972a39a0a6`; subsequent changes only record this evidence. The clean dependency install used the same unchanged dependency resolutions before the final source-only fix.

| Check | Result | Evidence |
|---|---|---|
| `npm ci` | PASS | Clean dependency install completed; package lock and dependency resolutions unchanged. |
| `npm run typecheck` | PASS | `tsc --noEmit`, exit 0. |
| `npm run lint` | PASS | `eslint src`, exit 0. |
| `npm test` | PASS | 15 files, 260 tests passed after all final fixes. Test stderr contains expected retry/captcha fixtures. |
| `npm run build` | PASS | TypeScript build completed, exit 0. |
| Compiled CLI runtime and recovery | PASS | Ran copied `dist/` with Node in a temporary install path containing spaces, with only production `zod` present and a mocked `fetch`. A second process with a different checkpoint failed busy before fetching. An actual SIGINT saved `CANCELLED`; resume completed with the same frozen time, cumulative requests 1 → 2, and nondecreasing active duration. A separate process suffering mocked network loss saved `PARTIAL`; explicit resume completed with cumulative requests 1 → 2 and unchanged frozen time. Checkpoint/result were mode `0600`, the spec was unchanged, primary lock removed, and the persistent guard kept its inode and mode `0600`. Temporary runtime harness files were removed. |
| `git diff --check` | PASS | No whitespace errors. |
| Task 6 `npm audit --json` | FAIL (advisories) | 20 total (1 low, 4 moderate, 12 high, 3 critical). The baseline and Task 6 vulnerability records are identical, including 104 advisory identities across 20 packages. No audit fix or dependency resolution change was made. |
| Coordinator `npm audit --json` | FAIL (registry) | The standalone audit and one retry could not produce a vulnerability report: npm registry returned HTTP 400 for its quick-audit fallback. A clean coordinator `npm ci` did complete and reported the same 20 vulnerabilities. This is not a fresh successful standalone audit. |
| `flock --version` | PASS | `flock from util-linux 2.39.3`; Linux and util-linux `flock` are now explicit CLI prerequisites. |
| `npm test -- src/search/__tests__/cli.test.ts` after fix round 1 | PASS | 1 file, 20 tests passed, including guard-held stale metadata, concurrent stale-owner starts, missing flock, and guard path safety. |
| MCP SDK transport integration | PASS | Tests exercise actual SDK tools/list and tools/call, published schemas, rejection before HTTP, old `raw: true`, cancellation, concurrency, allowlist, and output bounds. Separate coordinator SDK probes confirmed plan/explain make zero requests, repeated area keys, cap rejection, and disjoint matched/review/excluded IDs. The final compiled SDK probe placed negated remote/schedule and hidden script/style text in review rather than matched results, while visible affirmative HTML matched; 8 actual mocked fetch attempts across 4 calls, all responses below 64 KiB. |

The focused CLI suite uses temporary local files and injected/mocked HH reads only. It covers pre-fetch checkpoint persistence, failure while replacing a prior checkpoint, cancellation and resume with frozen time and cumulative counters, malformed/incompatible checkpoints, path collisions and symlinks, live and stale lock owners, cleanup, and spec byte limits. Fix round 1 obtains a persistent mode-0600 guard via inherited descriptor and keeps it through job cleanup; the empty guard file remains after a run while the primary PID/nonce lock is removed. No live HH request was made for this verification.

## Review and implementation decisions

All six implementation tasks received independent read-only Luna 6 spec and quality reviews. Confirmed findings were fixed and reviewed again:

| Task | Final task review |
|---|---|
| HTTP request budgets | Approved after two fix rounds; independent real-timer cancellation probe also passed. |
| Native search and dictionaries | Approved after two fix rounds; query and dictionary root probes passed. |
| Full cards and tri-state post-filters | Approved after two fix rounds; final branch probes subsequently added the negation/HTML fixes below. |
| Planner, partitions, and collector | Approved after two fix rounds; final branch review subsequently added transient-failure recovery below. |
| MCP SDK integration | Approved after one fix round for disjoint exclusion counts and structured errors. |
| Local CLI and operator guide | Approved after one fix round for kernel-serialized stale-lock recovery. |

Final whole-branch review covered baseline `f3f1dcfd4f6cc36c26b52d027d38ded8c86e2468` through `3ead26ab0a98b7c9583a49145c418607ab59e17a`. The reviewer found that transient failed partitions could not resume; coordinator probes also confirmed leading remote negation, negated schedules, and script/style text could produce false matches. One combined fix wave in `ea7a215ee6d17e219817c270e53992972a39a0a6` addressed all four findings. The independent scoped final re-review marked all four ADDRESSED with no new findings. The coordinator then confirmed the full suite and compiled CLI/SDK checks above. No confirmed review finding remains open.

The final review's declined areas align with the agreed scope: server exports/downloads/jobs/analytics/snapshots, remote checkpoints/cursors, employer/resume expansion, deployment/configuration, and GitHub Actions remain outside this implementation. Technical review approval does not authorize merge or deployment.

Two coordinator decisions affect operation:

- An explicit branch `period` replaces inherited date bounds and ends at the plan's frozen current time, preserving unrelated base criteria. If a historical trailing window was intended, supply absolute branch dates or revise this policy.
- The explicit local CLI requires Linux and installed util-linux `flock`. It retains a persistent private guard descriptor through the entire job; missing prerequisites fail before HH. Other platforms require an adaptation before CLI use. The MCP server gained no npm dependency or platform prerequisite from this CLI guard.

## Live HH evidence

The original unauthenticated probe and the later operator-authorized checks are separate verification windows. The owner explicitly approved checking the configured production credential and testing the candidate on 2026-10-27. The credential was loaded into memory from the running service without printing it, writing it to a file, refreshing it, or changing production configuration. All HTTP calls below were serial and bounded; the test helpers stopped on any HTTP error and did not retry or switch routes/credentials after denial.

| Probe | Result | Evidence |
|---|---|---|
| Original unauthenticated vacancy search, 2026-10-26 | FAIL | One `/vacancies` probe returned HTTP 403 with `{"type":"forbidden"}`. The probe stopped; its precise cause is not established. Other live probes in that window were skipped. |
| Configured-credential check, 2026-10-27 15:27:32 MSK | PASS | One `/me` returned HTTP 200 in 343 ms under the production service UID, using its credential and User-Agent. No profile fields were printed. This proves current acceptance, not a future expiry time or access to every protected resource. |
| Configured-credential quick search, 15:27:51 MSK | PASS | One `/vacancies?text=Python&per_page=1&page=0` returned HTTP 200 in 259 ms, `found=6024`, one result. Both this call and `/me` have corresponding `outbound/direct[direct-hh]` journal entries. Live configuration binds that outbound to `wlan0`. |
| Compiled candidate over actual SDK tools/call, 15:32:57 MSK | PASS | Six actual HH attempts, all HTTP 200, 542934 response bytes total; no mocked HTTP. `plan_search` and `explain_search` made zero requests. Candidate version `3.2.0-search.1`, product code unchanged from reviewed commit `ea7a215ee6d17e219817c270e53992972a39a0a6`. |
| Professional-role dictionary | PASS | Live `/professional_roles` lookup resolved the exact term and a prefix lookup reused its cache. Selected valid role IDs `10` and `157` for the multi-role probe. An initial harness incorrectly expected candidates for an exact match; that assertion was corrected without product changes. The initial run made one additional successful dictionary request and stopped before searching. |
| Modern work filters, salary, clusters | PASS (bounded sample) | `REMOTE`, `TWO_ON_TWO_OFF` / `THREE_ON_THREE_OFF`, salary 90000 RUR and `with_salary` returned HTTP 200, `found=586`, three cards, clusters and argument descriptions. All three cards listed REMOTE and at least one requested schedule. This does not prove every matching card obeys every filter. |
| Multi-region, role and search-field query | PASS (accepted and described) | Repeated `area=1&area=2`, `professional_role=10&professional_role=157`, and `search_field=name&search_field=description` returned HTTP 200, `found=168`, two cards. A separate targeted `describe_arguments=true` call returned individual entries for each of the two area, role, search-field, and schedule values, plus work format and salary. That combined narrow query returned zero matches; it verifies recognition, not exhaustive union semantics or completeness. |
| Bounding box and distance ordering | PASS (bounded sample) | HTTP 200, `found=2295`, two returned cards with coordinates inside the requested Moscow bounding box. Distance sort with a complete point was accepted. Two cards do not establish global ordering accuracy. |
| Full-card batch | PASS | One selected vacancy returned status `ok`, raw HTML, cleaned text, timestamp and content hash through `get_vacancies_batch`. |
| Bounded deep search | PASS | HTTP 200 on one HH search; `max_items=2` produced `total_known=2`, observed `found=330`, `PARTIAL` and `item_budget` gaps. Output was 10791 bytes. No full-coverage claim was made. |
| Live CLI collection | SKIP | The CLI was exercised only with local mocked reads; it was not pointed at HH. |

The new authorized window used ten HTTP attempts total: `/me`, one quick search, the initial dictionary-only harness run, six successful candidate calls, and one targeted argument-description check. No denied response occurred in this window. The candidate harness used the existing credential and its own default User-Agent; the diagnostic `/me` and quick/argument checks used the production User-Agent. This is not a controlled experiment isolating why the earlier anonymous request returned 403. Live API execution is now observed for these bounded cases; exhaustive coverage, boundary inclusivity, large-scale collection, live CLI recovery, and authenticated ChatGPT end-to-end use remain unverified.

## Read-only production baseline

An earlier coordinator read-only check on 2026-10-27 reported deployed SHA `98f9930a1bbeeed44572986c7d72b197cacc93e2`; loopback health on `127.0.0.1:3001` returned `ok`, version `v3.1.0`, 24 tools, default 55-tool inventory, and `filterActive=true`. The application, OAuth proxy, and `cloudflared` were active. Anonymous loopback proxy request to `127.0.0.1:3002/mcp` returned 401. The public request to `https://hh-mcp.kurva-cloud.ru/mcp` in that earlier check timed out after 10 seconds (curl exit 28 / HTTP 000). This failure remains historical evidence; the later check below establishes the current anonymous response. No production or network changes were made.

Later read-only Luna 6 diagnosis on 2026-10-27 at 15:26–15:27 MSK obtained public anonymous `/mcp` HTTP 401 in 0.52–0.64 seconds, local proxy 401 in about 0.8 ms, and backend health 200. Public DNS, TCP, and TLS completed successfully; the configured Cloudflare ingress still points to `127.0.0.1:3002`. The earlier public timeout was not reproduced, and no configuration fix is supported by the available evidence. A successful anonymous auth gate does not prove a complete authenticated OAuth/MCP client session. Cloudflared lifecycle logs show repeated explicit stop/start events; their trigger and any connection to the earlier timeout remain unestablished. Services, tokens, routes and deployment were unchanged by these checks.

## Dependency release preflight

The read-only dependency assessment confirmed that the saved baseline findings remain a release concern. Ten affected packages belong to the runtime dependency closure and ten to dev tooling; inclusion alone does not establish exploitation. A fresh successful standalone audit is still unavailable. The feature did not update dependency resolutions.

One high-severity runtime advisory matches the HTTP MCP server path: SDK `1.28.0` is affected by [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453), covering request-validation memory exhaustion. The current raw-body cap does not impose the advisory's separate element-count bound. Before rollout, complete a separately reviewed dependency-security change that upgrades the SDK to a patched release (at least `1.32.0`), configures `maxToolInputElements`, reassesses the body limit, evaluates the direct Zod advisory, refreshes affected transitives, and obtains fresh audit and compatibility results. Authentication narrows exposure but does not establish safety for all authenticated clients. No exploit probe, dependency upgrade, automatic audit fix or production change was performed for this assessment.

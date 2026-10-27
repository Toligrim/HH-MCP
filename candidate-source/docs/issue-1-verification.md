# Issue 1 verification record

This is a development candidate at version `3.2.0-search.1`. Stages 0–3 are implemented in the candidate. Server-side exports, background jobs, and analytics (stages 4–5) are deferred. No PR, merge, or deployment is claimed. The root `build-output/` and `SOURCE-CANDIDATE.txt` remain the historical deployment baseline; `candidate-source/dist/` is generated output for this candidate. Existing upstream attribution and MIT license are retained.

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

| Probe | Result | Evidence |
|---|---|---|
| Bounded live vacancy search | FAIL | Coordinator's single unauthenticated `/vacancies` probe returned HTTP 403 with `{"type":"forbidden"}` on 2026-10-26. The probe stopped there. |
| Remaining multi-value, geo, cluster/count probes | SKIP | Not attempted after the bounded search returned 403. No bypass or credential switch was attempted. |
| Live CLI collection | SKIP | The CLI was exercised only with local mocked reads; it was not pointed at HH. |

Live API execution and semantics therefore remain unverified. Local mocked wire serialization does not establish live HH behavior.

## Read-only production baseline

Coordinator's read-only check on 2026-10-27 reported deployed SHA `98f9930a1bbeeed44572986c7d72b197cacc93e2`; loopback health on `127.0.0.1:3001` returned `ok`, version `v3.1.0`, 24 tools, default 55-tool inventory, and `filterActive=true`. The application, OAuth proxy, and `cloudflared` were active. Anonymous loopback proxy request to `127.0.0.1:3002/mcp` returned 401. A fresh public request to `https://hh-mcp.kurva-cloud.ru/mcp` timed out after 10 seconds (curl exit 28 / HTTP 000), so current external OAuth reachability is unverified; the 401 evidence is from 2026-10-26 only. No production or network changes were made.

# Issue 1 verification record

This is a development candidate at version `3.2.0-search.1`. Stages 0–3 are implemented in the candidate. Server-side exports, background jobs, and analytics (stages 4–5) are deferred. This record supports review of the feature branch; no merge or deployment is claimed. The root `build-output/` and `SOURCE-CANDIDATE.txt` remain the historical deployment baseline; `candidate-source/dist/` is generated output for this candidate. Existing upstream attribution and MIT license are retained.

## PR 2 independent-review fixes — 2026-10-27

This cycle starts at PR HEAD `21e096539e128660bdf00c403998d8b015d2c2c7` on `feat/issue-1-search-engine`. The base remains `ops/preflight-2026-10-13` at `f3f1dcfd4f6cc36c26b52d027d38ded8c86e2468`. Live GitHub preflight confirmed the repository, exact refs and open/draft status before edits. GitHub submitted-review and inline-thread lists were empty; the owner's supplied independent findings, prior verification record and commit history were used as the review inputs. Work remains in existing [PR #2](https://github.com/Toligrim/HH-MCP/pull/2).

The coordinator checks below ran on product commit `ba9401a81a9ab6272479de8c35c046432835206a`; documentation changes do not alter the tested source. Candidate version remains `3.2.0-search.1`. This is evidence for owner review, not permission to merge or deploy.

### Findings, fixes and compatibility

| Finding | Confirmation and change | Regression evidence |
|---|---|---|
| P0 SDK input-validation memory exhaustion | SDK 1.28.0 was affected by [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453). Pinned SDK 1.32.2 and enabled `maxToolInputElements: 20000`; enforced 256 KiB in both the custom HTTP reader and transport, and depth 64 before JSON parsing/SDK dispatch. Input errors have bounded responses and omit submitted content from logs. | Original 260 tests passed, then three new input regressions failed on the old code. Actual SDK transports now reject large arrays before HH, excessive depth and oversized/malformed HTTP bodies; ordinary initialize/list/call, schemas, scalar/raw calls and cancellation pass. |
| P0 Zod/runtime dependencies | Replaced Zod 3.25.76 with patched root Zod 4.6.6 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). No request schema uses `zod/v3`. Zod 4.6.7 was not selected because its declared engines raise the Node floor. SDK protocol schemas and the adapter path used for our schemas use Zod 4. | Clean install, typecheck and published-schema/validation checks pass. Runtime audit is zero; full audit remains nonzero for dev packages listed below. |
| P1 false COMPLETE after duplicate IDs | Reproduced `found=150`, 100+50 rows with five repeats: 145 unique IDs and false COMPLETE. Per-partition membership and persisted observation counters now detect within-leaf duplicates, invalid IDs and count mismatches. Parent probes are checked against the union of completed descendant leaves; sibling overlap is deduplicated. | 150/150 permits COMPLETE; 150/145 returns PARTIAL. Intra-page repeats, stable sibling overlap, parent-to-child index drift, found changes in both directions and checkpoint/resume diagnostics are covered. The compiled SDK probe confirms both outcomes in `deep_search`. |
| P1 structured post-filters | Confirmed unrecognized 3/3, 1/3, ON_SITE and FIELD_WORK and incorrect unknown-value handling. All 14 seeded schedules and four formats are recognized independently from description heuristics; ON_SITE and FIELD_WORK stay distinct. Unknown/malformed values and conflicting recognized evidence remain unknown. | Tests cover every ID and official label, alternatives, missing/future fields, ID/name/description contradictions, RU/EN denials and longer numeric tokens. Review found and closed further label/negation/boundary cases. |
| P2 item lookup and rollback copies | Confirmed linear `cp.items.find` per hit and full-array copies before pages. A per-run ID Map and partition sets replace identity scans; a page-sized undo record restores appended rows, membership, timestamps, provenance and partition state. | Rollback with existing hits and large rows, duplicate checkpoint IDs, old v1 reconstruction, inconsistent counters, exact 32 MiB boundary and CLI recovery pass. 5k/20k synthetic tests are in the common suite. |

Runtime transitives were refreshed within supported ranges: `@hono/node-server@1.19.15`, `body-parser@2.4.0`, `express-rate-limit@8.7.1`, `fast-uri@3.1.9`, `hono@4.13.14`, `ip-address@10.7.5`, `proxy-addr@2.0.8` and `qs@6.17.0`. A narrow SDK-scoped Hono node-server override stays inside its `^1.19.9 || ^2.0.5` range and retains the existing Node 18 dependency family. No automatic audit fix or dev-major upgrade was run. Node 22.23.1 was actually tested; a separate Node 18 runtime matrix was not run.

### Coordinator verification after the fixes

| Command/check | Actual result |
|---|---|
| `npm ci` | PASS, exit 0; 244 packages installed, 245 audited. |
| `npm run typecheck` | PASS, exit 0. |
| `npm run lint` | PASS, exit 0. |
| `npm test` | PASS, 17 files / 289 tests; 21.43 seconds. Existing 260-test baseline passed before changes; the expanded suite includes the prior cases. Expected retry/captcha fixture messages appear on stderr. |
| `npm run build` | PASS, exit 0. |
| `git diff --check` | PASS. |
| `npm audit --json --omit=dev` | PASS, exit 0, zero findings at 2026-10-27 14:33 UTC. |
| `npm audit --json` | FAIL with advisories, exit 1: 10 dev-only package findings (1 low, 1 moderate, 6 high, 2 critical). This was a successful fresh report, not a registry failure. |
| Actual Streamable HTTP | PASS in the common suite: local child-process initialize/list/call, size, depth and malformed JSON checks. SDK in-memory tests also check schemas, cancellation and element limits. |
| Compiled SDK probe | PASS: stable 150 IDs COMPLETE; repeated-page 145 IDs PARTIAL with `duplicate_vacancy_id` and `coverage_mismatch`; old scalar `search_vacancies`/`raw:true` and `get_vacancy` raw data preserved. Oversized SDK input caused zero fetches and the next small call succeeded. Six mocked fetches. |
| Compiled filter/HTML SDK probe | PASS: negated remote/schedule and hidden script/style text stayed in review; visible affirmative HTML matched. Eight mocked fetches, responses under 64 KiB. |
| Compiled CLI process probe | PASS: actual SIGINT saved CANCELLED, explicit resume COMPLETE, mocked network failure PARTIAL then resume COMPLETE; cumulative attempts 1 to 2 and frozen plan retained. Second process failed busy before fetching; checkpoint/result were 0600, spec unchanged, primary lock removed and guard inode retained. Runtime path contained spaces and only production Zod was present. |
| Protected scope | Root `.github`, deployment, historical `build-output/` and `SOURCE-CANDIDATE.txt` unchanged from base; base worktree untouched; original-source pre-existing untracked `validation/` preserved. No production changes or Actions. |

All new collection/load/transport checks used synthetic data and mocked HH reads. No production stress, credential probe, new live HH collection, authenticated ChatGPT OAuth end-to-end session or deployment occurred in this cycle. Historical live observations below are separate evidence.

### Final-source performance measurements

Linux aarch64 / four Cortex-A76 CPUs / 15 GiB RAM / Node 22.23.1. One isolated process and one sample per final case; no speed threshold or statistical guarantee. `scripts/collector-bench.mjs` preserves the baseline rich-card fixture and query/options; run from `candidate-source/`, for example `bash scripts/run-collector-bench.sh 20000 on verification`. All rows are synthetic, details fetches are disabled and HH is never called. Persistence-on serializes and writes each callback snapshot; it does not include the CLI fsync/atomic-rename protocol.

Final collector SHA-256: `3b39d934e037c01a2ffc941584136273db5eff0ed046947418f7b199249b590a`, frozen through all final measurements. Earlier post-change pilot runs are excluded from this table.

| Rows / persistence | Baseline collector time | Final collector / process wall | Baseline / final maximum RSS (KiB) | Final checkpoint bytes |
|---|---:|---:|---:|---:|
| 5,000 / off | 8.069 s (supplemental pilot) | 4.847 / 5.56 s | 366460 / 212792 | 8067038 |
| 5,000 / on | 17.528 s | 11.892 / 13.21 s | 390928 / 328180 | 8067039 |
| 20,000 / off | 158.006 s | 84.699 / 86.01 s | 1209284 / 429800 | 32422543 |
| 20,000 / on | >300 s, capped before completion | 228.960 / 230.51 s | unavailable / 1012152 | 32422544 |

All four final runs returned COMPLETE with exact counts and no gaps. The 5k cases used 55 requests / 7 partitions; 20k used 223 / 31. Callback writes were 0/68/0/272 respectively. All final checkpoints fit 33554432 bytes (32 MiB); the 20k file is about 96.6% of that cap. The baseline 20k/on run stopped at 19,550 items with a valid RUNNING checkpoint of 31692984 bytes; its RSS was not retained. The supplemental baseline 5k/off pilot used an earlier equivalent fixture selector, so it is not a strict timing comparison.

The ID index removes quadratic identity lookup and undo work scales with the page, but whole-checkpoint size measurement, callback cloning and JSON persistence still cost O(state size) per save. Overall collection is not claimed to be linear. The rich 20k/on case still takes about 229 seconds and peaks near 1 GiB RSS. No SQLite, journal storage, server export or background architecture was added. Count reconciliation diagnoses observable discrepancies in a mutable index; it does not prove absolute completeness when the upstream changes without a detectable discrepancy.

### Remaining dependency advisories

Every entry below is dev-only in the final lockfile and absent from `npm audit --omit=dev`. Package inclusion and severity do not by themselves prove an exploitable production path. These findings remain unresolved; the full audit does not pass. Each package can contain several advisory identities, and shared identities can appear in more than one package record.

| Package | Severity | Advisory identities |
|---|---|---|
| `@vitest/mocker` | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) |
| `brace-expansion` | high | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) |
| `esbuild` | low | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) |
| `js-yaml` | high | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) |
| `nanoid` | high | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8), [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) |
| `postcss` | high | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) |
| `source-map-js` | high | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| `tinypool` | critical | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) |
| `vite` | high | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9), [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm), [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw), [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r), [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) |
| `vitest` | critical | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp), [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) |

### Independent review and publication status

- SDK/input task: independent Luna 6 spec and quality review approved `536b344ca36ecb5209b1dbf502a00d95ddd08fee`, no findings.
- Structured-filter task: independent review and four scoped fix rounds ended clean at `f7b7eb5b6ad7b094ee82ccb8d177da6ffd471678`; official labels, denials, numeric boundaries and explicit unsupported schedule contradictions were corrected. No confirmed task finding remains open.
- Collector task: independent Luna 6 spec and quality review approved `ba9401a81a9ab6272479de8c35c046432835206a`, with no findings, after inspecting the complete `f7b7eb5..ba9401a` diff. Coordinator fresh checks above also pass.
- Final whole-branch review, exact published PR HEAD and draft/unmerged status will be recorded in the PR description. Merge requires the owner's literal “Мержи”; deployment is separate. MERGE: NO. DEPLOY: NO.

### Files changed by this review-fix cycle

Comparison starts at the owner's previous PR HEAD `21e096539e128660bdf00c403998d8b015d2c2c7`; the full PR diff is independently reviewed from base `f3f1dcf`.

- `candidate-source/docs/issue-1-verification.md`
- `candidate-source/docs/search-engine.md`
- `candidate-source/package-lock.json`
- `candidate-source/package.json`
- `candidate-source/scripts/collector-bench.mjs`
- `candidate-source/scripts/run-collector-bench.sh`
- `candidate-source/src/__tests__/http-input-safety.test.ts`
- `candidate-source/src/index.ts`
- `candidate-source/src/search/__tests__/cli.test.ts`
- `candidate-source/src/search/__tests__/collector.load.test.ts`
- `candidate-source/src/search/__tests__/collector.test.ts`
- `candidate-source/src/search/__tests__/filters.test.ts`
- `candidate-source/src/search/collector.ts`
- `candidate-source/src/search/dictionaries.ts`
- `candidate-source/src/search/filters.ts`
- `candidate-source/src/search/planner.ts`
- `candidate-source/src/tools/__tests__/search-mcp.test.ts`
- `candidate-source/src/tools/batch.ts`
- `candidate-source/src/tools/search.ts`
- `docs/superpowers/plans/2026-10-27-pr2-review-fixes.md`

## Historical record through 21e0965

The following sections preserve earlier task reviews, live checks and the pre-fix dependency assessment. They are historical observations; the current validation and dependency results are above.

### Local verification

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

### Review and implementation decisions

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

### Live HH evidence

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

### Read-only production baseline

An earlier coordinator read-only check on 2026-10-27 reported deployed SHA `98f9930a1bbeeed44572986c7d72b197cacc93e2`; loopback health on `127.0.0.1:3001` returned `ok`, version `v3.1.0`, 24 tools, default 55-tool inventory, and `filterActive=true`. The application, OAuth proxy, and `cloudflared` were active. Anonymous loopback proxy request to `127.0.0.1:3002/mcp` returned 401. The public request to `https://hh-mcp.kurva-cloud.ru/mcp` in that earlier check timed out after 10 seconds (curl exit 28 / HTTP 000). This failure remains historical evidence; the later check below establishes the current anonymous response. No production or network changes were made.

Later read-only Luna 6 diagnosis on 2026-10-27 at 15:26–15:27 MSK obtained public anonymous `/mcp` HTTP 401 in 0.52–0.64 seconds, local proxy 401 in about 0.8 ms, and backend health 200. Public DNS, TCP, and TLS completed successfully; the configured Cloudflare ingress still points to `127.0.0.1:3002`. The earlier public timeout was not reproduced, and no configuration fix is supported by the available evidence. A successful anonymous auth gate does not prove a complete authenticated OAuth/MCP client session. Cloudflared lifecycle logs show repeated explicit stop/start events; their trigger and any connection to the earlier timeout remain unestablished. Services, tokens, routes and deployment were unchanged by these checks.

### Dependency release preflight

The read-only dependency assessment confirmed that the saved baseline findings remain a release concern. Ten affected packages belong to the runtime dependency closure and ten to dev tooling; inclusion alone does not establish exploitation. A fresh successful standalone audit is still unavailable. The feature did not update dependency resolutions.

One high-severity runtime advisory matches the HTTP MCP server path: SDK `1.28.0` is affected by [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453), covering request-validation memory exhaustion. The current raw-body cap does not impose the advisory's separate element-count bound. Before rollout, complete a separately reviewed dependency-security change that upgrades the SDK to a patched release (at least `1.32.0`), configures `maxToolInputElements`, reassesses the body limit, evaluates the direct Zod advisory, refreshes affected transitives, and obtains fresh audit and compatibility results. Authentication narrows exposure but does not establish safety for all authenticated clients. No exploit probe, dependency upgrade, automatic audit fix or production change was performed for this assessment.

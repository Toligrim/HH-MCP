# Issue 1 verification record

This is a development candidate at version `3.2.0-search.1`. Stages 0–3 are implemented in the candidate. Server-side exports, background jobs, and analytics (stages 4–5) are deferred. No PR, merge, or deployment is claimed. The root `build-output/` and `SOURCE-CANDIDATE.txt` remain the historical deployment baseline; `candidate-source/dist/` is generated output for this candidate. Existing upstream attribution and MIT license are retained.

## Local verification

Recorded 2026-10-27 in `candidate-source/`:

| Check | Result | Evidence |
|---|---|---|
| `npm ci` | PASS | Clean dependency install completed; package lock and dependency resolutions unchanged. |
| `npm run typecheck` | PASS | `tsc --noEmit`, exit 0. |
| `npm run lint` | PASS | `eslint src`, exit 0. |
| `npm test` | PASS | 15 files, 249 tests passed. Test stderr contains expected retry/captcha fixtures. |
| `npm run build` | PASS | TypeScript build completed, exit 0. |
| Compiled CLI runtime | PASS | Copied `dist/` into a temporary path containing spaces with only production `zod` available, then ran the compiled `cli.js --unsupported`; it loaded and rejected the argument before any HH request. |
| `git diff --check` | PASS | No whitespace errors. |
| `npm audit --json` | FAIL | npm exits 1 for the existing advisories. Current: 20 total (1 low, 4 moderate, 12 high, 3 critical). Baseline `/tmp/hh-mcp-baseline-audit.json`: same counts and the same 104 advisory identities across the same 20 packages; no added, removed, or changed advisory identities. No audit fix or dependency resolution change was made. Current JSON: `/tmp/hh-mcp-current-audit-task6.json`. |

The focused CLI suite uses temporary local files and injected/mocked HH reads only. It covers pre-fetch checkpoint persistence, failure while replacing a prior checkpoint, cancellation and resume with frozen time and cumulative counters, malformed/incompatible checkpoints, path collisions and symlinks, live and stale lock owners, cleanup, and spec byte limits. No live HH request was made for this verification.

## Live HH evidence

| Probe | Result | Evidence |
|---|---|---|
| Bounded live vacancy search | FAIL | Coordinator's single unauthenticated `/vacancies` probe returned HTTP 403 with `{"type":"forbidden"}` on 2026-10-26. The probe stopped there. |
| Remaining multi-value, geo, cluster/count probes | SKIP | Not attempted after the bounded search returned 403. No bypass or credential switch was attempted. |
| Live CLI collection | SKIP | The CLI was exercised only with local mocked reads; it was not pointed at HH. |

Live API execution and semantics therefore remain unverified. Local mocked wire serialization does not establish live HH behavior.

## Read-only production baseline

Coordinator's read-only check on 2026-10-27 reported deployed SHA `98f9930a1bbeeed44572986c7d72b197cacc93e2`; loopback health on `127.0.0.1:3001` returned `ok`, version `v3.1.0`, 24 tools, default 55-tool inventory, and `filterActive=true`. The application, OAuth proxy, and `cloudflared` were active. Anonymous loopback proxy request to `127.0.0.1:3002/mcp` returned 401. A fresh public request to `https://hh-mcp.kurva-cloud.ru/mcp` timed out after 10 seconds (curl exit 28 / HTTP 000), so current external OAuth reachability is unverified; the 401 evidence is from 2026-10-26 only. No production or network changes were made.

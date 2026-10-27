# Task 6 report — local recovery CLI and operator guide

Base commit SHA: `34c4ee47cd0f3b7f1c8eddc264c2198f733e9a7e`.

## RED / GREEN

- RED: `npm test -- src/search/__tests__/cli.test.ts` failed because the CLI module was absent (7 intended cases). After adding coordinator-requested regressions first, RED also showed that explicit `limits: null`/string/array were replaced by defaults and that the bounded-read and direct-entry helpers were missing.
- GREEN: the focused CLI suite passed all 15 tests after implementation.

## Changes

- Added `candidate-source/src/search/cli.ts` with strict argument parsing, path/symlink/size preflight, default-plus-caller limits, checkpoint frozen-time resume, exclusive per-user lock and dead-owner recovery, private atomic persistence, cancellation, and concise status output.
- Added `candidate-source/src/search/__tests__/cli.test.ts` using temporary files and mocked collector reads only. It covers initial checkpoint persistence before HTTP, failed atomic replacement, result file permissions, cancellation/resume counters, malformed/incompatible checkpoints, malformed limits, bounded reads, path aliases/symlinks, lock ownership/recovery/cleanup, and entry paths containing spaces.
- Added the compiled `search:collect` script and expanded candidate/operator documentation. Appended a development-candidate pointer to the repository-root README. Historical `build-output/` and `SOURCE-CANDIDATE.txt` were untouched.

## Verification

- `npm ci` — PASS, exit 0; 242 packages installed. No package-lock or dependency-resolution changes.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `npm test` — PASS, 15 files / 249 tests.
- `npm run build` — PASS, exit 0.
- Compiled runtime — PASS: ran `dist/search/cli.js --unsupported` from a temporary install path containing spaces with only production `zod` available. It loaded and rejected the unsupported argument before HH access (expected exit 1).
- `git diff --check` — PASS, exit 0.
- `npm audit --json` — FAIL, exit 1 because of existing advisories. Baseline and current both report 20 vulnerabilities (1 low, 4 moderate, 12 high, 3 critical), with identical 104 advisory identities across the same 20 packages; no identities were added, removed, or changed. No audit fix was run. Current JSON: `/tmp/hh-mcp-current-audit-task6.json`; baseline: `/tmp/hh-mcp-baseline-audit.json`.
- Live HH — SKIP for Task 6; all CLI tests used mocked reads. Coordinator's prior bounded public vacancy search returned 403 and was stopped; remaining live probes were skipped. No live request was retried.

## Concerns

Live HH behavior remains unverified after the coordinator's 403. The pre-existing audit findings remain unchanged. Server-side exports, jobs, and analytics are deferred; no production, deployment, merge, or publish action was performed.

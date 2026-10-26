# Task 1 report: deadline-aware HH request budgets

## Result

Implemented a shared request budget for `hhGet`. A budget counts each network attempt, retry, and received response byte across calls that share the same budget object. The client enforces the deadline during limiter waits, retry delays, fetches, and streaming response reads. An optional `AbortSignal` cancels waits, active fetches, and body reads. Calls without a budget retain the existing response handling and retry behavior.

## RED and GREEN evidence

- RED: `npm test -- src/__tests__/request-budget.test.ts` against the original client — 7 of the initial 9 behavior tests failed. They exposed absent attempt/retry counters, no pre-fetch exhaustion check, unbounded Retry-After and rate waits, unbounded response body reads, and no byte accounting. The existing 401 and 403 no-retry checks passed.
- GREEN: `npm test -- src/__tests__/request-budget.test.ts` — 16 tests passed. Coverage includes request and retry counts, exhausted budgets, cancellation/deadlines in the rate queue and Retry-After waits, streaming byte overflow, slow-body deadlines, caller cancellation during body reads, 401/403/captcha no-retry behavior, HTTP-date Retry-After, malformed/negative fallback, and safe budget errors.

## Changes

- `candidate-source/src/requestBudget.ts`: budget interface, constructor, typed safe errors, and counter checks.
- `candidate-source/src/client.ts`: optional budget/signal support; abortable rate waits; deadline enforcement around gated slots, fetches, body reads, and retries; incremental byte counting; HTTP-date Retry-After parsing.
- `candidate-source/src/__tests__/request-budget.test.ts`: focused behavior tests.
- `candidate-source/src/__tests__/client.test.ts`: fixed the jitter-sensitive incident-burst test by setting `Math.random()` to its neutral value for that test only and restoring it in `finally`.

## Verification

- RED command/result: `npm test -- src/__tests__/request-budget.test.ts` — 7 failed, 2 passed against the pre-change client.
- GREEN focused command/result: `npm test -- src/__tests__/request-budget.test.ts` — 16 passed.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm test` — first run: 149 passed, 1 failed because the existing gated limiter test measured 5,964 ms across four waits against a 6,000 ms threshold. `resumeBudget.ts` applies ±20% jitter. After stabilizing that test with `Math.random() === 0.5`, the final `npm test` run passed all 150 tests across 7 files.
- `git diff --check` — PASS.

## Concerns

No outstanding implementation concerns. The first full-suite failure was isolated to the old nondeterministic jitter assumption and resolved in the test; production limiter behavior was not changed. Existing retry/captcha stderr output remains expected.

No deployment, ops, source baseline, environment, or Actions files were changed. No live HH probes were run.

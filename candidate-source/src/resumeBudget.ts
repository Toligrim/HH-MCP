/**
 * Resume-view budget: concurrency + min interval + sliding window, optionally
 * shared across processes via a lock file (two MCP instances behind one public IP).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResumeBudgetConfig {
  maxConcurrency: number;
  minIntervalMs: number;
  /** Max gated starts per sliding window; 0 = window limiter off. */
  maxPerWindow: number;
  windowMs: number;
  budgetFile: string | null;
  shared: boolean;
}

export interface ResumeBudgetHealth {
  minIntervalMs: number;
  maxConcurrency: number;
  maxPerWindow: number;
  windowMs: number;
  /** Gated starts inside the current window (shared across instances when shared). */
  windowUsed: number;
  /** Total ms spent waiting on the window limiter by this process. */
  windowWaitTotalMs: number;
  shared: boolean;
  budgetFile: string | null;
}

/** Per-call pace override (recovery mode after a captcha). */
export interface GatedPace {
  minIntervalMs: number;
  maxPerWindow: number;
}

const STALE_LOCK_MS = 30_000;
/** Drop writer pids that have not been seen for this long. */
const WRITER_TTL_MS = 24 * 60 * 60 * 1000;
/** Half-open probe reservations older than this are considered abandoned. */
export const PROBE_TTL_MS = 30_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function getResumeBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResumeBudgetConfig {
  const maxConcurrency = Math.max(
    1,
    parsePositiveInt(env.HH_RESUME_MAX_CONCURRENCY, 1) || 1,
  );
  const minIntervalMs = parsePositiveInt(env.HH_RESUME_MIN_INTERVAL_MS, 1500);
  const maxPerWindow = parsePositiveInt(env.HH_RESUME_MAX_PER_WINDOW, 20);
  const windowMs = Math.max(1, parsePositiveInt(env.HH_RESUME_WINDOW_MS, 60_000));
  const explicit = env.HH_BUDGET_FILE?.trim();
  const budgetFile =
    explicit === "" || explicit === "off"
      ? null
      : explicit ||
        path.join(os.tmpdir(), `hh-mcp-budget.${os.userInfo().username}.json`);
  return {
    maxConcurrency,
    minIntervalMs,
    maxPerWindow,
    windowMs,
    budgetFile,
    shared: budgetFile != null,
  };
}

/** ±20 % jitter so parallel instances do not re-synchronise. */
export function jitterInterval(ms: number): number {
  if (ms <= 0) return 0;
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(0, Math.round(ms * factor));
}

// --- in-process state ---
let localLastStartMs = 0;
let localInflight = 0;
let localWindowStarts: number[] = [];
let localWarnedCorrupt = false;
let windowWaitTotalMs = 0;
let gateTail: Promise<void> = Promise.resolve();

export interface SharedBreaker {
  state: "closed" | "open" | "half-open";
  openedAt?: number;
  cooldownMs?: number;
  /** openedAt + cooldownMs; the merge key — never decreases while open. */
  openUntil?: number;
  failures?: number;
  closedAt?: number;
  requestId?: string;
  fallbackUrl?: string;
  captchaUrl?: string;
  value?: string;
  errorType?: string;
  sourceInstance?: string;
  /** Instance holding the half-open probe and when it took it. */
  probeBy?: string;
  probeAt?: number;
  recoveryUntil?: number;
  recoverySuccesses?: number;
  lastWriter?: string;
  writers?: string[];
  /** Last time each writer id was seen; used to drop dead pids. */
  writerSeen?: Record<string, number>;
}

interface SharedState {
  lastStartMs: number;
  inflight: number;
  windowStarts: number[];
  breaker?: SharedBreaker;
}

export const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

function lockPath(budgetFile: string): string {
  return `${budgetFile}.lock`;
}

function tryAcquireLock(budgetFile: string): boolean {
  const lp = lockPath(budgetFile);
  try {
    fs.mkdirSync(lp);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") return false;
    try {
      const st = fs.statSync(lp);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lp, { recursive: true, force: true });
        fs.mkdirSync(lp);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
}

function releaseLock(budgetFile: string): void {
  try {
    fs.rmSync(lockPath(budgetFile), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function emptyShared(): SharedState {
  return { lastStartMs: 0, inflight: 0, windowStarts: [] };
}

function readShared(budgetFile: string): SharedState {
  try {
    const raw = fs.readFileSync(budgetFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<SharedState>;
    return {
      lastStartMs: typeof parsed.lastStartMs === "number" ? parsed.lastStartMs : 0,
      inflight: typeof parsed.inflight === "number" ? parsed.inflight : 0,
      windowStarts: Array.isArray(parsed.windowStarts)
        ? parsed.windowStarts.filter((t): t is number => typeof t === "number")
        : [],
      breaker: parsed.breaker,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyShared();
    }
    if (!localWarnedCorrupt) {
      localWarnedCorrupt = true;
      console.error(
        "[hh-mcp] shared budget file unreadable/corrupt — falling back to in-process limiter",
      );
    }
    return emptyShared();
  }
}

function writeShared(budgetFile: string, state: SharedState): void {
  const tmp = `${budgetFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, budgetFile);
}

async function withSharedLock<T>(
  budgetFile: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  while (!tryAcquireLock(budgetFile)) {
    if (Date.now() - start > 10_000) {
      // Degrade to local — don't hang forever.
      return fn();
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    return await fn();
  } finally {
    releaseLock(budgetFile);
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous lock for the breaker mirror; bounded, falls back to lock-free write. */
function withSharedLockSync<T>(budgetFile: string, fn: () => T): T {
  for (let i = 0; i < 40; i++) {
    if (tryAcquireLock(budgetFile)) {
      try {
        return fn();
      } finally {
        releaseLock(budgetFile);
      }
    }
    Atomics.wait(sleepBuf, 0, 0, 5);
  }
  return fn();
}

function pruneWindow(starts: number[], now: number, windowMs: number): number[] {
  return starts.filter((t) => t > now - windowMs);
}

function computeWait(
  s: { lastStartMs: number; inflight: number; windowStarts: number[] },
  cfg: ResumeBudgetConfig,
  pace: GatedPace,
  now: number,
  jitter: boolean,
): { wait: number; windowWait: number } {
  const waitConcurrency = s.inflight >= cfg.maxConcurrency ? 50 : 0;
  const interval = jitter ? jitterInterval(pace.minIntervalMs) : pace.minIntervalMs;
  const waitInterval = Math.max(0, s.lastStartMs + interval - now);
  let windowWait = 0;
  if (pace.maxPerWindow > 0) {
    const inWindow = pruneWindow(s.windowStarts, now, cfg.windowMs);
    if (inWindow.length >= pace.maxPerWindow) {
      const blocking = inWindow[inWindow.length - pace.maxPerWindow]!;
      windowWait = Math.max(1, blocking + cfg.windowMs - now);
    }
  }
  return { wait: Math.max(waitConcurrency, waitInterval, windowWait), windowWait };
}

function defaultPace(cfg: ResumeBudgetConfig): GatedPace {
  return { minIntervalMs: cfg.minIntervalMs, maxPerWindow: cfg.maxPerWindow };
}

export interface GatedSlot {
  release: () => Promise<void>;
}

/**
 * Reserve a gated slot (concurrency + spacing + window). Caller must release
 * when the request finishes (success or failure).
 */
export async function acquireGatedSlot(
  env: NodeJS.ProcessEnv = process.env,
  pace?: GatedPace,
): Promise<GatedSlot> {
  const cfg = getResumeBudgetConfig(env);
  const p = pace ?? defaultPace(cfg);

  // Serialize waiters in-process so we don't stampede the shared file.
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const previous = gateTail;
  gateTail = previous.then(() => gate);
  await previous;

  try {
    for (;;) {
      if (cfg.budgetFile) {
        const decision = await withSharedLock(cfg.budgetFile, () => {
          const now = Date.now();
          const state = readShared(cfg.budgetFile!);
          const w = computeWait(state, cfg, p, now, true);
          if (w.wait > 0) return w;
          const startedAt = Date.now();
          state.inflight += 1;
          state.lastStartMs = startedAt;
          state.windowStarts = [
            ...pruneWindow(state.windowStarts, startedAt, cfg.windowMs),
            startedAt,
          ];
          writeShared(cfg.budgetFile!, state);
          localLastStartMs = state.lastStartMs;
          localInflight = state.inflight;
          localWindowStarts = state.windowStarts;
          return { wait: 0, windowWait: 0 };
        });
        if (decision.wait > 0) {
          if (decision.windowWait > 0) windowWaitTotalMs += decision.wait;
          await new Promise((r) => setTimeout(r, decision.wait));
          continue;
        }
        break;
      }

      // In-process only
      const w = computeWait(
        {
          lastStartMs: localLastStartMs,
          inflight: localInflight,
          windowStarts: localWindowStarts,
        },
        cfg,
        p,
        Date.now(),
        true,
      );
      if (w.wait > 0) {
        if (w.windowWait > 0) windowWaitTotalMs += w.wait;
        await new Promise((r) => setTimeout(r, w.wait));
        continue;
      }
      const startedAt = Date.now();
      localInflight += 1;
      localLastStartMs = startedAt;
      localWindowStarts = [
        ...pruneWindow(localWindowStarts, startedAt, cfg.windowMs),
        startedAt,
      ];
      break;
    }
  } finally {
    releaseGate();
  }

  return {
    release: async () => {
      if (cfg.budgetFile) {
        await withSharedLock(cfg.budgetFile, () => {
          const state = readShared(cfg.budgetFile!);
          state.inflight = Math.max(0, state.inflight - 1);
          writeShared(cfg.budgetFile!, state);
          localInflight = state.inflight;
        });
      } else {
        localInflight = Math.max(0, localInflight - 1);
      }
    },
  };
}

/**
 * Estimate how long the next gated start would wait (no reservation, no jitter).
 * Used by batch tools to stop cleanly instead of sleeping past their deadline.
 */
export function peekGatedWaitMs(
  env: NodeJS.ProcessEnv = process.env,
  pace?: GatedPace,
): number {
  const cfg = getResumeBudgetConfig(env);
  const p = pace ?? defaultPace(cfg);
  const s = cfg.budgetFile
    ? readShared(cfg.budgetFile)
    : {
        lastStartMs: localLastStartMs,
        inflight: 0,
        windowStarts: localWindowStarts,
      };
  return computeWait({ ...s, inflight: 0 }, cfg, p, Date.now(), false).wait;
}

export function getResumeBudgetHealth(
  env: NodeJS.ProcessEnv = process.env,
): ResumeBudgetHealth {
  const c = getResumeBudgetConfig(env);
  const starts = c.budgetFile ? readShared(c.budgetFile).windowStarts : localWindowStarts;
  return {
    minIntervalMs: c.minIntervalMs,
    maxConcurrency: c.maxConcurrency,
    maxPerWindow: c.maxPerWindow,
    windowMs: c.windowMs,
    windowUsed: pruneWindow(starts, Date.now(), c.windowMs).length,
    windowWaitTotalMs,
    shared: c.shared,
    budgetFile: c.budgetFile,
  };
}

/** Test helper: reset in-process counters. */
export function __resetResumeBudgetForTests(): void {
  localLastStartMs = 0;
  localInflight = 0;
  localWindowStarts = [];
  localWarnedCorrupt = false;
  windowWaitTotalMs = 0;
  gateTail = Promise.resolve();
}

export function readSharedBreaker(
  env: NodeJS.ProcessEnv = process.env,
): SharedBreaker | undefined {
  const cfg = getResumeBudgetConfig(env);
  if (!cfg.budgetFile) return undefined;
  try {
    return readShared(cfg.budgetFile).breaker;
  } catch {
    return undefined;
  }
}

function mergeWriters(
  shared: SharedBreaker | undefined,
  incoming: SharedBreaker,
  now: number,
): { writers: string[]; writerSeen: Record<string, number> } {
  const seen: Record<string, number> = { ...(shared?.writerSeen ?? {}) };
  for (const w of shared?.writers ?? []) {
    if (seen[w] == null) seen[w] = now;
  }
  for (const w of incoming.writers ?? []) {
    seen[w] = now;
  }
  for (const [id, at] of Object.entries(seen)) {
    if (now - at > WRITER_TTL_MS) delete seen[id];
  }
  const writers = Object.keys(seen).slice(-8);
  const kept = new Set(writers);
  for (const id of Object.keys(seen)) {
    if (!kept.has(id)) delete seen[id];
  }
  return { writers, writerSeen: seen };
}

/**
 * Monotonic merge of breaker state: `openUntil` never decreases, and a
 * closed/half-open write cannot overwrite an open state before it expires.
 */
export function mergeBreaker(
  shared: SharedBreaker | undefined,
  incoming: SharedBreaker,
  now: number = Date.now(),
): SharedBreaker {
  if (!shared) return incoming;
  const sharedUntil = shared.state === "open" ? (shared.openUntil ?? 0) : 0;
  const { writers, writerSeen } = mergeWriters(shared, incoming, now);

  if (incoming.state === "open") {
    const incomingUntil = incoming.openUntil ?? 0;
    const base = incomingUntil >= sharedUntil ? incoming : { ...shared, ...incoming };
    return {
      ...base,
      state: "open",
      openUntil: Math.max(incomingUntil, sharedUntil),
      failures: Math.max(incoming.failures ?? 0, shared.failures ?? 0),
      requestId: base.requestId ?? shared.requestId,
      fallbackUrl: base.fallbackUrl ?? shared.fallbackUrl,
      captchaUrl: base.captchaUrl ?? shared.captchaUrl,
      writers,
      writerSeen,
    };
  }

  if (now < sharedUntil) {
    // Someone else's cooldown is still running — keep it.
    return { ...shared, writers, writerSeen, lastWriter: incoming.lastWriter };
  }

  if (incoming.state === "half-open") {
    // First probe wins; a fresh probe held by another instance is kept.
    const otherProbe =
      shared.state === "half-open" &&
      shared.probeBy != null &&
      shared.probeBy !== incoming.sourceInstance &&
      (shared.probeAt ?? 0) > now - PROBE_TTL_MS;
    if (otherProbe) return { ...shared, writers, writerSeen, lastWriter: incoming.lastWriter };
  }

  return {
    ...incoming,
    failures: incoming.state === "closed" ? incoming.failures : Math.max(incoming.failures ?? 0, shared.failures ?? 0),
    recoveryUntil: Math.max(incoming.recoveryUntil ?? 0, shared.recoveryUntil ?? 0) || undefined,
    writers,
    writerSeen,
  };
}

export function writeSharedBreaker(
  breaker: SharedBreaker,
  env: NodeJS.ProcessEnv = process.env,
): SharedBreaker | undefined {
  const cfg = getResumeBudgetConfig(env);
  if (!cfg.budgetFile) return undefined;
  const incoming: SharedBreaker = {
    ...breaker,
    lastWriter: INSTANCE_ID,
    writers: [INSTANCE_ID],
  };
  try {
    return withSharedLockSync(cfg.budgetFile, () => {
      const state = readShared(cfg.budgetFile!);
      state.breaker = mergeBreaker(state.breaker, incoming);
      writeShared(cfg.budgetFile!, state);
      return state.breaker;
    });
  } catch {
    return undefined;
  }
}

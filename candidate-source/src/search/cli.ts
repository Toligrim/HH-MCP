import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSearch, type CollectorCheckpoint, type CollectorResult } from "./collector.js";
import { planSearch, type SearchLimits } from "./planner.js";
import type { hhGet } from "../client.js";

const DEFAULT_LIMITS: SearchLimits = { max_requests: 500, max_items: 20_000, max_duration_sec: 600, max_bytes: 67_108_864, max_detail_fetches: 20_000 };
const SPEC_MAX = 64 * 1024;
const INPUT_MAX = 128 * 1024 * 1024;
type CliDependencies = {
  get?: typeof hhGet;
  lockPath?: string;
  signal?: AbortSignal;
  atomicWrite?: (path: string, data: string) => Promise<void>;
};

function usage(): Error { return new Error("usage: search:collect -- --spec <localfile> --checkpoint <localfile> [--resume] [--result <localfile>]"); }
export function isDirectEntry(argvPath: string, moduleUrl: string): boolean { return resolve(argvPath) === resolve(fileURLToPath(moduleUrl)); }
function parseArgs(args: string[]): { spec: string; checkpoint: string; result?: string; resume: boolean } {
  let spec: string | undefined;
  let checkpoint: string | undefined;
  let result: string | undefined;
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--resume") { if (resume) throw usage(); resume = true; continue; }
    if (arg !== "--spec" && arg !== "--checkpoint" && arg !== "--result") throw new Error(`unsupported argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw usage();
    if (arg === "--spec") { if (spec) throw usage(); spec = value; }
    else if (arg === "--checkpoint") { if (checkpoint) throw usage(); checkpoint = value; }
    else { if (result) throw usage(); result = value; }
  }
  if (!spec || !checkpoint) throw usage();
  return { spec, checkpoint, result, resume };
}

async function canonicalFilePath(input: string): Promise<{ path: string; exists: boolean }> {
  const lexical = resolve(input);
  const parent = await realpath(dirname(lexical));
  const path = join(parent, basename(lexical));
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`symlink path is not allowed: ${input}`);
    if (!info.isFile()) throw new Error(`path is not a regular file: ${input}`);
    return { path, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
    throw error;
  }
}

async function preflightPaths(specArg: string, checkpointArg: string, resultArg: string | undefined, lockArg: string): Promise<{ spec: string; checkpoint: string; result?: string; lock: string }> {
  const [spec, checkpoint, result, lock] = await Promise.all([
    canonicalFilePath(specArg), canonicalFilePath(checkpointArg), resultArg ? canonicalFilePath(resultArg) : Promise.resolve(undefined), canonicalFilePath(lockArg),
  ]);
  const paths = [spec.path, checkpoint.path, ...(result ? [result.path] : []), lock.path];
  if (new Set(paths).size !== paths.length) throw new Error("spec, checkpoint, result, and lock paths must not collide");
  if (!spec.exists) throw new Error("spec file does not exist");
  if (spec.exists && (await stat(spec.path)).size > SPEC_MAX) throw new Error("spec exceeds 64 KiB");
  if (checkpoint.exists && (await stat(checkpoint.path)).size > INPUT_MAX) throw new Error("checkpoint exceeds 128 MiB");
  if (lock.exists) { /* lock acquisition validates the owner and stale state */ }
  return { spec: spec.path, checkpoint: checkpoint.path, ...(result ? { result: result.path } : {}), lock: lock.path };
}

export async function atomicWriteFile(path: string, data: string, replace: typeof rename = rename): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replace(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("input path is not a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(maxBytes === SPEC_MAX ? "spec exceeds 64 KiB" : "checkpoint exceeds 128 MiB");
    return buffer.toString("utf8", 0, total);
  } finally { await handle.close(); }
}

type LockOwner = { uid: number; pid: number; nonce: string };
async function readLock(path: string): Promise<{ owner: LockOwner; info: Awaited<ReturnType<typeof stat>> }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("search collection lock is malformed or not owned by this user");
  let owner: unknown;
  try { owner = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("search collection lock is malformed"); }
  if (!owner || typeof owner !== "object" || !Number.isInteger((owner as LockOwner).uid) || !Number.isInteger((owner as LockOwner).pid) || (owner as LockOwner).pid < 1 || typeof (owner as LockOwner).nonce !== "string") throw new Error("search collection lock is malformed");
  if ((owner as LockOwner).uid !== process.getuid?.()) throw new Error("search collection lock owner does not match this user");
  return { owner: owner as LockOwner, info };
}
function sameFile(a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const owner: LockOwner = { uid: process.getuid?.() ?? -1, pid: process.pid, nonce: randomBytes(16).toString("hex") };
  const contents = JSON.stringify(owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      let createdInfo: Awaited<ReturnType<typeof handle.stat>> | undefined;
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      catch (error) {
        createdInfo = await handle.stat().catch(() => undefined);
        await handle.close().catch(() => undefined);
        if (createdInfo) {
          const current = await lstat(path).catch(() => undefined);
          if (current && sameFile(current, createdInfo)) await unlink(path).catch(() => undefined);
        }
        throw error;
      }
      await handle.close();
      const ownedInfo = await lstat(path);
      return async () => {
        try {
          const current = await lstat(path);
          if (sameFile(current, ownedInfo)) {
            const currentOwner = JSON.parse(await readFile(path, "utf8")) as LockOwner;
            if (currentOwner.nonce === owner.nonce) await unlink(path);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLock(path);
      let alive = true;
      try { process.kill(existing.owner.pid, 0); }
      catch (probe) {
        const code = (probe as NodeJS.ErrnoException).code;
        if (code === "ESRCH") alive = false;
        else if (code === "EPERM") alive = true;
        else throw new Error("cannot validate search collection lock owner");
      }
      if (alive) throw new Error("search collection is busy (another local job owns the lock)");
      const tomb = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
      await rename(path, tomb);
      const moved = await lstat(tomb);
      if (!sameFile(moved, existing.info)) {
        try { await lstat(path); } catch (restore) {
          if ((restore as NodeJS.ErrnoException).code === "ENOENT") await rename(tomb, path).catch(() => undefined);
        }
        throw new Error("search collection lock changed during stale recovery; retry the command");
      }
      await unlink(tomb);
    }
  }
  throw new Error("could not acquire search collection lock");
}

function defaults(spec: Record<string, unknown>): Record<string, unknown> {
  if (spec.limits !== undefined && (!spec.limits || typeof spec.limits !== "object" || Array.isArray(spec.limits))) throw new Error("limits must be an object when supplied");
  const limits = (spec.limits ?? {}) as Record<string, unknown>;
  return { ...spec, limits: { ...DEFAULT_LIMITS, ...limits } };
}
function readFrozenAt(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid checkpoint shape");
  const plan = (value as Record<string, unknown>).plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Number.isFinite((plan as Record<string, unknown>).frozen_at)) throw new Error("invalid checkpoint frozen_at");
  return (plan as { frozen_at: number }).frozen_at;
}

export async function runSearchCollect(args: string[], dependencies: CliDependencies = {}): Promise<CollectorResult> {
  const options = parseArgs(args);
  const lockPath = dependencies.lockPath ?? (process.platform === "linux" && process.getuid ? join(tmpdir(), `hh-mcp-search-collect-${process.getuid()}.lock`) : join(tmpdir(), `hh-mcp-search-collect-${userInfo().username}.lock`));
  const paths = await preflightPaths(options.spec, options.checkpoint, options.result, lockPath);
  let specValue: unknown;
  let specText: string;
  try { specText = await readBoundedFile(paths.spec, SPEC_MAX); }
  catch (error) { if (error instanceof Error && /64 KiB/.test(error.message)) throw error; throw new Error("spec must be a readable regular file"); }
  try { specValue = JSON.parse(specText); }
  catch { throw new Error("spec must contain valid JSON"); }
  if (!specValue || typeof specValue !== "object" || Array.isArray(specValue)) throw new Error("spec must be a JSON object");
  let checkpoint: CollectorCheckpoint | undefined;
  if (options.resume) {
    if (!options.result && options.resume && !paths.checkpoint) throw new Error("checkpoint is required for resume");
    try {
      const raw = await readBoundedFile(paths.checkpoint, INPUT_MAX);
      checkpoint = JSON.parse(raw) as CollectorCheckpoint;
      readFrozenAt(checkpoint);
    } catch { throw new Error("checkpoint is missing, oversized, or malformed"); }
  } else if ((await lstatOrMissing(paths.checkpoint)) && (await stat(paths.checkpoint)).size > INPUT_MAX) throw new Error("checkpoint exceeds 128 MiB");

  const frozenAt = checkpoint ? readFrozenAt(checkpoint) : Date.now();
  const plan = planSearch(defaults(specValue as Record<string, unknown>), frozenAt);
  const release = await acquireLock(paths.lock);
  const atomicWrite = dependencies.atomicWrite ?? atomicWriteFile;
  try {
    const result = await collectSearch(plan, {
      ...(checkpoint ? { checkpoint } : {}), ...(dependencies.get ? { get: dependencies.get } : {}), ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      onCheckpoint: async (state) => atomicWrite(paths.checkpoint, JSON.stringify(state)),
    });
    if (paths.result) await atomicWrite(paths.result, JSON.stringify({ status: result.status, manifest: result.manifest, items: result.items }));
    return result;
  } finally { await release(); }
}

async function lstatOrMissing(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const result = await runSearchCollect(process.argv.slice(2), { signal: controller.signal });
    const output = { status: result.status, requests: result.manifest.requests, items: result.manifest.known_items, checkpoint: process.argv[process.argv.indexOf("--checkpoint") + 1] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (result.status === "PARTIAL") process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "local collection failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally { process.removeListener("SIGINT", onInterrupt); }
}

if (process.argv[1] && isDirectEntry(process.argv[1], import.meta.url)) void main();

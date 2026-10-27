import { mkdtemp, readFile, readdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile, isDirectEntry, readBoundedFile, runSearchCollect } from "../cli.js";

const dirs: string[] = [];
const specValue = { native: { date_from: "2026-01-01T00:00:00Z", date_to: "2026-01-01T00:05:00Z" } };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hh-search-cli-test-"));
  dirs.push(dir);
  const spec = join(dir, "spec.json");
  const checkpoint = join(dir, "checkpoint.json");
  const lock = join(dir, "lock.json");
  await writeFile(spec, JSON.stringify(specValue));
  return { dir, spec, checkpoint, lock };
}
const emptyPage = vi.fn(async () => ({ found: 0, pages: 0, items: [] }));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local search collection CLI", () => {
  it("persists the initial checkpoint before any HTTP and leaves no checkpoint on write failure", async () => {
    const paths = await setup();
    const get = vi.fn(emptyPage);
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], {
      lockPath: paths.lock, get: get as never,
      atomicWrite: async () => { throw new Error("simulated disk failure"); },
    })).rejects.toThrow(/onCheckpoint persistence failed/);
    expect(get).not.toHaveBeenCalled();
    await expect(stat(paths.checkpoint)).rejects.toThrow();
  });

  it("preserves a prior checkpoint when atomic replacement fails", async () => {
    const paths = await setup();
    await writeFile(paths.checkpoint, "previous checkpoint");
    let writes = 0;
    const write = async (path: string, data: string) => {
      if (++writes === 1) { await (await import("node:fs/promises")).writeFile(path, data, { mode: 0o600 }); return; }
      throw new Error("simulated rename failure");
    };
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], {
      lockPath: paths.lock, get: emptyPage as never, atomicWrite: write,
    })).rejects.toThrow(/onCheckpoint persistence failed/);
    expect(JSON.parse(await readFile(paths.checkpoint, "utf8")).version).toBe("hh-search-checkpoint-v1");
  });

  it("keeps the old target and removes its private temp file when atomic rename fails", async () => {
    const paths = await setup();
    const target = join(paths.dir, "atomic.json");
    await writeFile(target, "old contents");
    await expect(atomicWriteFile(target, "new contents", async () => { throw new Error("rename failed"); })).rejects.toThrow(/rename failed/);
    expect(await readFile(target, "utf8")).toBe("old contents");
    expect((await readdir(paths.dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects path aliases and symlink targets before any HTTP", async () => {
    const paths = await setup();
    const get = vi.fn(emptyPage);
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.spec], { lockPath: paths.lock, get: get as never })).rejects.toThrow(/collid/i);
    const target = join(paths.dir, "target.json");
    await writeFile(target, "safe");
    const link = join(paths.dir, "link.json");
    await symlink(target, link);
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", link], { lockPath: paths.lock, get: get as never })).rejects.toThrow(/symlink/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects malformed and incompatible checkpoint state before any HTTP", async () => {
    const paths = await setup();
    const get = vi.fn(emptyPage);
    await writeFile(paths.checkpoint, "{");
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint, "--resume"], { lockPath: paths.lock, get: get as never })).rejects.toThrow(/checkpoint/i);
    await writeFile(paths.checkpoint, JSON.stringify({ version: "hh-search-checkpoint-v1", plan: { frozen_at: 0 } }));
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint, "--resume"], { lockPath: paths.lock, get: get as never })).rejects.toThrow(/checkpoint/i);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([null, "bad", []])("rejects explicitly malformed limits %j instead of replacing them with defaults", async (limits) => {
    const paths = await setup();
    await writeFile(paths.spec, JSON.stringify({ ...specValue, limits }));
    const get = vi.fn(emptyPage);
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], { lockPath: paths.lock, get: get as never })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("enforces the spec byte cap on the bytes actually read", async () => {
    const paths = await setup();
    const large = join(paths.dir, "large.json");
    await writeFile(large, `${JSON.stringify(specValue)}${" ".repeat(65 * 1024)}`);
    await expect(readBoundedFile(large, 64 * 1024)).rejects.toThrow(/64 KiB/);
  });

  it("recognizes compiled entry paths containing spaces from their file URL", () => {
    expect(isDirectEntry("/tmp/candidate source/dist/search/cli.js", "file:///tmp/candidate%20source/dist/search/cli.js")).toBe(true);
  });

  it("cancels durably and resumes with the frozen plan and cumulative counters", async () => {
    const paths = await setup();
    const controller = new AbortController();
    controller.abort();
    const get = vi.fn(emptyPage);
    const first = await runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], { lockPath: paths.lock, get: get as never, signal: controller.signal });
    expect(first.status).toBe("CANCELLED");
    const saved = JSON.parse(await readFile(paths.checkpoint, "utf8"));
    expect(saved.status).toBe("CANCELLED");
    const resumed = await runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint, "--resume"], { lockPath: paths.lock, get: get as never });
    expect(resumed.status).toBe("COMPLETE");
    expect(resumed.checkpoint.plan.frozen_at).toBe(saved.plan.frozen_at);
    expect(resumed.checkpoint.counters.requests).toBeGreaterThanOrEqual(saved.counters.requests);
  });

  it("takes a global exclusive lock and removes its own lock after completion", async () => {
    const first = await setup();
    const secondSpec = join(first.dir, "second.json");
    const secondCheckpoint = join(first.dir, "second-checkpoint.json");
    await writeFile(secondSpec, JSON.stringify(specValue));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = runSearchCollect(["--spec", first.spec, "--checkpoint", first.checkpoint], {
      lockPath: first.lock, get: async () => { await held; return { found: 0, pages: 0, items: [] }; },
    });
    for (let i = 0; i < 50; i++) {
      try { await stat(first.lock); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
    }
    await expect(runSearchCollect(["--spec", secondSpec, "--checkpoint", secondCheckpoint], { lockPath: first.lock, get: emptyPage as never })).rejects.toThrow(/busy|lock/i);
    release();
    await inFlight;
    await expect(stat(first.lock)).rejects.toThrow();
  });

  it("recovers a well-formed lock only when its owner PID is dead", async () => {
    const paths = await setup();
    await writeFile(paths.lock, JSON.stringify({ uid: process.getuid?.() ?? -1, pid: 2_147_483_647, nonce: "stale-owner" }), { mode: 0o600 });
    const result = await runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], { lockPath: paths.lock, get: emptyPage as never });
    expect(result.status).toBe("COMPLETE");
    await expect(stat(paths.lock)).rejects.toThrow();
  });

  it("creates private checkpoint files and rejects unsupported flags before collection", async () => {
    const paths = await setup();
    const get = vi.fn(emptyPage);
    await expect(runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint, "--api-url", "https://elsewhere"], { lockPath: paths.lock, get: get as never })).rejects.toThrow(/argument/i);
    expect(get).not.toHaveBeenCalled();
    await runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint], { lockPath: paths.lock, get: emptyPage as never });
    expect((await stat(paths.checkpoint)).mode & 0o777).toBe(0o600);
    expect(await readdir(paths.dir)).not.toContain("result.json");
  });

  it("writes a separate private result only when an explicit result path is supplied", async () => {
    const paths = await setup();
    const resultPath = join(paths.dir, "result.json");
    const result = await runSearchCollect(["--spec", paths.spec, "--checkpoint", paths.checkpoint, "--result", resultPath], { lockPath: paths.lock, get: emptyPage as never });
    const saved = JSON.parse(await readFile(resultPath, "utf8"));
    expect(saved.status).toBe(result.status);
    expect(saved.manifest.known_items).toBe(result.manifest.known_items);
    expect(saved.items).toEqual([]);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
  });
});

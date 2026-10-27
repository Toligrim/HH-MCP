import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BODY_LIMIT = 256 * 1024;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate test port");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("HTTP MCP input limits", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index.ts", "--http"], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        HTTP_PORT: String(port),
        HH_TOOLS: "search",
        HH_ACCESS_TOKEN: "",
        HH_LOG_DIR: "off",
        HH_LEDGER_FILE: "off",
        HH_QUOTA_CHECK: "off",
      },
    });
    await viWaitForHealth(baseUrl, child);
    transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client({ name: "http-input-safety", version: "1.0.0" });
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("serves real Streamable HTTP initialize, list and call requests", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toContain("get_capabilities");
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    expect(result.isError).not.toBe(true);
    const quotedDelimiters = await client.callTool({ name: "plan_search", arguments: {
      native: { text: `find ${"{[".repeat(40)}` },
    } });
    expect(quotedDelimiters.isError).not.toBe(true);
  });

  it("rejects deep envelopes and malformed JSON before dispatch", async () => {
    const deep = { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "plan_search", arguments: { native: { text: "go", unknown: nestedValue(80) } },
    } };
    const tooDeep = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(deep),
    });
    expect(tooDeep.status).toBe(400);

    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
  });

  it("rejects HTTP bodies above 256 KiB with a bounded 413 response", async () => {
    const valid = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    const body = valid + " ".repeat(BODY_LIMIT + 1 - Buffer.byteLength(valid));
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    expect(body.length).toBeGreaterThan(BODY_LIMIT);
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(1_000);
  });
});

function nestedValue(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index++) value = { nested: value };
  return value;
}

async function viWaitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`HTTP test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP test server did not become healthy: ${String(lastError)}`);
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeHttpMcpSessions, configureTools, createHttpServer } from "../index.js";

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

function rawRequestTarget(port: number, requestTarget: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw request timed out")));
    socket.once("connect", () => {
      socket.write(`POST ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

type FixtureCall = { path: string; aborted: boolean; release: () => void };
const fixtureCalls: FixtureCall[] = [];

function rawMcpRequest(endpoint: string, options: {
  method?: "POST" | "DELETE";
  sessionId?: string;
  host?: string;
  origin?: string;
  protocolVersion?: string;
  body?: unknown;
  onChunk?: (chunk: string) => void;
} = {}): Promise<{ status: number; body: string }> {
  const target = new URL(endpoint);
  const headers: Record<string, string> = {};
  if (options.method !== "DELETE") {
    headers["content-type"] = "application/json";
    headers.accept = "application/json, text/event-stream";
  }
  if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
  if (options.host) headers.host = options.host;
  if (options.origin) headers.origin = options.origin;
  if (options.protocolVersion) headers["mcp-protocol-version"] = options.protocolVersion;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: options.method ?? "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        options.onChunk?.(chunk.toString("utf8"));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function connectHttpClient(endpoint: string, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, close: async () => { await client.close(); } };
}

function captureToolRequestIds(transport: StreamableHTTPClientTransport): Array<string | number> {
  const ids: Array<string | number> = [];
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (!Array.isArray(message) && "method" in message && message.method === "tools/call") {
      ids.push(message.id);
    }
    return send(message, options);
  };
  return ids;
}

describe("HTTP MCP input limits", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let fixtureServer: Server;
  let fixtureUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const fixturePort = await freePort();
    fixtureUrl = `http://127.0.0.1:${fixturePort}`;
    fixtureCalls.length = 0;
    fixtureServer = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", fixtureUrl);
      const call: FixtureCall = {
        path: `${url.pathname}${url.search}`,
        aborted: false,
        release: () => {
          if (response.writableEnded || response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json" });
          const vacancyId = url.pathname.match(/^\/vacancies\/(\d+)$/)?.[1];
          response.end(JSON.stringify(vacancyId
            ? { id: vacancyId, name: "Mock vacancy", description: "" }
            : { items: [], found: 0, pages: 0, per_page: 20, page: 0 }));
        },
      };
      response.on("close", () => { if (!response.writableFinished) call.aborted = true; });
      fixtureCalls.push(call);
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once("error", reject);
      fixtureServer.listen(fixturePort, "127.0.0.1", resolve);
    });
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
        HH_ALLOWED_ORIGINS: "http://allowed.test",
        HH_API_BASE_URL: fixtureUrl,
      },
    });
    await viWaitForHealth(baseUrl, child);
    transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client({ name: "http-input-safety", version: "1.0.0" });
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    for (const call of fixtureCalls) call.release();
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (fixtureServer?.listening) await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  });

  it("serves real Streamable HTTP initialize, list and call requests", async () => {
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toContain("get_capabilities");
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    expect(result.isError).not.toBe(true);
    const quotedDelimiters = await client.callTool({ name: "plan_search", arguments: {
      native: { text: `find ${"{[".repeat(40)}` },
    } });
    expect(quotedDelimiters.isError).not.toBe(true);
  });

  it("forwards SDK HTTP cancellation to the active deep search and releases its busy slot", async () => {
    fixtureCalls.length = 0;
    const controller = new AbortController();
    const request = client.callTool({
      name: "deep_search",
      arguments: { native: { text: "go" }, limits: { max_requests: 1, max_items: 5 } },
    }, undefined, { signal: controller.signal }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      controller.abort(new Error("test cancellation"));
      await request;
      await vi.waitFor(() => expect(fixtureCalls[0]?.aborted).toBe(true));

      const retry = client.callTool({ name: "deep_search", arguments: {
        native: { text: "go" }, limits: { max_requests: 1, max_items: 5 },
      } });
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(2));
      fixtureCalls[1]!.release();
      expect((await retry).isError).not.toBe(true);
    } finally {
      controller.abort();
      fixtureCalls[0]?.release();
      fixtureCalls[1]?.release();
      await request;
    }
  });

  it.each([
    ["malformed cancellation envelope", { jsonrpc: "2.0", id: 90, method: "notifications/cancelled", params: { requestId: 1, reason: 42 } }, undefined],
    ["unsupported protocol version", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "test" } }, "unsupported-test-version"],
  ] as const)("does not close an active call stream for a rejected %s", async (_label, cancellation, protocolVersion) => {
    fixtureCalls.length = 0;
    const activeClient = await connectHttpClient(`${baseUrl}/mcp`, `rejected-cancel-${randomUUID()}`);
    const ids = captureToolRequestIds(activeClient.transport);
    const activeCall = activeClient.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } });
    let settled = false;
    const observedCall = activeCall.then((value) => {
      settled = true;
      return value;
    }, (error) => {
      settled = true;
      throw error;
    });
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      const rejected = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        ...(protocolVersion ? { protocolVersion } : {}),
        body: { ...cancellation, params: { ...cancellation.params, requestId: ids[0] } },
      });
      expect(rejected.status).toBe(protocolVersion ? 400 : 200);
      expect(settled).toBe(false);

      fixtureCalls[0]!.release();
      const outcome = await Promise.race([
        observedCall.then(() => "settled", () => "rejected"),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 750)),
      ]);
      expect(outcome).toBe("settled");
      expect(fixtureCalls[0]?.aborted).toBe(false);
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close();
      await observedCall.catch(() => undefined);
    }
  });

  it("keeps delayed legacy sessionless tool calls alive through their response", async () => {
    fixtureCalls.length = 0;
    const responsePromise = rawMcpRequest(`${baseUrl}/mcp`, {
      body: {
        jsonrpc: "2.0",
        id: 70,
        method: "tools/call",
        params: { name: "deep_search", arguments: { native: { text: "go" }, limits: { max_requests: 1, max_items: 5 } } },
      },
    });
    await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
    fixtureCalls[0]!.release();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body).toContain('"jsonrpc":"2.0"');
    expect(response.body).toContain('"id":70');
    expect(fixtureCalls[0]?.aborted).toBe(false);
  });

  it("still handles a valid cancellation notification in an accepted mixed batch", async () => {
    fixtureCalls.length = 0;
    const activeClient = await connectHttpClient(`${baseUrl}/mcp`, "mixed-cancel-client");
    const ids = captureToolRequestIds(activeClient.transport);
    const activeCall = activeClient.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      const mixedBatch = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: [
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: ids[0], reason: "accepted mixed batch" } },
          { jsonrpc: "2.0", id: 91, method: "tools/list", params: {} },
        ],
      });
      expect(mixedBatch.status).toBe(200);
      expect(mixedBatch.body).toContain('"id":91');
      await vi.waitFor(() => expect(fixtureCalls[0]?.aborted).toBe(true));
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close();
      await activeCall;
    }
  });

  it("ignores a valid cancellation for an unknown request ID", async () => {
    fixtureCalls.length = 0;
    const activeClient = await connectHttpClient(`${baseUrl}/mcp`, "unknown-cancel-client");
    const call = activeClient.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } });
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      const unknownCancellation = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999, reason: "unknown ID" } },
      });
      expect(unknownCancellation.status).toBe(202);
      expect(fixtureCalls[0]?.aborted).toBe(false);
      fixtureCalls[0]!.release();
      expect((await call).isError).not.toBe(true);
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close();
    }
  });

  it("ignores cancellation for a completed member of an open HTTP batch", async () => {
    fixtureCalls.length = 0;
    const activeClient = await connectHttpClient(`${baseUrl}/mcp`, "batch-cancel-client");
    let batchStreamBody = "";
    const batchResponse = rawMcpRequest(`${baseUrl}/mcp`, {
      sessionId: activeClient.transport.sessionId,
      onChunk: (chunk) => { batchStreamBody += chunk; },
      body: [
        { jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "get_vacancies_batch", arguments: { ids: ["123"] } } },
        { jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "get_vacancies_batch", arguments: { ids: ["124"] } } },
      ],
    });
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(2));
      const cancelledFixtureCall = fixtureCalls.find((call) => call.path.startsWith("/vacancies/123"));
      const siblingFixtureCall = fixtureCalls.find((call) => call.path.startsWith("/vacancies/124"));
      expect(cancelledFixtureCall).toBeDefined();
      expect(siblingFixtureCall).toBeDefined();
      cancelledFixtureCall!.release();
      await vi.waitFor(() => expect(batchStreamBody).toContain('"id":201'));
      const cancellation = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 201, reason: "cancel one batch member" } },
      });
      expect(cancellation.status).toBe(202);
      expect(cancelledFixtureCall?.aborted).toBe(false);
      expect(batchStreamBody.match(/"id":201/g)).toHaveLength(1);
      expect(siblingFixtureCall?.aborted).toBe(false);
      siblingFixtureCall!.release();
      const response = await batchResponse;
      expect(response.status).toBe(200);
      expect(response.body).toContain('"id":201');
      expect(response.body).toContain('"id":202');
      expect(response.body).not.toContain("Request cancelled.");
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close();
    }
  });

  it("cancels one active HTTP batch member while preserving its sibling result", async () => {
    fixtureCalls.length = 0;
    const activeClient = await connectHttpClient(`${baseUrl}/mcp`, "active-batch-cancel-client");
    const batchResponse = rawMcpRequest(`${baseUrl}/mcp`, {
      sessionId: activeClient.transport.sessionId,
      body: [
        { jsonrpc: "2.0", id: 211, method: "tools/call", params: { name: "get_vacancies_batch", arguments: { ids: ["123"] } } },
        { jsonrpc: "2.0", id: 212, method: "tools/call", params: { name: "get_vacancies_batch", arguments: { ids: ["124"] } } },
      ],
    });
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(2));
      const cancelledFixtureCall = fixtureCalls.find((call) => call.path.startsWith("/vacancies/123"));
      const siblingFixtureCall = fixtureCalls.find((call) => call.path.startsWith("/vacancies/124"));
      expect(cancelledFixtureCall).toBeDefined();
      expect(siblingFixtureCall).toBeDefined();
      const cancellation = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 211, reason: "cancel active batch member" } },
      });
      expect(cancellation.status).toBe(202);
      await vi.waitFor(() => expect(cancelledFixtureCall?.aborted).toBe(true));
      expect(siblingFixtureCall?.aborted).toBe(false);
      siblingFixtureCall!.release();
      const response = await batchResponse;
      expect(response.status).toBe(200);
      expect(response.body).toContain('"id":211');
      expect(response.body).toContain('"id":212');
      expect(response.body).toContain("Request cancelled.");
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close();
    }
  });

  it("isolates colliding SDK request IDs by session and bounds session routing", async () => {
    fixtureCalls.length = 0;
    const first = await connectHttpClient(`${baseUrl}/mcp`, "http-cancel-client-a");
    const second = await connectHttpClient(`${baseUrl}/mcp`, "http-cancel-client-b");
    const firstIds = captureToolRequestIds(first.transport);
    const secondIds = captureToolRequestIds(second.transport);
    const firstAbort = new AbortController();
    const firstRequest = first.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } }, undefined, { signal: firstAbort.signal }).catch(() => undefined);
    let secondRequest: ReturnType<typeof second.client.callTool> | undefined;
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      secondRequest = second.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } });
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(2));
      expect(firstIds[0]).toEqual(secondIds[0]);
      expect(typeof firstIds[0]).toBe("number");
      const firstSessionId = first.transport.sessionId;
      const secondSessionId = second.transport.sessionId;
      expect(firstSessionId).toBeDefined();
      expect(secondSessionId).toBeDefined();
      expect(firstSessionId).not.toBe(secondSessionId);

      const malformed = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: "malformed-session-id",
        body: { jsonrpc: "2.0", id: 40, method: "tools/list" },
      });
      expect(malformed.status).toBe(400);
      const unknown = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: randomUUID(),
        body: { jsonrpc: "2.0", id: 41, method: "tools/list" },
      });
      expect(unknown.status).toBe(404);

      const blockedCancel = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: secondSessionId,
        host: "evil.example",
        body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: secondIds[0], reason: "host test" } },
      });
      expect(blockedCancel.status).toBe(403);
      const blockedDelete = await rawMcpRequest(`${baseUrl}/mcp`, {
        method: "DELETE",
        sessionId: secondSessionId,
        origin: "https://evil.example",
      });
      expect(blockedDelete.status).toBe(403);
      expect(fixtureCalls[1]?.aborted).toBe(false);

      firstAbort.abort(new Error("cancel only client a"));
      await firstRequest;
      await vi.waitFor(() => expect(fixtureCalls[0]?.aborted).toBe(true));
      expect(fixtureCalls[1]?.aborted).toBe(false);
      fixtureCalls[1]!.release();
      expect((await secondRequest).isError).not.toBe(true);

      await second.transport.terminateSession();
      const afterTermination = await rawMcpRequest(`${baseUrl}/mcp`, {
        sessionId: secondSessionId,
        body: { jsonrpc: "2.0", id: 42, method: "tools/list" },
      });
      expect(afterTermination.status).toBe(404);
    } finally {
      firstAbort.abort();
      fixtureCalls.forEach((call) => call.release());
      await Promise.all([firstRequest, secondRequest?.catch(() => undefined)]);
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("allows only a validated cancellation through a saturated session and permits DELETE cleanup", async () => {
    const previousEnv = new Map<string, string | undefined>();
    const testEnv = {
      HH_API_BASE_URL: fixtureUrl,
      HH_BUDGET_FILE: "off",
      HH_CACHE_TTL_MS: "0",
      HH_QUOTA_CHECK: "off",
      HH_LEDGER_FILE: "off",
      HH_LOG_DIR: "off",
    };
    for (const [key, value] of Object.entries(testEnv)) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    configureTools({ allow: "search", env: {} });
    const port = await freePort();
    const host = "127.0.0.1";
    const server = createHttpServer({
      port,
      allowedHosts: [`${host}:${port}`],
      allowedOrigins: ["http://allowed.test"],
      maxActiveRequestsPerSession: 1,
      sessionIdleTimeoutMs: 10_000,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const activeClient = await connectHttpClient(`http://${host}:${port}/mcp`, "saturated-session-client");
    const ids = captureToolRequestIds(activeClient.transport);
    fixtureCalls.length = 0;
    const firstCall = activeClient.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["123"] } }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(1));
      const mixedBatch = await rawMcpRequest(`http://${host}:${port}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: [
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: ids[0], reason: "must not bypass the cap" } },
          { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
        ],
      });
      expect(mixedBatch.status).toBe(429);
      expect(fixtureCalls[0]?.aborted).toBe(false);

      const cancellation = await rawMcpRequest(`http://${host}:${port}/mcp`, {
        sessionId: activeClient.transport.sessionId,
        body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: ids[0], reason: "valid saturated-session cancellation" } },
      });
      expect(cancellation.status).toBe(202);
      await vi.waitFor(() => expect(fixtureCalls[0]?.aborted).toBe(true));

      const secondCall = activeClient.client.callTool({ name: "get_vacancies_batch", arguments: { ids: ["124"] } }).catch(() => undefined);
      await vi.waitFor(() => expect(fixtureCalls.length).toBe(2));
      const terminated = await rawMcpRequest(`http://${host}:${port}/mcp`, {
        method: "DELETE",
        sessionId: activeClient.transport.sessionId,
      });
      expect(terminated.status).toBe(200);
      await vi.waitFor(() => expect(fixtureCalls[1]?.aborted).toBe(true));
      await activeClient.close();
      await Promise.all([firstCall, secondCall]);
    } finally {
      fixtureCalls.forEach((call) => call.release());
      await activeClient.close().catch(() => undefined);
      await Promise.all([firstCall]);
      await closeHttpMcpSessions(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      configureTools({ env: {} });
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reserves session capacity atomically, expires idle sessions, and closes sessions on shutdown", async () => {
    configureTools({ allow: "search", env: {} });
    const port = await freePort();
    const host = "127.0.0.1";
    const server = createHttpServer({
      port,
      allowedHosts: [`${host}:${port}`],
      allowedOrigins: ["http://allowed.test"],
      maxSessions: 1,
      sessionIdleTimeoutMs: 250,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const endpoint = `http://${host}:${port}/mcp`;
    const initializeBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "preflight", version: "1" } },
    };
    const blockedHostInitialization = await rawMcpRequest(endpoint, { host: "evil.example", body: initializeBody });
    expect(blockedHostInitialization.status).toBe(403);
    const blockedOriginInitialization = await rawMcpRequest(endpoint, { origin: "https://evil.example", body: initializeBody });
    expect(blockedOriginInitialization.status).toBe(403);
    const attempts = await Promise.allSettled([
      connectHttpClient(endpoint, "capacity-client-a"),
      connectHttpClient(endpoint, "capacity-client-b"),
    ]);
    const connected = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
    expect(connected).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const initial = connected[0]!;
    const expiredId = initial.transport.sessionId;
    expect(expiredId).toBeDefined();
    await initial.client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterExpiry = await rawMcpRequest(endpoint, {
      sessionId: expiredId,
      body: { jsonrpc: "2.0", id: 50, method: "tools/list" },
    });
    expect(afterExpiry.status).toBe(404);

    const replacement = await connectHttpClient(endpoint, "after-expiry-client");
    const replacementId = replacement.transport.sessionId;
    expect(replacementId).toBeDefined();
    await closeHttpMcpSessions(server);
    const afterShutdown = await rawMcpRequest(endpoint, {
      sessionId: replacementId,
      body: { jsonrpc: "2.0", id: 51, method: "tools/list" },
    });
    expect(afterShutdown.status).toBe(503);

    await Promise.all([initial.close(), replacement.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configureTools({ env: {} });
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

describe("HTTP request target handling", () => {
  it("returns a bounded 400 for an invalid request target and remains healthy", async () => {
    const port = await freePort();
    const server = createHttpServer({ port, allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    try {
      const response = await rawRequestTarget(port, "http://[");
      expect(response).toMatch(/^HTTP\/1\.1 400\b/m);
      expect(Buffer.byteLength(response)).toBeLessThan(1_000);

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await closeHttpMcpSessions(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

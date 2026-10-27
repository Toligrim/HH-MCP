import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configureTools, createServer } from "../../index.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function connect() {
  const server = createServer();
  const client = new Client({ name: "search-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

const silentEnv = () => {
  delete process.env.HH_ACCESS_TOKEN;
  process.env.HH_BUDGET_FILE = "off";
  process.env.HH_CACHE_TTL_MS = "0";
  process.env.HH_QUOTA_CHECK = "off";
  process.env.HH_LEDGER_FILE = "off";
  process.env.HH_LOG_DIR = "off";
};

afterEach(() => {
  vi.unstubAllGlobals();
  configureTools({ env: {} });
  delete process.env.HH_ACCESS_TOKEN;
});

describe("search tools over the MCP transport", () => {
  it("publishes non-empty strict schemas and the safe search inventory", async () => {
    configureTools({ allow: "search", env: {} });
    const { client, close } = await connect();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map(({ name }) => name);
      expect(names).toEqual([
        "plan_search", "explain_search", "deep_search", "get_capabilities",
        "resolve_search_dictionary", "get_vacancies_batch",
      ]);
      expect(names).not.toContain("validate_token");
      expect(names).not.toContain("get_employer_manager");
      expect(names).not.toContain("get_resume");
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect(byName.get("plan_search")?.inputSchema.properties).toHaveProperty("native");
      expect(byName.get("deep_search")?.inputSchema.properties).toHaveProperty("native");
      expect(byName.get("explain_search")?.inputSchema.properties).toHaveProperty("text");
      expect(byName.get("resolve_search_dictionary")?.inputSchema.properties).toHaveProperty("dictionary");
      expect(byName.get("get_vacancies_batch")?.inputSchema.properties).toHaveProperty("ids");
      expect(byName.get("plan_search")?.inputSchema.additionalProperties).toBe(false);
      expect(byName.get("deep_search")?.inputSchema.additionalProperties).toBe(false);
      const planned = await client.callTool({ name: "plan_search", arguments: { native: { text: "go" } } });
      expect(planned.isError).not.toBe(true);
      expect((planned.content as { text: string }[])[0]!.text).toContain("signature");
      const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
      const payload = JSON.parse((capabilities.content as { text: string }[])[0]!.text);
      expect(payload.implementation).toBeDefined();
      expect(payload.schema_version).toBeDefined();
      expect(payload.api_limits.pagination).toBe("unsupported");
      expect(payload.checkpoint_mode).toBe("local_cli_only");
      expect(payload.auth_mode).toBe("external_oauth_proxy");
      expect(payload.export_enabled).toBe(false);
      expect(payload.bulk_jobs_enabled).toBe(false);
      expect(payload.rate_limit_scope).toBe("process");
      expect(payload.read_only_mode).toBe(true);
    } finally { await close(); }
  });

  it("keeps legacy scalar/default/raw contracts over tools/call", async () => {
    silentEnv();
    const fetch = vi.fn(async () => response({ items: [{ id: "123", name: "Go Developer", employer: { name: "Example" }, area: { name: "Moscow" } }], found: 1, pages: 1, per_page: 20, page: 0 }));
    vi.stubGlobal("fetch", fetch);
    const { client, close } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === "search_vacancies")?.inputSchema.additionalProperties).toBe(false);
      const summary = await client.callTool({ name: "search_vacancies", arguments: { area: 1, text: "go" } });
      expect((summary.content as { text: string }[])[0]!.text).toContain("Go Developer");
      const url = new URL(String(fetch.mock.calls[0]![0]));
      expect(url.searchParams.get("area")).toBe("1");
      expect(url.searchParams.get("per_page")).toBe("20");
      const raw = await client.callTool({ name: "search_vacancies", arguments: { raw: true, text: "go" } });
      expect(JSON.parse((raw.content as { text: string }[])[0]!.text).items[0].id).toBe("123");
    } finally { await close(); }
  });

  it("rejects invalid cross-field and unknown inputs before any HH request", async () => {
    silentEnv();
    const fetch = vi.fn(async () => response({ items: [], found: 0, pages: 0 }));
    vi.stubGlobal("fetch", fetch);
    const { client, close } = await connect();
    try {
      const invalid = await client.callTool({ name: "search_vacancies", arguments: { currency: "USD", mystery: true } });
      expect(invalid.isError).toBe(true);
      const invalidCrossField = await client.callTool({ name: "search_vacancies", arguments: { currency: "USD" } });
      expect(invalidCrossField.isError).toBe(true);
      const plan = await client.callTool({ name: "plan_search", arguments: { native: { text: "go" }, unknown: true } });
      expect(plan.isError).toBe(true);
      const duplicateBranches = await client.callTool({ name: "plan_search", arguments: {
        native: {}, branches: [{ name: "same", native: {} }, { name: "same", native: {} }],
      } });
      expect(duplicateBranches.isError).toBe(true);
      const overCap = await client.callTool({ name: "deep_search", arguments: { native: { text: "go" }, limits: { max_requests: 26 } } });
      expect(overCap.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it("applies omitted MCP limits and reports the actual active inventory", async () => {
    configureTools({ allow: "search", env: {} });
    const { client, close } = await connect();
    try {
      const planned = await client.callTool({ name: "plan_search", arguments: { native: { text: "go" }, limits: { max_requests: 4, max_items: 7 } } });
      const plan = JSON.parse((planned.content as { text: string }[])[0]!.text);
      expect(plan.limits).toMatchObject({ max_requests: 4, max_items: 7, max_duration_sec: 20, max_bytes: 2 * 1024 * 1024, max_detail_fetches: 25 });
      const safe = await client.callTool({ name: "get_capabilities", arguments: {} });
      const capabilities = JSON.parse((safe.content as { text: string }[])[0]!.text);
      expect(capabilities.enabled_tools).toEqual([
        "plan_search", "explain_search", "deep_search", "get_capabilities", "resolve_search_dictionary", "get_vacancies_batch",
      ]);
      expect(capabilities.read_only_mode).toBe(true);
      expect(capabilities.full_detail_fetch_enabled).toBe(true);
      expect(capabilities.api_limits.max_output_bytes).toBe(64 * 1024);
      expect(capabilities.api_limits.pagination).toBe("unsupported");
    } finally { await close(); }

    configureTools({ env: {} });
    const unrestricted = await connect();
    try {
      const result = await unrestricted.client.callTool({ name: "get_capabilities", arguments: {} });
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ read_only_mode: false, full_detail_fetch_enabled: true });
    } finally { await unrestricted.close(); }
  });

  it("rejects a concurrent deep search as retryable and releases the process slot", async () => {
    silentEnv();
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { client, close } = await connect();
    try {
      const args = { native: { text: "go" }, limits: { max_requests: 1, max_items: 5 } };
      const first = client.callTool({ name: "deep_search", arguments: args });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const busy = await client.callTool({ name: "deep_search", arguments: args });
      expect(busy.isError).toBe(true);
      expect((busy.content as { text: string }[])[0]!.text).toMatch(/already running.*retry/i);
      release(response({ items: [], found: 0, pages: 0 }));
      const completed = await first;
      expect(completed.isError).not.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const next = client.callTool({ name: "deep_search", arguments: args });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      release(response({ items: [], found: 0, pages: 0 }));
      expect((await next).isError).not.toBe(true);
    } finally { await close(); }
  });

  it("forwards MCP cancellation to the in-flight HH request", async () => {
    silentEnv();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal as AbortSignal;
      observedSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const { client, close } = await connect();
    const controller = new AbortController();
    try {
      const request = client.callTool({ name: "deep_search", arguments: { native: { text: "go" } } }, undefined, { signal: controller.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      controller.abort();
      await request;
      expect(observedSignal?.aborted).toBe(true);
      const retryFetch = vi.fn(async () => response({ items: [], found: 0, pages: 0 }));
      vi.stubGlobal("fetch", retryFetch);
      const next = await client.callTool({ name: "deep_search", arguments: { native: { text: "go" } } });
      expect(next.isError).not.toBe(true);
    } finally { await close(); }
  });

  it("reports executed branch criteria and keeps inclusive unknowns in review IDs", async () => {
    silentEnv();
    const fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/vacancies/123") return response({ id: "123", description: "" });
      return response({ items: [{ id: "123", name: "Backend engineer" }], found: 1, pages: 1 });
    });
    vi.stubGlobal("fetch", fetch);
    const { client, close } = await connect();
    try {
      const branchResult = await client.callTool({ name: "deep_search", arguments: {
        native: { area: "1", text: "backend" },
        branches: [{ name: "override", native: { area: "2" } }],
        limits: { max_requests: 2, max_items: 5 },
      } });
      const branch = JSON.parse((branchResult.content as { text: string }[])[0]!.text);
      expect(branch.applied_filters.base_template.area).toEqual(["1"]);
      expect(branch.applied_filters.branches).toHaveLength(1);
      expect(branch.applied_filters.branches[0]).toMatchObject({ name: "override", native: { area: ["2"] }, overridden_fields: ["area"] });
      expect(new URLSearchParams(branch.applied_filters.branches[0].query).get("area")).toBe("2");
      expect(branch.matched_ids).toEqual(["123"]);
      expect(branch.matched_ids_returned).toBe(branch.matched_ids.length);

      const filteredResult = await client.callTool({ name: "deep_search", arguments: {
        native: { text: "backend" }, post_filters: [{ rule: "required_technology", value: "PostgreSQL" }], filter_mode: "inclusive",
        limits: { max_requests: 2, max_items: 5, max_detail_fetches: 1 },
      } });
      const filtered = JSON.parse((filteredResult.content as { text: string }[])[0]!.text);
      expect(filtered.matched_ids).toEqual([]);
      expect(filtered.review_ids).toEqual(["123"]);
      expect(filtered.summaries[0].filtering).toMatchObject({ state: "unknown", decision: "keep" });
    } finally { await close(); }
  });

  it("keeps deep-search output under 64 KiB and reports actual returned summaries", async () => {
    silentEnv();
    const items = Array.from({ length: 20 }, (_, index) => ({ id: String(index + 1), name: "x".repeat(6000) }));
    vi.stubGlobal("fetch", vi.fn(async () => response({ items, found: items.length, pages: 1 })));
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "deep_search", arguments: { mode: "fast", native: { text: "backend" }, limits: { max_requests: 1, max_items: 20 } } });
      const text = (result.content as { text: string }[])[0]!.text;
      const payload = JSON.parse(text);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(payload.summaries_returned).toBe(payload.summaries.length);
      expect(payload.summaries_truncated).toBe(true);
      expect(payload.total_known).toBe(20);
    } finally { await close(); }
  });
});

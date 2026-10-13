#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/** Unfiltered default surface (compile-time / test assertion). */
export declare const DEFAULT_TOOL_NAMES: string[];
export declare const DEFAULT_TOOL_COUNT: number;
/** Active tool count after HH_TOOLS filter (defaults to DEFAULT_TOOL_COUNT). */
export declare let TOOL_COUNT: number;
/** Apply HH_TOOLS / CLI filter. Call once from main() before serving. */
export declare function configureTools(opts?: {
    allow?: string;
    exclude?: string;
    env?: NodeJS.ProcessEnv;
}): void;
export declare function createServer(): McpServer;
export declare function getHealthPayload(): Record<string, unknown>;

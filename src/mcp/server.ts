import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { registerResources } from "./resources/index.ts";
import { registerTools } from "./tools/index.ts";
import type { McpServerOptions } from "./types.ts";

/**
 * Debug logger that writes to stderr (doesn't interfere with stdio MCP protocol)
 */
export function createDebugLogger(enabled: boolean) {
	return (message: string, data?: unknown) => {
		if (!enabled) return;
		const timestamp = new Date().toISOString();
		const line = data
			? `[jack-mcp ${timestamp}] ${message}: ${JSON.stringify(data)}`
			: `[jack-mcp ${timestamp}] ${message}`;
		console.error(line);
	};
}

export async function createMcpServer(options: McpServerOptions = {}) {
	const debug = createDebugLogger(options.debug ?? false);

	debug("Creating MCP server", { version: pkg.version, options });

	const server = new McpServer(
		{
			name: "jack",
			version: pkg.version,
		},
		{
			capabilities: {
				tools: {},
				resources: {},
			},
		},
	);

	registerTools(server, options, debug);
	registerResources(server, options, debug);

	return { server, debug };
}

export async function startMcpServer(options: McpServerOptions = {}) {
	const { server, debug } = await createMcpServer(options);
	const transport = new StdioServerTransport();

	debug("Starting MCP server on stdio transport");

	// Always log startup to stderr so user knows it's running
	console.error(
		`[jack-mcp] Server started (v${pkg.version})${options.debug ? " [debug mode]" : ""}`,
	);

	await server.connect(transport);

	debug("MCP server connected and ready");
}

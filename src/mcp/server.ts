import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { registerResources } from "./resources/index.ts";
import { registerTools } from "./tools/index.ts";
import type { McpServerOptions } from "./types.ts";

export async function createMcpServer(options: McpServerOptions = {}) {
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

	registerTools(server, options);
	registerResources(server, options);

	return server;
}

export async function startMcpServer(options: McpServerOptions = {}) {
	const server = await createMcpServer(options);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

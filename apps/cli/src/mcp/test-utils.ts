import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer } from "./server.ts";
import type { McpServerOptions } from "./types.ts";

export interface McpClientOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	clientName?: string;
	clientVersion?: string;
}

export interface McpTestClient {
	client: Client;
	transport: Transport;
	getStderr(): string;
	close(): Promise<void>;
}

/**
 * Open an MCP test client using in-memory transport.
 * This is the recommended approach for testing - no process spawning,
 * no race conditions, deterministic behavior.
 */
export async function openMcpTestClientInMemory(
	serverOptions: McpServerOptions = {},
): Promise<McpTestClient> {
	// Create linked transport pair
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	// Create and connect server
	const { server } = await createMcpServer(serverOptions);
	await server.connect(serverTransport);

	// Create and connect client
	const client = new Client({
		name: "jack-mcp-test",
		version: "0.1.0",
	});
	await client.connect(clientTransport);

	return {
		client,
		transport: clientTransport,
		getStderr: () => "(in-memory transport - no stderr)",
		close: async () => {
			await clientTransport.close();
			await serverTransport.close();
		},
	};
}

/**
 * Open an MCP test client using stdio transport (spawns a child process).
 * This tests the full stdio path but is prone to race conditions.
 * Use openMcpTestClientInMemory() for reliable testing.
 */
export async function openMcpTestClientStdio(options: McpClientOptions): Promise<McpTestClient> {
	const transport = new StdioClientTransport({
		command: options.command,
		args: options.args ?? [],
		cwd: options.cwd,
		env: options.env as Record<string, string> | undefined,
		stderr: "pipe",
	});

	let stderr = "";
	transport.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const client = new Client({
		name: options.clientName ?? "jack-mcp-test",
		version: options.clientVersion ?? "0.1.0",
	});

	try {
		await client.connect(transport);
	} catch (error) {
		await transport.close();
		throw error;
	}

	return {
		client,
		transport,
		getStderr: () => stderr,
		close: () => transport.close(),
	};
}

// Legacy alias for backwards compatibility
export const openMcpTestClient = openMcpTestClientStdio;

export function parseMcpToolResult(toolResult: {
	content?: Array<{ type: string; text?: string }>;
	[key: string]: unknown;
}): unknown {
	const toolText = toolResult.content?.[0]?.type === "text" ? toolResult.content[0].text : null;
	if (!toolText) {
		throw new Error("MCP tool response missing text content");
	}

	const parsed = JSON.parse(toolText);
	if (!parsed.success) {
		const message = parsed.error?.message ?? "unknown error";
		throw new Error(`MCP tool failed: ${message}`);
	}

	return parsed.data;
}

export async function verifyMcpToolsAndResources(client: Client): Promise<void> {
	const tools = await client.listTools();
	if (!tools.tools?.length) {
		throw new Error("MCP server reported no tools");
	}

	const resources = await client.listResources();
	if (!resources.resources?.length) {
		throw new Error("MCP server reported no resources");
	}

	await client.readResource({ uri: "agents://context" });
}

export async function callMcpListProjects(
	client: Client,
	filter?: "all" | "local" | "deployed" | "cloud",
): Promise<unknown[]> {
	const response = await client.callTool({
		name: "list_projects",
		arguments: filter ? { filter } : {},
	});

	const data = parseMcpToolResult(response);
	if (!Array.isArray(data)) {
		throw new Error("MCP list_projects returned unexpected data");
	}

	return data;
}

export async function callMcpGetProjectStatus(
	client: Client,
	args: { name?: string; project_path?: string },
): Promise<unknown> {
	const response = await client.callTool({
		name: "get_project_status",
		arguments: args,
	});

	return parseMcpToolResult(response);
}

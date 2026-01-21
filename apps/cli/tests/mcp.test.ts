import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import {
	openMcpTestClientInMemory,
	callMcpListProjects,
	verifyMcpToolsAndResources,
} from "../src/mcp/test-utils.ts";

test("MCP server exposes tools and resources", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "jack-mcp-test-"));

	let client: Awaited<ReturnType<typeof openMcpTestClientInMemory>> | null = null;
	try {
		// Use in-memory transport - no process spawning, no race conditions
		client = await openMcpTestClientInMemory({ projectPath: projectDir });

		// Verify tools and resources are exposed
		await verifyMcpToolsAndResources(client.client);

		// Test list_projects tool
		const projects = await callMcpListProjects(client.client, "local");
		expect(Array.isArray(projects)).toBe(true);
	} finally {
		await client?.close();
		await rm(projectDir, { recursive: true, force: true });
	}
});

test("MCP server has expected tools", async () => {
	const client = await openMcpTestClientInMemory();

	try {
		const tools = await client.client.listTools();
		const toolNames = tools.tools?.map((t) => t.name) ?? [];

		// Core tools should always be present
		expect(toolNames).toContain("create_project");
		expect(toolNames).toContain("deploy_project");
		expect(toolNames).toContain("get_project_status");
		expect(toolNames).toContain("list_projects");
		expect(toolNames).toContain("execute_sql");
	} finally {
		await client.close();
	}
});

test("MCP server has expected resources", async () => {
	const client = await openMcpTestClientInMemory();

	try {
		const resources = await client.client.listResources();
		const resourceUris = resources.resources?.map((r) => r.uri) ?? [];

		expect(resourceUris).toContain("agents://context");
		expect(resourceUris).toContain("jack://capabilities");
	} finally {
		await client.close();
	}
});

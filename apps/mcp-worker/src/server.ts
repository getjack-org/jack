import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ControlPlaneClient } from "./control-plane.ts";
import { deployFromCode } from "./tools/deploy-code.ts";
import { deployFromTemplate } from "./tools/deploy-template.ts";
import { getLogs } from "./tools/logs.ts";
import { getProjectStatus, listProjects } from "./tools/projects.ts";
import type { Bindings } from "./types.ts";

export function createMcpServer(token: string, env: Bindings): McpServer {
	const server = new McpServer({
		name: "jack",
		version: "1.0.0",
	});

	const client = new ControlPlaneClient(token, env.CONTROL_PLANE_URL || undefined);

	// --- deploy_from_code ---
	server.tool(
		"deploy_from_code",
		"Deploy source files to Jack Cloud. Handles npm imports (hono, zod, etc) via server-side bundling. Pass file contents as a JSON object mapping file paths to their content.",
		{
			files: z
				.record(z.string(), z.string())
				.describe(
					'Source files as { "path": "content" }. Example: { "src/index.ts": "import { Hono } from \\"hono\\";" }',
				),
			project_name: z.string().optional().describe("Project name (auto-generated if omitted)"),
			project_id: z.string().optional().describe("Existing project ID for redeployment"),
			compatibility_flags: z
				.array(z.string())
				.optional()
				.describe('Cloudflare Workers compatibility flags (default: ["nodejs_compat"])'),
		},
		async ({ files, project_name, project_id, compatibility_flags }) => {
			return deployFromCode(client, files, project_name, project_id, compatibility_flags);
		},
	);

	// --- deploy_from_template ---
	server.tool(
		"deploy_from_template",
		"Deploy a builtin Jack template (e.g. hello, api, miniapp, nextjs, saas). The control plane validates template names — pass the desired template and it will return an error if unknown.",
		{
			template: z.string().describe("Template name (e.g. 'api', 'hello', 'miniapp')"),
			project_name: z.string().optional().describe("Project name (auto-generated if omitted)"),
		},
		async ({ template, project_name }) => {
			return deployFromTemplate(client, template, project_name);
		},
	);

	// --- list_projects ---
	server.tool(
		"list_projects",
		"List all projects deployed to Jack Cloud for the authenticated user.",
		{},
		async () => {
			return listProjects(client);
		},
	);

	// --- get_project_status ---
	server.tool(
		"get_project_status",
		"Get deployment status, live URL, and resources for a project.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return getProjectStatus(client, project_id);
		},
	);

	// --- get_logs ---
	server.tool(
		"get_logs",
		"Start a log session and collect recent log entries for a project. Logs appear when the worker receives HTTP requests.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return getLogs(client, project_id);
		},
	);

	return server;
}

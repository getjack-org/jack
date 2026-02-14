import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ControlPlaneClient } from "./control-plane.ts";
import { createDatabase, executeSql, listDatabases } from "./tools/database.ts";
import { deploy } from "./tools/deploy-code.ts";
import { getLogs } from "./tools/logs.ts";
import { getProjectStatus, listProjects } from "./tools/projects.ts";
import { rollbackProject } from "./tools/rollback.ts";
import { listProjectFiles, readProjectFile } from "./tools/source.ts";
import type { Bindings } from "./types.ts";

export function createMcpServer(token: string, env: Bindings): McpServer {
	const server = new McpServer({
		name: "jack",
		version: "1.0.0",
	});

	const client = new ControlPlaneClient(token, env.CONTROL_PLANE_URL || undefined);

	server.tool(
		"deploy",
		`Deploy to Jack Cloud. Three modes (pass exactly one):
- files: Full file set for initial deploy or full redeploy. Pass all source files as { "path": "content" }.
- template: Deploy a prebuilt template (hello, api, miniapp, nextjs, saas). Always creates a new project.
- changes: Partial update to an existing project. Pass only changed files as { "path": "new content" } or { "path": null } to delete. Requires project_id.

Use files for new custom projects, changes for iterating on existing ones, template for starting from a prebuilt app.`,
		{
			files: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					'Full file set as { "path": "content" }. Example: { "src/index.ts": "import { Hono } from \\"hono\\";" }',
				),
			template: z
				.string()
				.optional()
				.describe("Prebuilt template name (e.g. 'api', 'hello', 'miniapp', 'nextjs', 'saas')"),
			changes: z
				.record(z.string(), z.string().nullable())
				.optional()
				.describe(
					'Partial file changes as { "path": "new content" } or { "path": null } to delete. Requires project_id.',
				),
			project_id: z
				.string()
				.optional()
				.describe("Existing project ID (required for changes, optional for files)"),
			project_name: z
				.string()
				.optional()
				.describe("Project name for new projects (auto-generated if omitted)"),
			compatibility_flags: z
				.array(z.string())
				.optional()
				.describe('Worker compatibility flags (default: ["nodejs_compat"])'),
		},
		async (params) => {
			return deploy(client, params);
		},
	);

	server.tool(
		"list_projects",
		"List all projects deployed to Jack Cloud for the authenticated user.",
		{},
		async () => {
			return listProjects(client);
		},
	);

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

	server.tool(
		"get_logs",
		"Collect recent log entries from a project. Listens for up to 5 seconds. Logs appear when the worker receives HTTP requests. Use after deploying to verify the app works or debug errors.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return getLogs(client, project_id);
		},
	);

	server.tool(
		"list_project_files",
		"List all source files in a deployed project. Use before read_project_file to see what files exist, or before deploying with changes to understand current project structure.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return listProjectFiles(client, project_id);
		},
	);

	server.tool(
		"read_project_file",
		"Read the contents of a single source file from a deployed project. Use after list_project_files to inspect specific files before making changes with deploy(changes).",
		{
			project_id: z.string().describe("The project ID"),
			path: z.string().describe("File path from list_project_files (e.g. 'src/index.ts')"),
		},
		async ({ project_id, path }) => {
			return readProjectFile(client, project_id, path);
		},
	);

	server.tool(
		"create_database",
		"Create a D1 SQL database for a project. Accessible in Worker code via env.DB (or custom binding_name). Requires a redeploy after creation for the binding to activate. Use list_databases first to check if one already exists.",
		{
			project_id: z.string().describe("The project ID"),
			name: z.string().optional().describe("Database name (auto-generated if omitted)"),
			binding_name: z
				.string()
				.optional()
				.describe(
					"Worker binding name, how your code accesses the DB (default: 'DB'). Use 'DB' unless your code uses a different name.",
				),
		},
		async ({ project_id, name, binding_name }) => {
			return createDatabase(client, project_id, name, binding_name);
		},
	);

	server.tool(
		"list_databases",
		"List D1 databases attached to a project. Use to check if a database exists before creating one or executing SQL.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return listDatabases(client, project_id);
		},
	);

	server.tool(
		"execute_sql",
		"Execute SQL against a project's D1 database. Read-only by default (SELECT, PRAGMA). Set allow_write=true for INSERT, UPDATE, DELETE, CREATE TABLE. Destructive operations (DROP, TRUNCATE, ALTER) are always blocked — use the Jack CLI for those.",
		{
			project_id: z.string().describe("The project ID"),
			sql: z.string().describe("SQL statement to execute"),
			params: z.array(z.unknown()).optional().describe("Bind parameters for parameterized queries"),
			allow_write: z
				.boolean()
				.optional()
				.describe(
					"Allow write operations (INSERT, UPDATE, DELETE, CREATE TABLE). Default: false (read-only).",
				),
		},
		async ({ project_id, sql, params, allow_write }) => {
			return executeSql(client, project_id, sql, params, allow_write);
		},
	);

	server.tool(
		"rollback_project",
		"Roll back to a previous deployment. Only rolls back code — database state and secrets are unchanged. Use when a deploy broke something and you need to quickly revert.",
		{
			project_id: z.string().describe("The project ID"),
			deployment_id: z
				.string()
				.optional()
				.describe(
					"Specific deployment ID to roll back to (defaults to previous successful deployment)",
				),
		},
		async ({ project_id, deployment_id }) => {
			return rollbackProject(client, project_id, deployment_id);
		},
	);

	return server;
}

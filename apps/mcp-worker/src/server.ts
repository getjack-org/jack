import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ControlPlaneClient } from "./control-plane.ts";
import { askProject } from "./tools/ask-project.ts";
import { createDatabase, executeSql, listDatabases } from "./tools/database.ts";
import { deploy } from "./tools/deploy-code.ts";
import { testEndpoint } from "./tools/endpoint-test.ts";
import { getLogs } from "./tools/logs.ts";
import { getProjectStatus, listProjects } from "./tools/projects.ts";
import { rollbackProject } from "./tools/rollback.ts";
import { listProjectFiles, listStagedChanges, readProjectFile, updateFile } from "./tools/source.ts";
import type { Bindings } from "./types.ts";

export function createMcpServer(token: string, env: Bindings): McpServer {
	const server = new McpServer({
		name: "jack-cloud",
		version: "1.0.0",
	});

	const client = new ControlPlaneClient(token, env.CONTROL_PLANE_URL || undefined);
	const kv = env.OAUTH_KV;

	server.tool(
		"deploy",
		`Deploy to Jack Cloud. Four modes (pass exactly one):
- files: Full file set for a brand-new project. Pass all source files as { "path": "content" }. Only use this for the FIRST deploy of a new custom project.
- template: Deploy a prebuilt template (hello, api, miniapp, nextjs, saas). Always creates a new project.
- changes: Partial update to an existing project. Pass only changed/added files as { "path": "new content" } or { "path": null } to delete. Requires project_id.
- staged: Deploy files previously staged via stage_file. Set staged=true with project_id. Use this when files are too large to pass inline in a single changes call.

IMPORTANT: To update an existing project, ALWAYS use changes mode with project_id. Do NOT use files mode for existing projects — it replaces all files and may create a duplicate project. If the user mentions an existing app, call list_projects first to find its project_id, then use changes.

For large files (>15KB): Use stage_file to stage files one at a time, then deploy(staged=true, project_id). This avoids output token limits that can truncate large inline content.`,
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
			staged: z
				.boolean()
				.optional()
				.describe(
					"Deploy files previously staged via stage_file calls. Requires project_id. Use when files are too large for inline changes.",
				),
			project_id: z
				.string()
				.optional()
				.describe("Existing project ID (required for changes/staged, optional for files)"),
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
			return deploy(client, params, kv);
		},
	);

	server.tool(
		"stage_file",
		`Stage a file for cloud deployment via deploy(staged=true). Only use this in environments WITHOUT local filesystem access (e.g. claude.ai web, Claude Desktop without terminal).

If you have built-in Read/Edit/Write tools available, do NOT use this tool — edit files locally and deploy with deploy_project or jack ship instead.

Best for:
- Large files that exceed output token limits when passed inline via changes
- Multi-file updates where you want to stage all changes before deploying
- Splitting a monolithic file into multiple smaller files

After staging all changes, call deploy(project_id, staged=true) to deploy.
Staged changes expire after 10 minutes if not deployed.
Pass content=null to mark a file for deletion.`,
		{
			project_id: z.string().describe("The project ID to stage changes for"),
			path: z
				.string()
				.describe("Relative file path within the project (e.g. 'src/index.ts', 'public/styles.css')"),
			content: z
				.string()
				.nullable()
				.describe("File content to write, or null to delete the file"),
		},
		async ({ project_id, path, content }) => {
			return updateFile(kv, project_id, path, content);
		},
	);

	server.tool(
		"list_staged_files",
		"List files currently staged via stage_file that haven't been deployed yet. Use to review pending changes before calling deploy(staged=true).",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return listStagedChanges(kv, project_id);
		},
	);

	server.tool(
		"ask_project",
		"Ask an evidence-backed debugging question about a deployed project. Best for runtime failures, recent changes, and code-to-production impact analysis.",
		{
			project_id: z.string().describe("The project ID"),
			question: z.string().describe("Debugging question to ask about this project"),
			hints: z
				.object({
					endpoint: z.string().optional().describe("Endpoint path hint, e.g. /api/todos"),
					method: z
						.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
						.optional()
						.describe("HTTP method hint for endpoint checks"),
					deployment_id: z
						.string()
						.optional()
						.describe("Optional deployment ID to focus historical reasoning"),
				})
				.optional(),
		},
		async ({ project_id, question, hints }) => {
			return askProject(client, project_id, question, hints);
		},
	);

	server.tool(
		"list_projects",
		"List all projects deployed to Jack Cloud for the authenticated user. Call this FIRST when the user refers to an existing app or project to find its project_id before using other tools.",
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
		"test_endpoint",
		"Make an HTTP request to a deployed project's endpoint and return the status, headers, and body. Use after deploying to verify the app works, or to debug endpoint issues. More reliable than asking the user to check manually.",
		{
			project_id: z.string().describe("The project ID"),
			path: z
				.string()
				.optional()
				.default("/")
				.describe("Endpoint path to test (e.g. '/api/health', '/'). Defaults to '/'."),
			method: z
				.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
				.optional()
				.default("GET")
				.describe("HTTP method (default: GET)"),
		},
		async ({ project_id, path, method }) => {
			return testEndpoint(client, project_id, path || "/", method);
		},
	);

	server.tool(
		"get_logs",
		"Open a LIVE log stream for up to 5 seconds and return any log entries captured during that window. This is NOT historical — it only shows logs from requests that happen WHILE listening. To capture logs: call this tool, then immediately ask the user to visit the app URL (or make a request yourself). If no requests hit the worker during the 5-second window, the result will be empty. Use to debug runtime errors after deploying.",
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return getLogs(client, project_id);
		},
	);

	server.tool(
		"browse_deployed_source",
		`List all source files in the DEPLOYED version of a project on Jack Cloud. Shows the file tree as it exists in production, not local files.

If you have local filesystem access (e.g. Claude Code with Glob/LS tools), read the local project directory instead — it's faster and more accurate.

Use before read_deployed_file to see what files exist, or before deploying with changes to understand current project structure.`,
		{
			project_id: z.string().describe("The project ID"),
		},
		async ({ project_id }) => {
			return listProjectFiles(client, project_id);
		},
	);

	server.tool(
		"read_deployed_file",
		`Read the contents of a single source file from the DEPLOYED version on Jack Cloud. Returns the file as it exists in production.

If you have local filesystem access (e.g. Claude Code with the Read tool), read the local file instead — it's faster and always up-to-date with your working copy.

Use after browse_deployed_source to inspect specific files before making changes with deploy(changes).`,
		{
			project_id: z.string().describe("The project ID"),
			path: z.string().describe("File path from browse_deployed_source (e.g. 'src/index.ts')"),
		},
		async ({ project_id, path }) => {
			return readProjectFile(client, project_id, path);
		},
	);

	server.tool(
		"create_database",
		"Create a D1 SQL database for a project. If a database with the same binding already exists, returns the existing one (idempotent). Accessible in Worker code via env.DB (or custom binding_name). After creation, redeploy the project with deploy(changes) for the binding to activate.",
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
		"Execute SQL against a project's D1 database. Read-only by default (SELECT, PRAGMA). Set allow_write=true for INSERT, UPDATE, DELETE, CREATE TABLE, and ALTER TABLE. Set allow_destructive=true for DROP and TRUNCATE (use with caution).",
		{
			project_id: z.string().describe("The project ID"),
			sql: z.string().describe("SQL statement to execute"),
			params: z.array(z.unknown()).optional().describe("Bind parameters for parameterized queries"),
			allow_write: z
				.boolean()
				.optional()
				.describe(
					"Allow write operations (INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE). Default: false (read-only).",
				),
			allow_destructive: z
				.boolean()
				.optional()
				.describe(
					"Allow destructive operations (DROP, TRUNCATE). Default: false. Use with caution.",
				),
		},
		async ({ project_id, sql, params, allow_write, allow_destructive }) => {
			return executeSql(client, project_id, sql, params, allow_write, allow_destructive);
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

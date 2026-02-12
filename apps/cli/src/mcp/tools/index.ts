import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authFetch } from "../../lib/auth/index.ts";
import { getControlApiUrl, startLogSession } from "../../lib/control-plane.ts";
import { JackError, JackErrorCode } from "../../lib/errors.ts";
import { getDeployMode, getProjectId } from "../../lib/project-link.ts";
import { createProject, deployProject, getProjectStatus } from "../../lib/project-operations.ts";
import { listAllProjects } from "../../lib/project-resolver.ts";
import { createCronSchedule } from "../../lib/services/cron-create.ts";
import { deleteCronSchedule } from "../../lib/services/cron-delete.ts";
import { listCronSchedules } from "../../lib/services/cron-list.ts";
import { testCronExpression } from "../../lib/services/cron-test.ts";
import { createDatabase } from "../../lib/services/db-create.ts";
import {
	DestructiveOperationError,
	WriteNotAllowedError,
	executeSql,
	wrapResultsForMcp,
} from "../../lib/services/db-execute.ts";
import { listDatabases } from "../../lib/services/db-list.ts";
import {
	assignDomain,
	connectDomain,
	disconnectDomain,
	listDomains,
	unassignDomain,
} from "../../lib/services/domain-operations.ts";
import { createStorageBucket } from "../../lib/services/storage-create.ts";
import { deleteStorageBucket } from "../../lib/services/storage-delete.ts";
import { getStorageBucketInfo } from "../../lib/services/storage-info.ts";
import { listStorageBuckets } from "../../lib/services/storage-list.ts";
import { createVectorizeIndex } from "../../lib/services/vectorize-create.ts";
import { deleteVectorizeIndex } from "../../lib/services/vectorize-delete.ts";
import { getVectorizeInfo } from "../../lib/services/vectorize-info.ts";
import { listVectorizeIndexes } from "../../lib/services/vectorize-list.ts";
import { Events, track, withTelemetry } from "../../lib/telemetry.ts";
import type { DebugLogger, McpServerOptions } from "../types.ts";
import { formatErrorResponse, formatSuccessResponse } from "../utils.ts";

// Tool schemas
const CreateProjectSchema = z.object({
	name: z.string().optional().describe("Project name (auto-generated if not provided)"),
	template: z
		.string()
		.optional()
		.describe(
			"Template to use (e.g., 'miniapp', 'api'). Also supports forking: use 'username/slug' for published projects or 'my-project' to fork your own.",
		),
});

const DeployProjectSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
	message: z
		.string()
		.optional()
		.describe(
			"Deploy message describing what changed and why (e.g., 'Add user auth', 'Fix CORS bug')",
		),
});

const GetProjectStatusSchema = z.object({
	name: z.string().optional().describe("Project name (auto-detected if not provided)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListProjectsSchema = z.object({
	filter: z
		.enum(["all", "local", "deployed", "cloud"])
		.optional()
		.describe("Filter projects by status (defaults to 'all')"),
});

const CreateDatabaseSchema = z.object({
	name: z.string().optional().describe("Database name (auto-generated if not provided)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListDatabasesSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ExecuteSqlSchema = z.object({
	sql: z.string().describe("SQL query to execute"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
	allow_write: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Allow write operations (INSERT, UPDATE, DELETE). Required for any data modification. Destructive operations (DROP, TRUNCATE) are blocked and must be run via CLI.",
		),
	database_name: z
		.string()
		.optional()
		.describe("Database name (auto-detect from wrangler.jsonc if not provided)"),
});

const CreateVectorizeIndexSchema = z.object({
	name: z.string().optional().describe("Index name (auto-generated if not provided)"),
	dimensions: z.number().optional().default(768).describe("Vector dimensions (default: 768)"),
	metric: z
		.enum(["cosine", "euclidean", "dot-product"])
		.optional()
		.default("cosine")
		.describe("Distance metric (default: cosine)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListVectorizeIndexesSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const DeleteVectorizeIndexSchema = z.object({
	name: z.string().describe("Index name to delete"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const GetVectorizeInfoSchema = z.object({
	name: z.string().describe("Index name"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const CreateStorageBucketSchema = z.object({
	name: z.string().optional().describe("Bucket name (auto-generated if not provided)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListStorageBucketsSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const GetStorageInfoSchema = z.object({
	name: z.string().optional().describe("Bucket name (defaults to first bucket if not provided)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const DeleteStorageBucketSchema = z.object({
	name: z.string().describe("Bucket name to delete"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const StartLogSessionSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
	label: z.string().optional().describe("Optional short tag/description for the log session"),
});

const TailLogsSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
	label: z.string().optional().describe("Optional short tag/description for the log session"),
	max_events: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.default(50)
		.describe("Maximum number of log events to collect (default: 50, max: 200)"),
	duration_ms: z
		.number()
		.int()
		.min(100)
		.max(10_000)
		.optional()
		.default(2_000)
		.describe("How long to listen before returning (default: 2000ms, max: 10000ms)"),
});

const RollbackProjectSchema = z.object({
	deployment_id: z
		.string()
		.optional()
		.describe(
			"Specific deployment ID to roll back to (defaults to previous successful deployment)",
		),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListDomainsSchema = z.object({});

const ConnectDomainSchema = z.object({
	hostname: z.string().describe("The domain hostname to connect (e.g., 'app.example.com')"),
});

const AssignDomainSchema = z.object({
	hostname: z.string().describe("The domain hostname to assign"),
	project_slug: z.string().describe("The project slug to assign the domain to"),
});

const UnassignDomainSchema = z.object({
	hostname: z.string().describe("The domain hostname to unassign from its project"),
});

const DisconnectDomainSchema = z.object({
	hostname: z.string().describe("The domain hostname to disconnect (fully remove)"),
});

const CreateCronSchema = z.object({
	expression: z
		.string()
		.describe("Cron expression (e.g., '0 * * * *' for hourly, '*/15 * * * *' for every 15 min)"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const ListCronsSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const DeleteCronSchema = z.object({
	expression: z.string().describe("Cron expression to delete"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
});

const TestCronSchema = z.object({
	expression: z.string().describe("Cron expression to test"),
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
	trigger_production: z
		.boolean()
		.optional()
		.default(false)
		.describe("Whether to trigger the cron handler on production (requires managed project)"),
});

export function registerTools(server: McpServer, _options: McpServerOptions, debug: DebugLogger) {
	// Register tool list handler
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		debug("tools/list requested");
		return {
			tools: [
				{
					name: "create_project",
					description:
						"Create a new project from a template. Automatically installs dependencies, deploys, and registers the project. Also supports forking: pass a 'username/slug' template to fork a published project, or a project slug to fork your own.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Project name (auto-generated if not provided)",
							},
							template: {
								type: "string",
								description:
									"Template to use (e.g., 'miniapp', 'api'). Also supports forking: use 'username/slug' for published projects or 'my-project' to fork your own.",
							},
						},
					},
				},
				{
					name: "deploy_project",
					description:
						"Deploy an existing project. Builds if needed and pushes to production. Always provide a 'message' describing what changed and why (e.g., 'Add user auth', 'Fix CORS bug').",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
							message: {
								type: "string",
								description:
									"Deploy message describing what changed and why (e.g., 'Add user auth', 'Fix CORS bug')",
							},
						},
					},
				},
				{
					name: "get_project_status",
					description:
						"Get live deployment state: URL, last deploy time, deploy count, status (live/failed), and deploy source. Call this first to understand what's currently deployed before making changes.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Project name (auto-detected if not provided)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "list_projects",
					description:
						"List all known projects with their status information. Can filter by local, deployed, or backup projects.",
					inputSchema: {
						type: "object",
						properties: {
							filter: {
								type: "string",
								enum: ["all", "local", "deployed", "cloud"],
								description: "Filter projects by status (defaults to 'all')",
							},
						},
					},
				},
				{
					name: "start_log_session",
					description:
						"Start or renew a 1-hour real-time log session for a managed (jack cloud) project. Returns an SSE stream URL.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
							label: {
								type: "string",
								description: "Optional short tag/description for the session",
							},
						},
					},
				},
				{
					name: "tail_logs",
					description:
						"Collect live log events from production. Use after deploying to verify changes work, or to debug errors. Returns JSON log entries with timestamps and messages.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
							label: {
								type: "string",
								description: "Optional short tag/description for the session",
							},
							max_events: {
								type: "number",
								description: "Maximum number of events to collect (default: 50, max: 200)",
							},
							duration_ms: {
								type: "number",
								description: "How long to listen before returning (default: 2000ms, max: 10000ms)",
							},
						},
					},
				},
				{
					name: "rollback_project",
					description:
						"Roll back a managed (jack cloud) project to a previous deployment. " +
						"Defaults to the previous successful deployment if no deployment_id is specified. " +
						"Only rolls back code — database state and secrets are unchanged.",
					inputSchema: {
						type: "object",
						properties: {
							deployment_id: {
								type: "string",
								description:
									"Specific deployment ID to roll back to (defaults to previous successful deployment)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "create_database",
					description:
						"Create a D1 database for a project. Returns deploy_required=true since binding needs deploy to activate.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Database name (auto-generated if not provided)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "list_databases",
					description: "List all D1 databases for a project.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "execute_sql",
					description:
						"Execute SQL against the project's D1 database. Read-only by default for safety. " +
						"Set allow_write=true for INSERT, UPDATE, DELETE operations. " +
						"Destructive operations (DROP, TRUNCATE, ALTER) are blocked and must be run via CLI with confirmation. " +
						"Results are wrapped with anti-injection headers to prevent prompt injection from database content.",
					inputSchema: {
						type: "object",
						properties: {
							sql: {
								type: "string",
								description: "SQL query to execute",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
							allow_write: {
								type: "boolean",
								default: false,
								description:
									"Allow write operations (INSERT, UPDATE, DELETE). Required for any data modification.",
							},
							database_name: {
								type: "string",
								description: "Database name (auto-detect from wrangler.jsonc if not provided)",
							},
						},
						required: ["sql"],
					},
				},
				{
					name: "create_vectorize_index",
					description:
						"Create a new Vectorize index for vector similarity search. Returns deploy_required=true since binding needs deploy to activate.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Index name (auto-generated if not provided)",
							},
							dimensions: {
								type: "number",
								default: 768,
								description: "Vector dimensions (default: 768 for bge-base-en-v1.5)",
							},
							metric: {
								type: "string",
								enum: ["cosine", "euclidean", "dot-product"],
								default: "cosine",
								description: "Distance metric (default: cosine)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "list_vectorize_indexes",
					description: "List all Vectorize indexes for a project.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "delete_vectorize_index",
					description: "Delete a Vectorize index.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Index name to delete",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
						required: ["name"],
					},
				},
				{
					name: "get_vectorize_info",
					description:
						"Get information about a Vectorize index (dimensions, metric, vector count).",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Index name",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
						required: ["name"],
					},
				},
				{
					name: "create_storage_bucket",
					description:
						"Create an R2 storage bucket for a project. Returns deploy_required=true since binding needs deploy to activate.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Bucket name (auto-generated if not provided)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "list_storage_buckets",
					description: "List all R2 storage buckets for a project.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "get_storage_info",
					description: "Get information about an R2 storage bucket.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Bucket name (defaults to first bucket if not provided)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "delete_storage_bucket",
					description: "Delete an R2 storage bucket.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Bucket name to delete",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
						required: ["name"],
					},
				},
				{
					name: "list_domains",
					description:
						"List all custom domains for the current user, including their status and assigned projects.",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "connect_domain",
					description:
						"Reserve a custom domain slot. This is the first step before assigning the domain to a project.",
					inputSchema: {
						type: "object",
						properties: {
							hostname: {
								type: "string",
								description: "The domain hostname to connect (e.g., 'app.example.com')",
							},
						},
						required: ["hostname"],
					},
				},
				{
					name: "assign_domain",
					description:
						"Assign a reserved domain to a project. The domain must be connected first. Returns DNS verification instructions.",
					inputSchema: {
						type: "object",
						properties: {
							hostname: {
								type: "string",
								description: "The domain hostname to assign",
							},
							project_slug: {
								type: "string",
								description: "The project slug to assign the domain to",
							},
						},
						required: ["hostname", "project_slug"],
					},
				},
				{
					name: "unassign_domain",
					description:
						"Unassign a domain from its project, keeping the domain slot reserved for future use.",
					inputSchema: {
						type: "object",
						properties: {
							hostname: {
								type: "string",
								description: "The domain hostname to unassign from its project",
							},
						},
						required: ["hostname"],
					},
				},
				{
					name: "disconnect_domain",
					description:
						"Fully remove a domain, releasing the slot. Use this when you no longer need the domain.",
					inputSchema: {
						type: "object",
						properties: {
							hostname: {
								type: "string",
								description: "The domain hostname to disconnect (fully remove)",
							},
						},
						required: ["hostname"],
					},
				},
				{
					name: "create_cron",
					description:
						"Create a cron schedule for a managed (Jack Cloud) project. Minimum interval is 15 minutes. The worker must handle POST /__scheduled requests — Cloudflare's native scheduled() export does not work with Jack Cloud crons.",
					inputSchema: {
						type: "object",
						properties: {
							expression: {
								type: "string",
								description:
									"Cron expression (e.g., '0 * * * *' for hourly, '*/15 * * * *' for every 15 min)",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
						required: ["expression"],
					},
				},
				{
					name: "list_crons",
					description: "List all cron schedules for a managed (Jack Cloud) project.",
					inputSchema: {
						type: "object",
						properties: {
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
					},
				},
				{
					name: "delete_cron",
					description: "Delete a cron schedule by its expression.",
					inputSchema: {
						type: "object",
						properties: {
							expression: {
								type: "string",
								description: "Cron expression to delete",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
						},
						required: ["expression"],
					},
				},
				{
					name: "test_cron",
					description:
						"Test a cron expression: validate, show human-readable description, and display next 5 scheduled times. Optionally trigger the handler on production.",
					inputSchema: {
						type: "object",
						properties: {
							expression: {
								type: "string",
								description: "Cron expression to test",
							},
							project_path: {
								type: "string",
								description: "Path to project directory (defaults to current directory)",
							},
							trigger_production: {
								type: "boolean",
								default: false,
								description:
									"Whether to trigger the cron handler on production (requires managed project)",
							},
						},
						required: ["expression"],
					},
				},
			],
		};
	});

	// Register single tools/call handler that dispatches to individual tool implementations
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const startTime = Date.now();
		const toolName = request.params.name;

		debug("tools/call requested", { tool: toolName, args: request.params.arguments });

		try {
			switch (toolName) {
				case "create_project": {
					const args = CreateProjectSchema.parse(request.params.arguments ?? {});

					const wrappedCreateProject = withTelemetry(
						"create_project",
						async (name?: string, template?: string) => {
							const result = await createProject(name, {
								template,
								interactive: false,
							});

							// Track business event
							track(Events.PROJECT_CREATED, {
								template: template ?? "default",
								platform: "mcp",
							});

							return result;
						},
						{ platform: "mcp" },
					);

					const result = await wrappedCreateProject(args.name, args.template);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "deploy_project": {
					const args = DeployProjectSchema.parse(request.params.arguments ?? {});

					const wrappedDeployProject = withTelemetry(
						"deploy_project",
						async (projectPath?: string, message?: string) => {
							const result = await deployProject({
								projectPath,
								interactive: false,
								includeSecrets: false,
								includeSync: false,
								message,
							});

							// Track business event
							track(Events.DEPLOY_STARTED, {
								platform: "mcp",
							});

							return result;
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDeployProject(args.project_path, args.message);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "get_project_status": {
					const args = GetProjectStatusSchema.parse(request.params.arguments ?? {});

					const wrappedGetProjectStatus = withTelemetry(
						"get_project_status",
						async (name?: string, projectPath?: string) => {
							const status = await getProjectStatus(name, projectPath);
							if (status === null) {
								return null;
							}
							// Add available_services to tell agents what services can be created
							return {
								...status,
								available_services: ["d1", "kv", "r2"],
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedGetProjectStatus(args.name, args.project_path);

					if (result === null) {
						throw new JackError(
							JackErrorCode.PROJECT_NOT_FOUND,
							"Project not found",
							"Use list_projects to see available projects",
						);
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "list_projects": {
					const args = ListProjectsSchema.parse(request.params.arguments ?? {});

					const wrappedListProjects = withTelemetry(
						"list_projects",
						async (filter?: "all" | "local" | "deployed" | "cloud") => {
							const allProjects = await listAllProjects();

							// Apply filter if specified
							if (!filter || filter === "all") {
								return allProjects;
							}

							switch (filter) {
								case "local":
									return allProjects.filter((p) => p.sources.filesystem);
								case "deployed":
									return allProjects.filter((p) => p.status === "live");
								case "cloud":
									return allProjects.filter((p) => p.sources.controlPlane);
								default:
									return allProjects;
							}
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListProjects(args.filter);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "start_log_session": {
					const args = StartLogSessionSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const deployMode = await getDeployMode(projectPath);
					if (deployMode !== "managed") {
						throw new JackError(
							JackErrorCode.VALIDATION_ERROR,
							"Real-time logs are only available for managed (jack cloud) projects",
							"For BYOC projects, use Cloudflare dashboard logs or 'wrangler tail'.",
						);
					}

					const projectId = await getProjectId(projectPath);
					if (!projectId) {
						throw new JackError(
							JackErrorCode.PROJECT_NOT_FOUND,
							"Project not found",
							"Run this from a linked jack cloud project directory (has .jack/project.json).",
						);
					}

					const wrappedStartLogSession = withTelemetry(
						"start_log_session",
						async (id: string, label?: string) => startLogSession(id, label),
						{ platform: "mcp" },
					);

					const result = await wrappedStartLogSession(projectId, args.label);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "tail_logs": {
					const args = TailLogsSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const deployMode = await getDeployMode(projectPath);
					if (deployMode !== "managed") {
						throw new JackError(
							JackErrorCode.VALIDATION_ERROR,
							"Real-time logs are only available for managed (jack cloud) projects",
							"For BYOC projects, use Cloudflare dashboard logs or 'wrangler tail'.",
						);
					}

					const projectId = await getProjectId(projectPath);
					if (!projectId) {
						throw new JackError(
							JackErrorCode.PROJECT_NOT_FOUND,
							"Project not found",
							"Run this from a linked jack cloud project directory (has .jack/project.json).",
						);
					}

					const wrappedTailLogs = withTelemetry(
						"tail_logs",
						async (
							id: string,
							label: string | undefined,
							maxEvents: number,
							durationMs: number,
						) => {
							const session = await startLogSession(id, label);
							const streamUrl = `${getControlApiUrl()}${session.stream.url}`;

							const controller = new AbortController();
							const timeout = setTimeout(() => controller.abort(), durationMs);

							const events: unknown[] = [];
							let truncated = false;

							try {
								const response = await authFetch(streamUrl, {
									method: "GET",
									headers: { Accept: "text/event-stream" },
									signal: controller.signal,
								});

								if (!response.ok || !response.body) {
									const err = (await response
										.json()
										.catch(() => ({ message: "Failed to open log stream" }))) as {
										message?: string;
									};
									throw new Error(err.message || `Failed to open log stream: ${response.status}`);
								}

								const reader = response.body.getReader();
								const decoder = new TextDecoder();
								let buffer = "";

								while (events.length < maxEvents) {
									const { done, value } = await reader.read();
									if (done) break;

									buffer += decoder.decode(value, { stream: true });
									const lines = buffer.split("\n");
									buffer = lines.pop() || "";

									for (const line of lines) {
										if (!line.startsWith("data:")) continue;
										const data = line.slice(5).trim();
										if (!data) continue;

										let parsed: { type?: string } | null = null;
										try {
											parsed = JSON.parse(data) as { type?: string };
										} catch {
											continue;
										}

										if (parsed?.type !== "event") continue;
										events.push(parsed);

										if (events.length >= maxEvents) {
											truncated = true;
											controller.abort();
											break;
										}
									}
								}
							} catch (error) {
								// Treat abort as a normal exit (duration elapsed or max events reached).
								if (!(error instanceof Error && error.name === "AbortError")) {
									throw error;
								}
							} finally {
								clearTimeout(timeout);
								controller.abort();
							}

							return { session: session.session, events, truncated };
						},
						{ platform: "mcp" },
					);

					const result = await wrappedTailLogs(
						projectId,
						args.label,
						args.max_events,
						args.duration_ms,
					);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "rollback_project": {
					const args = RollbackProjectSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const deployMode = await getDeployMode(projectPath);
					if (deployMode !== "managed") {
						throw new JackError(
							JackErrorCode.VALIDATION_ERROR,
							"Rollback is only available for managed (jack cloud) projects",
							"For BYOC projects, use wrangler to manage deployments.",
						);
					}

					const projectId = await getProjectId(projectPath);
					if (!projectId) {
						throw new JackError(
							JackErrorCode.PROJECT_NOT_FOUND,
							"Project not found",
							"Run this from a linked jack cloud project directory (has .jack/project.json).",
						);
					}

					// Import rollbackDeployment from control-plane
					const { rollbackDeployment } = await import("../../lib/control-plane.ts");

					const wrappedRollback = withTelemetry(
						"rollback_project",
						async (id: string, deploymentId?: string) => rollbackDeployment(id, deploymentId),
						{ platform: "mcp" },
					);

					const result = await wrappedRollback(projectId, args.deployment_id);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									formatSuccessResponse(
										{
											...result.deployment,
											message:
												"Code rolled back successfully. Database state and secrets are unchanged.",
										},
										startTime,
									),
									null,
									2,
								),
							},
						],
					};
				}

				case "create_database": {
					const args = CreateDatabaseSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedCreateDatabase = withTelemetry(
						"create_database",
						async (projectDir: string, name?: string) => {
							const result = await createDatabase(projectDir, {
								name,
								interactive: false,
							});

							// Track business event
							track(Events.SERVICE_CREATED, {
								service_type: "d1",
								platform: "mcp",
							});

							return {
								database_name: result.databaseName,
								database_id: result.databaseId,
								binding_name: result.bindingName,
								created: result.created,
								deploy_required: true,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedCreateDatabase(projectPath, args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "list_databases": {
					const args = ListDatabasesSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedListDatabases = withTelemetry(
						"list_databases",
						async (projectDir: string) => {
							const databases = await listDatabases(projectDir);
							return {
								databases: databases.map((db) => ({
									name: db.name,
									binding: db.binding,
									id: db.id,
									size_bytes: db.sizeBytes,
									num_tables: db.numTables,
								})),
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListDatabases(projectPath);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "execute_sql": {
					const args = ExecuteSqlSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedExecuteSql = withTelemetry(
						"execute_sql",
						async (projectDir: string, sql: string, allowWrite: boolean, databaseName?: string) => {
							try {
								const result = await executeSql({
									projectDir,
									sql,
									databaseName,
									allowWrite,
									interactive: false, // MCP is non-interactive
									wrapResults: true,
								});

								// Track business event
								track(Events.SQL_EXECUTED, {
									risk_level: result.risk,
									statement_count: result.statements.length,
									platform: "mcp",
								});

								// Wrap results with anti-injection header for MCP
								const wrappedContent = wrapResultsForMcp(result.results ?? [], sql, result.meta);

								return {
									success: result.success,
									risk_level: result.risk,
									results_wrapped: wrappedContent,
									meta: result.meta,
									warning: result.warning,
								};
							} catch (err) {
								if (err instanceof WriteNotAllowedError) {
									return {
										success: false,
										error: err.message,
										suggestion: "Set allow_write=true to allow data modification",
										risk_level: err.risk,
									};
								}
								if (err instanceof DestructiveOperationError) {
									return {
										success: false,
										error: err.message,
										suggestion: `Destructive operations (DROP, TRUNCATE, ALTER, DELETE without WHERE) must be run via CLI with explicit confirmation: jack services db execute "${sql.slice(0, 50)}..." --write`,
										risk_level: "destructive",
									};
								}
								throw err;
							}
						},
						{ platform: "mcp" },
					);

					const result = await wrappedExecuteSql(
						projectPath,
						args.sql,
						args.allow_write ?? false,
						args.database_name,
					);

					// Check if the result indicates an error (e.g., WriteNotAllowedError, DestructiveOperationError)
					// These are returned as objects with success: false instead of thrown
					const resultObj = result as Record<string, unknown>;
					if (resultObj?.success === false) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											success: false,
											error: resultObj.error,
											suggestion: resultObj.suggestion,
											risk_level: resultObj.risk_level,
											meta: {
												duration_ms: Date.now() - startTime,
											},
										},
										null,
										2,
									),
								},
							],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "create_vectorize_index": {
					const args = CreateVectorizeIndexSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedCreateVectorizeIndex = withTelemetry(
						"create_vectorize_index",
						async (
							projectDir: string,
							name?: string,
							dimensions?: number,
							metric?: "cosine" | "euclidean" | "dot-product",
						) => {
							const result = await createVectorizeIndex(projectDir, {
								name,
								dimensions,
								metric,
							});

							// Track business event
							track(Events.SERVICE_CREATED, {
								service_type: "vectorize",
								platform: "mcp",
							});

							return {
								index_name: result.indexName,
								binding_name: result.bindingName,
								dimensions: result.dimensions,
								metric: result.metric,
								created: result.created,
								deploy_required: true,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedCreateVectorizeIndex(
						projectPath,
						args.name,
						args.dimensions,
						args.metric,
					);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									formatSuccessResponse(result, startTime, [
										"Vectorize indexes have eventual consistency. Newly inserted vectors typically take 2-3 minutes to become queryable.",
									]),
									null,
									2,
								),
							},
						],
					};
				}

				case "list_vectorize_indexes": {
					const args = ListVectorizeIndexesSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedListVectorizeIndexes = withTelemetry(
						"list_vectorize_indexes",
						async (projectDir: string) => {
							const indexes = await listVectorizeIndexes(projectDir);
							return {
								indexes: indexes.map((idx) => ({
									name: idx.name,
									binding: idx.binding,
									dimensions: idx.dimensions,
									metric: idx.metric,
									vector_count: idx.vectorCount,
								})),
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListVectorizeIndexes(projectPath);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "delete_vectorize_index": {
					const args = DeleteVectorizeIndexSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedDeleteVectorizeIndex = withTelemetry(
						"delete_vectorize_index",
						async (projectDir: string, indexName: string) => {
							const result = await deleteVectorizeIndex(projectDir, indexName);

							// Track business event
							track(Events.SERVICE_DELETED, {
								service_type: "vectorize",
								platform: "mcp",
							});

							return {
								index_name: result.indexName,
								deleted: result.deleted,
								binding_removed: result.bindingRemoved,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDeleteVectorizeIndex(projectPath, args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "get_vectorize_info": {
					const args = GetVectorizeInfoSchema.parse(request.params.arguments ?? {});

					const wrappedGetVectorizeInfo = withTelemetry(
						"get_vectorize_info",
						async (indexName: string) => {
							const info = await getVectorizeInfo(indexName);

							if (!info) {
								throw new JackError(
									JackErrorCode.RESOURCE_NOT_FOUND,
									`Vectorize index '${indexName}' not found`,
									"Use list_vectorize_indexes to see available indexes",
								);
							}

							return {
								name: info.name,
								dimensions: info.dimensions,
								metric: info.metric,
								vector_count: info.vectorCount,
								created_on: info.createdOn,
								modified_on: info.modifiedOn,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedGetVectorizeInfo(args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "create_storage_bucket": {
					const args = CreateStorageBucketSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedCreateStorageBucket = withTelemetry(
						"create_storage_bucket",
						async (projectDir: string, name?: string) => {
							const result = await createStorageBucket(projectDir, {
								name,
								interactive: false,
							});

							// Track business event
							track(Events.SERVICE_CREATED, {
								service_type: "r2",
								platform: "mcp",
							});

							return {
								bucket_name: result.bucketName,
								binding_name: result.bindingName,
								created: result.created,
								deploy_required: true,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedCreateStorageBucket(projectPath, args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "list_storage_buckets": {
					const args = ListStorageBucketsSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedListStorageBuckets = withTelemetry(
						"list_storage_buckets",
						async (projectDir: string) => {
							const buckets = await listStorageBuckets(projectDir);
							return {
								buckets: buckets.map((bucket) => ({
									name: bucket.name,
									binding: bucket.binding,
								})),
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListStorageBuckets(projectPath);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "get_storage_info": {
					const args = GetStorageInfoSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedGetStorageInfo = withTelemetry(
						"get_storage_info",
						async (projectDir: string, bucketName?: string) => {
							const info = await getStorageBucketInfo(projectDir, bucketName);

							if (!info) {
								throw new JackError(
									JackErrorCode.RESOURCE_NOT_FOUND,
									bucketName
										? `Storage bucket '${bucketName}' not found`
										: "No storage buckets found",
									"Use list_storage_buckets to see available buckets or create_storage_bucket to create one",
								);
							}

							return {
								name: info.name,
								binding: info.binding,
								source: info.source,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedGetStorageInfo(projectPath, args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "delete_storage_bucket": {
					const args = DeleteStorageBucketSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedDeleteStorageBucket = withTelemetry(
						"delete_storage_bucket",
						async (projectDir: string, bucketName: string) => {
							const result = await deleteStorageBucket(projectDir, bucketName);

							// Track business event
							track(Events.SERVICE_DELETED, {
								service_type: "r2",
								platform: "mcp",
							});

							return {
								bucket_name: result.bucketName,
								deleted: result.deleted,
								binding_removed: result.bindingRemoved,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDeleteStorageBucket(projectPath, args.name);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "list_domains": {
					ListDomainsSchema.parse(request.params.arguments ?? {});

					const wrappedListDomains = withTelemetry(
						"list_domains",
						async () => {
							const result = await listDomains();
							return {
								domains: result.domains.map((d) => ({
									id: d.id,
									hostname: d.hostname,
									status: d.status,
									ssl_status: d.ssl_status,
									project_id: d.project_id,
									project_slug: d.project_slug,
									created_at: d.created_at,
								})),
								slots: result.slots,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListDomains();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "connect_domain": {
					const args = ConnectDomainSchema.parse(request.params.arguments ?? {});

					const wrappedConnectDomain = withTelemetry(
						"connect_domain",
						async (hostname: string) => {
							const result = await connectDomain(hostname);
							return {
								id: result.id,
								hostname: result.hostname,
								status: result.status,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedConnectDomain(args.hostname);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "assign_domain": {
					const args = AssignDomainSchema.parse(request.params.arguments ?? {});

					const wrappedAssignDomain = withTelemetry(
						"assign_domain",
						async (hostname: string, projectSlug: string) => {
							const result = await assignDomain(hostname, projectSlug);
							return {
								id: result.id,
								hostname: result.hostname,
								status: result.status,
								ssl_status: result.ssl_status,
								project_id: result.project_id,
								project_slug: result.project_slug,
								verification: result.verification,
								ownership_verification: result.ownership_verification,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedAssignDomain(args.hostname, args.project_slug);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "unassign_domain": {
					const args = UnassignDomainSchema.parse(request.params.arguments ?? {});

					const wrappedUnassignDomain = withTelemetry(
						"unassign_domain",
						async (hostname: string) => {
							const result = await unassignDomain(hostname);
							return {
								id: result.id,
								hostname: result.hostname,
								status: result.status,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedUnassignDomain(args.hostname);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "disconnect_domain": {
					const args = DisconnectDomainSchema.parse(request.params.arguments ?? {});

					const wrappedDisconnectDomain = withTelemetry(
						"disconnect_domain",
						async (hostname: string) => {
							const result = await disconnectDomain(hostname);
							return {
								success: result.success,
								hostname: result.hostname,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDisconnectDomain(args.hostname);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "create_cron": {
					const args = CreateCronSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedCreateCron = withTelemetry(
						"create_cron",
						async (projectDir: string, expression: string) => {
							const result = await createCronSchedule(projectDir, expression, {
								interactive: false,
							});

							track(Events.SERVICE_CREATED, {
								service_type: "cron",
								platform: "mcp",
							});

							return {
								id: result.id,
								expression: result.expression,
								description: result.description,
								next_run_at: result.nextRunAt,
								created: result.created,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedCreateCron(projectPath, args.expression);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "list_crons": {
					const args = ListCronsSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedListCrons = withTelemetry(
						"list_crons",
						async (projectDir: string) => {
							const schedules = await listCronSchedules(projectDir);
							return {
								schedules: schedules.map((s) => ({
									id: s.id,
									expression: s.expression,
									description: s.description,
									enabled: s.enabled,
									next_run_at: s.nextRunAt,
									last_run_at: s.lastRunAt,
									last_run_status: s.lastRunStatus,
									last_run_duration_ms: s.lastRunDurationMs,
									consecutive_failures: s.consecutiveFailures,
									created_at: s.createdAt,
								})),
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedListCrons(projectPath);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "delete_cron": {
					const args = DeleteCronSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedDeleteCron = withTelemetry(
						"delete_cron",
						async (projectDir: string, expression: string) => {
							const result = await deleteCronSchedule(projectDir, expression, {
								interactive: false,
							});

							track(Events.SERVICE_DELETED, {
								service_type: "cron",
								platform: "mcp",
							});

							return {
								expression: result.expression,
								deleted: result.deleted,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDeleteCron(projectPath, args.expression);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				case "test_cron": {
					const args = TestCronSchema.parse(request.params.arguments ?? {});
					const projectPath = args.project_path ?? process.cwd();

					const wrappedTestCron = withTelemetry(
						"test_cron",
						async (projectDir: string, expression: string, triggerProduction: boolean) => {
							const result = await testCronExpression(projectDir, expression, {
								triggerProduction,
								interactive: false,
							});

							if (!result.valid) {
								return {
									valid: false,
									error: result.error,
								};
							}

							return {
								valid: true,
								expression: result.expression,
								description: result.description,
								next_times: result.nextTimes?.map((d) => d.toISOString()),
								trigger_result: result.triggerResult
									? {
											triggered: result.triggerResult.triggered,
											status: result.triggerResult.status,
											duration_ms: result.triggerResult.durationMs,
										}
									: undefined,
							};
						},
						{ platform: "mcp" },
					);

					const result = await wrappedTestCron(
						projectPath,
						args.expression,
						args.trigger_production ?? false,
					);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
							},
						],
					};
				}

				default:
					throw new Error(`Unknown tool: ${toolName}`);
			}
		} catch (error) {
			const duration = Date.now() - startTime;
			debug("tools/call failed", {
				tool: toolName,
				duration_ms: duration,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(formatErrorResponse(error, startTime), null, 2),
					},
				],
				isError: true,
			};
		}
	});
}

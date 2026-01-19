import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JackError, JackErrorCode } from "../../lib/errors.ts";
import { createProject, deployProject, getProjectStatus } from "../../lib/project-operations.ts";
import { listAllProjects } from "../../lib/project-resolver.ts";
import { createDatabase } from "../../lib/services/db-create.ts";
import { listDatabases } from "../../lib/services/db-list.ts";
import { Events, track, withTelemetry } from "../../lib/telemetry.ts";
import type { DebugLogger, McpServerOptions } from "../types.ts";
import { formatErrorResponse, formatSuccessResponse } from "../utils.ts";

// Tool schemas
const CreateProjectSchema = z.object({
	name: z.string().optional().describe("Project name (auto-generated if not provided)"),
	template: z.string().optional().describe("Template to use (e.g., 'miniapp', 'api')"),
});

const DeployProjectSchema = z.object({
	project_path: z
		.string()
		.optional()
		.describe("Path to project directory (defaults to current directory)"),
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

export function registerTools(server: McpServer, _options: McpServerOptions, debug: DebugLogger) {
	// Register tool list handler
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		debug("tools/list requested");
		return {
			tools: [
				{
					name: "create_project",
					description:
						"Create a new Cloudflare Workers project from a template. Automatically installs dependencies, deploys to Cloudflare, and registers the project.",
					inputSchema: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Project name (auto-generated if not provided)",
							},
							template: {
								type: "string",
								description: "Template to use (e.g., 'miniapp', 'api')",
							},
						},
					},
				},
				{
					name: "deploy_project",
					description:
						"Deploy an existing project to Cloudflare Workers. Builds the project if needed and pushes to production.",
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
					name: "get_project_status",
					description:
						"Get detailed status information for a specific project, including deployment status, local path, and backup status.",
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
						async (projectPath?: string) => {
							const result = await deployProject({
								projectPath,
								interactive: false,
								includeSecrets: false,
								includeSync: false,
							});

							// Track business event
							track(Events.DEPLOY_STARTED, {
								platform: "mcp",
							});

							return result;
						},
						{ platform: "mcp" },
					);

					const result = await wrappedDeployProject(args.project_path);

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

import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JackError, JackErrorCode } from "../../lib/errors.ts";
import { createProject, deployProject, getProjectStatus } from "../../lib/project-operations.ts";
import { listAllProjects } from "../../lib/project-resolver.ts";
import { createDatabase } from "../../lib/services/db-create.ts";
import {
	DestructiveOperationError,
	WriteNotAllowedError,
	executeSql,
	wrapResultsForMcp,
} from "../../lib/services/db-execute.ts";
import { listDatabases } from "../../lib/services/db-list.ts";
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
										suggestion:
											"Destructive operations (DROP, TRUNCATE, ALTER, DELETE without WHERE) " +
											"must be run via CLI with explicit confirmation: " +
											`jack services db execute "${sql.slice(0, 50)}..." --write`,
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
								text: JSON.stringify(formatSuccessResponse(result, startTime), null, 2),
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

/**
 * Project environment introspection service
 *
 * Consolidates multiple API calls into a single environment snapshot:
 * project info, bindings, DB schema, crons, variables, and config issues.
 *
 * Used by both CLI and MCP (get_project_environment tool).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type CronScheduleInfo,
	executeManagedSql,
	fetchProjectResources,
	listCronSchedules as listCronSchedulesApi,
} from "../control-plane.ts";
import { type DeployMode, readProjectLink } from "../project-link.ts";
import { getProjectStatus } from "../project-operations.ts";
import {
	type ControlPlaneResource,
	type ResolvedResources,
	convertControlPlaneResources,
	parseWranglerResources,
} from "../resources.ts";
import { findWranglerConfig, hasWranglerConfig } from "../wrangler-config.ts";

// ============================================================================
// Types
// ============================================================================

export interface ProjectEnvironment {
	project: {
		name: string;
		url: string | null;
		deploy_mode: DeployMode;
		last_deploy: {
			at: string | null;
			status: string | null;
			message: string | null;
			source: string | null;
		} | null;
	};
	bindings: EnvironmentBindings;
	secrets_set: string[];
	variables: Record<string, string>;
	database: DatabaseSchema | null;
	crons: CronEntry[];
	issues: EnvironmentIssue[];
}

export interface EnvironmentBindings {
	d1?: { binding: string; database_name: string; database_id?: string };
	r2?: Array<{ binding: string; bucket_name: string }>;
	kv?: Array<{ binding: string; namespace_id: string; name?: string }>;
	ai?: { binding: string };
	vectorize?: Array<{ binding: string; index_name: string }>;
	durable_objects?: Array<{ binding: string; class_name: string }>;
}

export interface DatabaseSchema {
	name: string;
	tables: TableSchema[];
}

export interface TableSchema {
	name: string;
	columns: ColumnSchema[];
	row_count: number;
}

export interface ColumnSchema {
	name: string;
	type: string;
	pk: boolean;
	notnull: boolean;
}

export interface CronEntry {
	expression: string;
	enabled: boolean;
	last_run_status: string | null;
}

export interface EnvironmentIssue {
	severity: "warning" | "error";
	message: string;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get a consolidated environment snapshot for a project.
 * Handles both managed and BYO deploy modes.
 */
export async function getProjectEnvironment(projectDir: string): Promise<ProjectEnvironment> {
	const link = await readProjectLink(projectDir);
	const deployMode: DeployMode = link?.deploy_mode ?? "byo";

	// 1. Get project status (name, URL, deploy info)
	const status = await getProjectStatus(undefined, projectDir);
	if (!status) {
		throw new Error("Project not found. Ensure you're in a valid jack project directory.");
	}

	// 2. Get bindings
	const { bindings, rawResources, wranglerResources } = await getBindings(
		projectDir,
		deployMode,
		link?.project_id,
	);

	// 3. Get variables from wrangler.jsonc
	const variables = wranglerResources?.vars ?? {};

	// 4. Get secrets names from wrangler.jsonc (we only report names, not values)
	const secretsSet = await getSecretsNames(projectDir);

	// 5. Get database schema (if D1 exists)
	let database: DatabaseSchema | null = null;
	if (bindings.d1) {
		database = await getDatabaseSchema(
			projectDir,
			deployMode,
			link?.project_id,
			bindings.d1.database_name,
		);
	}

	// 6. Get crons (managed only)
	let crons: CronEntry[] = [];
	if (deployMode === "managed" && link?.project_id) {
		crons = await getCrons(link.project_id);
	}

	// 7. Detect issues
	const issues = detectIssues(bindings, rawResources, wranglerResources, projectDir);

	return {
		project: {
			name: status.name,
			url: status.workerUrl,
			deploy_mode: deployMode,
			last_deploy:
				status.lastDeployAt || status.lastDeployStatus
					? {
							at: status.lastDeployAt,
							status: status.lastDeployStatus,
							message: status.lastDeployMessage,
							source: status.lastDeploySource,
						}
					: null,
		},
		bindings,
		secrets_set: secretsSet,
		variables,
		database,
		crons,
		issues,
	};
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function getBindings(
	projectDir: string,
	deployMode: DeployMode,
	projectId?: string,
): Promise<{
	bindings: EnvironmentBindings;
	rawResources?: ControlPlaneResource[];
	wranglerResources?: ResolvedResources;
}> {
	const result: EnvironmentBindings = {};
	let rawResources: ControlPlaneResource[] | undefined;
	let wranglerResources: ResolvedResources | undefined;

	if (deployMode === "managed" && projectId) {
		// Managed: fetch from control plane
		rawResources = await fetchProjectResources(projectId);
		const resolved = convertControlPlaneResources(rawResources);
		wranglerResources = resolved;

		if (resolved.d1) {
			result.d1 = {
				binding: resolved.d1.binding,
				database_name: resolved.d1.name,
				database_id: resolved.d1.id,
			};
		}
		if (resolved.r2?.length) {
			result.r2 = resolved.r2.map((r) => ({
				binding: r.binding,
				bucket_name: r.name,
			}));
		}
		if (resolved.kv?.length) {
			result.kv = resolved.kv.map((k) => ({
				binding: k.binding,
				namespace_id: k.id,
				name: k.name,
			}));
		}
		if (resolved.ai) {
			result.ai = { binding: resolved.ai.binding };
		}
	} else {
		// BYO: parse from wrangler.jsonc
		wranglerResources = await parseWranglerResources(projectDir);

		if (wranglerResources.d1) {
			result.d1 = {
				binding: wranglerResources.d1.binding,
				database_name: wranglerResources.d1.name,
				database_id: wranglerResources.d1.id,
			};
		}
		if (wranglerResources.r2?.length) {
			result.r2 = wranglerResources.r2.map((r) => ({
				binding: r.binding,
				bucket_name: r.name,
			}));
		}
		if (wranglerResources.kv?.length) {
			result.kv = wranglerResources.kv.map((k) => ({
				binding: k.binding,
				namespace_id: k.id,
				name: k.name,
			}));
		}
		if (wranglerResources.ai) {
			result.ai = { binding: wranglerResources.ai.binding };
		}
	}

	// Also parse wrangler.jsonc for vectorize and durable_objects (not in ResolvedResources)
	await enrichFromWranglerConfig(projectDir, result);

	return { bindings: result, rawResources, wranglerResources };
}

/**
 * Parse vectorize indexes and durable objects from wrangler.jsonc,
 * since these aren't covered by the standard ResolvedResources type.
 */
async function enrichFromWranglerConfig(
	projectDir: string,
	bindings: EnvironmentBindings,
): Promise<void> {
	const wranglerPath = findWranglerConfig(projectDir);
	if (!wranglerPath) return;

	try {
		const { parseJsonc } = await import("../jsonc.ts");
		const content = await Bun.file(wranglerPath).text();
		const config = parseJsonc<{
			vectorize?: Array<{ binding: string; index_name: string }>;
			durable_objects?: {
				bindings?: Array<{ name: string; class_name: string }>;
			};
		}>(content);

		if (config.vectorize?.length) {
			bindings.vectorize = config.vectorize.map((v) => ({
				binding: v.binding,
				index_name: v.index_name,
			}));
		}

		if (config.durable_objects?.bindings?.length) {
			bindings.durable_objects = config.durable_objects.bindings.map((d) => ({
				binding: d.name,
				class_name: d.class_name,
			}));
		}
	} catch {
		// Failed to parse, skip enrichment
	}
}

/**
 * Get secret names from wrangler.jsonc (from vars that look like secrets)
 * and any .dev.vars file.
 */
async function getSecretsNames(projectDir: string): Promise<string[]> {
	const secrets = new Set<string>();

	// Check .dev.vars for secret names (these are typically what's set via wrangler secret)
	const devVarsPath = join(projectDir, ".dev.vars");
	if (existsSync(devVarsPath)) {
		try {
			const content = await Bun.file(devVarsPath).text();
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith("#")) {
					const eqIdx = trimmed.indexOf("=");
					if (eqIdx > 0) {
						secrets.add(trimmed.slice(0, eqIdx).trim());
					}
				}
			}
		} catch {
			// Ignore read errors
		}
	}

	return Array.from(secrets);
}

/**
 * Get database schema via SQL introspection.
 */
async function getDatabaseSchema(
	projectDir: string,
	deployMode: DeployMode,
	projectId: string | undefined,
	databaseName: string,
): Promise<DatabaseSchema | null> {
	try {
		// Get table list
		const tablesResult = await runSql(
			projectDir,
			deployMode,
			projectId,
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		);

		if (!tablesResult?.length) {
			return { name: databaseName, tables: [] };
		}

		const tableNames = tablesResult.map((row) => (row as { name: string }).name);

		// Get schema + row counts in parallel across all tables
		const tables = await Promise.all(
			tableNames.map(async (tableName) => {
				const escaped = tableName.replace(/"/g, '""');
				const [columnsResult, countResult] = await Promise.all([
					runSql(projectDir, deployMode, projectId, `PRAGMA table_info("${escaped}")`),
					runSql(projectDir, deployMode, projectId, `SELECT COUNT(*) as count FROM "${escaped}"`),
				]);

				const columns: ColumnSchema[] = (columnsResult ?? []).map((col: unknown) => {
					const c = col as {
						name: string;
						type: string;
						pk: number;
						notnull: number;
					};
					return {
						name: c.name,
						type: c.type,
						pk: c.pk === 1,
						notnull: c.notnull === 1,
					};
				});

				const rowCount = (countResult?.[0] as { count: number })?.count ?? 0;

				return { name: tableName, columns, row_count: rowCount };
			}),
		);

		return { name: databaseName, tables };
	} catch {
		// DB introspection failed — return null rather than crashing the whole environment call
		return null;
	}
}

/**
 * Execute SQL against the project's D1 database.
 * Routes through managed or BYO path.
 */
async function runSql(
	projectDir: string,
	deployMode: DeployMode,
	projectId: string | undefined,
	sql: string,
): Promise<unknown[] | null> {
	if (deployMode === "managed" && projectId) {
		const result = await executeManagedSql(projectId, sql);
		return result.results ?? null;
	}

	// BYO: use executeSql service
	const { executeSql } = await import("./db-execute.ts");
	const result = await executeSql({
		projectDir,
		sql,
		allowWrite: false,
		interactive: false,
	});
	return result.results ?? null;
}

/**
 * Get cron schedules for a managed project.
 */
async function getCrons(projectId: string): Promise<CronEntry[]> {
	try {
		const schedules = await listCronSchedulesApi(projectId);
		return schedules.map((s: CronScheduleInfo) => ({
			expression: s.expression,
			enabled: s.enabled,
			last_run_status: s.last_run_status,
		}));
	} catch {
		return [];
	}
}

/**
 * Detect configuration issues by comparing bindings against known resources.
 */
function detectIssues(
	bindings: EnvironmentBindings,
	_rawResources?: ControlPlaneResource[],
	wranglerResources?: ResolvedResources,
	projectDir?: string,
): EnvironmentIssue[] {
	const issues: EnvironmentIssue[] = [];

	// Check for wrangler config existence
	if (projectDir && !hasWranglerConfig(projectDir)) {
		issues.push({
			severity: "warning",
			message: "No wrangler config found in project directory",
		});
	}

	// Check for D1 binding without database_id (BYO projects)
	if (bindings.d1 && !bindings.d1.database_id) {
		issues.push({
			severity: "warning",
			message: `D1 binding '${bindings.d1.binding}' has no database_id — database may not be created yet`,
		});
	}

	// Check for KV bindings without namespace_id
	if (bindings.kv) {
		for (const kv of bindings.kv) {
			if (!kv.namespace_id) {
				issues.push({
					severity: "warning",
					message: `KV binding '${kv.binding}' has no namespace_id — namespace may not be created yet`,
				});
			}
		}
	}

	return issues;
}

import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function createDatabase(
	client: ControlPlaneClient,
	projectId: string,
	name?: string,
	bindingName?: string,
): Promise<McpToolResult> {
	try {
		// Check if a database already exists to avoid duplicates
		const { resources } = await client.listDatabases(projectId);
		const targetBinding = bindingName || "DB";
		const existing = resources.find(
			(r) => r.binding_name === targetBinding || (name && r.resource_name === name),
		);
		if (existing) {
			return ok({
				database_id: existing.id,
				database_name: existing.resource_name,
				binding_name: existing.binding_name,
				already_exists: true,
				note: `Database already exists with binding '${existing.binding_name}'. No new database created. Use execute_sql to interact with it.`,
			});
		}

		const result = await client.createDatabase(projectId, name, bindingName);
		return ok({
			database_id: result.resource.id,
			database_name: result.resource.resource_name,
			binding_name: result.resource.binding_name,
			note: "Database created. Redeploy the project with deploy(changes) for the binding to activate. Use this binding_name in your Worker code (e.g. env.DB).",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err("DEPLOY_FAILED", message, "Ensure the project exists and try again.");
	}
}

export async function listDatabases(
	client: ControlPlaneClient,
	projectId: string,
): Promise<McpToolResult> {
	try {
		const { resources } = await client.listDatabases(projectId);
		return ok({
			databases: resources.map((r) => ({
				id: r.id,
				name: r.resource_name,
				binding_name: r.binding_name,
			})),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err("NOT_FOUND", message);
	}
}

function classifySql(sql: string): "read" | "write" | "migration" | "destructive" {
	const stripped = sql
		.replace(/--.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.trim();
	const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();

	const destructive = ["DROP", "TRUNCATE"];
	const migration = ["ALTER"];
	const write = ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "UPSERT"];

	if (destructive.includes(firstWord ?? "")) return "destructive";
	if (migration.includes(firstWord ?? "")) return "migration";
	if (write.includes(firstWord ?? "")) return "write";
	return "read";
}

export async function executeSql(
	client: ControlPlaneClient,
	projectId: string,
	sql: string,
	params?: unknown[],
	allowWrite?: boolean,
	allowDestructive?: boolean,
): Promise<McpToolResult> {
	const classification = classifySql(sql);

	if (classification === "destructive" && !allowDestructive) {
		return err(
			"DESTRUCTIVE_BLOCKED",
			"DROP/TRUNCATE are blocked by default via MCP.",
			"Set allow_destructive=true to allow destructive operations, or use the Jack CLI.",
		);
	}

	if (classification === "migration" && !allowWrite) {
		return err(
			"WRITE_NOT_ALLOWED",
			"ALTER TABLE requires allow_write=true.",
			"Set allow_write=true to allow schema migrations (ALTER TABLE).",
		);
	}

	if (classification === "write" && !allowWrite) {
		return err(
			"WRITE_NOT_ALLOWED",
			"Write operations require allow_write=true.",
			"Set allow_write=true to allow INSERT, UPDATE, DELETE, CREATE TABLE.",
		);
	}

	try {
		const result = await client.executeSql(projectId, sql, params);
		return ok(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("No database") || message.includes("no database")) {
			return err(
				"NO_DATABASE",
				message,
				"Create a database first with create_database, then redeploy the project.",
			);
		}
		return err("INTERNAL_ERROR", `SQL execution failed: ${message}`);
	}
}

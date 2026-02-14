import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function createDatabase(
	client: ControlPlaneClient,
	projectId: string,
	name?: string,
	bindingName?: string,
): Promise<McpToolResult> {
	try {
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

function classifySql(sql: string): "read" | "write" | "destructive" {
	const stripped = sql
		.replace(/--.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.trim();
	const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();

	const destructive = ["DROP", "TRUNCATE", "ALTER"];
	const write = ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "UPSERT"];

	if (destructive.includes(firstWord ?? "")) return "destructive";
	if (write.includes(firstWord ?? "")) return "write";
	return "read";
}

export async function executeSql(
	client: ControlPlaneClient,
	projectId: string,
	sql: string,
	params?: unknown[],
	allowWrite?: boolean,
): Promise<McpToolResult> {
	const classification = classifySql(sql);

	if (classification === "destructive") {
		return err(
			"DESTRUCTIVE_BLOCKED",
			"DROP/TRUNCATE/ALTER are blocked via MCP. Use the Jack CLI for destructive operations.",
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

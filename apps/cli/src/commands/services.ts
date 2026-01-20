import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchProjectResources } from "../lib/control-plane.ts";
import { formatSize } from "../lib/format.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { parseWranglerResources } from "../lib/resources.ts";
import { createDatabase } from "../lib/services/db-create.ts";
import {
	DestructiveOperationError,
	WriteNotAllowedError,
	executeSql,
	executeSqlFile,
} from "../lib/services/db-execute.ts";
import { listDatabases } from "../lib/services/db-list.ts";
import {
	deleteDatabase,
	exportDatabase,
	generateExportFilename,
	getDatabaseInfo as getWranglerDatabaseInfo,
} from "../lib/services/db.ts";
import { getRiskDescription } from "../lib/services/sql-classifier.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";
import { Events, track } from "../lib/telemetry.ts";

/**
 * Database info from control plane or wrangler config
 */
interface ResolvedDatabaseInfo {
	name: string;
	id?: string;
	source: "control-plane" | "wrangler";
}

async function ensureLocalProjectContext(projectName: string): Promise<void> {
	try {
		const cwdProjectName = await getProjectNameFromDir(process.cwd());
		if (cwdProjectName !== projectName) {
			error(`Current directory is not the "${projectName}" project`);
			info(`Run this command from the ${projectName} project directory`);
			process.exit(1);
		}
	} catch {
		error("Could not determine project from current directory");
		info(`Run this command from the ${projectName} project directory`);
		process.exit(1);
	}
}

/**
 * Get database info for a project.
 * For managed: fetch from control plane
 * For BYO: parse from wrangler.jsonc
 */
async function resolveDatabaseInfo(projectName: string): Promise<ResolvedDatabaseInfo | null> {
	// Read deploy mode from .jack/project.json
	const link = await readProjectLink(process.cwd());

	// For managed projects, fetch from control plane
	if (link?.deploy_mode === "managed") {
		try {
			const resources = await fetchProjectResources(link.project_id);
			const d1 = resources.find((r) => r.resource_type === "d1");
			if (d1) {
				return {
					name: d1.resource_name,
					id: d1.provider_id,
					source: "control-plane",
				};
			}
		} catch {
			// Fall through to wrangler parsing
		}
	}

	// For BYO or fallback, parse from wrangler config
	try {
		await ensureLocalProjectContext(projectName);
		const resources = await parseWranglerResources(process.cwd());
		if (resources.d1) {
			return {
				name: resources.d1.name,
				id: resources.d1.id,
				source: "wrangler",
			};
		}
	} catch {
		// No database found
	}

	return null;
}

interface ServiceOptions {
	project?: string;
}

export default async function services(
	subcommand?: string,
	args: string[] = [],
	options: ServiceOptions = {},
): Promise<void> {
	if (!subcommand) {
		return showHelp();
	}

	switch (subcommand) {
		case "db":
			return await dbCommand(args, options);
		default:
			error(`Unknown service: ${subcommand}`);
			info("Available: db");
			process.exit(1);
	}
}

function showHelp(): void {
	console.error("");
	info("jack services - Manage project services");
	console.error("");
	console.error("Commands:");
	console.error("  db         Manage database");
	console.error("");
	console.error("Run 'jack services <command>' for more information.");
	console.error("");
}

function showDbHelp(): void {
	console.error("");
	info("jack services db - Manage databases");
	console.error("");
	console.error("Actions:");
	console.error("  info       Show database information (default)");
	console.error("  create     Create a new database");
	console.error("  list       List all databases in the project");
	console.error("  execute    Execute SQL against the database");
	console.error("  export     Export database to SQL file");
	console.error("  delete     Delete a database");
	console.error("");
	console.error("Examples:");
	console.error(
		"  jack services db                                   Show info about the default database",
	);
	console.error("  jack services db create                            Create a new database");
	console.error("  jack services db list                              List all databases");
	console.error('  jack services db execute "SELECT * FROM users"     Run a read query');
	console.error('  jack services db execute "INSERT..." --write       Run a write query');
	console.error("  jack services db execute --file schema.sql --write Run SQL from file");
	console.error("");
}

async function dbCommand(args: string[], options: ServiceOptions): Promise<void> {
	const action = args[0] || "info"; // Default to info

	switch (action) {
		case "--help":
		case "-h":
		case "help":
			return showDbHelp();
		case "info":
			return await dbInfo(options);
		case "create":
			return await dbCreate(args.slice(1), options);
		case "list":
			return await dbList(options);
		case "execute":
			return await dbExecute(args.slice(1), options);
		case "export":
			return await dbExport(options);
		case "delete":
			return await dbDelete(options);
		default:
			error(`Unknown action: ${action}`);
			info("Available: info, create, list, execute, export, delete");
			process.exit(1);
	}
}

/**
 * Resolve project name from options or current directory
 */
async function resolveProjectName(options: ServiceOptions): Promise<string> {
	if (options.project) {
		return options.project;
	}

	try {
		return await getProjectNameFromDir(process.cwd());
	} catch {
		error("Could not determine project");
		info("Run from a project directory, or use --project <name>");
		process.exit(1);
	}
}

/**
 * Show database information
 */
async function dbInfo(options: ServiceOptions): Promise<void> {
	const projectName = await resolveProjectName(options);
	const dbInfo = await resolveDatabaseInfo(projectName);

	if (!dbInfo) {
		console.error("");
		error("No database found for this project");
		info("Create one with: jack services db create");
		console.error("");
		return;
	}

	// Fetch detailed database info via wrangler
	outputSpinner.start("Fetching database info...");
	const wranglerDbInfo = await getWranglerDatabaseInfo(dbInfo.name);
	outputSpinner.stop();

	if (!wranglerDbInfo) {
		console.error("");
		error("Database not found");
		info("It may have been deleted");
		console.error("");
		process.exit(1);
	}

	// Display info
	console.error("");
	success(`Database: ${wranglerDbInfo.name}`);
	console.error("");
	item(`Size: ${formatSize(wranglerDbInfo.sizeBytes)}`);
	item(`Tables: ${wranglerDbInfo.numTables}`);
	item(`ID: ${dbInfo.id || wranglerDbInfo.id}`);
	if (dbInfo.source === "control-plane") {
		item("Source: managed (jack cloud)");
	}
	console.error("");
}

/**
 * Export database to SQL file
 */
async function dbExport(options: ServiceOptions): Promise<void> {
	const projectName = await resolveProjectName(options);
	const dbInfo = await resolveDatabaseInfo(projectName);

	if (!dbInfo) {
		console.error("");
		error("No database found for this project");
		info("Create one with: jack services db create");
		console.error("");
		return;
	}

	// Generate filename
	const filename = generateExportFilename(dbInfo.name);

	// Export to current directory
	const outputPath = join(process.cwd(), filename);

	// Export
	outputSpinner.start("Exporting database...");
	try {
		await exportDatabase(dbInfo.name, outputPath);
		outputSpinner.stop();

		console.error("");
		success(`Exported to ./${filename}`);
		console.error("");
	} catch (err) {
		outputSpinner.stop();
		console.error("");
		error(`Failed to export: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/**
 * Delete database with full cleanup
 */
async function dbDelete(options: ServiceOptions): Promise<void> {
	const projectName = await resolveProjectName(options);
	const projectDir = process.cwd();

	// Check deploy mode
	const link = await readProjectLink(projectDir);
	const isManaged = link?.deploy_mode === "managed";

	const dbInfo = await resolveDatabaseInfo(projectName);

	if (!dbInfo) {
		console.error("");
		error("No database found for this project");
		info("Create one with: jack services db create");
		console.error("");
		return;
	}

	// Get detailed database info to show what will be deleted
	outputSpinner.start("Fetching database info...");
	const wranglerDbInfo = await getWranglerDatabaseInfo(dbInfo.name);
	outputSpinner.stop();

	// Show what will be deleted
	console.error("");
	info(`Database: ${dbInfo.name}`);
	if (wranglerDbInfo) {
		item(`Size: ${formatSize(wranglerDbInfo.sizeBytes)}`);
		item(`Tables: ${wranglerDbInfo.numTables}`);
	}
	console.error("");
	warn("This will permanently delete the database and all its data");
	console.error("");

	// Confirm deletion
	const { confirm } = await import("@clack/prompts");
	const shouldDelete = await confirm({
		message: `Delete database '${dbInfo.name}'?`,
	});

	if (shouldDelete !== true) {
		info("Cancelled");
		return;
	}

	outputSpinner.start("Deleting database...");

	// Track binding_name from control plane for matching in wrangler.jsonc
	let controlPlaneBindingName: string | null = null;

	try {
		if (isManaged && link) {
			// Managed mode: delete via control plane
			const { fetchProjectResources, deleteProjectResource } = await import(
				"../lib/control-plane.ts"
			);

			// Find the resource ID for this database
			const resources = await fetchProjectResources(link.project_id);
			const d1Resource = resources.find(
				(r) => r.resource_type === "d1" && r.resource_name === dbInfo.name,
			);

			if (d1Resource) {
				// Save binding_name for wrangler.jsonc cleanup
				controlPlaneBindingName = d1Resource.binding_name;
				// Delete via control plane (which also deletes from Cloudflare)
				await deleteProjectResource(link.project_id, d1Resource.id);
			} else {
				// Resource not in control plane - fall back to wrangler for cleanup
				await deleteDatabase(dbInfo.name);
			}
		} else {
			// BYO mode: delete via wrangler directly
			await deleteDatabase(dbInfo.name);
		}

		// Remove binding from wrangler.jsonc (both modes)
		// Note: We need to find the LOCAL database_name from wrangler.jsonc,
		// which may differ from the control plane's resource_name
		const { removeD1Binding, getExistingD1Bindings } = await import("../lib/wrangler-config.ts");
		const configPath = join(projectDir, "wrangler.jsonc");

		let bindingRemoved = false;
		try {
			// Find the binding by matching (in order of reliability):
			// 1. binding name (e.g., "DB") - if control plane provided it
			// 2. database_id (provider_id from control plane)
			// 3. database_name
			// 4. If managed mode and we successfully deleted, remove first D1 binding
			const existingBindings = await getExistingD1Bindings(configPath);
			let bindingToRemove = existingBindings.find(
				(b) =>
					(controlPlaneBindingName && b.binding === controlPlaneBindingName) ||
					b.database_id === dbInfo.id ||
					b.database_name === dbInfo.name,
			);

			// Fallback: if managed mode and we deleted from control plane,
			// remove the first D1 binding (binding_name may be null for older DBs)
			if (!bindingToRemove && isManaged && existingBindings.length > 0) {
				bindingToRemove = existingBindings[0];
			}

			if (bindingToRemove) {
				bindingRemoved = await removeD1Binding(configPath, bindingToRemove.database_name);
			}
		} catch (bindingErr) {
			// Log but don't fail - the database is already deleted
			// The user can manually clean up wrangler.jsonc if needed
		}

		outputSpinner.stop();

		console.error("");
		success("Database deleted");
		if (bindingRemoved) {
			item("Binding removed from wrangler.jsonc");
		}
		console.error("");
	} catch (err) {
		outputSpinner.stop();
		console.error("");
		error(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/**
 * Parse --name flag or positional arg from args
 * Supports: --name foo, --name=foo, or first positional arg
 */
function parseNameFlag(args: string[]): string | undefined {
	// Check --name flag first (takes priority)
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--name" && args[i + 1]) {
			return args[i + 1];
		}
		if (arg.startsWith("--name=")) {
			return arg.slice("--name=".length);
		}
	}

	// Fall back to first positional argument (non-flag)
	for (const arg of args) {
		if (!arg.startsWith("-")) {
			return arg;
		}
	}

	return undefined;
}

/**
 * Create a new database
 */
async function dbCreate(args: string[], options: ServiceOptions): Promise<void> {
	// Parse --name flag
	const name = parseNameFlag(args);

	outputSpinner.start("Creating database...");
	try {
		const result = await createDatabase(process.cwd(), {
			name,
			interactive: true,
		});
		outputSpinner.stop();

		// Track telemetry
		track(Events.SERVICE_CREATED, {
			service_type: "d1",
			binding_name: result.bindingName,
			created: result.created,
		});

		console.error("");
		if (result.created) {
			success(`Database created: ${result.databaseName}`);
		} else {
			success(`Using existing database: ${result.databaseName}`);
		}
		console.error("");
		item(`Binding: ${result.bindingName}`);
		item(`ID: ${result.databaseId}`);
		console.error("");

		// Prompt to deploy
		const { confirm } = await import("@clack/prompts");
		const shouldDeploy = await confirm({
			message: "Deploy now?",
		});

		if (shouldDeploy === true) {
			const { deployProject } = await import("../lib/project-operations.ts");
			await deployProject(process.cwd(), { interactive: true });
		} else {
			console.error("");
			info("Run 'jack ship' when ready to deploy");
			console.error("");
		}
	} catch (err) {
		outputSpinner.stop();
		console.error("");
		error(`Failed to create database: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/**
 * List all databases in the project
 */
async function dbList(options: ServiceOptions): Promise<void> {
	outputSpinner.start("Fetching databases...");
	try {
		const databases = await listDatabases(process.cwd());
		outputSpinner.stop();

		if (databases.length === 0) {
			console.error("");
			info("No databases found in this project.");
			console.error("");
			info("Create one with: jack services db create");
			console.error("");
			return;
		}

		console.error("");
		success(`Found ${databases.length} database${databases.length === 1 ? "" : "s"}:`);
		console.error("");

		for (const db of databases) {
			item(`${db.name} (${db.binding})`);
			if (db.sizeBytes !== undefined) {
				item(`  Size: ${formatSize(db.sizeBytes)}`);
			}
			if (db.numTables !== undefined) {
				item(`  Tables: ${db.numTables}`);
			}
			item(`  ID: ${db.id}`);
			console.error("");
		}
	} catch (err) {
		outputSpinner.stop();
		console.error("");
		error(`Failed to list databases: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/**
 * Parse execute command arguments
 * Supports:
 *   jack services db execute "SELECT * FROM users"
 *   jack services db execute "INSERT..." --write
 *   jack services db execute --file schema.sql --write
 *   jack services db execute --db my-other-db "SELECT..."
 */
interface ExecuteArgs {
	sql?: string;
	filePath?: string;
	allowWrite: boolean;
	databaseName?: string;
}

function parseExecuteArgs(args: string[]): ExecuteArgs {
	const result: ExecuteArgs = {
		allowWrite: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "--write" || arg === "-w") {
			result.allowWrite = true;
			continue;
		}

		if (arg === "--file" || arg === "-f") {
			result.filePath = args[i + 1];
			i++; // Skip the next arg
			continue;
		}

		if (arg.startsWith("--file=")) {
			result.filePath = arg.slice("--file=".length);
			continue;
		}

		if (arg === "--db" || arg === "--database") {
			result.databaseName = args[i + 1];
			i++; // Skip the next arg
			continue;
		}

		if (arg.startsWith("--db=")) {
			result.databaseName = arg.slice("--db=".length);
			continue;
		}

		if (arg.startsWith("--database=")) {
			result.databaseName = arg.slice("--database=".length);
			continue;
		}

		// Any other non-flag argument is the SQL query
		if (!arg.startsWith("-")) {
			result.sql = arg;
		}
	}

	return result;
}

/**
 * Execute SQL against the database
 */
async function dbExecute(args: string[], _options: ServiceOptions): Promise<void> {
	const execArgs = parseExecuteArgs(args);

	// Validate input
	if (!execArgs.sql && !execArgs.filePath) {
		console.error("");
		error("No SQL provided");
		info('Usage: jack services db execute "SELECT * FROM users"');
		info("       jack services db execute --file schema.sql --write");
		console.error("");
		process.exit(1);
	}

	// Cannot specify both SQL and file
	if (execArgs.sql && execArgs.filePath) {
		console.error("");
		error("Cannot specify both inline SQL and --file");
		info("Use either inline SQL or --file, not both");
		console.error("");
		process.exit(1);
	}

	// If using --file, verify file exists
	if (execArgs.filePath) {
		const absPath = resolve(process.cwd(), execArgs.filePath);
		if (!existsSync(absPath)) {
			console.error("");
			error(`File not found: ${execArgs.filePath}`);
			console.error("");
			process.exit(1);
		}
		execArgs.filePath = absPath;
	}

	const projectDir = process.cwd();

	try {
		outputSpinner.start("Executing SQL...");

		let result;
		if (execArgs.filePath) {
			result = await executeSqlFile({
				projectDir,
				filePath: execArgs.filePath,
				databaseName: execArgs.databaseName,
				allowWrite: execArgs.allowWrite,
				interactive: true,
			});
		} else {
			result = await executeSql({
				projectDir,
				sql: execArgs.sql!,
				databaseName: execArgs.databaseName,
				allowWrite: execArgs.allowWrite,
				interactive: true,
			});
		}

		// Handle destructive operations - need confirmation BEFORE execution
		if (result.requiresConfirmation) {
			outputSpinner.stop();

			// Find the destructive statements
			const destructiveStmts = result.statements.filter((s) => s.risk === "destructive");

			console.error("");
			warn("This SQL contains destructive operations:");
			for (const stmt of destructiveStmts) {
				item(`${stmt.operation}: ${stmt.sql.slice(0, 60)}${stmt.sql.length > 60 ? "..." : ""}`);
			}
			console.error("");

			// Require typed confirmation
			const { text } = await import("@clack/prompts");
			const confirmText = destructiveStmts
				.map((s) => s.operation)
				.join(" ")
				.toUpperCase();

			const userInput = await text({
				message: `Type "${confirmText}" to confirm:`,
				validate: (value) => {
					if (value.toUpperCase() !== confirmText) {
						return `Please type "${confirmText}" exactly to confirm`;
					}
				},
			});

			if (typeof userInput !== "string") {
				info("Cancelled");
				return;
			}

			// NOW execute with confirmation (interactive: false means "already confirmed")
			outputSpinner.start("Executing SQL...");
			if (execArgs.filePath) {
				result = await executeSqlFile({
					projectDir,
					filePath: execArgs.filePath,
					databaseName: execArgs.databaseName,
					allowWrite: true,
					interactive: false, // Already confirmed, execute now
				});
			} else {
				result = await executeSql({
					projectDir,
					sql: execArgs.sql!,
					databaseName: execArgs.databaseName,
					allowWrite: true,
					interactive: false, // Already confirmed, execute now
				});
			}
		}

		outputSpinner.stop();

		if (!result.success) {
			console.error("");
			error(result.error || "SQL execution failed");
			console.error("");
			process.exit(1);
		}

		// Show results
		console.error("");
		success(`SQL executed (${getRiskDescription(result.risk)})`);

		if (result.meta?.changes !== undefined && result.meta.changes > 0) {
			item(`Rows affected: ${result.meta.changes}`);
		}

		if (result.meta?.duration_ms !== undefined) {
			item(`Duration: ${result.meta.duration_ms}ms`);
		}

		if (result.warning) {
			console.error("");
			warn(result.warning);
		}

		// Output query results
		if (result.results && result.results.length > 0) {
			console.error("");
			console.log(JSON.stringify(result.results, null, 2));
		}
		console.error("");

		// Track telemetry
		track(Events.SQL_EXECUTED, {
			risk_level: result.risk,
			statement_count: result.statements.length,
			from_file: !!execArgs.filePath,
		});
	} catch (err) {
		outputSpinner.stop();

		if (err instanceof WriteNotAllowedError) {
			console.error("");
			error(err.message);
			info("Add the --write flag to allow data modification:");
			info(`  jack services db execute "${execArgs.sql || `--file ${execArgs.filePath}`}" --write`);
			console.error("");
			process.exit(1);
		}

		if (err instanceof DestructiveOperationError) {
			console.error("");
			error(err.message);
			info("Destructive operations require confirmation via CLI.");
			console.error("");
			process.exit(1);
		}

		console.error("");
		error(`SQL execution failed: ${err instanceof Error ? err.message : String(err)}`);
		console.error("");
		process.exit(1);
	}
}

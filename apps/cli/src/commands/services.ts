import { join } from "node:path";
import { fetchProjectResources } from "../lib/control-plane.ts";
import { formatSize } from "../lib/format.ts";
import { promptSelect } from "../lib/hooks.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { parseWranglerResources } from "../lib/resources.ts";
import {
	deleteDatabase,
	exportDatabase,
	generateExportFilename,
	getDatabaseInfo as getWranglerDatabaseInfo,
} from "../lib/services/db.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

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

async function dbCommand(args: string[], options: ServiceOptions): Promise<void> {
	const action = args[0] || "info"; // Default to info

	switch (action) {
		case "info":
			return await dbInfo(options);
		case "export":
			return await dbExport(options);
		case "delete":
			return await dbDelete(options);
		default:
			error(`Unknown action: ${action}`);
			info("Available: info, export, delete");
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
		error("No database found for this project.");
		info("For managed projects, create a database with: jack services db create");
		info("For BYO projects, add d1_databases to your wrangler.jsonc");
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
		error("No database found for this project.");
		info("For managed projects, create a database with: jack services db create");
		info("For BYO projects, add d1_databases to your wrangler.jsonc");
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
	const dbInfo = await resolveDatabaseInfo(projectName);

	if (!dbInfo) {
		console.error("");
		error("No database found for this project.");
		info("For managed projects, create a database with: jack services db create");
		info("For BYO projects, add d1_databases to your wrangler.jsonc");
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
	console.error(`  Delete database '${dbInfo.name}'?\n`);
	const choice = await promptSelect(["Yes", "No"]);

	if (choice !== 0) {
		info("Cancelled");
		return;
	}

	// Delete database
	outputSpinner.start("Deleting database...");
	try {
		await deleteDatabase(dbInfo.name);
		outputSpinner.stop();

		console.error("");
		success("Database deleted");
		console.error("");
	} catch (err) {
		outputSpinner.stop();
		console.error("");
		error(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import { formatSize } from "../lib/format.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import {
	type Project,
	getProject,
	getProjectDatabaseName,
	updateProjectDatabase,
} from "../lib/registry.ts";
import {
	deleteDatabase,
	exportDatabase,
	generateExportFilename,
	getDatabaseInfo,
} from "../lib/services/db.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

/**
 * Get database name from wrangler.jsonc/toml file
 * Fallback when registry doesn't have the info
 */
async function getDatabaseFromWranglerConfig(projectPath: string): Promise<string | null> {
	// Try wrangler.jsonc first
	const jsoncPath = join(projectPath, "wrangler.jsonc");
	if (existsSync(jsoncPath)) {
		try {
			const content = await Bun.file(jsoncPath).text();
			// Remove comments for JSON parsing (simple approach)
			const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
			const config = JSON.parse(jsonContent);
			if (config.d1_databases?.[0]?.database_name) {
				return config.d1_databases[0].database_name;
			}
		} catch {
			// Ignore parse errors
		}
	}

	// Try wrangler.toml
	const tomlPath = join(projectPath, "wrangler.toml");
	if (existsSync(tomlPath)) {
		try {
			const content = await Bun.file(tomlPath).text();
			// Simple regex to extract database_name from [[d1_databases]] section
			const match = content.match(/database_name\s*=\s*"([^"]+)"/);
			if (match?.[1]) {
				return match[1];
			}
		} catch {
			// Ignore read errors
		}
	}

	return null;
}

/**
 * Get database name for a project, with fallback to wrangler config
 */
async function resolveDbName(project: Project): Promise<string | null> {
	// First check registry
	const dbFromRegistry = getProjectDatabaseName(project);
	if (dbFromRegistry) {
		return dbFromRegistry;
	}

	// Fallback: read from wrangler config file
	if (project.localPath && existsSync(project.localPath)) {
		return await getDatabaseFromWranglerConfig(project.localPath);
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
	const project = await getProject(projectName);

	if (!project) {
		error(`Project "${projectName}" not found in registry`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	const dbName = await resolveDbName(project);

	if (!dbName) {
		console.error("");
		info("No database configured for this project");
		console.error("");
		return;
	}

	// Fetch database info
	outputSpinner.start("Fetching database info...");
	const dbInfo = await getDatabaseInfo(dbName);
	outputSpinner.stop();

	if (!dbInfo) {
		console.error("");
		error("Database not found");
		info("It may have been deleted");
		console.error("");
		process.exit(1);
	}

	// Display info
	console.error("");
	success(`Database: ${dbInfo.name}`);
	console.error("");
	item(`Size: ${formatSize(dbInfo.sizeBytes)}`);
	item(`Tables: ${dbInfo.numTables}`);
	item(`ID: ${dbInfo.id}`);
	console.error("");
}

/**
 * Export database to SQL file
 */
async function dbExport(options: ServiceOptions): Promise<void> {
	const projectName = await resolveProjectName(options);
	const project = await getProject(projectName);

	if (!project) {
		error(`Project "${projectName}" not found in registry`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	const dbName = await resolveDbName(project);

	if (!dbName) {
		console.error("");
		info("No database configured for this project");
		console.error("");
		return;
	}

	// Generate filename
	const filename = generateExportFilename(dbName);

	// Determine output directory (project dir if in it, cwd otherwise)
	let outputDir = process.cwd();
	if (project.localPath && existsSync(project.localPath)) {
		// Check if we're in the project directory or subdirectory
		const cwd = process.cwd();
		if (cwd === project.localPath || cwd.startsWith(`${project.localPath}/`)) {
			outputDir = project.localPath;
		}
	}

	const outputPath = join(outputDir, filename);

	// Export
	outputSpinner.start("Exporting database...");
	try {
		await exportDatabase(dbName, outputPath);
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
	const project = await getProject(projectName);

	if (!project) {
		error(`Project "${projectName}" not found in registry`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	const dbName = await resolveDbName(project);

	if (!dbName) {
		console.error("");
		info("No database configured for this project");
		console.error("");
		return;
	}

	// Get database info to show what will be deleted
	outputSpinner.start("Fetching database info...");
	const dbInfo = await getDatabaseInfo(dbName);
	outputSpinner.stop();

	// Show what will be deleted
	console.error("");
	info(`Database: ${dbName}`);
	if (dbInfo) {
		item(`Size: ${formatSize(dbInfo.sizeBytes)}`);
		item(`Tables: ${dbInfo.numTables}`);
	}
	console.error("");
	warn("This will permanently delete the database and all its data");
	console.error("");

	// Confirm deletion
	console.error("  Esc to skip\n");
	const action = await select({
		message: `Delete database '${dbName}'?`,
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (action === "no") {
		info("Cancelled");
		return;
	}

	// Delete database
	outputSpinner.start("Deleting database...");
	try {
		await deleteDatabase(dbName);
		outputSpinner.stop();

		// Update registry (set db to null in services structure)
		await updateProjectDatabase(projectName, null);

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

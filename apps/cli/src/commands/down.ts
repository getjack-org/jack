import { existsSync } from "node:fs";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../lib/cloudflare-api.ts";
import { managedDown } from "../lib/managed-down.ts";
import { error, info, item, output, success, warn } from "../lib/output.ts";
import {
	type Project,
	getProject,
	getProjectDatabaseName,
	updateProject,
	updateProjectDatabase,
} from "../lib/registry.ts";
import { deleteCloudProject, getProjectNameFromDir } from "../lib/storage/index.ts";

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
		const jsoncPath = join(project.localPath, "wrangler.jsonc");
		if (existsSync(jsoncPath)) {
			try {
				const content = await Bun.file(jsoncPath).text();
				// Remove comments for JSON parsing
				// Note: Only remove line comments at the start of a line to avoid breaking URLs
				const jsonContent = content
					.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
					.replace(/^\s*\/\/.*$/gm, ""); // line comments at start of line only
				const config = JSON.parse(jsonContent);
				if (config.d1_databases?.[0]?.database_name) {
					return config.d1_databases[0].database_name;
				}
			} catch {
				// Ignore parse errors
			}
		}

		const tomlPath = join(project.localPath, "wrangler.toml");
		if (existsSync(tomlPath)) {
			try {
				const content = await Bun.file(tomlPath).text();
				const match = content.match(/database_name\s*=\s*"([^"]+)"/);
				if (match?.[1]) {
					return match[1];
				}
			} catch {
				// Ignore read errors
			}
		}
	}

	return null;
}

export interface DownFlags {
	force?: boolean;
}

export default async function down(projectName?: string, flags: DownFlags = {}): Promise<void> {
	try {
		// Get project name
		let name = projectName;
		if (!name) {
			try {
				name = await getProjectNameFromDir(process.cwd());
			} catch (err) {
				error("Could not determine project name");
				info("Usage: jack down [project-name]");
				process.exit(1);
			}
		}

		// Get project from registry
		const project = await getProject(name);
		if (!project) {
			warn(`Project '${name}' not found in registry`);
			info("Will attempt to undeploy if deployed");
		}

		// Check if this is a managed project
		if (project?.deploy_mode === "managed" && project.remote?.project_id) {
			// Route to managed deletion flow
			const success = await managedDown(project, name, flags);
			if (!success) {
				process.exit(0); // User cancelled
			}
			return;
		}

		// Continue with existing BYO flow...

		// Check if worker exists
		output.start("Checking deployment...");
		const workerExists = await checkWorkerExists(name);
		output.stop();

		if (!workerExists) {
			console.error("");
			warn(`'${name}' is not deployed`);
			info("Nothing to undeploy");
			return;
		}

		// Force mode - quick deletion without prompts
		if (flags.force) {
			console.error("");
			info(`Undeploying '${name}'`);
			console.error("");

			output.start("Undeploying...");
			await deleteWorker(name);
			output.stop();

			// Update registry - keep entry but clear worker URL
			if (project) {
				await updateProject(name, {
					workerUrl: null,
					lastDeployed: null,
				});
			}

			console.error("");
			success(`'${name}' undeployed`);
			info("Databases and backups were not affected");
			console.error("");
			return;
		}

		// Interactive mode - show what will be affected
		console.error("");
		info(`Project: ${name}`);
		if (project?.workerUrl) {
			item(`URL: ${project.workerUrl}`);
		}
		const dbName = project ? await resolveDbName(project) : null;
		if (dbName) {
			item(`Database: ${dbName}`);
		}
		console.error("");

		// Confirm undeploy
		console.error("  Esc to skip\n");
		const action = await select({
			message: "Undeploy this project?",
			choices: [
				{ name: "1. Yes", value: "yes" },
				{ name: "2. No", value: "no" },
			],
		});

		if (action === "no") {
			info("Cancelled");
			return;
		}

		// Handle database if it exists
		let shouldDeleteDb = false;

		if (dbName) {
			console.error("");
			info(`Found database: ${dbName}`);

			// Ask if they want to export first
			console.error("  Esc to skip\n");
			const exportAction = await select({
				message: `Export database '${dbName}' before deleting?`,
				choices: [
					{ name: "1. Yes", value: "yes" },
					{ name: "2. No", value: "no" },
				],
			});

			if (exportAction === "yes") {
				const exportPath = join(process.cwd(), `${dbName}-backup.sql`);
				output.start(`Exporting database to ${exportPath}...`);
				try {
					await exportDatabase(dbName, exportPath);
					output.stop();
					success(`Database exported to ${exportPath}`);
				} catch (err) {
					output.stop();
					error(`Failed to export database: ${err instanceof Error ? err.message : String(err)}`);
					console.error("  Esc to skip\n");
					const continueAction = await select({
						message: "Continue without exporting?",
						choices: [
							{ name: "1. Yes", value: "yes" },
							{ name: "2. No", value: "no" },
						],
					});
					if (continueAction === "no") {
						info("Cancelled");
						return;
					}
				}
			}

			// Ask if they want to delete the database
			console.error("  Esc to skip\n");
			const deleteAction = await select({
				message: `Delete database '${dbName}'?`,
				choices: [
					{ name: "1. Yes", value: "yes" },
					{ name: "2. No", value: "no" },
				],
			});

			shouldDeleteDb = deleteAction === "yes";
		}

		// Handle backup deletion
		let shouldDeleteR2 = false;
		if (project) {
			console.error("");
			console.error("  Esc to skip\n");
			const deleteR2Action = await select({
				message: "Delete backup for this project?",
				choices: [
					{ name: "1. Yes", value: "yes" },
					{ name: "2. No", value: "no" },
				],
			});
			shouldDeleteR2 = deleteR2Action === "yes";
		}

		// Execute deletions
		console.error("");
		info("Executing cleanup...");
		console.error("");

		// Undeploy service
		output.start("Undeploying...");
		try {
			await deleteWorker(name);
			output.stop();
			success(`'${name}' undeployed`);
		} catch (err) {
			output.stop();
			error(`Failed to undeploy: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}

		// Delete database if requested
		if (shouldDeleteDb && dbName) {
			output.start(`Deleting database '${dbName}'...`);
			try {
				await deleteDatabase(dbName);
				output.stop();
				success(`Database '${dbName}' deleted`);

				// Update registry
				await updateProjectDatabase(name, null);
			} catch (err) {
				output.stop();
				warn(
					`Failed to delete database '${dbName}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Delete backup if requested
		if (shouldDeleteR2) {
			output.start("Deleting backup...");
			try {
				const deleted = await deleteCloudProject(name);
				output.stop();
				if (deleted) {
					success("Backup deleted");
				} else {
					warn("No backup found or already deleted");
				}
			} catch (err) {
				output.stop();
				warn(`Failed to delete backup: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Update registry - keep entry but clear worker URL
		if (project) {
			await updateProject(name, {
				workerUrl: null,
				lastDeployed: null,
			});
		}

		console.error("");
		success(`Project '${name}' undeployed`);
		console.error("");
	} catch (err) {
		console.error("");
		error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

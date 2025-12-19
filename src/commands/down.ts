import { join } from "node:path";
import { select } from "@inquirer/prompts";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../lib/cloudflare-api.ts";
import { error, info, item, output, success, warn } from "../lib/output.ts";
import { getProject, updateProject } from "../lib/registry.ts";
import { deleteCloudProject, getProjectNameFromDir } from "../lib/storage/index.ts";

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
			info("Databases and cloud storage were not affected");
			console.error("");
			return;
		}

		// Interactive mode - show what will be affected
		console.error("");
		info(`Project: ${name}`);
		if (project?.workerUrl) {
			item(`URL: ${project.workerUrl}`);
		}
		if (project?.resources.d1Databases && project.resources.d1Databases.length > 0) {
			item(`Databases: ${project.resources.d1Databases.length}`);
			for (const db of project.resources.d1Databases) {
				item(`  - ${db}`);
			}
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

		// Handle D1 databases if they exist
		const databases = project?.resources.d1Databases || [];
		const databasesToDelete: string[] = [];

		for (const dbName of databases) {
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
			const shouldExport = exportAction === "yes";

			if (shouldExport) {
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

			if (deleteAction === "yes") {
				databasesToDelete.push(dbName);
			}
		}

		// Handle R2 backup deletion
		let shouldDeleteR2 = false;
		if (project) {
			console.error("");
			console.error("  Esc to skip\n");
			const deleteR2Action = await select({
				message: "Delete cloud backup for this project?",
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

		// Delete databases
		for (const dbName of databasesToDelete) {
			output.start(`Deleting database '${dbName}'...`);
			try {
				await deleteDatabase(dbName);
				output.stop();
				success(`Database '${dbName}' deleted`);
			} catch (err) {
				output.stop();
				warn(
					`Failed to delete database '${dbName}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Delete cloud backup if requested
		if (shouldDeleteR2) {
			output.start("Deleting cloud backup...");
			try {
				const deleted = await deleteCloudProject(name);
				output.stop();
				if (deleted) {
					success("Cloud backup deleted");
				} else {
					warn("No cloud backup found or already deleted");
				}
			} catch (err) {
				output.stop();
				warn(`Failed to delete cloud backup: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Update registry - keep entry but clear worker URL
		if (project) {
			const updates: {
				workerUrl: null;
				lastDeployed: null;
				resources?: { d1Databases: string[] };
			} = {
				workerUrl: null,
				lastDeployed: null,
			};

			// Remove deleted databases from registry
			if (databasesToDelete.length > 0) {
				updates.resources = {
					d1Databases: databases.filter((db) => !databasesToDelete.includes(db)),
				};
			}

			await updateProject(name, updates);
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

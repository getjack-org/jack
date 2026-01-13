/**
 * Managed mode project deletion handler
 * Mirrors BYO down.ts flow but uses control plane APIs.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteManagedProject, exportManagedDatabase } from "./control-plane.ts";
import { promptSelect } from "./hooks.ts";
import { error, info, item, output, success, warn } from "./output.ts";

export interface ManagedDownFlags {
	force?: boolean;
}

export interface ManagedProjectInfo {
	projectId: string;
	runjackUrl: string | null;
}

export async function managedDown(
	project: ManagedProjectInfo,
	projectName: string,
	flags: ManagedDownFlags = {},
): Promise<boolean> {
	const { projectId, runjackUrl } = project;

	// Force mode - quick deletion without prompts
	if (flags.force) {
		console.error("");
		info(`Undeploying '${projectName}'`);
		console.error("");

		output.start("Undeploying from jack cloud...");
		try {
			await deleteManagedProject(projectId);
			output.stop();

			console.error("");
			success(`'${projectName}' undeployed`);
			info("Database and backups were deleted");
			console.error("");
			return true;
		} catch (err) {
			output.stop();
			throw err;
		}
	}

	// Interactive mode
	console.error("");
	info(`Project: ${projectName}`);
	if (runjackUrl) {
		item(`URL: ${runjackUrl}`);
	}
	item("Mode: jack cloud (managed)");
	item("Database: managed D1");
	console.error("");

	// Confirm undeploy
	console.error("");
	info("Undeploy this project?");
	const action = await promptSelect(["Yes", "No"]);

	if (action !== 0) {
		info("Cancelled");
		return false;
	}

	// Ask about database export
	console.error("");
	info("Database will be deleted with the project");

	console.error("");
	info("Export database before deleting?");
	const exportAction = await promptSelect(["Yes", "No"]);

	if (exportAction === 0) {
		const exportPath = join(process.cwd(), `${projectName}-backup.sql`);
		output.start(`Exporting database to ${exportPath}...`);

		try {
			const exportResult = await exportManagedDatabase(projectId);

			// Download the SQL file
			const response = await fetch(exportResult.download_url);
			if (!response.ok) {
				throw new Error(`Failed to download export: ${response.statusText}`);
			}

			const sqlContent = await response.text();
			await writeFile(exportPath, sqlContent, "utf-8");

			output.stop();
			success(`Database exported to ${exportPath}`);
		} catch (err) {
			output.stop();
			error(`Failed to export database: ${err instanceof Error ? err.message : String(err)}`);

			// If export times out, abort
			if (err instanceof Error && err.message.includes("timed out")) {
				error("Export timeout - deletion aborted");
				return false;
			}

			console.error("");
			info("Continue without exporting?");
			const continueAction = await promptSelect(["Yes", "No"]);

			if (continueAction !== 0) {
				info("Cancelled");
				return false;
			}
		}
	}

	// Execute deletion
	console.error("");
	info("Executing cleanup...");
	console.error("");

	output.start("Undeploying from jack cloud...");
	try {
		const result = await deleteManagedProject(projectId);
		output.stop();
		success(`'${projectName}' undeployed`);

		// Report resource results
		for (const resource of result.resources) {
			if (resource.success) {
				success(`Deleted ${resource.resource}`);
			} else {
				warn(`Failed to delete ${resource.resource}: ${resource.error}`);
			}
		}

		console.error("");
		success(`Project '${projectName}' undeployed`);
		console.error("");
		return true;
	} catch (err) {
		output.stop();
		error(`Failed to undeploy: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
}

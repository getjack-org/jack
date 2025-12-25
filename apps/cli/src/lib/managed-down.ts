/**
 * Managed mode project deletion handler
 * Mirrors BYO down.ts flow but uses control plane APIs.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import { deleteManagedProject, exportManagedDatabase } from "./control-plane.ts";
import { error, info, item, output, success, warn } from "./output.ts";
import type { Project } from "./registry.ts";
import { updateProject } from "./registry.ts";

export interface ManagedDownFlags {
	force?: boolean;
}

export async function managedDown(
	project: Project,
	projectName: string,
	flags: ManagedDownFlags = {},
): Promise<boolean> {
	const remote = project.remote;
	if (!remote?.project_id) {
		throw new Error("Project is not linked to jack cloud");
	}

	const runjackUrl = remote.runjack_url;
	const projectId = remote.project_id;

	// Force mode - quick deletion without prompts
	if (flags.force) {
		console.error("");
		info(`Undeploying '${projectName}'`);
		console.error("");

		output.start("Undeploying from jack cloud...");
		try {
			await deleteManagedProject(projectId);
			output.stop();

			await updateProject(projectName, {
				workerUrl: null,
				lastDeployed: null,
			});

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
		return false;
	}

	// Ask about database export
	console.error("");
	info("Database will be deleted with the project");

	console.error("  Esc to skip\n");
	const exportAction = await select({
		message: "Export database before deleting?",
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (exportAction === "yes") {
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

		await updateProject(projectName, {
			workerUrl: null,
			lastDeployed: null,
		});

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

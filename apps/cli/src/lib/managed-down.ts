/**
 * Managed mode project deletion handler
 * Mirrors BYO down.ts flow but uses control plane APIs.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	deleteManagedProject,
	exportManagedDatabase,
	fetchProjectResources,
} from "./control-plane.ts";
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

	// Interactive mode - fetch actual resources
	let hasDatabase = false;
	let databaseName: string | null = null;
	try {
		const resources = await fetchProjectResources(projectId);
		const d1Resource = resources.find((r) => r.resource_type === "d1");
		if (d1Resource) {
			hasDatabase = true;
			databaseName = d1Resource.resource_name;
		}
	} catch {
		// If fetch fails, assume no database (safer than showing wrong info)
	}

	console.error("");
	info(`Project: ${projectName}`);
	if (runjackUrl) {
		item(`URL: ${runjackUrl}`);
	}
	item("Mode: jack cloud (managed)");
	if (hasDatabase) {
		item(`Database: ${databaseName ?? "managed D1"}`);
	}
	console.error("");

	// Single confirmation with clear description
	console.error("");
	const confirmMsg = hasDatabase
		? "Undeploy this project? All resources will be deleted."
		: "Undeploy this project?";
	info(confirmMsg);
	const action = await promptSelect(["Yes", "No"]);

	if (action !== 0) {
		info("Cancelled");
		return false;
	}

	// Auto-export database if it exists (no prompt)
	let exportPath: string | null = null;
	if (hasDatabase) {
		exportPath = join(process.cwd(), `${projectName}-backup.sql`);
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
		} catch (err) {
			output.stop();
			warn(`Could not export database: ${err instanceof Error ? err.message : String(err)}`);
			exportPath = null;
		}
	}

	// Execute deletion
	output.start("Undeploying from jack cloud...");
	try {
		const result = await deleteManagedProject(projectId);
		output.stop();

		// Report any resource deletion failures
		for (const resource of result.resources) {
			if (!resource.success) {
				warn(`Failed to delete ${resource.resource}: ${resource.error}`);
			}
		}

		// Final success message
		console.error("");
		success(`Undeployed '${projectName}'`);
		if (exportPath) {
			info(`Backup saved to ./${projectName}-backup.sql`);
		}
		console.error("");
		return true;
	} catch (err) {
		output.stop();
		error(`Failed to undeploy: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
}

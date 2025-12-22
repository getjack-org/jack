import { existsSync } from "node:fs";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import { requireAuthOrLogin } from "../lib/auth/guard.ts";
import { formatRelativeTime, formatSize } from "../lib/format.ts";
import { error, info, item, output as outputSpinner, success } from "../lib/output.ts";
import { scanProjectFiles } from "../lib/storage/file-filter.ts";
import {
	type CloudProject,
	type ManifestFile,
	computeChecksum,
	computeDiff,
	deleteCloudProject,
	getProjectNameFromDir,
	getRemoteManifest,
	listCloudProjects,
} from "../lib/storage/index.ts";
import { getBucketName } from "../lib/storage/r2-client.ts";

/**
 * Main cloud command - handles all cloud storage operations
 */
export default async function cloud(subcommand?: string, args: string[] = []): Promise<void> {
	await requireAuthOrLogin();

	if (!subcommand) {
		return await listCommand();
	}

	switch (subcommand) {
		case "list":
			return await listCommand();
		case "status":
			return await statusCommand();
		case "delete":
			return await deleteCommand(args);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: list, status, delete");
			process.exit(1);
	}
}

/**
 * List all cloud projects
 */
async function listCommand(): Promise<void> {
	outputSpinner.start("Fetching projects...");
	const projects = await listCloudProjects();
	outputSpinner.stop();

	if (projects.length === 0) {
		info("No projects in cloud storage");
		return;
	}

	console.error("");
	// Header
	console.error(`${"PROJECT".padEnd(20)} ${"FILES".padEnd(8)} ${"SIZE".padEnd(12)} ${"LAST SYNC"}`);
	console.error("-".repeat(60));

	// Projects
	let totalFiles = 0;
	let totalSize = 0;

	for (const project of projects) {
		const name = project.name.padEnd(20);
		const files = String(project.files).padEnd(8);
		const size = formatSize(project.size).padEnd(12);
		const lastSync = formatRelativeTime(project.lastSync);

		console.error(`${name} ${files} ${size} ${lastSync}`);

		totalFiles += project.files;
		totalSize += project.size;
	}

	// Total
	console.error("-".repeat(60));
	console.error(
		`${"TOTAL".padEnd(20)} ${String(totalFiles).padEnd(8)} ${formatSize(totalSize).padEnd(12)}`,
	);
	console.error("");
}

/**
 * Show cloud storage status
 */
async function statusCommand(): Promise<void> {
	try {
		const bucketName = await getBucketName();

		console.error("");
		success("Cloud Storage");
		item(`Bucket: ${bucketName}`);
		console.error("");

		// Check if we're in a project directory
		const cwd = process.cwd();
		const hasWranglerToml = existsSync(join(cwd, "wrangler.toml"));
		const hasWranglerJsonc = existsSync(join(cwd, "wrangler.jsonc"));

		if (!hasWranglerToml && !hasWranglerJsonc) {
			info("Not in a project directory (no wrangler.toml or wrangler.jsonc found)");
			console.error("");
			return;
		}

		// Get project name
		const projectName = await getProjectNameFromDir(cwd);
		info(`Current project: ${projectName}`);
		console.error("");

		// Get remote manifest
		const remoteManifest = await getRemoteManifest(projectName);

		if (!remoteManifest) {
			info("Project not synced to cloud yet");
			console.error("");
			return;
		}

		// Get local files and compute checksums
		const filteredFiles = await scanProjectFiles(cwd);
		const localFiles: ManifestFile[] = [];

		for (const file of filteredFiles) {
			const checksum = await computeChecksum(file.absolutePath);
			localFiles.push({
				path: file.path,
				size: file.size,
				checksum,
				modified: new Date().toISOString(),
			});
		}

		// Compute diff
		const diff = computeDiff(localFiles, remoteManifest);
		const totalChanges = diff.added.length + diff.changed.length + diff.deleted.length;

		// Show sync status
		success("Sync Status");
		item(`Remote files: ${remoteManifest.files.length}`);
		item(`Local files: ${localFiles.length}`);
		item(`Last sync: ${formatRelativeTime(remoteManifest.lastSync)}`);

		// Show pending changes
		if (totalChanges > 0) {
			console.error("");
			info(`${totalChanges} file(s) have changed`);
			if (diff.added.length > 0) {
				item(`  ${diff.added.length} added`);
			}
			if (diff.changed.length > 0) {
				item(`  ${diff.changed.length} modified`);
			}
			if (diff.deleted.length > 0) {
				item(`  ${diff.deleted.length} deleted`);
			}
			console.error("");
			item("Run 'jack ship' to sync changes");
		} else {
			console.error("");
			info("All files in sync");
		}

		console.error("");
	} catch (err) {
		console.error("");
		error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

/**
 * Delete a cloud project
 */
async function deleteCommand(args: string[]): Promise<void> {
	const [projectName] = args;

	if (!projectName) {
		error("Project name required");
		info("Usage: jack cloud delete <project-name>");
		process.exit(1);
	}

	// Check if project exists
	outputSpinner.start("Checking project...");
	const manifest = await getRemoteManifest(projectName);
	outputSpinner.stop();

	if (!manifest) {
		error(`Project '${projectName}' not found in cloud storage`);
		process.exit(1);
	}

	// Show what will be deleted
	console.error("");
	info(`Project: ${projectName}`);
	item(`Files: ${manifest.files.length}`);
	item(`Size: ${formatSize(manifest.files.reduce((sum, f) => sum + f.size, 0))}`);
	item(`Last sync: ${formatRelativeTime(manifest.lastSync)}`);
	console.error("");

	// Confirm deletion
	console.error("  Esc to skip\n");
	const action = await select({
		message: `Delete project '${projectName}' from cloud storage?`,
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (action === "no") {
		info("Cancelled");
		return;
	}

	// Delete project
	outputSpinner.start("Deleting project...");
	const deleted = await deleteCloudProject(projectName);
	outputSpinner.stop();

	if (deleted) {
		console.error("");
		success(`Deleted project '${projectName}' from cloud storage`);
	} else {
		console.error("");
		error("Failed to delete project");
		process.exit(1);
	}
}

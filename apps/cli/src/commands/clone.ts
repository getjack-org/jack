import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isCancel, select } from "@clack/prompts";
import { downloadProjectSource, fetchProjectTags } from "../lib/control-plane.ts";
import { formatSize } from "../lib/format.ts";
import { box, error, info, spinner, success } from "../lib/output.ts";
import { registerPath } from "../lib/paths-index.ts";
import { linkProject, updateProjectLink } from "../lib/project-link.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import { cloneFromCloud, getRemoteManifest } from "../lib/storage/index.ts";
import { extractZipToDirectory } from "../lib/zip-utils.ts";

export interface CloneFlags {
	as?: string;
}

export default async function clone(projectName?: string, flags: CloneFlags = {}): Promise<void> {
	// Validate project name
	if (!projectName) {
		error("Project name required");
		info("Usage: jack clone <project> [--as <directory>]");
		process.exit(1);
	}

	// Determine target directory
	const targetDir = resolve(flags.as ?? projectName);

	// Check if target directory exists
	if (existsSync(targetDir)) {
		// If not TTY, error immediately
		if (!process.stdout.isTTY) {
			error(`Directory ${flags.as ?? projectName} already exists`);
			process.exit(1);
		}

		// Prompt user for action
		const action = await select({
			message: `Directory ${flags.as ?? projectName} already exists. What would you like to do?`,
			options: [
				{ value: "overwrite", label: "Overwrite (delete and recreate)" },
				{ value: "merge", label: "Merge (keep existing files)" },
				{ value: "cancel", label: "Cancel" },
			],
		});

		if (isCancel(action) || action === "cancel") {
			info("Clone cancelled");
			process.exit(0);
		}

		if (action === "overwrite") {
			// Delete directory
			await Bun.$`rm -rf ${targetDir}`.quiet();
		}
	}

	// Check if this is a managed project (has source in control-plane)
	const spin = spinner(`Looking up ${projectName}...`);
	let project: Awaited<ReturnType<typeof resolveProject>> = null;

	try {
		project = await resolveProject(projectName);
	} catch {
		// Not found on control-plane, will fall back to User R2
	}

	// Managed mode: download from control-plane
	if (project?.sources.controlPlane && project.remote?.projectId) {
		spin.success("Found on jack cloud");

		const downloadSpin = spinner("Downloading from jack cloud...");
		try {
			const sourceZip = await downloadProjectSource(projectName);
			const fileCount = await extractZipToDirectory(sourceZip, targetDir);
			downloadSpin.success(`Restored ${fileCount} file(s) to ./${flags.as ?? projectName}/`);
		} catch (err) {
			downloadSpin.error("Download failed");
			const message = err instanceof Error ? err.message : "Could not download project source";
			error(message);
			process.exit(1);
		}

		// Link to control-plane
		await linkProject(targetDir, project.remote.projectId, "managed");
		await registerPath(project.remote.projectId, targetDir);

		// Fetch and restore tags from control plane
		try {
			const remoteTags = await fetchProjectTags(project.remote.projectId);
			if (remoteTags.length > 0) {
				await updateProjectLink(targetDir, { tags: remoteTags });
				info(`Restored ${remoteTags.length} tag(s)`);
			}
		} catch {
			// Silent fail - tag restoration is non-critical
		}
	} else {
		// BYO mode: use existing User R2 flow
		spin.stop();
		const fetchSpin = spinner(`Fetching from jack-storage/${projectName}/...`);
		const manifest = await getRemoteManifest(projectName);

		if (!manifest) {
			fetchSpin.error(`Project not found: ${projectName}`);
			info("For BYO projects, run 'jack sync' first to backup your project.");
			process.exit(1);
		}

		// Show file count and size
		const totalSize = manifest.files.reduce((sum, f) => sum + f.size, 0);
		fetchSpin.success(`Found ${manifest.files.length} file(s) (${formatSize(totalSize)})`);

		// Download files
		const downloadSpin = spinner("Downloading...");
		const result = await cloneFromCloud(projectName, targetDir);

		if (!result.success) {
			downloadSpin.error("Clone failed");
			error(result.error || "Could not download project files");
			info("Check your network connection and try again");
			process.exit(1);
		}

		downloadSpin.success(`Restored to ./${flags.as ?? projectName}/`);
	}

	// Show next steps
	box("Next steps:", [`cd ${flags.as ?? projectName}`, "bun install", "jack ship"]);
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isCancel, select } from "@clack/prompts";
import { fetchProjectTags } from "../lib/control-plane.ts";
import { formatSize } from "../lib/format.ts";
import { box, error, info, spinner, success } from "../lib/output.ts";
import { registerPath } from "../lib/paths-index.ts";
import { linkProject, updateProjectLink } from "../lib/project-link.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import { cloneFromCloud, getRemoteManifest } from "../lib/storage/index.ts";

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

	// Fetch remote manifest
	const spin = spinner(`Fetching from jack-storage/${projectName}/...`);
	const manifest = await getRemoteManifest(projectName);

	if (!manifest) {
		spin.error(`Project not found: ${projectName}`);
		process.exit(1);
	}

	// Show file count and size
	const totalSize = manifest.files.reduce((sum, f) => sum + f.size, 0);
	spin.success(`Found ${manifest.files.length} file(s) (${formatSize(totalSize)})`);

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

	// Link project to control plane if it's a managed project
	try {
		const project = await resolveProject(projectName);
		if (project?.sources.controlPlane && project.remote?.projectId) {
			// Managed project - link with control plane project ID
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
		}
	} catch {
		// Not a control plane project or offline - continue without linking
	}

	// Show next steps
	box("Next steps:", [`cd ${flags.as ?? projectName}`, "bun install", "jack ship"]);
}

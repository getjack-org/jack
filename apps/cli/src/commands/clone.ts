import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CloneCollisionError, type CloneReporter, cloneProject } from "../lib/clone-core.ts";
import { downloadProjectSource } from "../lib/control-plane.ts";
import { extractZipToDirectory } from "../lib/zip-utils.ts";
import { isCancel, promptSelectValue } from "../lib/hooks.ts";
import { box, error, info, spinner, success } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { resolveProject } from "../lib/project-resolver.ts";

export interface CloneFlags {
	as?: string;
	force?: boolean;
}

export default async function clone(projectName?: string, flags: CloneFlags = {}): Promise<void> {
	// Check if we're in a linked directory and should pull/update
	const currentLink = await readProjectLink(process.cwd());

	if (!projectName && currentLink?.deploy_mode === "managed") {
		// No project name, but in a managed linked directory - pull latest code
		await pullCurrentProject(currentLink.project_id, flags);
		return;
	}

	// Validate project name
	if (!projectName) {
		error("Project name required");
		info("Usage: jack clone <project> [--as <directory>]");
		info("Or run in a linked directory to pull latest code.");
		process.exit(1);
	}

	// Determine target directory
	const targetDir = resolve(flags.as ?? projectName);
	const displayName = flags.as ?? projectName;

	// Check if target directory exists and handle collision
	if (existsSync(targetDir)) {
		// If not TTY, error immediately
		if (!process.stdout.isTTY) {
			error(`Directory ${displayName} already exists`);
			process.exit(1);
		}

		// Prompt user for action
		const action = await promptSelectValue(
			`Directory ${displayName} already exists. What would you like to do?`,
			[
				{ value: "overwrite", label: "Overwrite (delete and recreate)" },
				{ value: "merge", label: "Merge (keep existing files)" },
				{ value: "cancel", label: "Cancel" },
			],
		);

		if (isCancel(action) || action === "cancel") {
			info("Clone cancelled");
			process.exit(0);
		}

		if (action === "overwrite") {
			// Delete directory
			await Bun.$`rm -rf ${targetDir}`.quiet();
		}
		// For "merge", we continue and let files be overwritten/added
	}

	// Create reporter for progress output
	let currentSpinner: ReturnType<typeof spinner> | null = null;

	const reporter: CloneReporter = {
		onLookup: (name) => {
			currentSpinner = spinner(`Looking up ${name}...`);
		},
		onLookupComplete: (found, isManaged) => {
			if (found && isManaged) {
				currentSpinner?.success("Found on jack cloud");
			} else {
				currentSpinner?.stop();
			}
		},
		onDownloadStart: (source, details) => {
			if (source === "cloud") {
				currentSpinner = spinner("Downloading from jack cloud...");
			} else {
				// BYO mode - show file count info first, then start download spinner
				if (details) {
					success(`Found ${details}`);
				}
				currentSpinner = spinner("Downloading...");
			}
		},
		onDownloadComplete: (fileCount, displayPath) => {
			currentSpinner?.success(`Restored ${fileCount} file(s) to ${displayPath}`);
		},
		onDownloadError: (err) => {
			currentSpinner?.error("Download failed");
			error(err);
		},
		onTagsRestored: (count) => {
			info(`Restored ${count} tag(s)`);
		},
	};

	try {
		await cloneProject(projectName, targetDir, { silent: false, skipPrompts: false }, reporter);

		// Show next steps
		box("Next steps:", [`cd ${displayName}`, "bun install", "jack ship"]);
	} catch (err) {
		if (err instanceof CloneCollisionError) {
			// This shouldn't happen since we handle collision above, but just in case
			error(err.message);
			process.exit(1);
		}

		// For ProjectNotFoundError and other errors
		if (err instanceof Error) {
			// Check if it's a "not found" error for BYO projects
			if (err.message.includes("For BYO projects")) {
				error(`Project not found: ${projectName}`);
				info("For BYO projects, run 'jack sync' first to backup your project.");
			} else {
				error(err.message);
			}
		} else {
			error("Clone failed");
		}
		process.exit(1);
	}
}

/**
 * Pull latest code from cloud into current linked directory
 */
async function pullCurrentProject(projectId: string, flags: CloneFlags): Promise<void> {
	// Resolve project to get slug/name
	const project = await resolveProject(projectId);
	const projectName = project?.slug || project?.name || projectId;

	if (!project) {
		error("Could not resolve project from control plane");
		process.exit(1);
	}

	// Confirm before overwriting (unless --force)
	if (!flags.force && process.stdout.isTTY) {
		const action = await promptSelectValue(`Pull latest code for ${projectName}?`, [
			{ value: "yes", label: "Yes, overwrite local files" },
			{ value: "cancel", label: "Cancel" },
		]);

		if (isCancel(action) || action === "cancel") {
			info("Cancelled");
			process.exit(0);
		}
	}

	const currentSpinner = spinner("Downloading from jack cloud...");

	try {
		const sourceZip = await downloadProjectSource(projectName);
		const fileCount = await extractZipToDirectory(sourceZip, process.cwd());
		currentSpinner.success(`Updated ${fileCount} file(s)`);
		success(`Pulled latest code for ${projectName}`);
	} catch (err) {
		currentSpinner.error("Download failed");
		if (err instanceof Error) {
			error(err.message);
		}
		process.exit(1);
	}
}

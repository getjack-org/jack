/**
 * Clone Core - reusable clone logic for CLI and other callers
 *
 * This module extracts the core clone functionality from the clone command
 * so it can be reused by other commands (e.g., `jack cd` for auto-cloning).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { downloadProjectSource, fetchProjectTags } from "./control-plane.ts";
import { formatSize } from "./format.ts";
import { registerPath } from "./paths-index.ts";
import { linkProject, updateProjectLink } from "./project-link.ts";
import { resolveProject } from "./project-resolver.ts";
import { cloneFromCloud, getRemoteManifest } from "./storage/index.ts";
import { extractZipToDirectory } from "./zip-utils.ts";

/**
 * Options for the clone operation
 */
export interface CloneOptions {
	/**
	 * When true, don't show spinners or progress output.
	 * Useful for programmatic calls or when called from other commands.
	 */
	silent?: boolean;

	/**
	 * When true, skip interactive prompts for collision handling.
	 * If target directory exists, throws an error instead of prompting.
	 */
	skipPrompts?: boolean;
}

/**
 * Result of a clone operation
 */
export interface CloneResult {
	/** The final absolute path where the project was cloned */
	path: string;
	/** Number of files restored */
	fileCount: number;
	/** Whether this was a managed (Jack Cloud) or BYO project */
	mode: "managed" | "byo";
	/** Project ID if managed */
	projectId?: string;
	/** Number of tags restored (if any) */
	tagsRestored?: number;
}

/**
 * Error thrown when clone cannot proceed due to existing directory
 */
export class CloneCollisionError extends Error {
	constructor(
		public readonly targetDir: string,
		public readonly displayName: string,
	) {
		super(`Directory ${displayName} already exists`);
		this.name = "CloneCollisionError";
	}
}

/**
 * Error thrown when project is not found
 */
export class ProjectNotFoundError extends Error {
	constructor(
		public readonly projectName: string,
		public readonly isByo: boolean,
	) {
		super(
			isByo
				? `Project not found: ${projectName}. For BYO projects, run 'jack sync' first to backup your project.`
				: `Project not found: ${projectName}`,
		);
		this.name = "ProjectNotFoundError";
	}
}

/**
 * Reporter interface for clone progress (optional)
 */
export interface CloneReporter {
	onLookup?: (projectName: string) => void;
	onLookupComplete?: (found: boolean, isManaged: boolean) => void;
	onDownloadStart?: (source: "cloud" | "r2", details?: string) => void;
	onDownloadComplete?: (fileCount: number, displayPath: string) => void;
	onDownloadError?: (error: string) => void;
	onTagsRestored?: (count: number) => void;
}

/**
 * Clone a project from Jack Cloud or User R2 storage.
 *
 * This is the core clone logic that can be called from:
 * - `jack clone` command (full UX with prompts)
 * - `jack cd` command (silent, auto-clone mode)
 * - MCP tools (programmatic access)
 *
 * @param projectName - The project name/slug to clone
 * @param targetDir - The target directory (can be relative, will be resolved to absolute)
 * @param options - Clone options (silent, skipPrompts)
 * @param reporter - Optional reporter for progress callbacks
 * @returns CloneResult with the final path and details
 * @throws CloneCollisionError if target exists and skipPrompts is true
 * @throws ProjectNotFoundError if project not found
 * @throws Error for other failures (download, extract, etc.)
 */
export async function cloneProject(
	projectName: string,
	targetDir: string,
	options: CloneOptions = {},
	reporter?: CloneReporter,
): Promise<CloneResult> {
	const { silent = false, skipPrompts = false } = options;
	const absoluteTargetDir = resolve(targetDir);
	const displayName = targetDir.startsWith("/") ? targetDir : targetDir.replace(/^\.\//, "");

	// Check if target directory exists
	if (existsSync(absoluteTargetDir)) {
		if (skipPrompts) {
			throw new CloneCollisionError(absoluteTargetDir, displayName);
		}
		// If not skipping prompts, caller is responsible for handling collision
		// (the clone.ts command handles this with interactive prompts)
		throw new CloneCollisionError(absoluteTargetDir, displayName);
	}

	// Look up project
	reporter?.onLookup?.(projectName);

	let project: Awaited<ReturnType<typeof resolveProject>> = null;
	try {
		project = await resolveProject(projectName);
	} catch {
		// Not found on control-plane, will fall back to User R2
	}

	reporter?.onLookupComplete?.(
		!!project,
		!!(project?.sources.controlPlane && project?.remote?.projectId),
	);

	// Managed mode: download from control-plane
	if (project?.sources.controlPlane && project.remote?.projectId) {
		reporter?.onDownloadStart?.("cloud");

		try {
			const sourceZip = await downloadProjectSource(projectName);
			const fileCount = await extractZipToDirectory(sourceZip, absoluteTargetDir);

			reporter?.onDownloadComplete?.(fileCount, `./${displayName}/`);

			// Link to control-plane
			await linkProject(absoluteTargetDir, project.remote.projectId, "managed");
			await registerPath(project.remote.projectId, absoluteTargetDir);

			// Fetch and restore tags from control plane
			let tagsRestored = 0;
			try {
				const remoteTags = await fetchProjectTags(project.remote.projectId);
				if (remoteTags.length > 0) {
					await updateProjectLink(absoluteTargetDir, { tags: remoteTags });
					tagsRestored = remoteTags.length;
					reporter?.onTagsRestored?.(tagsRestored);
				}
			} catch {
				// Silent fail - tag restoration is non-critical
			}

			return {
				path: absoluteTargetDir,
				fileCount,
				mode: "managed",
				projectId: project.remote.projectId,
				tagsRestored: tagsRestored > 0 ? tagsRestored : undefined,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not download project source";
			reporter?.onDownloadError?.(message);
			throw new Error(message);
		}
	}

	// BYO mode: use existing User R2 flow
	const manifest = await getRemoteManifest(projectName);

	if (!manifest) {
		throw new ProjectNotFoundError(projectName, true);
	}

	// Show file count and size in reporter
	const totalSize = manifest.files.reduce((sum, f) => sum + f.size, 0);
	reporter?.onDownloadStart?.("r2", `${manifest.files.length} file(s) (${formatSize(totalSize)})`);

	// Download files
	const result = await cloneFromCloud(projectName, absoluteTargetDir);

	if (!result.success) {
		const errorMsg = result.error || "Could not download project files";
		reporter?.onDownloadError?.(errorMsg);
		throw new Error(errorMsg);
	}

	reporter?.onDownloadComplete?.(result.filesDownloaded, `./${displayName}/`);

	return {
		path: absoluteTargetDir,
		fileCount: result.filesDownloaded,
		mode: "byo",
	};
}

/**
 * Check if a project exists (either on Jack Cloud or User R2).
 * Useful for pre-flight checks before cloning.
 *
 * @param projectName - The project name/slug to check
 * @returns Object with exists flag and source info
 */
export async function checkProjectExists(
	projectName: string,
): Promise<{ exists: boolean; isManaged: boolean; projectId?: string }> {
	// Check Jack Cloud first
	try {
		const project = await resolveProject(projectName);
		if (project?.sources.controlPlane && project.remote?.projectId) {
			return {
				exists: true,
				isManaged: true,
				projectId: project.remote.projectId,
			};
		}
	} catch {
		// Not found on control-plane
	}

	// Check User R2
	const manifest = await getRemoteManifest(projectName);
	if (manifest) {
		return {
			exists: true,
			isManaged: false,
		};
	}

	return {
		exists: false,
		isManaged: false,
	};
}

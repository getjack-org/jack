/**
 * Local Paths Index
 *
 * Tracks where projects live on the local filesystem.
 * This is a cache - can be rebuilt by scanning directories.
 *
 * Design:
 * - One project can have multiple local paths (forks, copies)
 * - Paths are verified on read (deleted dirs are pruned)
 * - Auto-registered when jack commands run from project dirs
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Local paths index structure
 */
export interface LocalPathsIndex {
	version: 1;
	/** Map of project name -> array of local paths */
	paths: Record<string, string[]>;
	/** Last time the index was updated */
	updatedAt: string;
}

const INDEX_PATH = join(CONFIG_DIR, "local-paths.json");

/** Directories to skip when scanning */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	".output",
	"coverage",
	".turbo",
	".cache",
]);

/**
 * Check if a directory has a wrangler config file
 */
function hasWranglerConfig(dir: string): boolean {
	return (
		existsSync(join(dir, "wrangler.jsonc")) ||
		existsSync(join(dir, "wrangler.toml")) ||
		existsSync(join(dir, "wrangler.json"))
	);
}

/**
 * Read the local paths index from disk
 */
export async function readLocalPaths(): Promise<LocalPathsIndex> {
	if (!existsSync(INDEX_PATH)) {
		return { version: 1, paths: {}, updatedAt: new Date().toISOString() };
	}

	try {
		return await Bun.file(INDEX_PATH).json();
	} catch {
		// Handle corrupted index file gracefully
		return { version: 1, paths: {}, updatedAt: new Date().toISOString() };
	}
}

/**
 * Write the local paths index to disk
 */
export async function writeLocalPaths(index: LocalPathsIndex): Promise<void> {
	index.updatedAt = new Date().toISOString();
	await Bun.write(INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * Register a local path for a project
 * Idempotent - won't add duplicates
 */
export async function registerLocalPath(projectName: string, localPath: string): Promise<void> {
	const absolutePath = resolve(localPath);
	const index = await readLocalPaths();

	if (!index.paths[projectName]) {
		index.paths[projectName] = [];
	}

	// Avoid duplicates
	if (!index.paths[projectName].includes(absolutePath)) {
		index.paths[projectName].push(absolutePath);
	}

	await writeLocalPaths(index);
}

/**
 * Remove a local path for a project
 */
export async function removeLocalPath(projectName: string, localPath: string): Promise<void> {
	const absolutePath = resolve(localPath);
	const index = await readLocalPaths();

	if (index.paths[projectName]) {
		index.paths[projectName] = index.paths[projectName].filter((p) => p !== absolutePath);

		// Clean up empty arrays
		if (index.paths[projectName].length === 0) {
			delete index.paths[projectName];
		}
	}

	await writeLocalPaths(index);
}

/**
 * Get all local paths for a project, verified to exist
 * Automatically prunes paths that no longer exist or lack wrangler config
 */
export async function getLocalPaths(projectName: string): Promise<string[]> {
	const index = await readLocalPaths();
	const paths = index.paths[projectName] || [];

	// Verify paths exist and have wrangler config
	const validPaths: string[] = [];
	const invalidPaths: string[] = [];

	for (const path of paths) {
		if (hasWranglerConfig(path)) {
			validPaths.push(path);
		} else {
			invalidPaths.push(path);
		}
	}

	// Prune invalid paths
	if (invalidPaths.length > 0) {
		index.paths[projectName] = validPaths;
		if (validPaths.length === 0) {
			delete index.paths[projectName];
		}
		await writeLocalPaths(index);
	}

	return validPaths;
}

/**
 * Get all local paths for all projects, verified to exist
 * Returns a map of projectName -> paths[]
 */
export async function getAllLocalPaths(): Promise<Record<string, string[]>> {
	const index = await readLocalPaths();
	const result: Record<string, string[]> = {};
	let needsWrite = false;

	for (const [projectName, paths] of Object.entries(index.paths)) {
		const validPaths: string[] = [];

		for (const path of paths) {
			if (hasWranglerConfig(path)) {
				validPaths.push(path);
			} else {
				needsWrite = true;
			}
		}

		if (validPaths.length > 0) {
			result[projectName] = validPaths;
		} else if (paths.length > 0) {
			needsWrite = true;
		}
	}

	// Write back pruned index if needed
	if (needsWrite) {
		index.paths = result;
		await writeLocalPaths(index);
	}

	return result;
}

/**
 * Scan a directory recursively for jack projects
 * Returns discovered projects with their paths
 */
export async function scanDirectoryForProjects(
	rootDir: string,
	maxDepth = 3,
): Promise<Array<{ name: string; path: string }>> {
	const { getProjectNameFromDir } = await import("./storage/index.ts");
	const discovered: Array<{ name: string; path: string }> = [];
	const absoluteRoot = resolve(rootDir);

	async function scan(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;

		// Check if this directory is a jack project
		try {
			const name = await getProjectNameFromDir(dir);
			discovered.push({ name, path: dir });
			return; // Don't scan subdirectories of projects
		} catch {
			// Not a project, continue scanning subdirectories
		}

		// Scan subdirectories
		try {
			const entries = await readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				// Skip non-directories
				if (!entry.isDirectory()) continue;

				// Skip hidden directories and common non-project directories
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
					continue;
				}

				const fullPath = join(dir, entry.name);
				await scan(fullPath, depth + 1);
			}
		} catch {
			// Permission denied or other error, skip silently
		}
	}

	await scan(absoluteRoot, 0);
	return discovered;
}

/**
 * Register multiple discovered projects
 * More efficient than calling registerLocalPath for each project
 */
export async function registerDiscoveredProjects(
	projects: Array<{ name: string; path: string }>,
): Promise<void> {
	const index = await readLocalPaths();

	for (const { name, path } of projects) {
		const absolutePath = resolve(path);

		if (!index.paths[name]) {
			index.paths[name] = [];
		}

		if (!index.paths[name].includes(absolutePath)) {
			index.paths[name].push(absolutePath);
		}
	}

	await writeLocalPaths(index);
}

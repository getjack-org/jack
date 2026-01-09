/**
 * Paths Index
 *
 * Tracks where projects live locally, keyed by project_id (not name).
 * This is a lightweight discovery index that can be rebuilt by scanning.
 *
 * Design:
 * - Keyed by project_id for stability (names can collide/change)
 * - Array of paths per project (one project can have multiple local copies)
 * - Auto-pruned on read (invalid paths removed)
 * - Rebuildable via scanAndRegisterProjects()
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { type DeployMode, getJackDir, readProjectLink } from "./project-link.ts";

/**
 * Paths index structure stored in ~/.config/jack/paths.json
 */
export interface PathsIndex {
	version: 1;
	/** Map of project_id -> array of local paths */
	paths: Record<string, string[]>;
	/** Last time the index was updated */
	updatedAt: string;
}

const INDEX_PATH = join(CONFIG_DIR, "paths.json");

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
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".vscode",
]);

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
	if (!existsSync(CONFIG_DIR)) {
		await mkdir(CONFIG_DIR, { recursive: true });
	}
}

/**
 * Read the paths index from disk
 */
export async function readPathsIndex(): Promise<PathsIndex> {
	if (!existsSync(INDEX_PATH)) {
		return { version: 1, paths: {}, updatedAt: new Date().toISOString() };
	}

	try {
		const content = await readFile(INDEX_PATH, "utf-8");
		return JSON.parse(content) as PathsIndex;
	} catch {
		// Handle corrupted index file gracefully
		return { version: 1, paths: {}, updatedAt: new Date().toISOString() };
	}
}

/**
 * Write the paths index to disk
 */
export async function writePathsIndex(index: PathsIndex): Promise<void> {
	await ensureConfigDir();
	index.updatedAt = new Date().toISOString();
	await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * Check if a path has a valid .jack/project.json with matching project ID
 */
async function isValidProjectPath(projectId: string, path: string): Promise<boolean> {
	const link = await readProjectLink(path);
	return link !== null && link.project_id === projectId;
}

/**
 * Register a local path for a project (by ID)
 * Idempotent - won't add duplicates
 */
export async function registerPath(projectId: string, localPath: string): Promise<void> {
	const absolutePath = resolve(localPath);
	const index = await readPathsIndex();

	if (!index.paths[projectId]) {
		index.paths[projectId] = [];
	}

	// Avoid duplicates
	if (!index.paths[projectId].includes(absolutePath)) {
		index.paths[projectId].push(absolutePath);
	}

	await writePathsIndex(index);
}

/**
 * Remove a local path for a project
 */
export async function unregisterPath(projectId: string, localPath: string): Promise<void> {
	const absolutePath = resolve(localPath);
	const index = await readPathsIndex();

	if (index.paths[projectId]) {
		index.paths[projectId] = index.paths[projectId].filter((p) => p !== absolutePath);

		// Clean up empty arrays
		if (index.paths[projectId].length === 0) {
			delete index.paths[projectId];
		}
	}

	await writePathsIndex(index);
}

/**
 * Get all local paths for a project, verified to exist.
 * Auto-prunes paths where .jack/project.json is missing or has wrong project_id.
 */
export async function getPathsForProject(projectId: string): Promise<string[]> {
	const index = await readPathsIndex();
	const paths = index.paths[projectId] || [];

	const validPaths: string[] = [];
	const invalidPaths: string[] = [];

	for (const path of paths) {
		if (await isValidProjectPath(projectId, path)) {
			validPaths.push(path);
		} else {
			invalidPaths.push(path);
		}
	}

	// Prune invalid paths
	if (invalidPaths.length > 0) {
		index.paths[projectId] = validPaths;
		if (validPaths.length === 0) {
			delete index.paths[projectId];
		}
		await writePathsIndex(index);
	}

	return validPaths;
}

/**
 * Get all paths for all projects, verified to exist.
 * Auto-prunes invalid paths across all projects.
 */
export async function getAllPaths(): Promise<Record<string, string[]>> {
	const index = await readPathsIndex();
	const result: Record<string, string[]> = {};
	let needsWrite = false;

	for (const [projectId, paths] of Object.entries(index.paths)) {
		const validPaths: string[] = [];

		for (const path of paths) {
			if (await isValidProjectPath(projectId, path)) {
				validPaths.push(path);
			} else {
				needsWrite = true;
			}
		}

		if (validPaths.length > 0) {
			result[projectId] = validPaths;
		} else if (paths.length > 0) {
			needsWrite = true;
		}
	}

	// Write back pruned index if needed
	if (needsWrite) {
		index.paths = result;
		await writePathsIndex(index);
	}

	return result;
}

/**
 * Information about a discovered project
 */
export interface DiscoveredProject {
	projectId: string;
	path: string;
	deployMode: DeployMode;
}

/**
 * Scan a directory for Jack projects (.jack/project.json) and register them.
 * Only finds linked projects, ignores directories without .jack/
 */
export async function scanAndRegisterProjects(
	rootDir: string,
	maxDepth = 3,
): Promise<DiscoveredProject[]> {
	const discovered: DiscoveredProject[] = [];
	const absoluteRoot = resolve(rootDir);

	async function scan(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;

		// Check if this directory has a .jack/project.json
		const link = await readProjectLink(dir);
		if (link) {
			discovered.push({
				projectId: link.project_id,
				path: dir,
				deployMode: link.deploy_mode,
			});
			return; // Don't scan subdirectories of linked projects
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

	// Register all discovered projects
	if (discovered.length > 0) {
		await registerDiscoveredProjects(discovered);
	}

	return discovered;
}

/**
 * Register multiple discovered projects efficiently.
 * More efficient than calling registerPath for each project.
 */
export async function registerDiscoveredProjects(projects: DiscoveredProject[]): Promise<void> {
	const index = await readPathsIndex();

	for (const { projectId, path } of projects) {
		const absolutePath = resolve(path);

		if (!index.paths[projectId]) {
			index.paths[projectId] = [];
		}

		if (!index.paths[projectId].includes(absolutePath)) {
			index.paths[projectId].push(absolutePath);
		}
	}

	await writePathsIndex(index);
}

/**
 * Find project ID by path (reverse lookup).
 * Scans the index to find which project owns a given path.
 */
export async function findProjectIdByPath(localPath: string): Promise<string | null> {
	const absolutePath = resolve(localPath);
	const index = await readPathsIndex();

	for (const [projectId, paths] of Object.entries(index.paths)) {
		if (paths.includes(absolutePath)) {
			return projectId;
		}
	}

	return null;
}

/**
 * Get the index file path (for testing/debugging)
 */
export function getIndexPath(): string {
	return INDEX_PATH;
}

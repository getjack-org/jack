/**
 * Storage Orchestrator - coordinates all storage operations
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Re-export submodules
export * from "./checksum.ts";
export * from "./file-filter.ts";
export * from "./manifest.ts";
export * from "./r2-client.ts";

// Import from submodules
import { computeChecksum } from "./checksum.ts";
import { DEFAULT_EXCLUDES, type FilteredFile, scanProjectFiles } from "./file-filter.ts";
import {
	type Manifest,
	type ManifestFile,
	computeDiff,
	createManifest,
	parseManifest,
	serializeManifest,
} from "./manifest.ts";
import {
	deleteFile,
	deletePrefix,
	downloadFile,
	ensureBucket,
	listObjects,
	uploadFile,
} from "./r2-client.ts";

// Result types
export interface SyncResult {
	success: boolean;
	projectName: string;
	filesUploaded: number;
	filesDeleted: number;
	totalSize: number;
	error?: string;
}

export interface CloneResult {
	success: boolean;
	projectName: string;
	filesDownloaded: number;
	targetDir: string;
	error?: string;
}

export interface CloudProject {
	name: string;
	files: number;
	size: number;
	lastSync: string;
}

/**
 * Extract project name from wrangler.toml or wrangler.jsonc
 * @param projectDir - Absolute path to project directory
 * @returns Project name
 * @throws Error if wrangler file not found or name not found
 */
export async function getProjectNameFromDir(projectDir: string): Promise<string> {
	// Try wrangler.toml first
	const tomlPath = join(projectDir, "wrangler.toml");
	try {
		const content = await Bun.file(tomlPath).text();
		const match = content.match(/^name\s*=\s*["']([^"']+)["']/m);
		if (match?.[1]) {
			return match[1];
		}
	} catch {
		// File doesn't exist, try JSON
	}

	// Try wrangler.jsonc
	const jsoncPath = join(projectDir, "wrangler.jsonc");
	try {
		const content = await Bun.file(jsoncPath).text();
		// Remove comments and parse JSON
		const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		const config = JSON.parse(jsonContent);
		if (config.name) {
			return config.name;
		}
	} catch {
		// File doesn't exist or parse failed
	}

	throw new Error(
		"Could not find project name. Please ensure wrangler.toml or wrangler.jsonc exists with a 'name' field",
	);
}

/**
 * Get remote manifest from cloud storage
 * @param projectName - Name of the project
 * @returns Manifest object or null if not found
 */
export async function getRemoteManifest(projectName: string): Promise<Manifest | null> {
	try {
		const bucket = await ensureBucket();
		const manifestKey = `${projectName}/manifest.json`;
		const content = await downloadFile(bucket, manifestKey);
		const json = content.toString("utf-8");
		return parseManifest(json);
	} catch {
		// Manifest doesn't exist or can't be read
		return null;
	}
}

/**
 * Sync local project to cloud storage
 * @param projectDir - Absolute path to project directory
 * @param options - Sync options
 * @returns SyncResult with details about the sync operation
 */
export async function syncToCloud(
	projectDir: string,
	options?: { force?: boolean; dryRun?: boolean; verbose?: boolean },
): Promise<SyncResult> {
	try {
		const { force = false, dryRun = false, verbose = false } = options || {};

		// Get project name
		const projectName = await getProjectNameFromDir(projectDir);

		// Scan local files
		const filteredFiles = await scanProjectFiles(projectDir);

		// Compute checksums for all local files
		const localFiles: ManifestFile[] = [];
		let totalSize = 0;

		for (const file of filteredFiles) {
			const checksum = await computeChecksum(file.absolutePath);
			localFiles.push({
				path: file.path,
				size: file.size,
				checksum,
				modified: new Date().toISOString(),
			});
			totalSize += file.size;
		}

		// For dry-run, skip cloud operations entirely
		if (dryRun) {
			return {
				success: true,
				projectName,
				filesUploaded: localFiles.length,
				filesDeleted: 0,
				totalSize,
			};
		}

		// Ensure bucket exists (only for real sync)
		const bucket = await ensureBucket();

		// Get remote manifest
		const remoteManifest = await getRemoteManifest(projectName);

		// Compute diff
		const diff = computeDiff(localFiles, remoteManifest);

		// Upload added and changed files
		let filesUploaded = 0;
		const filesToUpload = [...diff.added, ...diff.changed];

		for (const file of filesToUpload) {
			const filePath = join(projectDir, file.path);
			const content = await readFile(filePath);
			const key = `${projectName}/current/${file.path}`;

			if (verbose) {
				console.error(`Uploading ${file.path}...`);
			}

			await uploadFile(bucket, key, content);
			filesUploaded++;
		}

		// Delete removed files
		let filesDeleted = 0;
		for (const file of diff.deleted) {
			const key = `${projectName}/current/${file.path}`;

			if (verbose) {
				console.error(`Deleting ${file.path}...`);
			}

			await deleteFile(bucket, key);
			filesDeleted++;
		}

		// Create and upload new manifest
		const newManifest = createManifest(projectName, localFiles, DEFAULT_EXCLUDES);
		const manifestKey = `${projectName}/manifest.json`;
		const manifestContent = serializeManifest(newManifest);

		await uploadFile(bucket, manifestKey, manifestContent);

		return {
			success: true,
			projectName,
			filesUploaded,
			filesDeleted,
			totalSize,
		};
	} catch (err) {
		return {
			success: false,
			projectName: "",
			filesUploaded: 0,
			filesDeleted: 0,
			totalSize: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Clone project from cloud storage to local directory
 * @param projectName - Name of the project to clone
 * @param targetDir - Absolute path to target directory
 * @returns CloneResult with details about the clone operation
 */
export async function cloneFromCloud(projectName: string, targetDir: string): Promise<CloneResult> {
	try {
		// Get manifest from cloud
		const manifest = await getRemoteManifest(projectName);

		if (!manifest) {
			return {
				success: false,
				projectName,
				filesDownloaded: 0,
				targetDir,
				error: `Project '${projectName}' not found in cloud storage`,
			};
		}

		// Get bucket
		const bucket = await ensureBucket();

		// Download each file
		let filesDownloaded = 0;

		for (const file of manifest.files) {
			const key = `${projectName}/current/${file.path}`;
			const targetPath = join(targetDir, file.path);

			// Create parent directory
			await mkdir(dirname(targetPath), { recursive: true });

			// Download file
			const content = await downloadFile(bucket, key);

			// Write to disk
			await writeFile(targetPath, content);
			filesDownloaded++;
		}

		return {
			success: true,
			projectName,
			filesDownloaded,
			targetDir,
		};
	} catch (err) {
		return {
			success: false,
			projectName,
			filesDownloaded: 0,
			targetDir,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * List all cloud projects
 * @returns Array of cloud projects with metadata
 */
export async function listCloudProjects(): Promise<CloudProject[]> {
	try {
		const bucket = await ensureBucket();

		// List all objects with empty prefix
		const objects = await listObjects(bucket, "");

		// Extract unique project names from paths
		const projectNames = new Set<string>();
		for (const obj of objects) {
			const parts = obj.key.split("/");
			const projectName = parts[0];
			if (parts.length >= 2 && projectName) {
				projectNames.add(projectName);
			}
		}

		// Get manifest for each project
		const projects: CloudProject[] = [];

		for (const projectName of projectNames) {
			const manifest = await getRemoteManifest(projectName);

			if (manifest) {
				const totalSize = manifest.files.reduce((sum, f) => sum + f.size, 0);

				projects.push({
					name: projectName,
					files: manifest.files.length,
					size: totalSize,
					lastSync: manifest.lastSync,
				});
			}
		}

		// Sort by last sync date (newest first)
		projects.sort((a, b) => new Date(b.lastSync).getTime() - new Date(a.lastSync).getTime());

		return projects;
	} catch {
		return [];
	}
}

/**
 * Delete a cloud project and all its files
 * @param projectName - Name of the project to delete
 * @returns true if successful, false otherwise
 */
export async function deleteCloudProject(projectName: string): Promise<boolean> {
	try {
		const bucket = await ensureBucket();

		// Delete all objects with project prefix
		const deleted = await deletePrefix(bucket, `${projectName}/`);

		return deleted > 0;
	} catch {
		return false;
	}
}

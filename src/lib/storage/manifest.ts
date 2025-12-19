/**
 * Manifest creation, parsing, serialization, and diff computation
 */

import { hostname } from "node:os";

export interface ManifestFile {
	path: string;
	size: number;
	checksum: string;
	modified: string;
}

export interface Manifest {
	version: number;
	projectName: string;
	lastSync: string;
	syncedFrom: string;
	files: ManifestFile[];
	excludes: string[];
}

export interface FileDiff {
	added: ManifestFile[];
	changed: ManifestFile[];
	deleted: ManifestFile[];
	unchanged: ManifestFile[];
	isEmpty: boolean;
}

const MANIFEST_VERSION = 1;

/**
 * Creates a new manifest object
 * @param projectName - Name of the project
 * @param files - Array of manifest files
 * @param excludes - Optional array of exclude patterns
 * @returns New manifest object
 */
export function createManifest(
	projectName: string,
	files: ManifestFile[],
	excludes: string[] = [],
): Manifest {
	return {
		version: MANIFEST_VERSION,
		projectName,
		lastSync: new Date().toISOString(),
		syncedFrom: hostname(),
		files,
		excludes,
	};
}

/**
 * Computes diff between local files and remote manifest
 * @param localFiles - Current local manifest files
 * @param remoteManifest - Remote manifest (null if first sync)
 * @returns FileDiff object with categorized changes
 */
export function computeDiff(localFiles: ManifestFile[], remoteManifest: Manifest | null): FileDiff {
	const diff: FileDiff = {
		added: [],
		changed: [],
		deleted: [],
		unchanged: [],
		isEmpty: false,
	};

	// If no remote manifest, all local files are new
	if (!remoteManifest) {
		diff.added = [...localFiles];
		diff.isEmpty = localFiles.length === 0;
		return diff;
	}

	// Create maps for efficient lookup
	const localMap = new Map(localFiles.map((f) => [f.path, f]));
	const remoteMap = new Map(remoteManifest.files.map((f) => [f.path, f]));

	// Find added and changed files
	for (const localFile of localFiles) {
		const remoteFile = remoteMap.get(localFile.path);

		if (!remoteFile) {
			diff.added.push(localFile);
		} else if (remoteFile.checksum !== localFile.checksum) {
			diff.changed.push(localFile);
		} else {
			diff.unchanged.push(localFile);
		}
	}

	// Find deleted files
	for (const remoteFile of remoteManifest.files) {
		if (!localMap.has(remoteFile.path)) {
			diff.deleted.push(remoteFile);
		}
	}

	// Check if diff is empty
	diff.isEmpty = diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0;

	return diff;
}

/**
 * Parses JSON string into Manifest object
 * @param json - JSON string representation of manifest
 * @returns Parsed Manifest object
 * @throws Error if JSON is invalid or doesn't match schema
 */
export function parseManifest(json: string): Manifest {
	const parsed = JSON.parse(json);

	// Basic validation
	if (typeof parsed.version !== "number") {
		throw new Error("Invalid manifest: missing or invalid version");
	}
	if (typeof parsed.projectName !== "string") {
		throw new Error("Invalid manifest: missing or invalid projectName");
	}
	if (!Array.isArray(parsed.files)) {
		throw new Error("Invalid manifest: files must be an array");
	}

	return {
		version: parsed.version,
		projectName: parsed.projectName,
		lastSync: parsed.lastSync || new Date().toISOString(),
		syncedFrom: parsed.syncedFrom || "unknown",
		files: parsed.files,
		excludes: parsed.excludes || [],
	};
}

/**
 * Serializes Manifest object to JSON string
 * @param manifest - Manifest object to serialize
 * @returns Pretty-printed JSON string
 */
export function serializeManifest(manifest: Manifest): string {
	return JSON.stringify(manifest, null, 2);
}

/**
 * Zip utility functions for extracting zip archives
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

/**
 * Extract a zip buffer to a target directory.
 * Creates directories as needed and writes files preserving relative paths.
 *
 * @param zipBuffer - The zip file contents as a Buffer
 * @param targetDir - The directory to extract files to
 * @returns The number of files extracted
 */
export async function extractZipToDirectory(zipBuffer: Buffer, targetDir: string): Promise<number> {
	const unzipped = unzipSync(new Uint8Array(zipBuffer));
	let fileCount = 0;

	for (const [path, content] of Object.entries(unzipped)) {
		// Skip directories (they end with /)
		if (path.endsWith("/")) continue;

		// Security: prevent path traversal by removing any .. segments
		const normalizedPath = path.replace(/\.\./g, "");
		const fullPath = join(targetDir, normalizedPath);

		// Ensure directory exists
		await mkdir(dirname(fullPath), { recursive: true });

		// Write file
		await writeFile(fullPath, content);
		fileCount++;
	}

	return fileCount;
}

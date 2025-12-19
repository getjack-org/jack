/**
 * SHA256 file hashing utilities using Bun's native crypto
 */

import { readFile } from "node:fs/promises";

/**
 * Computes SHA256 checksum for a file
 * @param filePath - Absolute or relative path to the file
 * @returns Formatted checksum string (sha256:...)
 */
export async function computeChecksum(filePath: string): Promise<string> {
	const content = await readFile(filePath);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	const hash = hasher.digest("hex");
	return `sha256:${hash}`;
}

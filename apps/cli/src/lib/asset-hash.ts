/**
 * Asset hash computation utilities for content-addressable asset management.
 * Uses SHA-256 hashing with base64 content and file extension.
 */

/**
 * Represents a single entry in the asset manifest.
 */
export interface AssetManifestEntry {
	hash: string;
	size: number;
}

/**
 * Maps asset paths to their manifest entries.
 */
export type AssetManifest = Record<string, AssetManifestEntry>;

/**
 * Computes a content-addressable hash for an asset.
 *
 * Algorithm: SHA-256(base64(content) + extension).slice(0, 32)
 * - Extension is extracted from filePath without the leading dot
 * - Uses Web Crypto API for SHA-256 computation
 *
 * @param content - The raw binary content of the asset
 * @param filePath - The file path used to extract the extension
 * @returns A 32-character hex hash string
 */
export async function computeAssetHash(content: Uint8Array, filePath: string): Promise<string> {
	// Extract extension without the dot (e.g., "js" not ".js")
	const extension = filePath.includes(".") ? filePath.split(".").pop() || "" : "";

	// Convert content to base64
	const base64 = Buffer.from(content).toString("base64");

	// Create hash input: base64 content + extension
	const hashInput = new TextEncoder().encode(base64 + extension);

	// Compute SHA-256 hash using Web Crypto API
	const hashBuffer = await crypto.subtle.digest("SHA-256", hashInput);

	// Convert to hex string and truncate to 32 characters
	const hashArray = new Uint8Array(hashBuffer);
	const hashHex = Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return hashHex.slice(0, 32);
}

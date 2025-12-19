import { unlink, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { error } from "../output.ts";

export interface R2Object {
	key: string;
	size: number;
	lastModified: string;
}

interface R2ApiObject {
	key: string;
	size: number;
	uploaded?: string;
	lastModified?: string;
}

/**
 * Get the Cloudflare account ID from wrangler whoami
 */
export async function getAccountId(): Promise<string> {
	const result = await $`wrangler whoami`.quiet();

	if (result.exitCode !== 0) {
		throw new Error("Failed to get account ID. Are you authenticated?");
	}

	const output = result.stdout.toString();
	// wrangler whoami outputs a table like:
	// │ Account Name   │ 26927580508a6da4ea3169bdc5c23418 │
	const match = output.match(/│[^│]+│\s*([a-f0-9]{32})\s*│/);

	if (!match?.[1]) {
		throw new Error("Could not parse account ID from wrangler whoami");
	}

	return match[1];
}

/**
 * Get the bucket name for this account
 */
export async function getBucketName(): Promise<string> {
	const accountId = await getAccountId();
	return `jack-storage-${accountId.slice(0, 16)}`;
}

/**
 * Check if a bucket exists
 */
async function bucketExists(bucketName: string): Promise<boolean> {
	const result = await $`wrangler r2 bucket list`.nothrow().quiet();

	if (result.exitCode !== 0) {
		return false;
	}

	const output = result.stdout.toString();
	return output.includes(bucketName);
}

/**
 * Ensure the bucket exists, creating it if necessary
 */
export async function ensureBucket(): Promise<string> {
	const bucketName = await getBucketName();

	if (await bucketExists(bucketName)) {
		return bucketName;
	}

	const result = await $`wrangler r2 bucket create ${bucketName}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to create bucket ${bucketName}`);
	}

	return bucketName;
}

/**
 * Upload a file to R2
 */
export async function uploadFile(
	bucket: string,
	key: string,
	content: Buffer | string,
): Promise<void> {
	const tempFile = `/tmp/jack-upload-${Date.now()}`;

	try {
		await writeFile(tempFile, content);

		const result = await $`wrangler r2 object put ${bucket}/${key} --file ${tempFile}`
			.nothrow()
			.quiet();

		if (result.exitCode !== 0) {
			throw new Error(`Failed to upload file to ${bucket}/${key}`);
		}
	} finally {
		try {
			await unlink(tempFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Download a file from R2
 */
export async function downloadFile(bucket: string, key: string): Promise<Buffer> {
	const tempFile = `/tmp/jack-download-${Date.now()}`;

	try {
		const result = await $`wrangler r2 object get ${bucket}/${key} --file ${tempFile}`
			.nothrow()
			.quiet();

		if (result.exitCode !== 0) {
			throw new Error(`Failed to download file from ${bucket}/${key}`);
		}

		const content = await Bun.file(tempFile).arrayBuffer();
		return Buffer.from(content);
	} finally {
		try {
			await unlink(tempFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Delete a file from R2
 */
export async function deleteFile(bucket: string, key: string): Promise<void> {
	const result = await $`wrangler r2 object delete ${bucket}/${key}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete file from ${bucket}/${key}`);
	}
}

/**
 * List objects in R2 with optional prefix
 */
export async function listObjects(bucket: string, prefix: string): Promise<R2Object[]> {
	const args = prefix
		? ["r2", "object", "list", bucket, "--prefix", prefix, "--json"]
		: ["r2", "object", "list", bucket, "--json"];

	const result = await $`wrangler ${args}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to list objects in bucket ${bucket}`);
	}

	try {
		const output = result.stdout.toString().trim();
		if (!output) {
			return [];
		}

		const data = JSON.parse(output);

		// Handle both array and object with objects array
		const objects: R2ApiObject[] = Array.isArray(data) ? data : data.objects || [];

		return objects.map((obj) => ({
			key: obj.key,
			size: obj.size,
			lastModified: obj.uploaded || obj.lastModified || "",
		}));
	} catch (err) {
		throw new Error(`Failed to parse R2 list output: ${err}`);
	}
}

/**
 * Check if an object exists in R2
 */
export async function objectExists(bucket: string, key: string): Promise<boolean> {
	const result = await $`wrangler r2 object get ${bucket}/${key}`.nothrow().quiet();
	return result.exitCode === 0;
}

/**
 * Delete all objects with a given prefix
 * Returns the number of objects deleted
 */
export async function deletePrefix(bucket: string, prefix: string): Promise<number> {
	const objects = await listObjects(bucket, prefix);

	let deleted = 0;
	for (const obj of objects) {
		try {
			await deleteFile(bucket, obj.key);
			deleted++;
		} catch (err) {
			error(`Failed to delete ${obj.key}: ${err}`);
		}
	}

	return deleted;
}

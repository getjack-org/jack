/**
 * Storage (R2 bucket) info logic for jack services storage info
 *
 * Gets bucket information. For now, just confirms the bucket exists
 * since R2 doesn't have a simple stats API via wrangler.
 */

import { join } from "node:path";
import { $ } from "bun";
import { fetchProjectResources } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { findWranglerConfig } from "../wrangler-config.ts";
import { getExistingR2Bindings } from "./storage-config.ts";

export interface StorageBucketInfo {
	name: string;
	binding: string;
	source: "control-plane" | "wrangler";
}

/**
 * Check if a bucket exists via wrangler
 */
async function bucketExistsViaWrangler(bucketName: string): Promise<boolean> {
	const result = await $`wrangler r2 bucket list --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		return false;
	}

	try {
		const output = result.stdout.toString().trim();
		const buckets = JSON.parse(output) as Array<{ name: string }>;
		return buckets.some((b) => b.name === bucketName);
	} catch {
		return false;
	}
}

/**
 * Get storage bucket info for a project.
 *
 * @param projectDir - The project directory
 * @param bucketName - Optional specific bucket name. If not provided, returns first bucket.
 */
export async function getStorageBucketInfo(
	projectDir: string,
	bucketName?: string,
): Promise<StorageBucketInfo | null> {
	const wranglerPath = findWranglerConfig(projectDir) ?? join(projectDir, "wrangler.jsonc");

	// Read deploy mode from .jack/project.json
	const link = await readProjectLink(projectDir);

	// Get bindings from wrangler.jsonc
	const bindings = await getExistingR2Bindings(wranglerPath);

	if (bindings.length === 0) {
		return null;
	}

	// Find the requested bucket (or first if not specified)
	const binding = bucketName ? bindings.find((b) => b.bucket_name === bucketName) : bindings[0];

	if (!binding) {
		return null;
	}

	// For managed projects, verify via control plane (don't call wrangler - user may not have CF auth)
	if (link?.deploy_mode === "managed") {
		const resources = await fetchProjectResources(link.project_id);
		const r2Resource = resources.find(
			(r) => r.resource_type === "r2" && r.resource_name === binding.bucket_name,
		);

		if (r2Resource) {
			return {
				name: binding.bucket_name,
				binding: binding.binding,
				source: "control-plane",
			};
		}
		// For managed mode: if not in control plane, the bucket doesn't exist on the server
		// but we still have a binding configured, so return the binding info
		return {
			name: binding.bucket_name,
			binding: binding.binding,
			source: "control-plane",
		};
	}

	// For BYO only, verify bucket exists via wrangler
	const exists = await bucketExistsViaWrangler(binding.bucket_name);

	if (!exists) {
		return null;
	}

	return {
		name: binding.bucket_name,
		binding: binding.binding,
		source: "wrangler",
	};
}

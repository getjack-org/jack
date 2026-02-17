/**
 * Storage (R2 bucket) listing logic for jack services storage list
 *
 * Lists R2 buckets configured in wrangler.jsonc.
 * For managed projects, fetches metadata via control plane instead of wrangler.
 */

import { findWranglerConfig } from "../wrangler-config.ts";
import { getExistingR2Bindings } from "./storage-config.ts";

export interface StorageBucketListEntry {
	name: string;
	binding: string;
}

/**
 * List all R2 storage buckets configured for a project.
 *
 * For managed projects: reads bindings from wrangler.jsonc.
 * For BYO projects: reads bindings from wrangler.jsonc.
 *
 * Note: R2 doesn't have a simple metadata API like D1, so we just return
 * the configured bindings. For detailed info, use storage info.
 */
export async function listStorageBuckets(projectDir: string): Promise<StorageBucketListEntry[]> {
	const wranglerPath = findWranglerConfig(projectDir);
	if (!wranglerPath) {
		return [];
	}

	// Get existing R2 bindings from wrangler config
	const bindings = await getExistingR2Bindings(wranglerPath);

	if (bindings.length === 0) {
		return [];
	}

	// Convert to list entries
	const entries: StorageBucketListEntry[] = bindings.map((binding) => ({
		name: binding.bucket_name,
		binding: binding.binding,
	}));

	return entries;
}

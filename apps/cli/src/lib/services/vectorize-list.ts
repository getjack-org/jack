/**
 * Vectorize index listing logic for jack MCP tools
 *
 * Lists Vectorize indexes configured in wrangler.jsonc with their metadata.
 */

import { findWranglerConfig } from "../wrangler-config.ts";
import { getExistingVectorizeBindings } from "./vectorize-config.ts";
import { getVectorizeInfo } from "./vectorize-info.ts";

export interface VectorizeListEntry {
	name: string;
	binding: string;
	dimensions?: number;
	metric?: string;
	vectorCount?: number;
}

/**
 * List all Vectorize indexes configured for a project.
 *
 * Reads bindings from wrangler.jsonc and fetches additional metadata
 * (dimensions, metric, vector count) via wrangler vectorize info for each index.
 */
export async function listVectorizeIndexes(projectDir: string): Promise<VectorizeListEntry[]> {
	const wranglerPath = findWranglerConfig(projectDir);
	if (!wranglerPath) {
		return [];
	}

	// Get existing Vectorize bindings from wrangler config
	const bindings = await getExistingVectorizeBindings(wranglerPath);

	if (bindings.length === 0) {
		return [];
	}

	// Fetch detailed info for each index
	const entries: VectorizeListEntry[] = [];

	for (const binding of bindings) {
		const entry: VectorizeListEntry = {
			name: binding.index_name,
			binding: binding.binding,
		};

		// Try to get additional metadata via wrangler
		const info = await getVectorizeInfo(binding.index_name);
		if (info) {
			entry.dimensions = info.dimensions;
			entry.metric = info.metric;
			entry.vectorCount = info.vectorCount;
		}

		entries.push(entry);
	}

	return entries;
}

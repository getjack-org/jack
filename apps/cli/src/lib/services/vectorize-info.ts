/**
 * Vectorize index info logic for jack MCP tools
 *
 * Uses wrangler CLI to get information about Vectorize indexes.
 */

import { $ } from "bun";

export interface VectorizeInfo {
	name: string;
	dimensions: number;
	metric: string;
	vectorCount: number;
	createdOn?: string;
	modifiedOn?: string;
}

/**
 * Get Vectorize index info via wrangler vectorize info
 */
export async function getVectorizeInfo(indexName: string): Promise<VectorizeInfo | null> {
	const result = await $`wrangler vectorize info ${indexName} --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		return null;
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);

		// wrangler vectorize info --json returns:
		// {
		//   "name": "...",
		//   "config": { "dimensions": N, "metric": "..." },
		//   "vectorsCount": N,
		//   "created_on": "...",
		//   "modified_on": "..."
		// }
		return {
			name: data.name || indexName,
			dimensions: data.config?.dimensions || 0,
			metric: data.config?.metric || "unknown",
			vectorCount: data.vectorsCount || 0,
			createdOn: data.created_on,
			modifiedOn: data.modified_on,
		};
	} catch {
		// Failed to parse JSON output
		return null;
	}
}

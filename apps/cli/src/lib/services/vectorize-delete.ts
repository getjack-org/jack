/**
 * Vectorize index deletion logic for jack MCP tools
 *
 * Uses wrangler CLI to delete Vectorize indexes.
 */

import { join } from "node:path";
import { $ } from "bun";
import { removeVectorizeBinding } from "./vectorize-config.ts";

export interface DeleteVectorizeResult {
	indexName: string;
	deleted: boolean;
	bindingRemoved: boolean;
}

/**
 * Delete a Vectorize index via wrangler
 */
async function deleteIndexViaWrangler(indexName: string): Promise<void> {
	const result = await $`wrangler vectorize delete ${indexName} --force`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		// Ignore "not found" errors - the index might already be deleted
		if (!stderr.includes("not found") && !stderr.includes("does not exist")) {
			throw new Error(stderr || `Failed to delete Vectorize index ${indexName}`);
		}
	}
}

/**
 * Delete a Vectorize index for the current project.
 *
 * Uses wrangler vectorize delete to delete the index, then removes
 * the binding from wrangler.jsonc.
 */
export async function deleteVectorizeIndex(
	projectDir: string,
	indexName: string,
): Promise<DeleteVectorizeResult> {
	// Delete via wrangler
	await deleteIndexViaWrangler(indexName);

	// Remove binding from wrangler.jsonc
	const wranglerPath = join(projectDir, "wrangler.jsonc");
	const bindingRemoved = await removeVectorizeBinding(wranglerPath, indexName);

	return {
		indexName,
		deleted: true,
		bindingRemoved,
	};
}

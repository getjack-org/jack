/**
 * Storage (R2 bucket) deletion logic for jack services storage delete
 *
 * Handles both managed (control plane) and BYO (wrangler r2 bucket delete) modes.
 */

import { join } from "node:path";
import { $ } from "bun";
import { deleteProjectResource, fetchProjectResources } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { getExistingR2Bindings, removeR2Binding } from "./storage-config.ts";

export interface DeleteStorageBucketResult {
	bucketName: string;
	deleted: boolean;
	bindingRemoved: boolean;
}

/**
 * Delete an R2 bucket via wrangler (for BYO mode)
 */
async function deleteBucketViaWrangler(bucketName: string): Promise<void> {
	const result = await $`wrangler r2 bucket delete ${bucketName}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		// Ignore "not found" errors - bucket may already be deleted
		if (!stderr.includes("not found") && !stderr.includes("does not exist")) {
			throw new Error(stderr || `Failed to delete bucket ${bucketName}`);
		}
	}
}

/**
 * Delete an R2 storage bucket for the current project.
 *
 * For managed projects: calls control plane DELETE /v1/projects/:id/resources/:id
 * For BYO projects: uses wrangler r2 bucket delete
 *
 * In both cases, removes the binding from wrangler.jsonc.
 */
export async function deleteStorageBucket(
	projectDir: string,
	bucketName: string,
): Promise<DeleteStorageBucketResult> {
	// Read project link to determine deploy mode
	const link = await readProjectLink(projectDir);
	if (!link) {
		throw new Error("Not in a jack project. Run 'jack new' to create a project.");
	}

	const wranglerPath = join(projectDir, "wrangler.jsonc");

	// Verify bucket exists in wrangler.jsonc
	const bindings = await getExistingR2Bindings(wranglerPath);
	const binding = bindings.find((b) => b.bucket_name === bucketName);

	if (!binding) {
		throw new Error(`Bucket "${bucketName}" not found in this project.`);
	}

	let deleted = true;

	if (link.deploy_mode === "managed") {
		// Managed mode: delete via control plane (don't call wrangler - user may not have CF auth)
		const resources = await fetchProjectResources(link.project_id);
		const r2Resource = resources.find(
			(r) => r.resource_type === "r2" && r.resource_name === bucketName,
		);

		if (r2Resource) {
			await deleteProjectResource(link.project_id, r2Resource.id);
		}
		// If resource not in control plane, just remove the local binding
		// Don't attempt wrangler delete - managed mode users don't have CF credentials
	} else {
		// BYO mode: delete via wrangler directly
		await deleteBucketViaWrangler(bucketName);
	}

	// Remove binding from wrangler.jsonc (both modes)
	const bindingRemoved = await removeR2Binding(wranglerPath, bucketName);

	return {
		bucketName,
		deleted,
		bindingRemoved,
	};
}

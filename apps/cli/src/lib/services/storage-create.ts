/**
 * Storage (R2 bucket) creation logic for jack services storage create
 *
 * Handles both managed (control plane) and BYO (wrangler r2 bucket create) modes.
 */

import { join } from "node:path";
import { $ } from "bun";
import { createProjectResource } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { getProjectNameFromDir } from "../storage/index.ts";
import {
	addR2Binding,
	generateBucketName,
	getExistingR2Bindings,
	toStorageBindingName,
} from "./storage-config.ts";

export interface CreateStorageBucketOptions {
	name?: string;
	interactive?: boolean; // Whether to prompt for deploy
}

export interface CreateStorageBucketResult {
	bucketName: string;
	bindingName: string;
	created: boolean; // false if reused existing
}

interface ExistingBucket {
	name: string;
	creation_date?: string;
}

/**
 * List all R2 buckets in the Cloudflare account via wrangler
 */
async function listBucketsViaWrangler(): Promise<ExistingBucket[]> {
	const result = await $`wrangler r2 bucket list --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		// If wrangler fails, return empty list (might not be logged in)
		return [];
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);
		// wrangler r2 bucket list --json returns array: [{ "name": "...", "creation_date": "..." }]
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/**
 * Find an existing R2 bucket by name
 */
async function findExistingBucket(bucketName: string): Promise<ExistingBucket | null> {
	const buckets = await listBucketsViaWrangler();
	return buckets.find((b) => b.name === bucketName) ?? null;
}

/**
 * Create an R2 bucket via wrangler (for BYO mode)
 */
async function createBucketViaWrangler(bucketName: string): Promise<{ created: boolean }> {
	// Check if bucket already exists
	const existing = await findExistingBucket(bucketName);
	if (existing) {
		return { created: false };
	}

	const result = await $`wrangler r2 bucket create ${bucketName}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to create bucket ${bucketName}`);
	}

	return { created: true };
}

/**
 * Create an R2 storage bucket for the current project.
 *
 * For managed projects: calls control plane POST /v1/projects/:id/resources/r2
 * For BYO projects: uses wrangler r2 bucket create
 *
 * In both cases, updates wrangler.jsonc with the new binding.
 */
export async function createStorageBucket(
	projectDir: string,
	options: CreateStorageBucketOptions = {},
): Promise<CreateStorageBucketResult> {
	// Read project link to determine deploy mode
	const link = await readProjectLink(projectDir);
	if (!link) {
		throw new Error("Not in a jack project. Run 'jack new' to create a project.");
	}

	// Get project name from wrangler config
	const projectName = await getProjectNameFromDir(projectDir);

	// Get existing R2 bindings to determine naming
	const wranglerPath = join(projectDir, "wrangler.jsonc");
	const existingBindings = await getExistingR2Bindings(wranglerPath);
	const existingCount = existingBindings.length;

	// Determine bucket name
	const bucketName = options.name ?? generateBucketName(projectName, existingCount);

	// Determine binding name
	const isFirst = existingCount === 0;
	const bindingName = toStorageBindingName(bucketName, isFirst);

	// Check if binding name already exists
	const bindingExists = existingBindings.some((b) => b.binding === bindingName);
	if (bindingExists) {
		throw new Error(`Binding "${bindingName}" already exists. Choose a different bucket name.`);
	}

	let created = true;
	let actualBucketName = bucketName;

	if (link.deploy_mode === "managed") {
		// Managed mode: call control plane
		// Note: Control plane will reuse existing bucket if name matches
		const resource = await createProjectResource(link.project_id, "r2", {
			name: bucketName,
			bindingName,
		});
		// Use the actual name from control plane (may differ from CLI-generated name)
		actualBucketName = resource.resource_name;
	} else {
		// BYO mode: use wrangler r2 bucket create (checks for existing first)
		const result = await createBucketViaWrangler(bucketName);
		created = result.created;
	}

	// Update wrangler.jsonc with the new binding
	await addR2Binding(wranglerPath, {
		binding: bindingName,
		bucket_name: actualBucketName,
	});

	return {
		bucketName: actualBucketName,
		bindingName,
		created,
	};
}

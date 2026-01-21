/**
 * Vectorize index creation logic for jack MCP tools
 *
 * Uses wrangler CLI to create Vectorize indexes.
 */

import { join } from "node:path";
import { $ } from "bun";
import { getProjectNameFromDir } from "../storage/index.ts";
import { addVectorizeBinding, getExistingVectorizeBindings } from "./vectorize-config.ts";

export type VectorizeMetric = "cosine" | "euclidean" | "dot-product";

export interface CreateVectorizeOptions {
	name?: string;
	dimensions?: number;
	metric?: VectorizeMetric;
}

export interface CreateVectorizeResult {
	indexName: string;
	bindingName: string;
	dimensions: number;
	metric: VectorizeMetric;
	created: boolean; // false if reused existing
}

/**
 * Convert an index name to SCREAMING_SNAKE_CASE for the binding name.
 * Special case: first index in a project gets "VECTORS" as the binding.
 */
function toBindingName(indexName: string, isFirst: boolean): string {
	if (isFirst) {
		return "VECTORS";
	}
	// Convert kebab-case/snake_case to SCREAMING_SNAKE_CASE
	return indexName
		.replace(/-/g, "_")
		.replace(/[^a-zA-Z0-9_]/g, "")
		.toUpperCase();
}

/**
 * Generate a unique index name for a project.
 * First index: {project}-vectors
 * Subsequent: {project}-vectors-{n}
 */
function generateIndexName(projectName: string, existingCount: number): string {
	if (existingCount === 0) {
		return `${projectName}-vectors`;
	}
	return `${projectName}-vectors-${existingCount + 1}`;
}

interface ExistingIndex {
	name: string;
	dimensions?: number;
	metric?: string;
}

/**
 * List all Vectorize indexes in the Cloudflare account via wrangler
 */
async function listIndexesViaWrangler(): Promise<ExistingIndex[]> {
	const result = await $`wrangler vectorize list --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		// If wrangler fails, return empty list (might not be logged in)
		return [];
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);
		// wrangler vectorize list --json returns array: [{ "name": "...", ... }]
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/**
 * Find an existing Vectorize index by name
 */
async function findExistingIndex(indexName: string): Promise<ExistingIndex | null> {
	const indexes = await listIndexesViaWrangler();
	return indexes.find((idx) => idx.name === indexName) ?? null;
}

/**
 * Create a Vectorize index via wrangler
 */
async function createIndexViaWrangler(
	indexName: string,
	dimensions: number,
	metric: VectorizeMetric,
): Promise<{ created: boolean }> {
	// Check if index already exists
	const existing = await findExistingIndex(indexName);
	if (existing) {
		return { created: false };
	}

	const result =
		await $`wrangler vectorize create ${indexName} --dimensions=${dimensions} --metric=${metric}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to create Vectorize index ${indexName}`);
	}

	return { created: true };
}

/**
 * Create a Vectorize index for the current project.
 *
 * Uses wrangler vectorize create to create the index, then updates
 * wrangler.jsonc with the new binding.
 */
export async function createVectorizeIndex(
	projectDir: string,
	options: CreateVectorizeOptions = {},
): Promise<CreateVectorizeResult> {
	// Get project name from wrangler config
	const projectName = await getProjectNameFromDir(projectDir);

	// Get existing Vectorize bindings to determine naming
	const wranglerPath = join(projectDir, "wrangler.jsonc");
	const existingBindings = await getExistingVectorizeBindings(wranglerPath);
	const existingCount = existingBindings.length;

	// Determine index name
	const indexName = options.name ?? generateIndexName(projectName, existingCount);

	// Determine binding name
	const isFirst = existingCount === 0;
	const bindingName = toBindingName(indexName, isFirst);

	// Check if binding name already exists
	const bindingExists = existingBindings.some((b) => b.binding === bindingName);
	if (bindingExists) {
		throw new Error(`Binding "${bindingName}" already exists. Choose a different index name.`);
	}

	// Use omakase defaults: 768 dimensions (for bge-base-en-v1.5), cosine metric
	const dimensions = options.dimensions ?? 768;
	const metric = options.metric ?? "cosine";

	// Create via wrangler
	const result = await createIndexViaWrangler(indexName, dimensions, metric);

	// Update wrangler.jsonc with the new binding
	await addVectorizeBinding(wranglerPath, {
		binding: bindingName,
		index_name: indexName,
	});

	return {
		indexName,
		bindingName,
		dimensions,
		metric,
		created: result.created,
	};
}

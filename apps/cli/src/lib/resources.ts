/**
 * Resource types and utilities for Jack CLI
 *
 * Resources are fetched on-demand from control plane (managed)
 * or parsed from wrangler.jsonc (BYO).
 */

import { parseJsonc } from "./jsonc.ts";
import { findWranglerConfig } from "./wrangler-config.ts";

// Resource types matching control plane schema
export type ResourceType =
	| "worker"
	| "d1"
	| "r2_content"
	| "kv"
	| "queue"
	| "ai"
	| "hyperdrive"
	| "vectorize";

// Resource from control plane API
export interface ControlPlaneResource {
	id: string;
	project_id: string;
	resource_type: ResourceType;
	resource_name: string;
	provider_id: string;
	status: "active" | "provisioning" | "error" | "deleted";
	metadata?: Record<string, unknown>;
	created_at: string;
}

// Unified resource view (used by CLI)
export interface ResolvedResources {
	d1?: { binding: string; name: string; id?: string };
	ai?: { binding: string };
	assets?: { binding: string; directory: string };
	kv?: Array<{ binding: string; id: string; name?: string }>;
	r2?: Array<{ binding: string; name: string }>;
	queues?: Array<{ binding: string; name: string }>;
	vars?: Record<string, string>;
}

/**
 * Convert control plane resources to unified format
 */
export function convertControlPlaneResources(resources: ControlPlaneResource[]): ResolvedResources {
	const result: ResolvedResources = {};

	for (const r of resources) {
		switch (r.resource_type) {
			case "d1":
				result.d1 = {
					binding: "DB",
					name: r.resource_name,
					id: r.provider_id,
				};
				break;
			case "kv":
				result.kv = result.kv || [];
				result.kv.push({
					binding: r.resource_name.toUpperCase().replace(/-/g, "_"),
					id: r.provider_id,
					name: r.resource_name,
				});
				break;
			case "r2_content":
				result.r2 = result.r2 || [];
				result.r2.push({
					binding: "BUCKET",
					name: r.resource_name,
				});
				break;
			// AI doesn't need provider_id, just indicates it's available
			case "ai":
				result.ai = { binding: "AI" };
				break;
		}
	}

	return result;
}

/**
 * Parse resources from wrangler.jsonc for BYO projects.
 * Returns a unified resource view.
 */
export async function parseWranglerResources(projectPath: string): Promise<ResolvedResources> {
	const wranglerPath = findWranglerConfig(projectPath);

	if (!wranglerPath) {
		return {} as ResolvedResources;
	}

	try {
		// Read and parse JSONC (strip comments)
		const content = await Bun.file(wranglerPath).text();
		const config = parseJsonc<WranglerConfig>(content);

		const resources: ResolvedResources = {};

		// D1 databases
		if (config.d1_databases?.[0]) {
			const d1 = config.d1_databases[0];
			resources.d1 = {
				binding: d1.binding || "DB",
				name: d1.database_name || d1.binding || "DB",
				id: d1.database_id,
			};
		}

		// AI binding
		if (config.ai) {
			resources.ai = {
				binding: config.ai.binding || "AI",
			};
		}

		// Assets
		if (config.assets?.directory) {
			resources.assets = {
				binding: config.assets.binding || "ASSETS",
				directory: config.assets.directory,
			};
		}

		// KV namespaces
		if (config.kv_namespaces && config.kv_namespaces.length > 0) {
			resources.kv = config.kv_namespaces.map((kv) => ({
				binding: kv.binding,
				id: kv.id,
			}));
		}

		// R2 buckets
		if (config.r2_buckets && config.r2_buckets.length > 0) {
			resources.r2 = config.r2_buckets.map((r2) => ({
				binding: r2.binding,
				name: r2.bucket_name,
			}));
		}

		// Queues
		if (config.queues?.producers && config.queues.producers.length > 0) {
			resources.queues = config.queues.producers.map((q) => ({
				binding: q.binding,
				name: q.queue,
			}));
		}

		// Environment variables (vars)
		if (config.vars && Object.keys(config.vars).length > 0) {
			resources.vars = config.vars;
		}

		return resources;
	} catch {
		// Failed to parse, return empty
		return {};
	}
}

/**
 * Wrangler config shape (partial, for resource parsing)
 */
interface WranglerConfig {
	d1_databases?: Array<{
		binding: string;
		database_name?: string;
		database_id?: string;
	}>;
	ai?: {
		binding?: string;
	};
	assets?: {
		binding?: string;
		directory: string;
	};
	kv_namespaces?: Array<{
		binding: string;
		id: string;
	}>;
	r2_buckets?: Array<{
		binding: string;
		bucket_name: string;
	}>;
	queues?: {
		producers?: Array<{
			binding: string;
			queue: string;
		}>;
	};
	vars?: Record<string, string>;
}

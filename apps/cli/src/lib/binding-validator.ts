/**
 * Binding validator for jack cloud managed deployments.
 *
 * Validates that project bindings are supported by jack cloud and
 * that required resources (like assets directories) exist.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WranglerConfig } from "./build-helper.ts";

/**
 * Bindings supported by jack cloud managed deployments.
 */
export const SUPPORTED_BINDINGS = ["d1_databases", "ai", "assets", "vars"] as const;

/**
 * Bindings not yet supported by jack cloud.
 * These will cause validation errors if present in wrangler config.
 */
export const UNSUPPORTED_BINDINGS = [
	"kv_namespaces",
	"durable_objects",
	"queues",
	"services",
	"r2_buckets",
	"hyperdrive",
	"vectorize",
	"browser",
	"mtls_certificates",
] as const;

/**
 * Human-readable names for unsupported bindings.
 */
const BINDING_DISPLAY_NAMES: Record<string, string> = {
	kv_namespaces: "KV Namespaces",
	durable_objects: "Durable Objects",
	queues: "Queues",
	services: "Service Bindings",
	r2_buckets: "R2 Buckets",
	hyperdrive: "Hyperdrive",
	vectorize: "Vectorize",
	browser: "Browser Rendering",
	mtls_certificates: "mTLS Certificates",
};

export interface BindingValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validates that a wrangler config only uses supported bindings.
 *
 * @param config - Parsed wrangler configuration
 * @param projectPath - Absolute path to project directory (for assets validation)
 * @returns Validation result with errors if invalid
 */
export function validateBindings(
	config: WranglerConfig,
	projectPath: string,
): BindingValidationResult {
	const errors: string[] = [];

	// Check for unsupported bindings
	for (const binding of UNSUPPORTED_BINDINGS) {
		const value = config[binding as keyof WranglerConfig];
		if (value !== undefined && value !== null) {
			const displayName = BINDING_DISPLAY_NAMES[binding] || binding;
			// Special message for R2 - suggest using Workers Assets instead
			if (binding === "r2_buckets") {
				errors.push(
					`✗ R2 buckets not supported in managed deploy.\n  For static files, use Workers Assets instead (assets.directory in wrangler.jsonc).\n  Fix: Replace r2_buckets with assets config, or use 'wrangler deploy' for full control.`,
				);
			} else {
				errors.push(
					`✗ ${displayName} not supported in managed deploy.\n  Managed deploy supports: D1, AI, Assets, vars.\n  Fix: Remove ${binding} from wrangler.jsonc, or use 'wrangler deploy' for full control.`,
				);
			}
		}
	}

	// Validate assets directory if configured
	const assetsValidation = validateAssetsDirectory(config, projectPath);
	if (!assetsValidation.valid) {
		errors.push(...assetsValidation.errors);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validates that the assets directory exists and is not empty.
 *
 * @param config - Parsed wrangler configuration
 * @param projectPath - Absolute path to project directory
 * @returns Validation result with errors if invalid
 */
export function validateAssetsDirectory(
	config: WranglerConfig,
	projectPath: string,
): BindingValidationResult {
	const errors: string[] = [];

	if (config.assets?.directory) {
		const assetsDir = config.assets.directory;
		const assetsPath = join(projectPath, assetsDir);

		if (!existsSync(assetsPath)) {
			errors.push(
				`✗ Assets directory not found: ${assetsDir}\n  The assets.directory specified in wrangler.jsonc does not exist.\n  Fix: Run your build command first, or update assets.directory in wrangler.jsonc.`,
			);
		} else {
			// Check if directory is empty
			try {
				const files = readdirSync(assetsPath);
				if (files.length === 0) {
					errors.push(
						`✗ Assets directory is empty: ${assetsDir}\n  No files found in the assets directory.\n  Fix: Run your build command to generate assets.`,
					);
				}
			} catch {
				// If we can't read the directory, the deploy will fail anyway
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

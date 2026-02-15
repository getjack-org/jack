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
export const SUPPORTED_BINDINGS = [
	"d1_databases",
	"ai",
	"assets",
	"vars",
	"r2_buckets",
	"kv_namespaces",
	"vectorize",
	"durable_objects",
] as const;

/**
 * Bindings not yet supported by jack cloud.
 * These will cause validation errors if present in wrangler config.
 */
export const UNSUPPORTED_BINDINGS = [
	"queues",
	"services",
	"hyperdrive",
	"browser",
	"mtls_certificates",
] as const;

/**
 * Human-readable names for unsupported bindings.
 */
const BINDING_DISPLAY_NAMES: Record<string, string> = {
	queues: "Queues",
	services: "Service Bindings",
	hyperdrive: "Hyperdrive",
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
			errors.push(
				`✗ ${displayName} not supported in managed deploy.\n  Managed deploy supports: D1, AI, Assets, R2, KV, Vectorize, Durable Objects, vars.\n  Fix: Remove ${binding} from wrangler.jsonc, or use 'wrangler deploy' for full control.`,
			);
		}
	}

	// Validate Durable Object constraints
	if (config.durable_objects?.bindings?.length) {
		const doBindings = config.durable_objects.bindings;

		// Max 3 DO classes per project (free tier)
		if (doBindings.length > 3) {
			errors.push(
				`✗ Too many Durable Object classes (${doBindings.length}).\n  Free tier allows max 3 DO classes per project.\n  Fix: Remove unused DO classes from wrangler.jsonc.`,
			);
		}

		// Require nodejs_compat flag
		const flags = config.compatibility_flags ?? [];
		if (!flags.includes("nodejs_compat")) {
			errors.push(
				`✗ Durable Objects require nodejs_compat flag.\n  Fix: Add "nodejs_compat" to compatibility_flags in wrangler.jsonc.`,
			);
		}

		// Require migrations
		if (!config.migrations?.length) {
			errors.push(
				`✗ Durable Object classes require migrations.\n  Fix: Add a migrations section to wrangler.jsonc with new_sqlite_classes.`,
			);
		}

		// Only allow new_sqlite_classes (not legacy new_classes)
		if (config.migrations?.length) {
			for (const migration of config.migrations) {
				if ((migration as any).new_classes?.length) {
					errors.push(
						`✗ Only new_sqlite_classes migrations are supported.\n  Fix: Replace new_classes with new_sqlite_classes in wrangler.jsonc.`,
					);
				}
			}
		}

		// Reject __JACK_ prefixed binding or class names
		for (const dob of doBindings) {
			if (dob.name.startsWith("__JACK_")) {
				errors.push(
					`✗ Binding name "${dob.name}" uses reserved __JACK_ prefix.\n  Fix: Use a different binding name.`,
				);
			}
			if (dob.class_name.startsWith("__JACK_")) {
				errors.push(
					`✗ Class name "${dob.class_name}" uses reserved __JACK_ prefix.\n  Fix: Use a different class name.`,
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

#!/usr/bin/env bun
/**
 * Test the actual sanitizeWranglerConfig implementation
 */

import { parseJsonc } from "../apps/cli/src/lib/jsonc.ts";

// Import would require exporting the function, so we copy the ACTUAL current implementation
// This should match apps/cli/src/templates/index.ts exactly
function sanitizeWranglerConfig(content: string, filename: string): string {
	// Only handle JSON/JSONC files
	if (!filename.endsWith(".json") && !filename.endsWith(".jsonc")) {
		return content;
	}

	try {
		const config = parseJsonc(content);

		// D1: strip database_id
		if (Array.isArray(config.d1_databases)) {
			for (const db of config.d1_databases) {
				if (db && typeof db === "object" && "database_id" in db) {
					delete db.database_id;
				}
			}
		}

		// KV: strip id
		if (Array.isArray(config.kv_namespaces)) {
			for (const kv of config.kv_namespaces) {
				if (kv && typeof kv === "object" && "id" in kv) {
					delete kv.id;
				}
			}
		}

		// Re-serialize with formatting
		return JSON.stringify(config, null, "\t");
	} catch {
		// If parsing fails, return original content
		return content;
	}
}

console.log("=== Testing Actual Sanitizer Implementation ===\n");

const tests = [
	{
		name: "D1 database_id stripped",
		input: `{"d1_databases":[{"binding":"DB","database_name":"test","database_id":"abc-123"}]}`,
		check: (r: string) => !r.includes("database_id") && r.includes("database_name"),
	},
	{
		name: "KV id stripped",
		input: `{"kv_namespaces":[{"binding":"CACHE","id":"kv-456"}]}`,
		check: (r: string) => !r.includes("kv-456") && r.includes("binding"),
	},
	{
		name: "R2 bucket_name preserved",
		input: `{"r2_buckets":[{"binding":"STORAGE","bucket_name":"my-bucket"}]}`,
		check: (r: string) => r.includes("my-bucket"),
	},
	{
		name: "Mixed bindings",
		input: `{
			"d1_databases":[{"binding":"DB","database_id":"d1-id","database_name":"mydb"}],
			"kv_namespaces":[{"binding":"KV","id":"kv-id"}],
			"r2_buckets":[{"binding":"R2","bucket_name":"bucket"}]
		}`,
		check: (r: string) =>
			!r.includes("d1-id") &&
			!r.includes("kv-id") &&
			r.includes("bucket") &&
			r.includes("mydb"),
	},
	{
		name: "Non-JSON file unchanged",
		input: `name = "test"`,
		filename: "wrangler.toml",
		check: (r: string) => r === `name = "test"`,
	},
];

let passed = 0;
let failed = 0;

for (const test of tests) {
	const filename = test.filename || "wrangler.jsonc";
	const result = sanitizeWranglerConfig(test.input, filename);
	const ok = test.check(result);

	if (ok) {
		console.log(`✓ ${test.name}`);
		passed++;
	} else {
		console.log(`✗ ${test.name}`);
		console.log(`  Input:  ${test.input.slice(0, 80)}...`);
		console.log(`  Output: ${result.slice(0, 80)}...`);
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env bun
/**
 * Test script to verify wrangler config sanitization
 */

import { parseJsonc } from "../apps/cli/src/lib/jsonc.ts";

// Simulate the sanitizeWranglerConfig function
function sanitizeWranglerConfig(content: string, filename: string): string {
	if (!filename.endsWith(".json") && !filename.endsWith(".jsonc")) {
		if (filename.endsWith(".toml")) {
			return content.replace(/^\s*database_id\s*=\s*"[^"]*"\s*$/gm, "");
		}
		return content;
	}

	try {
		const config = parseJsonc(content);

		if (Array.isArray(config.d1_databases)) {
			for (const db of config.d1_databases) {
				if (db && typeof db === "object" && "database_id" in db) {
					delete db.database_id;
				}
			}
		}

		return JSON.stringify(config, null, "\t");
	} catch {
		return content;
	}
}

// Test cases
const testCases = [
	{
		name: "JSONC with database_id",
		filename: "wrangler.jsonc",
		input: `{
	"name": "my-app",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db",
			"database_id": "abc-123-original-author-id"
		}
	]
}`,
		expectNoDbId: true,
	},
	{
		name: "JSONC without database_id",
		filename: "wrangler.jsonc",
		input: `{
	"name": "my-app",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db"
		}
	]
}`,
		expectNoDbId: true,
	},
	{
		name: "JSONC with no D1",
		filename: "wrangler.jsonc",
		input: `{
	"name": "my-app",
	"main": "src/index.ts"
}`,
		expectNoDbId: true,
	},
	{
		name: "TOML with database_id",
		filename: "wrangler.toml",
		input: `name = "my-app"

[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "abc-123-original-author-id"
`,
		expectNoDbId: true,
	},
];

console.log("=== Wrangler Config Sanitization Tests ===\n");

let passed = 0;
let failed = 0;

for (const test of testCases) {
	console.log(`Test: ${test.name}`);

	const result = sanitizeWranglerConfig(test.input, test.filename);

	// Check if database_id is removed
	const hasDbId = result.includes("database_id");

	if (test.expectNoDbId && hasDbId) {
		console.log("  ✗ FAILED - database_id still present");
		console.log("  Output:", result.slice(0, 200));
		failed++;
	} else if (!test.expectNoDbId && !hasDbId) {
		console.log("  ✗ FAILED - database_id was removed but shouldn't be");
		failed++;
	} else {
		console.log("  ✓ PASSED");
		passed++;
	}
	console.log("");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

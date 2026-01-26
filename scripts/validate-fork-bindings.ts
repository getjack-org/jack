#!/usr/bin/env bun
/**
 * Validation tests for fork binding sanitization - FOCUSED VERSION
 *
 * Only tests D1, KV, R2 (the actual supported binding types)
 *
 * Run: bun scripts/validate-fork-bindings.ts
 */

import { parseJsonc } from "../apps/cli/src/lib/jsonc.ts";

console.log("=== Fork Binding Sanitization Validation ===\n");
console.log("Supported bindings: D1, KV, R2\n");

// =============================================================================
// CURRENT IMPLEMENTATION TEST
// =============================================================================
console.log("=== TEST 1: Current Implementation (D1 only) ===\n");

// This is the ACTUAL current implementation from templates/index.ts
function currentSanitizer(content: string, filename: string): string {
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

const currentTests = [
	{
		name: "D1 database_id stripped",
		input: `{"d1_databases":[{"binding":"DB","database_name":"test","database_id":"abc-123"}]}`,
		check: (result: string) => !result.includes("database_id"),
	},
	{
		name: "KV id NOT stripped (current impl ignores KV)",
		input: `{"kv_namespaces":[{"binding":"CACHE","id":"kv-456"}]}`,
		check: (result: string) => result.includes("kv-456"), // Current impl doesn't strip KV
	},
];

for (const test of currentTests) {
	const result = currentSanitizer(test.input, "wrangler.jsonc");
	const passed = test.check(result);
	console.log(`${passed ? "✓" : "✗"} ${test.name}`);
	if (!passed) console.log(`  Result: ${result}`);
}

// =============================================================================
// WHAT NEEDS TO BE SANITIZED
// =============================================================================
console.log("\n=== Binding Types & What Needs Sanitization ===\n");

const bindingAnalysis = [
	{
		type: "d1_databases",
		providerField: "database_id",
		keepFields: ["binding", "database_name", "migrations_dir"],
		note: "database_id is author's DB. Strip it → wrangler creates new DB for forker",
	},
	{
		type: "kv_namespaces",
		providerField: "id",
		keepFields: ["binding"],
		note: "id is author's KV namespace. Strip it → wrangler creates new namespace",
	},
	{
		type: "r2_buckets",
		providerField: null,
		keepFields: ["binding", "bucket_name"],
		note: "bucket_name is just a name (can be template placeholder). No provider ID to strip",
	},
];

for (const binding of bindingAnalysis) {
	console.log(`${binding.type}:`);
	console.log(`  Strip: ${binding.providerField || "(nothing)"}`);
	console.log(`  Keep:  ${binding.keepFields.join(", ")}`);
	console.log(`  Note:  ${binding.note}\n`);
}

// =============================================================================
// PROPOSED IMPLEMENTATION TEST
// =============================================================================
console.log("=== TEST 2: Proposed Implementation (D1 + KV) ===\n");

const BINDING_SANITIZERS = {
	d1_databases: { stripFields: ["database_id"] },
	kv_namespaces: { stripFields: ["id"] },
	// r2_buckets has no provider ID to strip
};

function proposedSanitizer(content: string, filename: string): string {
	if (!filename.endsWith(".json") && !filename.endsWith(".jsonc")) {
		if (filename.endsWith(".toml")) {
			// TOML: strip all known provider fields
			let result = content;
			result = result.replace(/^\s*database_id\s*=\s*["'][^"']*["']\s*$/gm, "");
			result = result.replace(/^\s*id\s*=\s*["'][^"']*["']\s*$/gm, "");
			return result;
		}
		return content;
	}

	try {
		const config = parseJsonc(content);

		for (const [bindingKey, sanitizer] of Object.entries(BINDING_SANITIZERS)) {
			if (Array.isArray(config[bindingKey])) {
				for (const binding of config[bindingKey]) {
					for (const field of sanitizer.stripFields) {
						delete binding[field];
					}
				}
			}
		}

		return JSON.stringify(config, null, "\t");
	} catch {
		return content;
	}
}

const proposedTests = [
	{
		name: "D1 database_id stripped",
		input: `{"d1_databases":[{"binding":"DB","database_name":"test","database_id":"abc-123"}]}`,
		check: (result: string) => !result.includes("database_id") && result.includes("database_name"),
	},
	{
		name: "KV id stripped",
		input: `{"kv_namespaces":[{"binding":"CACHE","id":"kv-456"}]}`,
		check: (result: string) => !result.includes("kv-456") && result.includes("binding"),
	},
	{
		name: "R2 bucket_name preserved",
		input: `{"r2_buckets":[{"binding":"STORAGE","bucket_name":"my-bucket"}]}`,
		check: (result: string) => result.includes("my-bucket"),
	},
	{
		name: "Mixed bindings all sanitized correctly",
		input: `{
			"d1_databases":[{"binding":"DB","database_id":"d1-id"}],
			"kv_namespaces":[{"binding":"KV","id":"kv-id"}],
			"r2_buckets":[{"binding":"R2","bucket_name":"bucket"}]
		}`,
		check: (result: string) =>
			!result.includes("d1-id") && !result.includes("kv-id") && result.includes("bucket"),
	},
];

let passed = 0;
let failed = 0;

for (const test of proposedTests) {
	const result = proposedSanitizer(test.input, "wrangler.jsonc");
	const ok = test.check(result);
	console.log(`${ok ? "✓" : "✗"} ${test.name}`);
	if (!ok) {
		console.log(`  Result: ${result}`);
		failed++;
	} else {
		passed++;
	}
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

// =============================================================================
// COMMAND SCENARIOS TO VALIDATE
// =============================================================================
console.log("=== COMMAND SCENARIOS TO VALIDATE ===\n");

const scenarios = [
	{
		name: "Scenario 1: Fork template with D1",
		setup: "Have a published template with database_id in wrangler.jsonc",
		commands: [
			"jack new test-fork -t username/template-with-d1",
			"cat test-fork/wrangler.jsonc  # verify no database_id",
			"cd test-fork && jack ship     # should create new DB",
		],
		expected: "Deploy creates NEW database for forker, not uses author's",
		validates: "D1 sanitization works end-to-end",
	},
	{
		name: "Scenario 2: Fork template with KV",
		setup: "Have a published template with KV namespace id",
		commands: [
			"jack new test-kv -t username/template-with-kv",
			"cat test-kv/wrangler.jsonc  # verify no id in kv_namespaces",
			"cd test-kv && jack ship",
		],
		expected: "Deploy creates NEW KV namespace for forker",
		validates: "KV sanitization works (CURRENTLY NOT IMPLEMENTED)",
	},
	{
		name: "Scenario 3: Fork template with R2",
		setup: "Have a published template with R2 bucket using jack-template placeholder",
		commands: [
			"jack new test-r2 -t username/template-with-r2",
			"cat test-r2/wrangler.jsonc  # verify bucket_name replaced with project name",
		],
		expected: "bucket_name goes from jack-template-storage → test-r2-storage",
		validates: "R2 placeholder replacement (handled by renderTemplate, not sanitizer)",
	},
	{
		name: "Scenario 4: Wrangler auto-provisioning behavior",
		setup: "Create wrangler.jsonc with D1 binding but NO database_id",
		commands: [
			'echo \'{"d1_databases":[{"binding":"DB","database_name":"test-db"}]}\' > wrangler.jsonc',
			"wrangler deploy",
		],
		expected: "Wrangler should auto-create database OR fail with clear error",
		validates: "Core assumption: wrangler auto-provisions missing resources",
	},
];

for (const scenario of scenarios) {
	console.log(`📋 ${scenario.name}`);
	console.log(`   Setup: ${scenario.setup}`);
	console.log(`   Commands:`);
	for (const cmd of scenario.commands) {
		console.log(`     $ ${cmd}`);
	}
	console.log(`   Expected: ${scenario.expected}`);
	console.log(`   Validates: ${scenario.validates}\n`);
}

// =============================================================================
// GAP ANALYSIS
// =============================================================================
console.log("=== GAP ANALYSIS ===\n");

console.log("Current implementation gaps:");
console.log("  ✗ KV namespace 'id' is NOT stripped during fork");
console.log("  ✗ TOML edge cases (comments, inline tables) not handled");
console.log("");
console.log("Questions to resolve:");
console.log("  ? Does wrangler auto-provision D1 when database_id is missing?");
console.log("  ? Does wrangler auto-provision KV when id is missing?");
console.log("  ? What happens if forker deploys with author's IDs? (permission error?)");

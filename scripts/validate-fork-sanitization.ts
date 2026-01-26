#!/usr/bin/env bun
/**
 * Validation tests for fork binding sanitization
 *
 * These tests validate the assumptions in the plan:
 * docs/internal/plans/fork-binding-sanitization.md
 *
 * Run: bun scripts/validate-fork-sanitization.ts
 */

import { parseJsonc } from "../apps/cli/src/lib/jsonc.ts";

// =============================================================================
// TEST 1: Verify wrangler auto-provisions D1 when database_id is missing
// =============================================================================
console.log("=== TEST 1: D1 Auto-Provisioning Assumption ===\n");
console.log("MANUAL TEST REQUIRED:");
console.log("1. Create wrangler.jsonc with D1 binding but NO database_id:");
console.log(`   {
     "d1_databases": [{
       "binding": "DB",
       "database_name": "test-auto-provision"
     }]
   }`);
console.log("2. Run: wrangler deploy");
console.log("3. Expected: wrangler creates new D1 database");
console.log("4. Actual: ???\n");
console.log("If wrangler FAILS or PROMPTS, our assumption is WRONG.\n");

// =============================================================================
// TEST 2: TOML sanitization edge cases
// =============================================================================
console.log("=== TEST 2: TOML Sanitization Edge Cases ===\n");

const tomlSanitizer = (content: string): string => {
	// Current implementation from plan
	const allStripFields = ["database_id", "id", "queue_id", "namespace_id", "index_id"];
	let result = content;
	for (const field of allStripFields) {
		result = result.replace(new RegExp(`^\\s*${field}\\s*=\\s*["'][^"']*["']\\s*$`, "gm"), "");
	}
	return result;
};

const tomlTestCases = [
	{
		name: "Standard double-quoted",
		input: `database_id = "abc-123"`,
		expectStripped: true,
	},
	{
		name: "Single-quoted value",
		input: `database_id = 'abc-123'`,
		expectStripped: true, // Plan's regex handles this
	},
	{
		name: "Trailing comment",
		input: `database_id = "abc-123" # author's db`,
		expectStripped: true, // WILL THIS WORK?
	},
	{
		name: "Inline table (TOML syntax)",
		input: `d1_databases = [{ binding = "DB", database_id = "abc" }]`,
		expectStripped: true, // WILL THIS WORK?
	},
	{
		name: "Multi-line with indentation",
		input: `[[d1_databases]]
binding = "DB"
    database_id = "abc-123"
database_name = "test"`,
		expectStripped: true,
	},
];

let tomlPassed = 0;
let tomlFailed = 0;

for (const test of tomlTestCases) {
	const result = tomlSanitizer(test.input);
	const hasDbId = result.includes("database_id");
	const passed = test.expectStripped ? !hasDbId : hasDbId;

	if (passed) {
		console.log(`✓ ${test.name}`);
		tomlPassed++;
	} else {
		console.log(`✗ ${test.name}`);
		console.log(`  Input:  ${test.input.slice(0, 60)}...`);
		console.log(`  Output: ${result.slice(0, 60)}...`);
		console.log(`  Expected database_id stripped: ${test.expectStripped}`);
		tomlFailed++;
	}
}

console.log(`\nTOML: ${tomlPassed} passed, ${tomlFailed} failed\n`);

// =============================================================================
// TEST 3: JSONC sanitization for all binding types
// =============================================================================
console.log("=== TEST 3: JSONC Sanitization - All Binding Types ===\n");

// Simulate the registry-based sanitizer from the plan
const BINDING_SANITIZERS: Record<string, { stripFields: string[] }> = {
	d1_databases: { stripFields: ["database_id"] },
	kv_namespaces: { stripFields: ["id"] },
	r2_buckets: { stripFields: [] }, // Plan says nothing to strip
	queues: { stripFields: ["queue_id"] },
	durable_objects: { stripFields: ["namespace_id"] },
	vectorize: { stripFields: ["index_id"] },
};

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
	const result = { ...config };
	for (const [bindingKey, sanitizer] of Object.entries(BINDING_SANITIZERS)) {
		if (Array.isArray(result[bindingKey])) {
			result[bindingKey] = (result[bindingKey] as Record<string, unknown>[]).map((binding) => {
				const cleaned = { ...binding };
				for (const field of sanitizer.stripFields) {
					delete cleaned[field];
				}
				return cleaned;
			});
		}
	}
	return result;
}

const jsoncTestCases = [
	{
		name: "D1 with database_id",
		input: { d1_databases: [{ binding: "DB", database_name: "test", database_id: "abc-123" }] },
		expectFields: { d1_databases: [{ binding: "DB", database_name: "test" }] },
	},
	{
		name: "KV with id",
		input: { kv_namespaces: [{ binding: "CACHE", id: "def-456" }] },
		expectFields: { kv_namespaces: [{ binding: "CACHE" }] },
	},
	{
		name: "R2 bucket (nothing stripped)",
		input: { r2_buckets: [{ binding: "STORAGE", bucket_name: "my-bucket" }] },
		expectFields: { r2_buckets: [{ binding: "STORAGE", bucket_name: "my-bucket" }] },
	},
	{
		name: "Queue with queue_id",
		input: {
			queues: { producers: [{ binding: "QUEUE", queue_name: "my-queue", queue_id: "q-123" }] },
		},
		// NOTE: queues.producers is nested - does our sanitizer handle this?
		expectFields: { queues: { producers: [{ binding: "QUEUE", queue_name: "my-queue" }] } },
	},
	{
		name: "Multiple bindings mixed",
		input: {
			d1_databases: [{ binding: "DB", database_id: "abc" }],
			kv_namespaces: [{ binding: "KV", id: "def" }],
			r2_buckets: [{ binding: "R2", bucket_name: "bucket" }],
		},
		expectFields: {
			d1_databases: [{ binding: "DB" }],
			kv_namespaces: [{ binding: "KV" }],
			r2_buckets: [{ binding: "R2", bucket_name: "bucket" }],
		},
	},
];

let jsoncPassed = 0;
let jsoncFailed = 0;

for (const test of jsoncTestCases) {
	const result = sanitizeConfig(test.input);
	const match = JSON.stringify(result) === JSON.stringify(test.expectFields);

	if (match) {
		console.log(`✓ ${test.name}`);
		jsoncPassed++;
	} else {
		console.log(`✗ ${test.name}`);
		console.log(`  Expected: ${JSON.stringify(test.expectFields)}`);
		console.log(`  Got:      ${JSON.stringify(result)}`);
		jsoncFailed++;
	}
}

console.log(`\nJSONC: ${jsoncPassed} passed, ${jsoncFailed} failed\n`);

// =============================================================================
// TEST 4: Unknown binding types (future-proofing)
// =============================================================================
console.log("=== TEST 4: Unknown Binding Types ===\n");

const configWithUnknown = {
	d1_databases: [{ binding: "DB", database_id: "abc" }],
	future_binding_type: [{ binding: "FUTURE", some_id: "xyz-789" }],
};

const sanitizedUnknown = sanitizeConfig(configWithUnknown);

if (
	(sanitizedUnknown.future_binding_type as Array<{ some_id?: string }>)?.[0]?.some_id === "xyz-789"
) {
	console.log("⚠ Unknown binding types are NOT sanitized (passed through as-is)");
	console.log("  This is expected behavior but could leak IDs for new binding types");
} else {
	console.log("✓ Unknown binding types are handled");
}

// =============================================================================
// TEST 5: Real-world template analysis
// =============================================================================
console.log("\n=== TEST 5: What binding types exist in real templates? ===\n");
console.log("MANUAL INVESTIGATION NEEDED:");
console.log("1. Check published templates for which binding types are actually used");
console.log("2. Focus sanitization efforts on types that actually appear");
console.log("");
console.log("Suggested command:");
console.log("  bun scripts/test-fork-db-flow.ts <username>/<project>");
console.log("");

// =============================================================================
// SUMMARY
// =============================================================================
console.log("=== VALIDATION SUMMARY ===\n");

const issues: string[] = [];

if (tomlFailed > 0) {
	issues.push(`TOML sanitization has ${tomlFailed} failing edge cases`);
}

if (jsoncFailed > 0) {
	issues.push(`JSONC sanitization has ${jsoncFailed} failing cases`);
}

// Check for nested structure handling
const queueTest = jsoncTestCases.find((t) => t.name.includes("Queue"));
if (queueTest) {
	const result = sanitizeConfig(queueTest.input);
	const hasNestedId = JSON.stringify(result).includes("queue_id");
	if (hasNestedId) {
		issues.push("Queues use nested structure (queues.producers[]) - sanitizer doesn't handle this");
	}
}

if (issues.length === 0) {
	console.log("✓ All automated tests passed");
} else {
	console.log("Issues found:");
	for (const issue of issues) {
		console.log(`  ✗ ${issue}`);
	}
}

console.log("\nManual validation still required:");
console.log("  1. Verify wrangler auto-provisions D1 without database_id");
console.log("  2. Test full fork flow: jack new -t <template> && jack deploy");
console.log("  3. Verify forked project can write to its own database");

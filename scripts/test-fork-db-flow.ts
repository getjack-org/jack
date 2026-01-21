#!/usr/bin/env bun
/**
 * Test script to validate the fork flow with databases
 *
 * Tests:
 * 1. Fetch a published template (lennard/template-pwa or similar)
 * 2. Check if wrangler.jsonc has database_id values
 * 3. Simulate what happens during jack new -t ...
 * 4. Identify where DB setup fails
 */

import { getControlApiUrl } from "../apps/cli/src/lib/control-plane.ts";
import { unzipSync } from "fflate";
import { parseJsonc } from "../apps/cli/src/lib/jsonc.ts";

const TEST_TEMPLATE = process.argv[2] || "lennard/template-pwa";

async function main() {
	console.log("=== Fork DB Flow Test ===\n");
	console.log(`Testing template: ${TEST_TEMPLATE}\n`);

	// Step 1: Fetch template source
	console.log("1. Fetching template source...");
	const [username, slug] = TEST_TEMPLATE.split("/");

	const response = await fetch(
		`${getControlApiUrl()}/v1/projects/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/source`,
	);

	if (!response.ok) {
		if (response.status === 404) {
			console.error(`   ✗ Template not found: ${TEST_TEMPLATE}`);
			console.error("   Make sure the project exists and is published");
			process.exit(1);
		}
		console.error(`   ✗ Failed to fetch: ${response.status}`);
		process.exit(1);
	}

	console.log("   ✓ Template fetched");

	// Step 2: Extract and analyze files
	console.log("\n2. Extracting files...");
	const zipData = await response.arrayBuffer();
	const unzipped = unzipSync(new Uint8Array(zipData));

	const files: Record<string, string> = {};
	for (const [path, content] of Object.entries(unzipped)) {
		if (content.length === 0 || path.endsWith("/")) continue;
		files[path] = new TextDecoder().decode(content);
	}

	console.log(`   ✓ Extracted ${Object.keys(files).length} files`);

	// Step 3: Check for wrangler config
	console.log("\n3. Checking wrangler config...");
	const wranglerConfigNames = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
	let wranglerContent: string | null = null;
	let wranglerFileName: string | null = null;

	for (const name of wranglerConfigNames) {
		if (files[name]) {
			wranglerContent = files[name];
			wranglerFileName = name;
			break;
		}
	}

	if (!wranglerContent) {
		console.log("   ⚠ No wrangler config found");
		console.log("   Files:", Object.keys(files).slice(0, 10).join(", "));
		process.exit(0);
	}

	console.log(`   ✓ Found ${wranglerFileName}`);

	// Step 4: Parse and analyze D1 config
	console.log("\n4. Analyzing D1 database config...");
	let config: Record<string, unknown>;

	try {
		if (wranglerFileName?.endsWith(".toml")) {
			console.log("   ⚠ TOML config - manual inspection needed");
			console.log("   Raw content (first 500 chars):");
			console.log(wranglerContent.slice(0, 500));
			process.exit(0);
		}

		config = parseJsonc(wranglerContent);
	} catch (err) {
		console.error(`   ✗ Failed to parse config: ${err}`);
		process.exit(1);
	}

	const d1Databases = config.d1_databases as Array<{
		binding: string;
		database_name?: string;
		database_id?: string;
	}> | undefined;

	if (!d1Databases || d1Databases.length === 0) {
		console.log("   ✓ No D1 databases configured");
		process.exit(0);
	}

	console.log(`   Found ${d1Databases.length} D1 database(s):\n`);

	let hasIssues = false;

	for (const db of d1Databases) {
		console.log(`   Binding: ${db.binding}`);
		console.log(`   database_name: ${db.database_name || "(not set)"}`);
		console.log(`   database_id: ${db.database_id || "(not set)"}`);

		if (db.database_id) {
			console.log("   ⚠ ISSUE: database_id is set!");
			console.log("     This ID belongs to the original author.");
			console.log("     Forking will fail because the new user doesn't own this database.");
			hasIssues = true;
		} else if (db.database_name) {
			console.log("   ✓ No database_id - wrangler will auto-provision");
		}
		console.log("");
	}

	// Step 5: Check for schema.sql
	console.log("5. Checking for schema.sql...");
	if (files["schema.sql"]) {
		console.log("   ✓ schema.sql found");
		console.log("   First 200 chars:");
		console.log(files["schema.sql"].slice(0, 200));
	} else {
		console.log("   ⚠ No schema.sql found");
	}

	// Summary
	console.log("\n=== Summary ===\n");

	if (hasIssues) {
		console.log("❌ FORK WILL LIKELY FAIL");
		console.log("");
		console.log("The template has database_id values that belong to the original author.");
		console.log("When a user forks this template, deploy will fail because they don't");
		console.log("have access to these databases.");
		console.log("");
		console.log("FIX NEEDED:");
		console.log("1. Strip database_id from wrangler config when extracting forked templates");
		console.log("2. Let wrangler auto-provision new databases for the forker");
	} else {
		console.log("✓ Fork should work correctly");
		console.log("");
		console.log("No database_id values found - wrangler will auto-provision");
		console.log("databases for the new user on first deploy.");
	}
}

main().catch(console.error);

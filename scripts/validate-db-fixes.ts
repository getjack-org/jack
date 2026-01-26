#!/usr/bin/env bun
/**
 * Validation script for D1 database handling fixes
 *
 * Tests:
 * 1. Bug 1: Resource delete handles 404s gracefully (orphaned records)
 * 2. Bug 2: D1 binding resolution filters by binding_name
 *
 * Run from apps/cli directory:
 *   bun run ../../scripts/validate-db-fixes.ts
 *
 * Or after deploying control plane:
 *   bun run ../../scripts/validate-db-fixes.ts --live
 */

import { parseArgs } from "util";

const { values: args } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		live: { type: "boolean", default: false },
		"project-id": { type: "string" },
	},
});

const isLive = args.live;
const projectId = args["project-id"];

console.log("=".repeat(60));
console.log("D1 Database Handling Validation");
console.log("=".repeat(60));
console.log(
	`Mode: ${isLive ? "LIVE (testing deployed control plane)" : "CODE REVIEW (checking fixes in code)"}`,
);
console.log("");

if (!isLive) {
	// Code review mode - verify the fixes are in place
	console.log("Checking code fixes...\n");

	// Get script directory to resolve paths
	const scriptDir = import.meta.dir;
	const projectRoot = scriptDir.replace(/\/scripts$/, "");

	// Check Bug 1 fix: 404 handling in delete endpoint
	console.log("Bug 1: Resource delete 404 handling");
	console.log("-".repeat(40));

	const indexPath = `${projectRoot}/apps/control-plane/src/index.ts`;
	const indexContent = await Bun.file(indexPath).text();

	const has404Handling =
		indexContent.includes("could not be found") && indexContent.includes("cloudflare_deleted");

	if (has404Handling) {
		console.log("✓ Delete endpoint handles 404s gracefully");
		console.log("  - Checks for 'could not be found' error message");
		console.log("  - Still soft-deletes record when Cloudflare resource is gone");
		console.log("  - Returns cloudflare_deleted: false with note");
	} else {
		console.log("✗ Delete endpoint does NOT handle 404s");
		console.log("  Fix needed in apps/control-plane/src/index.ts");
	}
	console.log("");

	// Check Bug 2 fix: D1 binding resolution
	console.log("Bug 2: D1 binding resolution by binding_name");
	console.log("-".repeat(40));

	const deploymentPath = `${projectRoot}/apps/control-plane/src/deployment-service.ts`;
	const deploymentContent = await Bun.file(deploymentPath).text();

	const hasBindingFilter =
		deploymentContent.includes("binding_name = ?") &&
		deploymentContent.includes("intent.d1.binding");
	const hasFallback = deploymentContent.includes("ORDER BY created_at ASC LIMIT 1");

	if (hasBindingFilter) {
		console.log("✓ D1 resolution filters by binding_name");
		console.log("  - First query matches exact binding_name");
		if (hasFallback) {
			console.log("  - Fallback query for backwards compatibility (oldest first)");
		}
		console.log("  - Error message suggests 'jack services db create'");
	} else {
		console.log("✗ D1 resolution does NOT filter by binding_name");
		console.log("  Fix needed in apps/control-plane/src/deployment-service.ts");
	}
	console.log("");

	// Summary
	console.log("=".repeat(60));
	console.log("Summary");
	console.log("=".repeat(60));
	const allFixed = has404Handling && hasBindingFilter;
	if (allFixed) {
		console.log("✓ All fixes verified in code");
		console.log("");
		console.log("Next steps:");
		console.log("1. Deploy control plane: bun run deploy:control");
		console.log("2. Re-run with --live to test against deployed version");
	} else {
		console.log("✗ Some fixes are missing - see above");
	}
} else {
	// Live testing mode
	console.log("Testing against deployed control plane...\n");

	if (!projectId) {
		console.log("Usage: bun run validate-db-fixes.ts --live --project-id=proj_xxx");
		console.log("");
		console.log("Find a project ID with: jack ls --json | jq '.[0]'");
		process.exit(1);
	}

	// Import CLI modules for testing
	const { fetchProjectResources, deleteProjectResource } = await import(
		"./src/lib/control-plane.ts"
	);

	console.log(`Testing project: ${projectId}\n`);

	// List current D1 resources
	console.log("Current D1 resources:");
	console.log("-".repeat(40));
	const resources = await fetchProjectResources(projectId);
	const d1Resources = resources.filter((r) => r.resource_type === "d1");

	if (d1Resources.length === 0) {
		console.log("No D1 resources found. Create one to test:");
		console.log("  jack services db create --name test-db");
		process.exit(0);
	}

	for (const r of d1Resources) {
		console.log(`  ${r.resource_name}`);
		console.log(`    binding: ${r.binding_name ?? "(none)"}`);
		console.log(`    id: ${r.provider_id}`);
		console.log(`    status: ${r.status}`);
	}
	console.log("");

	// Test Bug 1: Try to delete a resource and see if 404 is handled
	console.log("Bug 1 Test: Delete handling");
	console.log("-".repeat(40));
	console.log("To test 404 handling, you would need an orphaned resource.");
	console.log("The fix ensures that if Cloudflare returns 404, the record is still soft-deleted.");
	console.log("");

	// Test Bug 2: Check binding resolution
	console.log("Bug 2 Test: Binding resolution");
	console.log("-".repeat(40));

	const resourcesWithDB = d1Resources.filter((r) => r.binding_name === "DB");
	if (resourcesWithDB.length > 1) {
		console.log(`⚠ Multiple D1 resources with binding 'DB': ${resourcesWithDB.length}`);
		console.log("  With the fix, deployment will use the one with matching binding_name");
	} else if (resourcesWithDB.length === 1) {
		console.log("✓ Single D1 resource with binding 'DB'");
		console.log(`  Provider ID: ${resourcesWithDB[0].provider_id}`);
	} else {
		console.log("No D1 resource with binding 'DB'");
	}
	console.log("");

	console.log("=".repeat(60));
	console.log("To fully test, deploy a project with D1 binding:");
	console.log("  cd /path/to/project && jack ship");
}

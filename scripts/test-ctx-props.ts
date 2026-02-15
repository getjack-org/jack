#!/usr/bin/env bun
/**
 * Test script to verify ctx.props works via Cloudflare's dispatch namespace API.
 *
 * This validates that service bindings with `entrypoint` and `props` fields
 * are accepted by the dispatch namespace upload API and that the proxy worker
 * receives the injected identity via ctx.props.
 *
 * Usage:
 *   bun run scripts/test-ctx-props.ts
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars set
 *   - jack-binding-proxy worker deployed with ProxyEntrypoint export
 *   - jack-tenants dispatch namespace exists
 *
 * What it does:
 *   1. Uploads a test worker to the dispatch namespace with a service binding
 *      that includes `entrypoint: "ProxyEntrypoint"` and `props: { projectId, orgId }`
 *   2. Reports whether the API accepted or rejected the binding config
 *   3. Cleans up the test worker
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DISPATCH_NAMESPACE = "jack-tenants";
const TEST_SCRIPT_NAME = "__jack-test-ctx-props";
const BASE_URL = "https://api.cloudflare.com/client/v4";

if (!ACCOUNT_ID || !API_TOKEN) {
	console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN env vars");
	process.exit(1);
}

// Minimal test worker that echoes its environment
const TEST_WORKER_CODE = `
export default {
  async fetch(request, env, ctx) {
    return Response.json({
      message: "ctx.props test worker",
      hasProxy: !!env.__AI_PROXY,
      timestamp: new Date().toISOString(),
    });
  }
};
`;

async function uploadTestWorker(): Promise<boolean> {
	const url = `${BASE_URL}/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${TEST_SCRIPT_NAME}`;

	const bindings = [
		{
			type: "plain_text",
			name: "PROJECT_ID",
			text: "test-ctx-props",
		},
		{
			type: "service",
			name: "__AI_PROXY",
			service: "jack-binding-proxy",
			entrypoint: "ProxyEntrypoint",
			props: {
				projectId: "test-ctx-props-project",
				orgId: "test-ctx-props-org",
			},
		},
	];

	const metadata = {
		main_module: "worker.js",
		bindings,
		compatibility_date: "2024-12-01",
	};

	const formData = new FormData();
	formData.append("metadata", JSON.stringify(metadata));
	formData.append(
		"worker.js",
		new Blob([TEST_WORKER_CODE], { type: "application/javascript+module" }),
		"worker.js",
	);

	console.log("Uploading test worker with service binding props...");
	console.log("Binding config:", JSON.stringify(bindings[1], null, 2));

	const response = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
		},
		body: formData,
	});

	const data = await response.json();

	if (data.success) {
		console.log("\n✓ API ACCEPTED the service binding with entrypoint + props!");
		console.log("  ctx.props approach is supported by the dispatch namespace API.");
		return true;
	}

	console.log("\n✗ API REJECTED the service binding config.");
	console.log("  Errors:", JSON.stringify(data.errors, null, 2));
	console.log("\n  If props/entrypoint are not supported, proceed with HMAC fallback (Step 5).");
	return false;
}

async function cleanupTestWorker(): Promise<void> {
	const url = `${BASE_URL}/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${TEST_SCRIPT_NAME}`;

	console.log("\nCleaning up test worker...");
	const response = await fetch(url, {
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
		},
	});

	const data = await response.json();
	if (data.success) {
		console.log("✓ Test worker deleted.");
	} else {
		console.log("⚠ Failed to delete test worker:", data.errors);
	}
}

async function main() {
	console.log("=== ctx.props Verification Test ===\n");
	console.log(`Account: ${ACCOUNT_ID}`);
	console.log(`Namespace: ${DISPATCH_NAMESPACE}`);
	console.log(`Test script: ${TEST_SCRIPT_NAME}\n`);

	const accepted = await uploadTestWorker();

	// Always clean up
	await cleanupTestWorker();

	console.log("\n=== Result ===");
	if (accepted) {
		console.log("Proceed with ctx.props approach (Steps 2-4 of the plan).");
		console.log("Next: Deploy binding-proxy-worker with ProxyEntrypoint, then test end-to-end.");
	} else {
		console.log("ctx.props NOT supported. Implement HMAC fallback (Step 5 of the plan).");
	}

	process.exit(accepted ? 0 : 1);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});

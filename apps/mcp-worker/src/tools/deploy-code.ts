import { zipSync } from "fflate";
import { type BundleResult, bundleCode } from "../bundler.ts";
import type { ControlPlaneClient } from "../control-plane.ts";

interface ManifestData {
	version: 1;
	entrypoint: string;
	compatibility_date: string;
	compatibility_flags: string[];
	module_format: "esm";
	built_at: string;
	bindings: Record<string, unknown>;
}

function createManifest(compatibilityFlags?: string[]): ManifestData {
	return {
		version: 1,
		entrypoint: "worker.js",
		compatibility_date: "2024-12-01",
		compatibility_flags: compatibilityFlags || ["nodejs_compat"],
		module_format: "esm",
		built_at: new Date().toISOString(),
		bindings: {},
	};
}

function createBundleZip(bundledCode: string): Uint8Array {
	return zipSync({
		"worker.js": new TextEncoder().encode(bundledCode),
	});
}

export async function deployFromCode(
	client: ControlPlaneClient,
	files: Record<string, string>,
	projectName?: string,
	projectId?: string,
	compatibilityFlags?: string[],
): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	// Validate input
	if (!files || Object.keys(files).length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						success: false,
						error: "No files provided. Include at least one source file.",
					}),
				},
			],
		};
	}

	// Check total size (limit: 500KB of source)
	const totalSize = Object.values(files).reduce((sum, content) => sum + content.length, 0);
	if (totalSize > 500_000) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						success: false,
						error: `Source files too large (${Math.round(totalSize / 1000)}KB). Maximum is 500KB. For larger projects, use the local Jack CLI.`,
					}),
				},
			],
		};
	}

	// Step 1: Bundle the code
	let bundleResult: BundleResult;
	try {
		bundleResult = await bundleCode(files);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						success: false,
						error: `Bundle failed: ${message}`,
						suggestion:
							"Check that your imports are valid. The remote MCP supports ESM packages available on esm.sh (hono, zod, itty-router, etc). Complex Node.js packages may not work — use the local Jack CLI instead.",
					}),
				},
			],
		};
	}

	// Step 2: Create manifest and zip
	const manifest = createManifest(compatibilityFlags);
	const bundleZip = createBundleZip(bundleResult.code);

	// Step 3: Create or reuse project
	let targetProjectId = projectId;
	let projectUrl: string | undefined;

	if (!targetProjectId) {
		const name = projectName || `mcp-${Date.now().toString(36)}`;
		const createResult = await client.createProject(name);
		targetProjectId = createResult.project.id;
		projectUrl = createResult.url;
	}

	// Step 4: Upload deployment
	const deployment = await client.uploadDeployment(
		targetProjectId,
		manifest,
		bundleZip,
		`Deployed via remote MCP from ${Object.keys(files).length} source file(s)`,
	);

	// Step 5: If we didn't get a URL from project creation, fetch it
	if (!projectUrl) {
		try {
			const { project } = await client.getProject(targetProjectId);
			projectUrl = `https://${project.slug}.runjack.xyz`;
		} catch {
			projectUrl = undefined;
		}
	}

	const result: Record<string, unknown> = {
		success: true,
		data: {
			project_id: targetProjectId,
			deployment_id: deployment.id,
			status: deployment.status,
			url: projectUrl,
			files_bundled: Object.keys(files).length,
			bundle_size_bytes: bundleResult.code.length,
		},
	};

	if (bundleResult.warnings.length > 0) {
		(result.data as Record<string, unknown>).warnings = bundleResult.warnings;
	}

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(result, null, 2),
			},
		],
	};
}

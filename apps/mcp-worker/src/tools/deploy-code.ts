import { zipSync } from "fflate";
import { type BundleResult, bundleCode } from "../bundler.ts";
import type { ControlPlaneClient } from "../control-plane.ts";
import { clearStagedChanges, getStagedChanges } from "../staging.ts";
import { type McpToolResult, err, ok } from "../utils.ts";
import { deployFromTemplate } from "./deploy-template.ts";

export interface DeployParams {
	files?: Record<string, string>;
	template?: string;
	changes?: Record<string, string | null>;
	staged?: boolean;
	project_id?: string;
	project_name?: string;
	compatibility_flags?: string[];
}

interface ManifestData {
	version: 1;
	entrypoint: string;
	compatibility_date: string;
	compatibility_flags: string[];
	module_format: "esm";
	built_at: string;
	bindings: Record<string, unknown>;
}

async function createManifest(
	client: ControlPlaneClient,
	projectId: string | undefined,
	compatibilityFlags?: string[],
): Promise<ManifestData> {
	const bindings: Record<string, unknown> = {};

	if (projectId) {
		try {
			const { resources } = await client.getProjectResources(projectId);
			for (const r of resources) {
				if (r.resource_type === "d1" && r.binding_name) {
					bindings.d1 = { binding: r.binding_name };
				}
			}
		} catch {
			// Project may not exist yet (new deploy) — skip
		}
	}

	return {
		version: 1,
		entrypoint: "worker.js",
		compatibility_date: "2024-12-01",
		compatibility_flags: compatibilityFlags || ["nodejs_compat"],
		module_format: "esm",
		built_at: new Date().toISOString(),
		bindings,
	};
}

function createBundleZip(bundledCode: string): Uint8Array {
	return zipSync({
		"worker.js": new TextEncoder().encode(bundledCode),
	});
}

/** Bundle resolved files and upload to the control plane. */
async function bundleAndDeploy(
	client: ControlPlaneClient,
	resolvedFiles: Record<string, string>,
	projectId: string | undefined,
	projectName: string | undefined,
	compatibilityFlags: string[] | undefined,
	mode: string,
): Promise<McpToolResult> {
	if (Object.keys(resolvedFiles).length === 0) {
		return err("VALIDATION_ERROR", "No files provided. Include at least one source file.");
	}

	const totalSize = Object.values(resolvedFiles).reduce(
		(sum, content) => sum + content.length,
		0,
	);
	if (totalSize > 500_000) {
		return err(
			"SIZE_LIMIT",
			`Source files too large (${Math.round(totalSize / 1000)}KB). Maximum is 500KB.`,
			"For larger projects, use the local Jack CLI.",
		);
	}

	let bundleResult: BundleResult;
	try {
		bundleResult = await bundleCode(resolvedFiles);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err(
			"BUNDLE_FAILED",
			`Bundle failed: ${message}`,
			"Check that your imports are valid. The remote MCP supports ESM packages available on esm.sh (hono, zod, itty-router, etc). Complex Node.js packages may not work — use the local Jack CLI instead.",
		);
	}

	const bundledSizeBytes = new TextEncoder().encode(bundleResult.code).byteLength;
	if (bundledSizeBytes > 10_000_000) {
		return err(
			"SIZE_LIMIT",
			`Bundled output too large (${Math.round(bundledSizeBytes / 1_000_000)}MB). Workers have a 10MB limit.`,
			"For large projects, use the local Jack CLI.",
		);
	}

	const sourceZip = zipSync(
		Object.fromEntries(
			Object.entries(resolvedFiles).map(([p, c]) => [p, new TextEncoder().encode(c)]),
		),
	);

	const bundleZip = createBundleZip(bundleResult.code);

	let targetProjectId = projectId;
	let projectUrl: string | undefined;

	if (!targetProjectId) {
		const name = projectName || `mcp-${Date.now().toString(36)}`;
		const createResult = await client.createProject(name);
		targetProjectId = createResult.project.id;
		projectUrl = createResult.url;
	}

	const manifest = await createManifest(client, targetProjectId, compatibilityFlags);

	const fileCount = Object.keys(resolvedFiles).length;
	const deployment = await client.uploadDeployment(
		targetProjectId,
		manifest,
		bundleZip,
		`Deployed via remote MCP from ${fileCount} source file(s)`,
		sourceZip,
	);

	if (!projectUrl) {
		try {
			const { url } = await client.getProject(targetProjectId);
			projectUrl = url;
		} catch {
			projectUrl = undefined;
		}
	}

	console.log(
		JSON.stringify({
			event: "deploy",
			mode,
			files: fileCount,
			bundle_size: bundleResult.code.length,
		}),
	);

	const data: Record<string, unknown> = {
		project_id: targetProjectId,
		deployment_id: deployment.id,
		status: deployment.status,
		url: projectUrl,
	};

	if (bundleResult.warnings.length > 0) {
		data.warnings = bundleResult.warnings;
	}

	return ok(data);
}

export async function deploy(
	client: ControlPlaneClient,
	params: DeployParams,
	kv?: KVNamespace,
): Promise<McpToolResult> {
	const { files, template, changes, staged, project_id, project_name, compatibility_flags } =
		params;

	// Staged mode: deploy from accumulated update_file calls
	if (staged) {
		if (files || template || changes) {
			return err(
				"VALIDATION_ERROR",
				"staged=true cannot be combined with files, template, or changes.",
				"Use staged=true alone with project_id, or use one of the other modes.",
			);
		}
		if (!project_id) {
			return err(
				"VALIDATION_ERROR",
				"project_id is required when using staged mode.",
				"Provide the project_id of the project with staged changes.",
			);
		}
		if (!kv) {
			return err("INTERNAL_ERROR", "Staging KV not available.");
		}

		const stagedChanges = await getStagedChanges(kv, project_id);
		if (!stagedChanges || Object.keys(stagedChanges.files).length === 0) {
			return err(
				"VALIDATION_ERROR",
				"No staged changes found for this project.",
				"Use update_file to stage file changes before deploying with staged=true.",
			);
		}

		let resolvedFiles: Record<string, string>;
		try {
			const existingFiles = await client.getAllSourceFiles(project_id);
			const merged = { ...existingFiles };
			for (const [path, content] of Object.entries(stagedChanges.files)) {
				if (content === null) {
					delete merged[path];
				} else {
					merged[path] = content;
				}
			}
			if (Object.keys(merged).length === 0) {
				return err(
					"VALIDATION_ERROR",
					"Merged file set is empty after applying staged changes.",
					"Ensure at least one file remains after deletions.",
				);
			}
			resolvedFiles = merged;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return err("DEPLOY_FAILED", `Failed to fetch existing source files: ${message}`);
		}

		const result = await bundleAndDeploy(
			client,
			resolvedFiles,
			project_id,
			undefined,
			compatibility_flags,
			"staged",
		);

		// Clear staged changes on successful deploy
		if (!result.isError) {
			await clearStagedChanges(kv, project_id);
		}

		return result;
	}

	const modeCount = [files, template, changes].filter((v) => v !== undefined).length;
	if (modeCount === 0) {
		return err(
			"VALIDATION_ERROR",
			"Exactly one of files, template, changes, or staged=true must be provided.",
			"Pass files for a full deploy, template for a prebuilt app, changes for a partial update, or staged=true to deploy files from update_file calls.",
		);
	}
	if (modeCount > 1) {
		return err(
			"VALIDATION_ERROR",
			"Only one of files, template, or changes can be provided per call.",
			"Use files for full deploy, template for prebuilt apps, or changes for partial updates.",
		);
	}

	if (changes && !project_id) {
		return err(
			"VALIDATION_ERROR",
			"project_id is required when using changes mode.",
			"Provide the project_id of the existing project you want to update.",
		);
	}

	if (template && project_id) {
		return err(
			"VALIDATION_ERROR",
			"template mode always creates a new project. Do not pass project_id with template.",
			"Remove project_id, or use files/changes mode to update an existing project.",
		);
	}

	if (template) {
		return deployFromTemplate(client, template, project_name);
	}

	let resolvedFiles: Record<string, string>;

	if (changes) {
		try {
			const existingFiles = await client.getAllSourceFiles(project_id!);
			const merged = { ...existingFiles };

			for (const [path, content] of Object.entries(changes)) {
				if (content === null) {
					delete merged[path];
				} else {
					merged[path] = content;
				}
			}

			if (Object.keys(merged).length === 0) {
				return err(
					"VALIDATION_ERROR",
					"Merged file set is empty after applying changes.",
					"Ensure at least one file remains after deletions.",
				);
			}

			resolvedFiles = merged;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const is404 =
				message.includes("404") || message.includes("not found") || message.includes("Not found");
			return err(
				is404 ? "NOT_FOUND" : "DEPLOY_FAILED",
				`Failed to fetch existing source files: ${message}`,
				is404
					? "This project may not have stored source (e.g., deployed before source storage was enabled, or deployed from a template). Use files mode with the full file set instead of changes."
					: undefined,
			);
		}
	} else {
		resolvedFiles = files!;
	}

	try {
		return await bundleAndDeploy(
			client,
			resolvedFiles,
			project_id,
			project_name,
			compatibility_flags,
			changes ? "changes" : "files",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err("DEPLOY_FAILED", `Deployment failed: ${message}`);
	}
}

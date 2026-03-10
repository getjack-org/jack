import type { ControlPlaneClient } from "../control-plane.ts";
import { getStagedChanges, stageFile } from "../staging.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function listProjectFiles(
	client: ControlPlaneClient,
	projectId: string,
): Promise<McpToolResult> {
	try {
		const { files, total_files } = await client.getSourceTree(projectId);

		return ok({ files, total: total_files });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err(
			"NOT_FOUND",
			message,
			"Source may not be available if the project was deployed before source storage was enabled. Try redeploying with deploy().",
		);
	}
}

export async function readProjectFile(
	client: ControlPlaneClient,
	projectId: string,
	path: string,
): Promise<McpToolResult> {
	try {
		const fileContent = await client.getSourceFile(projectId, path);

		return ok({ path, content: fileContent });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err(
			"NOT_FOUND",
			message,
			"Check the file path. Use list_project_files to see available files.",
		);
	}
}

export async function updateFile(
	kv: KVNamespace,
	projectId: string,
	path: string,
	content: string | null,
): Promise<McpToolResult> {
	// Validate path: no traversal, no absolute paths
	if (path.startsWith("/") || path.includes("..")) {
		return err(
			"VALIDATION_ERROR",
			"Invalid file path. Must be relative with no '..' segments.",
			"Use paths like 'src/index.ts' or 'public/styles.css'.",
		);
	}

	// Reject sensitive paths
	const blocked = [".env", "node_modules/", ".git/", ".wrangler/"];
	if (blocked.some((b) => path === b || path.startsWith(b))) {
		return err(
			"VALIDATION_ERROR",
			`Cannot write to ${path}. This path is blocked for security.`,
		);
	}

	// Size check for individual file content
	if (content !== null && content.length > 500_000) {
		return err(
			"SIZE_LIMIT",
			`File content too large (${Math.round(content.length / 1000)}KB). Maximum is 500KB per file.`,
			"For larger files, use the local Jack CLI.",
		);
	}

	const staged = await stageFile(kv, projectId, path, content);
	const fileCount = Object.keys(staged.files).length;
	const action = content === null ? "marked for deletion" : "staged";

	return ok({
		path,
		action,
		staged_files: fileCount,
		note: `File ${action}. ${fileCount} file(s) staged. Call deploy(project_id, staged=true) to deploy all staged changes.`,
	});
}

export async function listStagedChanges(
	kv: KVNamespace,
	projectId: string,
): Promise<McpToolResult> {
	const staged = await getStagedChanges(kv, projectId);
	if (!staged || Object.keys(staged.files).length === 0) {
		return ok({
			staged_files: 0,
			files: [],
			note: "No staged changes. Use update_file to stage file changes before deploying.",
		});
	}

	const files = Object.entries(staged.files).map(([path, content]) => ({
		path,
		action: content === null ? "delete" : "update",
		size: content !== null ? content.length : 0,
	}));

	return ok({
		staged_files: files.length,
		files,
		updated_at: staged.updated_at,
		note: "Call deploy(project_id, staged=true) to deploy these changes.",
	});
}

import type { ControlPlaneClient } from "../control-plane.ts";
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

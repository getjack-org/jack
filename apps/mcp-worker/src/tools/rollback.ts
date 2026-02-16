import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function rollbackProject(
	client: ControlPlaneClient,
	projectId: string,
	deploymentId?: string,
): Promise<McpToolResult> {
	try {
		const result = await client.rollbackProject(projectId, deploymentId);

		let url: string | undefined;
		try {
			const { url: projectUrl } = await client.getProject(projectId);
			url = projectUrl;
		} catch {
			// Non-fatal — URL is nice-to-have
		}

		return ok({
			deployment_id: result.deployment.id,
			status: result.deployment.status,
			url,
			note: "Rolled back successfully. Database state and secrets are unchanged.",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("No previous") || message.includes("Cannot roll back")) {
			return err(
				"VALIDATION_ERROR",
				message,
				"Check get_project_status to see available deployments.",
			);
		}
		return err("INTERNAL_ERROR", `Rollback failed: ${message}`);
	}
}

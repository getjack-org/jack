import type { AskProjectHintInput, ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function askProject(
	client: ControlPlaneClient,
	projectId: string,
	question: string,
	hints?: AskProjectHintInput,
): Promise<McpToolResult> {
	try {
		const result = await client.askProject(projectId, question, hints);
		return ok(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("not found") || message.includes("Not found")) {
			return err("NOT_FOUND", message, "Use list_projects to confirm project_id.");
		}
		if (message.includes("question is required")) {
			return err("VALIDATION_ERROR", message, "Provide a non-empty question.");
		}
		return err("INTERNAL_ERROR", `ask_project failed: ${message}`);
	}
}

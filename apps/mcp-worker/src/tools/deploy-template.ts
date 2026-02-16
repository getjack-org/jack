import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function deployFromTemplate(
	client: ControlPlaneClient,
	template: string,
	projectName?: string,
): Promise<McpToolResult> {
	const name = projectName || `${template}-${Date.now().toString(36)}`;

	const t0 = Date.now();
	const result = await client.createProjectWithPrebuilt(name, template);
	const deploy_ms = Date.now() - t0;

	console.log(JSON.stringify({ event: "deploy_from_template", template, deploy_ms }));

	if (result.prebuilt_failed) {
		return err(
			"DEPLOY_FAILED",
			`Template deploy failed: ${result.prebuilt_error}`,
			"Project was created but deployment failed. You can try deploying code directly using files mode.",
			{ project_id: result.project.id },
		);
	}

	return ok({
		project_id: result.project.id,
		project_name: result.project.name,
		slug: result.project.slug,
		url: result.url,
		status: result.status || "live",
		template,
	});
}

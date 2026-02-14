import type { ControlPlaneClient } from "../control-plane.ts";

export async function deployFromTemplate(
	client: ControlPlaneClient,
	template: string,
	projectName?: string,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const name = projectName || `${template}-${Date.now().toString(36)}`;

	const t0 = Date.now();
	const result = await client.createProjectWithPrebuilt(name, template);
	const deploy_ms = Date.now() - t0;

	console.log(JSON.stringify({ event: "deploy_from_template", template, deploy_ms }));

	if (result.prebuilt_failed) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							success: false,
							error: `Template deploy failed: ${result.prebuilt_error}`,
							project_id: result.project.id,
							note: "Project was created but deployment failed. You can try deploying code directly using deploy_from_code.",
						},
						null,
						2,
					),
				},
			],
		};
	}

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						success: true,
						data: {
							project_id: result.project.id,
							project_name: result.project.name,
							slug: result.project.slug,
							url: result.url,
							status: result.status || "live",
							template,
						},
					},
					null,
					2,
				),
			},
		],
	};
}

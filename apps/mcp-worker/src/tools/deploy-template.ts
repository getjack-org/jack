import type { ControlPlaneClient } from "../control-plane.ts";

const BUILTIN_TEMPLATES = [
	"hello",
	"miniapp",
	"api",
	"cron",
	"resend",
	"nextjs",
	"saas",
	"ai-chat",
	"semantic-search",
	"nextjs-shadcn",
	"nextjs-clerk",
	"nextjs-auth",
];

export async function deployFromTemplate(
	client: ControlPlaneClient,
	template: string,
	projectName?: string,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	if (!BUILTIN_TEMPLATES.includes(template)) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						success: false,
						error: `Unknown template: ${template}`,
						available_templates: BUILTIN_TEMPLATES,
					}),
				},
			],
		};
	}

	const name = projectName || `${template}-${Date.now().toString(36)}`;

	const result = await client.createProjectWithPrebuilt(name, template);

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

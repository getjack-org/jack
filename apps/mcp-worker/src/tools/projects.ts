import type { ControlPlaneClient } from "../control-plane.ts";

export async function listProjects(client: ControlPlaneClient): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const { projects } = await client.listProjects();

	const summary = projects.map((p) => ({
		id: p.id,
		name: p.name,
		slug: p.slug,
		created_at: p.created_at,
	}));

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						success: true,
						data: { projects: summary, total: summary.length },
					},
					null,
					2,
				),
			},
		],
	};
}

export async function getProjectStatus(
	client: ControlPlaneClient,
	projectId: string,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const [{ project }, { deployment }, { resources }] = await Promise.all([
		client.getProject(projectId),
		client.getLatestDeployment(projectId),
		client.getProjectResources(projectId),
	]);

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						success: true,
						data: {
							project: {
								id: project.id,
								name: project.name,
								slug: project.slug,
							},
							latest_deployment: deployment
								? {
										id: deployment.id,
										status: deployment.status,
										source: deployment.source,
										created_at: deployment.created_at,
									}
								: null,
							resources: resources.map((r) => ({
								id: r.id,
								type: r.type,
								name: r.name,
							})),
						},
					},
					null,
					2,
				),
			},
		],
	};
}

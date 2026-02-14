import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function listProjects(client: ControlPlaneClient): Promise<McpToolResult> {
	try {
		const { projects } = await client.listProjects();

		const summary = projects.map((p) => ({
			id: p.id,
			name: p.name,
			slug: p.slug,
			created_at: p.created_at,
		}));

		return ok({ projects: summary, total: summary.length });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err("INTERNAL_ERROR", message);
	}
}

export async function getProjectStatus(
	client: ControlPlaneClient,
	projectId: string,
): Promise<McpToolResult> {
	try {
		const [{ project, url }, { deployment }, { resources }] = await Promise.all([
			client.getProject(projectId),
			client.getLatestDeployment(projectId),
			client.getProjectResources(projectId),
		]);

		return ok({
			project: {
				id: project.id,
				name: project.name,
				slug: project.slug,
				url,
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
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("not found") || message.includes("Not found")) {
			return err("NOT_FOUND", message, "Use list_projects to see available projects.");
		}
		return err("INTERNAL_ERROR", message);
	}
}

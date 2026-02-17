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
		const overview = await client.getProjectOverview(projectId);

		return ok({
			project: {
				id: overview.project.id,
				name: overview.project.name,
				slug: overview.project.slug,
				url: overview.project.url,
			},
			latest_deployment: overview.latest_deployment
				? {
						id: overview.latest_deployment.id,
						status: overview.latest_deployment.status,
						source: overview.latest_deployment.source,
						created_at: overview.latest_deployment.created_at,
					}
				: null,
			resources: overview.resources.map((r) => ({
				id: r.id,
				type: r.resource_type,
				name: r.resource_name,
				binding_name: r.binding_name,
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

import { CloudflareClient, type DispatchScriptBinding } from "./cloudflare-api";
import type { Bindings, Deployment, Project, Resource } from "./types";

const DISPATCH_NAMESPACE = "jack-tenants";

// Template definitions
const TEMPLATES: Record<string, (projectId: string) => string> = {
	hello: (projectId: string) => `export default {
	async fetch(request, env) {
		return new Response(JSON.stringify({
			message: "Hello from jack!",
			project_id: env.PROJECT_ID,
			timestamp: new Date().toISOString()
		}), {
			headers: { "Content-Type": "application/json" }
		});
	}
};`,
};

/**
 * DeploymentService handles deployment lifecycle for projects
 */
export class DeploymentService {
	private db: D1Database;
	private codeBucket: R2Bucket;
	private cfClient: CloudflareClient;

	constructor(env: Bindings) {
		this.db = env.DB;
		this.codeBucket = env.CODE_BUCKET;
		this.cfClient = new CloudflareClient(env);
	}

	/**
	 * Create a new deployment for a project
	 */
	async createDeployment(projectId: string, source: string): Promise<Deployment> {
		const deploymentId = `dep_${crypto.randomUUID()}`;

		if (!source.startsWith("template:")) {
			throw new Error("Only template: sources are supported");
		}

		// Insert deployment record with status 'queued'
		await this.db
			.prepare(
				`INSERT INTO deployments (id, project_id, status, source)
         VALUES (?, ?, 'queued', ?)`,
			)
			.bind(deploymentId, projectId, source)
			.run();

		try {
			let versionId = "";
			let artifactKey = "";

			// Check if source is a template deployment
			if (source.startsWith("template:")) {
				const templateName = source.replace("template:", "");
				const result = await this.deployTemplate(projectId, templateName, deploymentId);
				versionId = result.versionId;
				artifactKey = result.artifactKey;
			}

			// Update deployment to 'live' with version ID and artifact key
			await this.db
				.prepare(
					`UPDATE deployments
           SET status = 'live',
               worker_version_id = ?,
               artifact_bucket_key = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
				.bind(versionId || null, artifactKey || null, deploymentId)
				.run();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Deployment failed";

			// Update deployment to 'failed' with error message
			await this.db
				.prepare(
					`UPDATE deployments
           SET status = 'failed',
               error_message = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
				.bind(errorMessage, deploymentId)
				.run();

			throw error;
		}

		// Fetch and return the final deployment state
		const deployment = await this.db
			.prepare("SELECT * FROM deployments WHERE id = ?")
			.bind(deploymentId)
			.first<Deployment>();

		if (!deployment) {
			throw new Error("Failed to retrieve created deployment");
		}

		return deployment;
	}

	/**
	 * Deploy a template to a project
	 */
	async deployTemplate(
		projectId: string,
		templateName: string,
		deploymentId: string,
	): Promise<{ versionId: string; artifactKey: string }> {
		// Get template function
		const templateFn = TEMPLATES[templateName];
		if (!templateFn) {
			throw new Error(`Template "${templateName}" not found`);
		}

		// Get project from DB
		const project = await this.db
			.prepare("SELECT * FROM projects WHERE id = ?")
			.bind(projectId)
			.first<Project>();

		if (!project) {
			throw new Error(`Project ${projectId} not found`);
		}

		// Get bindings for this project
		const bindings = await this.getBindingsForProject(projectId);

		// Build the worker script using the template
		const workerScript = templateFn(projectId);

		// Get worker name from resources table
		const workerResource = await this.db
			.prepare(
				"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker'",
			)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			throw new Error("Worker resource not found");
		}

		// Upload to dispatch namespace
		await this.cfClient.uploadDispatchScript(
			DISPATCH_NAMESPACE,
			workerResource.resource_name,
			workerScript,
			bindings,
		);

		// Store artifact in CODE_BUCKET
		const artifactKey = `projects/${projectId}/deployments/${deploymentId}/worker.js`;
		await this.codeBucket.put(artifactKey, workerScript);

		// Note: Cloudflare Workers API doesn't return version IDs from upload
		// We return empty string for now, but could be enhanced if needed
		return {
			versionId: "",
			artifactKey,
		};
	}

	/**
	 * List deployments for a project
	 */
	async listDeployments(projectId: string): Promise<Deployment[]> {
		const result = await this.db
			.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC")
			.bind(projectId)
			.all<Deployment>();

		return result.results || [];
	}

	/**
	 * Get bindings configuration for a project
	 */
	async getBindingsForProject(projectId: string): Promise<DispatchScriptBinding[]> {
		// Get all resources for this project
		const resources = await this.db
			.prepare(
				"SELECT resource_type, provider_id, resource_name FROM resources WHERE project_id = ? AND status != 'deleted'",
			)
			.bind(projectId)
			.all<Resource>();

		const bindings: DispatchScriptBinding[] = [];

		// Add D1 binding
		const d1Resource = resources.results?.find((r) => r.resource_type === "d1");
		if (d1Resource) {
			bindings.push({
				type: "d1",
				name: "DB",
				id: d1Resource.provider_id,
			});
		}

		// Add R2 binding if enabled
		const r2Resource = resources.results?.find((r) => r.resource_type === "r2_content");
		if (r2Resource) {
			bindings.push({
				type: "r2_bucket",
				name: "CONTENT",
				bucket_name: r2Resource.resource_name,
			});
		}

		// Add PROJECT_ID plain text binding
		bindings.push({
			type: "plain_text",
			name: "PROJECT_ID",
			text: projectId,
		});

		return bindings;
	}
}

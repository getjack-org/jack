import { unzipSync } from "fflate";
import { CloudflareClient, type DispatchScriptBinding } from "./cloudflare-api";
import type { Bindings, Deployment, Project, Resource } from "./types";

const DISPATCH_NAMESPACE = "jack-tenants";

interface ManifestData {
	version: 1;
	entrypoint: string;
	compatibility_date: string;
	compatibility_flags?: string[];
	module_format: "esm";
	assets_dir?: string;
	built_at: string;
}

interface CodeDeploymentInput {
	projectId: string;
	manifest: ManifestData;
	bundleZip: ArrayBuffer;
	sourceZip: ArrayBuffer | null;
	schemaSql: string | null;
	secretsJson: Record<string, string> | null;
	assetsZip: ArrayBuffer | null;
}

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

	/**
	 * Create a code deployment from uploaded artifacts
	 */
	async createCodeDeployment(input: CodeDeploymentInput): Promise<Deployment> {
		const deploymentId = `dep_${crypto.randomUUID()}`;

		// Insert deployment record with status 'queued'
		await this.db
			.prepare(
				`INSERT INTO deployments (id, project_id, status, source)
         VALUES (?, ?, 'queued', 'code:v1')`,
			)
			.bind(deploymentId, input.projectId)
			.run();

		try {
			// Store artifacts in CODE_BUCKET
			const artifactPrefix = `projects/${input.projectId}/deployments/${deploymentId}`;
			await this.codeBucket.put(`${artifactPrefix}/bundle.zip`, input.bundleZip);
			if (input.sourceZip) {
				await this.codeBucket.put(`${artifactPrefix}/source.zip`, input.sourceZip);
			}
			await this.codeBucket.put(`${artifactPrefix}/manifest.json`, JSON.stringify(input.manifest));

			// Upload assets to content bucket (if assets are provided)
			if (input.assetsZip) {
				await this.uploadAssetsToContentBucket(input.projectId, input.assetsZip);
			}

			// Execute schema.sql if provided
			if (input.schemaSql) {
				await this.executeSchema(input.projectId, input.schemaSql);
			}

			// Deploy worker code - extract main module and upload
			await this.deployCodeToWorker(input.projectId, input.bundleZip, input.manifest, deploymentId);

			// Set secrets (must be after worker upload)
			if (input.secretsJson) {
				await this.setSecrets(input.projectId, input.secretsJson);
			}

			// Update deployment status to 'live'
			await this.db
				.prepare(
					`UPDATE deployments SET status = 'live', artifact_bucket_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				)
				.bind(artifactPrefix, deploymentId)
				.run();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Deployment failed";
			await this.db
				.prepare(
					`UPDATE deployments SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				)
				.bind(errorMessage, deploymentId)
				.run();
			throw error;
		}

		// Fetch and return final deployment
		const deployment = await this.db
			.prepare("SELECT * FROM deployments WHERE id = ?")
			.bind(deploymentId)
			.first<Deployment>();
		if (!deployment) throw new Error("Failed to retrieve created deployment");
		return deployment;
	}

	/**
	 * Deploy worker code to Cloudflare
	 */
	private async deployCodeToWorker(
		projectId: string,
		bundleZip: ArrayBuffer,
		manifest: ManifestData,
		deploymentId: string,
	): Promise<void> {
		// Get worker name from resources
		const workerResource = await this.db
			.prepare(
				"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker'",
			)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) throw new Error("Worker resource not found");

		// Get bindings for this project (reuse existing method)
		const bindings = await this.getBindingsForProject(projectId);

		// Extract the main module from the ZIP
		const workerCode = await this.extractMainModule(bundleZip, manifest.entrypoint);

		// Upload to dispatch namespace
		await this.cfClient.uploadDispatchScript(
			DISPATCH_NAMESPACE,
			workerResource.resource_name,
			workerCode,
			bindings,
			{
				compatibilityDate: manifest.compatibility_date,
				compatibilityFlags: manifest.compatibility_flags,
			},
		);
	}

	/**
	 * Extract main module from bundle ZIP
	 */
	private async extractMainModule(bundleZip: ArrayBuffer, entrypoint: string): Promise<string> {
		const files = unzipSync(new Uint8Array(bundleZip));

		// Find the entrypoint file
		const entrypointData = files[entrypoint];
		if (!entrypointData) {
			// Try common variations
			const variations = [entrypoint, `${entrypoint}.js`, "worker.js", "index.js"];
			for (const name of variations) {
				if (files[name]) {
					return new TextDecoder().decode(files[name]);
				}
			}
			throw new Error(`Entrypoint ${entrypoint} not found in bundle`);
		}

		return new TextDecoder().decode(entrypointData);
	}

	/**
	 * Upload assets from assets ZIP to project's content bucket
	 */
	private async uploadAssetsToContentBucket(
		projectId: string,
		assetsZip: ArrayBuffer,
	): Promise<void> {
		// Get project's content bucket from resources
		const r2Resource = await this.db
			.prepare(
				"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'r2_content'",
			)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!r2Resource) {
			// Content bucket not enabled for this project - skip
			return;
		}

		// Unzip assets
		const files = unzipSync(new Uint8Array(assetsZip));

		// Upload each file to R2
		for (const [path, content] of Object.entries(files)) {
			if (content.length > 0) {
				await this.cfClient.uploadToR2Bucket(r2Resource.resource_name, path, content);
			}
		}
	}

	/**
	 * Execute schema.sql against project's D1 database
	 */
	private async executeSchema(projectId: string, schemaSql: string): Promise<void> {
		// Get project's D1 database from resources
		const d1Resource = await this.db
			.prepare("SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1'")
			.bind(projectId)
			.first<{ provider_id: string }>();

		if (!d1Resource) {
			throw new Error("D1 database not found for project");
		}

		await this.cfClient.executeD1Query(d1Resource.provider_id, schemaSql);
	}

	/**
	 * Set secrets on the project's worker
	 */
	private async setSecrets(projectId: string, secrets: Record<string, string>): Promise<void> {
		if (!secrets || Object.keys(secrets).length === 0) return;

		// Get worker name from resources
		const workerResource = await this.db
			.prepare(
				"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker'",
			)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			throw new Error("Worker resource not found");
		}

		await this.cfClient.setDispatchScriptSecrets(
			DISPATCH_NAMESPACE,
			workerResource.resource_name,
			secrets,
		);
	}
}

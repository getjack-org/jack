import { unzipSync } from "fflate";
import {
	CloudflareClient,
	type DispatchScriptBinding,
	createAssetManifest,
} from "./cloudflare-api";
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
	// Binding intent from CLI
	bindings?: {
		d1?: { binding: string };
		ai?: { binding: string };
		assets?: { binding: string; directory: string };
		vars?: Record<string, string>;
	};
}

/**
 * Supported binding types for managed deploy
 */
const SUPPORTED_BINDING_KEYS = ["d1", "ai", "assets", "vars"] as const;

/**
 * Binding types that are NOT supported in managed deploy
 * These map to wrangler.jsonc top-level keys
 */
const UNSUPPORTED_BINDING_KEYS = [
	"kv_namespaces",
	"durable_objects",
	"queues",
	"services",
	"r2_buckets",
	"hyperdrive",
	"vectorize",
	"browser",
	"mtls_certificates",
] as const;

export interface ManifestValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validates a deployment manifest at the API boundary.
 * This provides defense-in-depth when CLI validation is bypassed.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
	const errors: string[] = [];

	if (!manifest || typeof manifest !== "object") {
		return { valid: false, errors: ["Manifest must be a valid object"] };
	}

	const m = manifest as Record<string, unknown>;

	// Check required fields
	if (typeof m.entrypoint !== "string" || !m.entrypoint) {
		errors.push("manifest.entrypoint is required");
	}

	if (typeof m.compatibility_date !== "string" || !m.compatibility_date) {
		errors.push("manifest.compatibility_date is required");
	}

	// Validate bindings if present
	if (m.bindings !== undefined) {
		if (typeof m.bindings !== "object" || m.bindings === null) {
			errors.push("manifest.bindings must be an object if present");
		} else {
			const bindings = m.bindings as Record<string, unknown>;

			// Check for unsupported binding keys in manifest.bindings
			// Note: These would indicate someone trying to bypass CLI validation
			for (const key of Object.keys(bindings)) {
				if (!SUPPORTED_BINDING_KEYS.includes(key as (typeof SUPPORTED_BINDING_KEYS)[number])) {
					errors.push(
						`Unsupported binding type in manifest: ${key}. ` +
							`Managed deploy supports: ${SUPPORTED_BINDING_KEYS.join(", ")}`,
					);
				}
			}

			// Validate D1 binding structure
			if (bindings.d1 !== undefined) {
				const d1 = bindings.d1 as Record<string, unknown>;
				if (typeof d1 !== "object" || typeof d1.binding !== "string") {
					errors.push("manifest.bindings.d1.binding must be a string");
				}
			}

			// Validate AI binding structure
			if (bindings.ai !== undefined) {
				const ai = bindings.ai as Record<string, unknown>;
				if (typeof ai !== "object" || typeof ai.binding !== "string") {
					errors.push("manifest.bindings.ai.binding must be a string");
				}
			}

			// Validate assets binding structure
			if (bindings.assets !== undefined) {
				const assets = bindings.assets as Record<string, unknown>;
				if (typeof assets !== "object") {
					errors.push("manifest.bindings.assets must be an object");
				} else {
					if (typeof assets.binding !== "string") {
						errors.push("manifest.bindings.assets.binding must be a string");
					}
					if (typeof assets.directory !== "string") {
						errors.push("manifest.bindings.assets.directory must be a string");
					}
				}
			}

			// Validate vars structure
			if (bindings.vars !== undefined) {
				if (typeof bindings.vars !== "object" || bindings.vars === null) {
					errors.push("manifest.bindings.vars must be an object");
				} else {
					const vars = bindings.vars as Record<string, unknown>;
					for (const [key, value] of Object.entries(vars)) {
						if (typeof value !== "string") {
							errors.push(`manifest.bindings.vars.${key} must be a string`);
						}
					}
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
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
	 * Resolve bindings from manifest intent
	 * This method converts binding intent (from CLI) into actual DispatchScriptBinding objects
	 * by looking up provisioned resources from the database.
	 */
	async resolveBindingsFromManifest(
		projectId: string,
		intent: ManifestData["bindings"],
	): Promise<DispatchScriptBinding[]> {
		const bindings: DispatchScriptBinding[] = [];

		// Always add PROJECT_ID as plain_text binding
		bindings.push({
			type: "plain_text",
			name: "PROJECT_ID",
			text: projectId,
		});

		if (!intent) {
			return bindings;
		}

		// Resolve D1 binding
		if (intent.d1) {
			const d1Resource = await this.db
				.prepare(
					"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
				)
				.bind(projectId)
				.first<{ provider_id: string }>();

			if (!d1Resource) {
				throw new Error(
					`D1 database not found for project ${projectId}. Ensure the project has a D1 resource provisioned.`,
				);
			}

			bindings.push({
				type: "d1",
				name: intent.d1.binding,
				id: d1Resource.provider_id,
			});
		}

		// Resolve AI binding (no provisioning needed, just add the binding)
		if (intent.ai) {
			bindings.push({
				type: "ai",
				name: intent.ai.binding,
			});
		}

		// Note: Assets are NOT resolved here as bindings.
		// Assets are handled via Workers Assets API in deployWithAssets().
		// The ASSETS binding is attached during the script upload with the assets JWT.

		// Resolve vars as plain_text bindings
		if (intent.vars) {
			for (const [name, value] of Object.entries(intent.vars)) {
				bindings.push({
					type: "plain_text",
					name,
					text: value,
				});
			}
		}

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

			// Execute schema.sql if provided
			if (input.schemaSql) {
				await this.executeSchema(input.projectId, input.schemaSql);
			}

			// Deploy worker code - extract main module and upload
			// Assets are handled within deployCodeToWorker via Workers Assets API
			await this.deployCodeToWorker(
				input.projectId,
				input.bundleZip,
				input.manifest,
				deploymentId,
				input.assetsZip,
			);

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
	 * Handles assets via Workers Assets API if assetsZip is provided
	 */
	private async deployCodeToWorker(
		projectId: string,
		bundleZip: ArrayBuffer,
		manifest: ManifestData,
		deploymentId: string,
		assetsZip?: ArrayBuffer | null,
	): Promise<void> {
		// Get worker name from resources
		const workerResource = await this.db
			.prepare(
				"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker'",
			)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) throw new Error("Worker resource not found");

		// Validate assets consistency - fail fast if mismatch
		const hasAssetsZip = assetsZip && assetsZip.byteLength > 0;
		const hasAssetsBinding = !!manifest.bindings?.assets;

		if (hasAssetsBinding && !hasAssetsZip) {
			throw new Error(
				"Assets binding declared in manifest but assets.zip is missing. " +
					"The deployment would fail at runtime when accessing env.ASSETS. " +
					"Ensure the CLI packages assets.zip when assets binding is configured.",
			);
		}

		if (hasAssetsZip && !hasAssetsBinding) {
			throw new Error(
				"assets.zip provided but no assets binding in manifest. " +
					"Add an assets section to wrangler.jsonc to enable static file serving, " +
					"or remove assets.zip from the deployment package.",
			);
		}

		// Resolve bindings from manifest intent (uses manifest bindings, not legacy getBindingsForProject)
		const bindings = await this.resolveBindingsFromManifest(projectId, manifest.bindings);

		// Extract the main module from the ZIP
		const workerCode = await this.extractMainModule(bundleZip, manifest.entrypoint);

		// Deploy with or without assets
		if (hasAssetsZip && hasAssetsBinding) {
			// Deploy with Workers Assets API
			await this.deployWithAssets(
				workerResource.resource_name,
				workerCode,
				bindings,
				manifest,
				assetsZip,
			);
		} else {
			// Standard deployment without assets
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
	}

	/**
	 * Deploy worker with assets using Workers Assets API
	 */
	private async deployWithAssets(
		workerName: string,
		workerCode: string,
		bindings: DispatchScriptBinding[],
		manifest: ManifestData,
		assetsZip: ArrayBuffer,
	): Promise<void> {
		// 1. Unzip assets
		const files = unzipSync(new Uint8Array(assetsZip));
		const assetFiles = new Map<string, Uint8Array>();

		for (const [path, content] of Object.entries(files)) {
			if (content.length > 0) {
				// Ensure paths start with /
				const normalizedPath = path.startsWith("/") ? path : `/${path}`;
				assetFiles.set(normalizedPath, content);
			}
		}

		if (assetFiles.size === 0) {
			throw new Error("No assets found in assets.zip");
		}

		// 2. Create asset manifest with hashes
		const assetManifest = await createAssetManifest(assetFiles);

		// 3. Create upload session
		const session = await this.cfClient.createAssetUploadSession(
			DISPATCH_NAMESPACE,
			workerName,
			assetManifest,
		);

		// 4. Upload payloads if there are files to upload
		let completionJwt = session.jwt;

		if (session.buckets.length > 0) {
			// Build a lookup from hash to content
			const hashToContent = new Map<string, Uint8Array>();
			for (const [path, content] of assetFiles) {
				const entry = assetManifest[path];
				if (entry) {
					hashToContent.set(entry.hash, content);
				}
			}

			// Build payloads for each bucket
			const payloads: Array<Record<string, string>> = [];
			for (const bucket of session.buckets) {
				const payload: Record<string, string> = {};
				for (const hash of bucket) {
					const content = hashToContent.get(hash);
					if (!content) {
						throw new Error(`Content not found for asset hash: ${hash}`);
					}
					// Convert to base64
					let base64 = "";
					const chunkSize = 0x8000;
					for (let i = 0; i < content.length; i += chunkSize) {
						const chunk = content.subarray(i, Math.min(i + chunkSize, content.length));
						base64 += String.fromCharCode.apply(null, Array.from(chunk));
					}
					payload[hash] = btoa(base64);
				}
				payloads.push(payload);
			}

			// Upload all payloads
			completionJwt = await this.cfClient.uploadAssetPayloads(payloads, session.jwt);
		}

		// 5. Upload script with assets binding
		const assetsBinding = manifest.bindings?.assets?.binding || "ASSETS";

		await this.cfClient.uploadDispatchScriptWithAssets(
			DISPATCH_NAMESPACE,
			workerName,
			workerCode,
			bindings,
			completionJwt,
			assetsBinding,
			{
				compatibilityDate: manifest.compatibility_date,
				compatibilityFlags: manifest.compatibility_flags,
				assetConfig: {
					html_handling: "auto-trailing-slash",
					not_found_handling: "none",
				},
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

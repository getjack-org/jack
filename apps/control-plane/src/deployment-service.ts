import { unzipSync } from "fflate";
import {
	type AssetManifest,
	CloudflareClient,
	type DispatchScriptBinding,
	type WorkerModule,
	createAssetManifest,
	getMimeType,
} from "./cloudflare-api";
import { generateDoWrapper } from "./do-wrapper";
import { ProvisioningService } from "./provisioning";
import { ProjectCacheService } from "./repositories/project-cache-service";
import type { Bindings, Deployment, Project, ProjectConfig, Resource } from "./types";

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
		r2?: Array<{ binding: string; bucket_name: string }>;
		kv?: Array<{ binding: string }>;
		vectorize?: Array<{
			binding: string;
			preset?: string;
			dimensions?: number;
			metric?: string;
		}>;
		assets?: {
			binding: string;
			directory: string;
			not_found_handling?: "single-page-application" | "404-page" | "none";
			html_handling?:
				| "auto-trailing-slash"
				| "force-trailing-slash"
				| "drop-trailing-slash"
				| "none";
		};
		durable_objects?: Array<{
			binding: string;
			class_name: string;
		}>;
		vars?: Record<string, string>;
	};
	migrations?: Array<{
		tag: string;
		new_sqlite_classes?: string[];
		deleted_classes?: string[];
		renamed_classes?: Array<{ from: string; to: string }>;
	}>;
}

const SUPPORTED_BINDING_KEYS = [
	"d1",
	"ai",
	"r2",
	"kv",
	"vectorize",
	"assets",
	"vars",
	"durable_objects",
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

			// Validate R2 binding structure
			if (bindings.r2 !== undefined) {
				if (!Array.isArray(bindings.r2)) {
					errors.push("manifest.bindings.r2 must be an array");
				} else {
					for (let i = 0; i < bindings.r2.length; i++) {
						const r2 = bindings.r2[i] as Record<string, unknown>;
						if (typeof r2 !== "object" || r2 === null) {
							errors.push(`manifest.bindings.r2[${i}] must be an object`);
						} else {
							if (typeof r2.binding !== "string") {
								errors.push(`manifest.bindings.r2[${i}].binding must be a string`);
							}
							if (typeof r2.bucket_name !== "string") {
								errors.push(`manifest.bindings.r2[${i}].bucket_name must be a string`);
							}
						}
					}
				}
			}

			// Validate KV binding structure
			if (bindings.kv !== undefined) {
				if (!Array.isArray(bindings.kv)) {
					errors.push("manifest.bindings.kv must be an array");
				} else {
					for (let i = 0; i < bindings.kv.length; i++) {
						const kv = bindings.kv[i] as Record<string, unknown>;
						if (typeof kv !== "object" || kv === null) {
							errors.push(`manifest.bindings.kv[${i}] must be an object`);
						} else {
							if (typeof kv.binding !== "string") {
								errors.push(`manifest.bindings.kv[${i}].binding must be a string`);
							}
						}
					}
				}
			}

			// Validate Vectorize binding structure
			if (bindings.vectorize !== undefined) {
				if (!Array.isArray(bindings.vectorize)) {
					errors.push("manifest.bindings.vectorize must be an array");
				} else {
					for (let i = 0; i < bindings.vectorize.length; i++) {
						const vec = bindings.vectorize[i] as Record<string, unknown>;
						if (typeof vec !== "object" || vec === null) {
							errors.push(`manifest.bindings.vectorize[${i}] must be an object`);
						} else {
							if (typeof vec.binding !== "string") {
								errors.push(`manifest.bindings.vectorize[${i}].binding must be a string`);
							}
							// preset, dimensions, and metric are optional
							if (vec.preset !== undefined && typeof vec.preset !== "string") {
								errors.push(`manifest.bindings.vectorize[${i}].preset must be a string`);
							}
							if (vec.dimensions !== undefined && typeof vec.dimensions !== "number") {
								errors.push(`manifest.bindings.vectorize[${i}].dimensions must be a number`);
							}
							if (vec.metric !== undefined && typeof vec.metric !== "string") {
								errors.push(`manifest.bindings.vectorize[${i}].metric must be a string`);
							}
						}
					}
				}
			}

			// Validate Durable Object binding structure
			if (bindings.durable_objects !== undefined) {
				if (!Array.isArray(bindings.durable_objects)) {
					errors.push("manifest.bindings.durable_objects must be an array");
				} else {
					for (let i = 0; i < bindings.durable_objects.length; i++) {
						const dob = bindings.durable_objects[i] as Record<string, unknown>;
						if (typeof dob !== "object" || dob === null) {
							errors.push(`manifest.bindings.durable_objects[${i}] must be an object`);
						} else {
							if (typeof dob.binding !== "string") {
								errors.push(`manifest.bindings.durable_objects[${i}].binding must be a string`);
							}
							if (typeof dob.class_name !== "string") {
								errors.push(`manifest.bindings.durable_objects[${i}].class_name must be a string`);
							}
							// Reject __JACK_ prefixed binding or class names
							if (typeof dob.binding === "string" && dob.binding.startsWith("__JACK_")) {
								errors.push(
									`manifest.bindings.durable_objects[${i}].binding uses reserved __JACK_ prefix`,
								);
							}
							if (typeof dob.class_name === "string" && dob.class_name.startsWith("__JACK_")) {
								errors.push(
									`manifest.bindings.durable_objects[${i}].class_name uses reserved __JACK_ prefix`,
								);
							}
						}
					}
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

	// Require nodejs_compat when DO bindings are present
	if (m.bindings && typeof m.bindings === "object") {
		const bindings = m.bindings as Record<string, unknown>;
		if (
			bindings.durable_objects &&
			Array.isArray(bindings.durable_objects) &&
			bindings.durable_objects.length > 0
		) {
			const flags = m.compatibility_flags;
			if (!Array.isArray(flags) || !flags.includes("nodejs_compat")) {
				errors.push("Durable Objects require nodejs_compat in compatibility_flags");
			}
		}
	}

	// Validate migrations structure if present
	if (m.migrations !== undefined) {
		if (!Array.isArray(m.migrations)) {
			errors.push("manifest.migrations must be an array if present");
		} else {
			for (let i = 0; i < m.migrations.length; i++) {
				const mig = m.migrations[i] as Record<string, unknown>;
				if (typeof mig !== "object" || mig === null) {
					errors.push(`manifest.migrations[${i}] must be an object`);
				} else if (typeof mig.tag !== "string") {
					errors.push(`manifest.migrations[${i}].tag must be a string`);
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
	/** Pre-computed asset manifest from CLI (saves CPU by avoiding hash computation) */
	assetManifest?: AssetManifest;
	/** Optional deploy message describing what changed and why */
	message?: string;
	/** Override deployment source label (default: 'code:v1') */
	source?: string;
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
	private provisioningService: ProvisioningService;
	private cacheService: ProjectCacheService;

	constructor(env: Bindings) {
		this.db = env.DB;
		this.codeBucket = env.CODE_BUCKET;
		this.cfClient = new CloudflareClient(env);
		this.provisioningService = new ProvisioningService(env);
		this.cacheService = new ProjectCacheService(env.PROJECTS_CACHE);
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

		// Enable observability (Workers Logs) for the script
		try {
			await this.cfClient.enableScriptObservability(
				DISPATCH_NAMESPACE,
				workerResource.resource_name,
			);
		} catch {
			// Non-fatal: observability is nice-to-have, don't fail deployment
		}

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
	 * Get the latest live deployment for a project
	 */
	async getLatestDeployment(projectId: string): Promise<Deployment | null> {
		const deployment = await this.db
			.prepare(
				"SELECT * FROM deployments WHERE project_id = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1",
			)
			.bind(projectId)
			.first<Deployment>();

		return deployment || null;
	}

	/**
	 * Roll back a project to a previous deployment.
	 * If targetDeploymentId is provided, rolls back to that specific deployment.
	 * Otherwise, rolls back to the deployment immediately before the current live one.
	 */
	async rollbackDeployment(projectId: string, targetDeploymentId?: string): Promise<Deployment> {
		let target: Deployment;

		if (targetDeploymentId) {
			// Normalize: accept short IDs (e.g. "a1b2c3d4") or full IDs ("dep_a1b2c3d4-...")
			const lookupId = targetDeploymentId.startsWith("dep_")
				? targetDeploymentId
				: `dep_${targetDeploymentId}`;

			// Explicit target: fetch and validate (IDOR prevention — MUST check project_id)
			// Use prefix match to support short IDs from `jack deploys` output
			const found = await this.db
				.prepare(
					"SELECT * FROM deployments WHERE id LIKE ? AND project_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.bind(`${lookupId}%`, projectId)
				.first<Deployment>();

			if (!found) {
				throw new Error(
					`Deployment "${targetDeploymentId}" not found. Run 'jack deploys' to see available versions.`,
				);
			}

			if (found.status !== "live") {
				throw new Error(
					`Cannot roll back to deployment ${targetDeploymentId} because its status is "${found.status}". ` +
						"Only successful (live) deployments can be used as rollback targets.",
				);
			}

			if (
				!found.source.startsWith("code:") &&
				!found.source.startsWith("rollback:") &&
				!found.source.startsWith("prebuilt:")
			) {
				throw new Error(
					`Cannot roll back to deployment ${targetDeploymentId} because its source is "${found.source}". ` +
						"Only code, rollback, and prebuilt deployments can be used as rollback targets.",
				);
			}

			target = found;
		} else {
			// No explicit target: roll back to the deployment before the current live one
			const current = await this.db
				.prepare(
					"SELECT * FROM deployments WHERE project_id = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1",
				)
				.bind(projectId)
				.first<Deployment>();

			if (!current) {
				throw new Error(
					"No live deployment found for this project. Deploy first before rolling back.",
				);
			}

			const previous = await this.db
				.prepare(
					"SELECT * FROM deployments WHERE project_id = ? AND status = 'live' AND (source LIKE 'code:%' OR source LIKE 'rollback:%' OR source LIKE 'prebuilt:%') AND id != ? ORDER BY created_at DESC LIMIT 1",
				)
				.bind(projectId, current.id)
				.first<Deployment>();

			if (!previous) {
				throw new Error("No previous deployment found. This project has only been deployed once.");
			}

			target = previous;
		}

		// Fetch artifacts from R2 using the target deployment's artifact_bucket_key
		if (!target.artifact_bucket_key) {
			throw new Error(
				"Deployment artifacts not found in storage. " +
					"The target deployment does not have an artifact reference.",
			);
		}

		const [bundleObj, manifestObj, assetsObj] = await Promise.all([
			this.codeBucket.get(`${target.artifact_bucket_key}/bundle.zip`),
			this.codeBucket.get(`${target.artifact_bucket_key}/manifest.json`),
			this.codeBucket.get(`${target.artifact_bucket_key}/assets.zip`),
		]);

		if (!bundleObj || !manifestObj) {
			throw new Error(
				"Deployment artifacts not found in storage. " +
					"The bundle or manifest may have been cleaned up.",
			);
		}

		const [bundleZip, manifestText] = await Promise.all([
			bundleObj.arrayBuffer(),
			manifestObj.text(),
		]);
		const manifest = JSON.parse(manifestText) as ManifestData;
		const assetsZip = assetsObj ? await assetsObj.arrayBuffer() : null;

		// Create new deployment record
		const deploymentId = `dep_${crypto.randomUUID()}`;
		await this.db
			.prepare(
				`INSERT INTO deployments (id, project_id, status, source)
         VALUES (?, ?, 'queued', ?)`,
			)
			.bind(deploymentId, projectId, `rollback:${target.id}`)
			.run();

		try {
			// Deploy the code (reuse existing method)
			// Do NOT re-execute schema.sql (forward-only, could be destructive)
			// Do NOT re-apply secrets (persist on worker, re-applying could revert rotations)
			// Do NOT re-apply DO migrations (classes already exist, would 412 on tag mismatch)
			await this.deployCodeToWorker(projectId, bundleZip, manifest, deploymentId, assetsZip, undefined, { skipMigrations: true });

			// Update deployment to 'live', reuse target's artifact prefix (don't copy artifacts)
			await this.db
				.prepare(
					`UPDATE deployments SET status = 'live', artifact_bucket_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				)
				.bind(target.artifact_bucket_key, deploymentId)
				.run();

			// Refresh cache after successful deployment
			await this.refreshProjectCache(projectId);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Rollback failed";
			await this.db
				.prepare(
					`UPDATE deployments SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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
		orgId: string,
		intent: ManifestData["bindings"],
	): Promise<DispatchScriptBinding[]> {
		const bindings: DispatchScriptBinding[] = [];

		// Always add PROJECT_ID and ORG_ID as plain_text bindings
		bindings.push({
			type: "plain_text",
			name: "PROJECT_ID",
			text: projectId,
		});
		bindings.push({
			type: "plain_text",
			name: "__JACK_ORG_ID",
			text: orgId,
		});

		if (!intent) {
			return bindings;
		}

		// Resolve D1 binding
		if (intent.d1) {
			let d1Resource = await this.db
				.prepare(
					"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND binding_name = ? AND status != 'deleted'",
				)
				.bind(projectId, intent.d1.binding)
				.first<{ provider_id: string }>();

			// Fallback for projects created before binding_name was set
			if (!d1Resource) {
				d1Resource = await this.db
					.prepare(
						"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted' ORDER BY created_at ASC LIMIT 1",
					)
					.bind(projectId)
					.first<{ provider_id: string }>();
			}

			if (!d1Resource) {
				throw new Error(
					`D1 database with binding "${intent.d1.binding}" not found for project ${projectId}. Create one with: jack services db create`,
				);
			}

			bindings.push({
				type: "d1",
				name: intent.d1.binding,
				id: d1Resource.provider_id,
			});
		}

		// Resolve AI binding — route through metered proxy with unforgeable identity
		if (intent.ai) {
			// Service binding to proxy with ctx.props identity injection
			bindings.push({
				type: "service",
				name: "__AI_PROXY",
				service: "jack-binding-proxy",
				entrypoint: "ProxyEntrypoint",
				props: { projectId, orgId },
			});

			// Direct AI binding for the user's declared binding name
			bindings.push({
				type: "ai",
				name: intent.ai.binding,
			});

			// Register AI as a resource if not already registered (for UI display)
			const existingAI = await this.db
				.prepare(
					"SELECT id FROM resources WHERE project_id = ? AND resource_type = 'ai' AND binding_name = ? AND status != 'deleted'",
				)
				.bind(projectId, intent.ai.binding)
				.first();

			if (!existingAI) {
				await this.provisioningService.registerResourceWithBinding(
					projectId,
					"ai",
					intent.ai.binding,
					"workers-ai", // resource_name
					"workers-ai", // provider_id (global service)
				);
			}
		}

		// Resolve R2 bindings (provision if needed)
		if (intent.r2 && Array.isArray(intent.r2)) {
			// Get all existing R2 resources for this project
			const existingR2Resources = await this.db
				.prepare(
					"SELECT binding_name, resource_name FROM resources WHERE project_id = ? AND resource_type = 'r2' AND status != 'deleted'",
				)
				.bind(projectId)
				.all<{ binding_name: string; resource_name: string }>();

			const existingByBinding = new Map(
				(existingR2Resources.results ?? []).map((r) => [r.binding_name, r.resource_name]),
			);

			for (const r2Intent of intent.r2) {
				let bucketName = existingByBinding.get(r2Intent.binding);

				// If we don't have this R2 resource, provision it
				if (!bucketName) {
					const r2Resource = await this.provisioningService.provisionR2Binding(
						projectId,
						r2Intent.binding,
						r2Intent.bucket_name,
					);
					bucketName = r2Resource.resource_name;
				}

				bindings.push({
					type: "r2_bucket",
					name: r2Intent.binding, // Use the user's binding name
					bucket_name: bucketName,
				});
			}
		}

		if (intent.kv && Array.isArray(intent.kv)) {
			const existingKVResources = await this.db
				.prepare(
					"SELECT binding_name, provider_id FROM resources WHERE project_id = ? AND resource_type = 'kv' AND status != 'deleted'",
				)
				.bind(projectId)
				.all<{ binding_name: string; provider_id: string }>();

			const existingByBinding = new Map(
				(existingKVResources.results ?? []).map((r) => [r.binding_name, r.provider_id]),
			);

			for (const kvIntent of intent.kv) {
				let namespaceId = existingByBinding.get(kvIntent.binding);

				if (!namespaceId) {
					const kvResource = await this.provisioningService.provisionKVBinding(
						projectId,
						kvIntent.binding,
					);
					namespaceId = kvResource.provider_id;
				}

				bindings.push({
					type: "kv_namespace",
					name: kvIntent.binding,
					namespace_id: namespaceId,
				});
			}
		}

		// Resolve Vectorize bindings (provision if needed)
		if (intent.vectorize && Array.isArray(intent.vectorize)) {
			const existingVectorizeResources = await this.db
				.prepare(
					"SELECT binding_name, provider_id FROM resources WHERE project_id = ? AND resource_type = 'vectorize' AND status != 'deleted'",
				)
				.bind(projectId)
				.all<{ binding_name: string; provider_id: string }>();

			const existingByBinding = new Map(
				(existingVectorizeResources.results ?? []).map((r) => [r.binding_name, r.provider_id]),
			);

			for (const vecIntent of intent.vectorize) {
				let indexName = existingByBinding.get(vecIntent.binding);

				if (!indexName) {
					const vecResource = await this.provisioningService.provisionVectorizeBinding(
						projectId,
						vecIntent.binding,
						{
							preset: vecIntent.preset as
								| "cloudflare"
								| "cloudflare-small"
								| "cloudflare-large"
								| undefined,
							dimensions: vecIntent.dimensions,
							metric: vecIntent.metric as "cosine" | "euclidean" | "dot-product" | undefined,
						},
					);
					indexName = vecResource.provider_id;
				}

				bindings.push({
					type: "vectorize",
					name: vecIntent.binding,
					index_name: indexName,
				});
			}

			// Service binding to proxy with ctx.props identity injection for Vectorize metering
			bindings.push({
				type: "service",
				name: "__VECTORIZE_PROXY",
				service: "jack-binding-proxy",
				entrypoint: "ProxyEntrypoint",
				props: { projectId, orgId },
			});
		}

		// Resolve Durable Object bindings
		if (intent.durable_objects && Array.isArray(intent.durable_objects)) {
			for (const dob of intent.durable_objects) {
				bindings.push({
					type: "durable_object_namespace",
					name: dob.binding,
					class_name: dob.class_name,
				});
			}

			// Inject __JACK_USAGE AE binding for DO metering wrapper
			bindings.push({
				type: "analytics_engine",
				name: "__JACK_USAGE",
				dataset: "jack_do_usage",
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
				`INSERT INTO deployments (id, project_id, status, source, message)
         VALUES (?, ?, 'queued', ?, ?)`,
			)
			.bind(deploymentId, input.projectId, input.source ?? "code:v1", input.message ?? null)
			.run();

		try {
			// Store artifacts in CODE_BUCKET
			const artifactPrefix = `projects/${input.projectId}/deployments/${deploymentId}`;
			await this.codeBucket.put(`${artifactPrefix}/bundle.zip`, input.bundleZip);
			if (input.sourceZip) {
				await this.codeBucket.put(`${artifactPrefix}/source.zip`, input.sourceZip);
			}
			await this.codeBucket.put(`${artifactPrefix}/manifest.json`, JSON.stringify(input.manifest));
			if (input.assetsZip && input.assetsZip.byteLength > 0) {
				await this.codeBucket.put(`${artifactPrefix}/assets.zip`, input.assetsZip);
			}

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
				input.assetManifest,
			);

			// Update DO migration tag after successful deployment
			const manifestMigs = input.manifest.migrations;
			const manifestDOs = input.manifest.bindings?.durable_objects;
			if (manifestMigs && manifestMigs.length > 0 && manifestDOs && manifestDOs.length > 0) {
				const lastTag = manifestMigs[manifestMigs.length - 1]?.tag;
				if (lastTag) {
					await this.db
						.prepare("UPDATE projects SET do_migration_tag = ? WHERE id = ?")
						.bind(lastTag, input.projectId)
						.run();
				}
			}

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

			// Refresh cache after successful deployment
			await this.refreshProjectCache(input.projectId);
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

	private async refreshProjectCache(projectId: string): Promise<void> {
		const project = await this.db
			.prepare("SELECT * FROM projects WHERE id = ? AND status != 'deleted'")
			.bind(projectId)
			.first<{
				id: string;
				org_id: string;
				slug: string;
				owner_username: string | null;
				content_bucket_enabled: number;
			}>();

		if (!project) return;

		const workerResource = await this.db
			.prepare(
				"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'worker'",
			)
			.bind(projectId)
			.first<{ provider_id: string }>();

		const d1Resource = await this.db
			.prepare(
				"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
			)
			.bind(projectId)
			.first<{ provider_id: string }>();

		// Get existing cache to preserve d1_database_id if lookup returns nothing
		const existingCache = await this.cacheService.getProjectConfig(projectId);

		const r2Resource = project.content_bucket_enabled
			? await this.db
					.prepare(
						"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'r2_content'",
					)
					.bind(projectId)
					.first<{ provider_id: string }>()
			: null;

		// Get tier from org_billing
		const billing = await this.db
			.prepare("SELECT plan_tier FROM org_billing WHERE org_id = ?")
			.bind(project.org_id)
			.first<{ plan_tier: string }>();

		const projectConfig: ProjectConfig = {
			project_id: projectId,
			org_id: project.org_id,
			slug: project.slug,
			worker_name: workerResource?.provider_id || "",
			d1_database_id: d1Resource?.provider_id || existingCache?.d1_database_id || "",
			content_bucket_name: r2Resource?.provider_id || null,
			owner_username: project.owner_username,
			status: "active",
			tier: (billing?.plan_tier as "free" | "pro" | "team") || "free",
			updated_at: new Date().toISOString(),
		};

		await this.cacheService.setProjectConfig(projectConfig);
		await this.cacheService.setSlugLookup(project.org_id, project.slug, projectId);
		await this.cacheService.clearNotFound(project.slug, project.owner_username);
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
		precomputedAssetManifest?: AssetManifest,
		options?: { skipMigrations?: boolean },
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

		// Get org_id from project
		const project = await this.db
			.prepare("SELECT org_id FROM projects WHERE id = ?")
			.bind(projectId)
			.first<{ org_id: string }>();
		if (!project) throw new Error(`Project ${projectId} not found`);

		// Resolve bindings from manifest intent (uses manifest bindings, not legacy getBindingsForProject)
		const bindings = await this.resolveBindingsFromManifest(
			projectId,
			project.org_id,
			manifest.bindings,
		);

		// Extract all modules from the ZIP (main module and additional modules like WASM)
		const { mainModule, additionalModules } = await this.extractAllModules(
			bundleZip,
			manifest.entrypoint,
		);
		const workerCode = new TextDecoder().decode(mainModule.content);

		// Generate DO wrapper if manifest has DO bindings
		let doWrapperModule: WorkerModule | null = null;
		let doMigrations:
			| { old_tag: string; new_tag: string; steps: Array<Record<string, unknown>> }
			| undefined;

		if (manifest.bindings?.durable_objects?.length) {
			// Generate the DO metering wrapper
			const classNames = manifest.bindings.durable_objects.map((dob) => dob.class_name);

			const wrapperSource = generateDoWrapper({
				classNames,
				originalModule: mainModule.name,
				projectId,
				orgId: project.org_id,
			});

			doWrapperModule = {
				name: "__jack_do_meter.mjs",
				content: new TextEncoder().encode(wrapperSource),
				mimeType: "application/javascript+module",
			};

			// Compute migration metadata (skip on rollback — classes already exist)
			if (!options?.skipMigrations) {
				const manifestMigrations = manifest.migrations;
				if (manifestMigrations && manifestMigrations.length > 0) {
					const currentTag = await this.db
						.prepare("SELECT do_migration_tag FROM projects WHERE id = ?")
						.bind(projectId)
						.first<{ do_migration_tag: string | null }>();

					const oldTag = currentTag?.do_migration_tag ?? "";
					const lastMigration = manifestMigrations[manifestMigrations.length - 1];
					const lastMigrationTag = lastMigration?.tag ?? "";

					// Only include migrations if there are new ones to apply
					if (oldTag !== lastMigrationTag) {
						// Find migrations that need to be applied (after the old_tag)
						let startIndex = 0;
						if (oldTag) {
							const oldTagIndex = manifestMigrations.findIndex((m) => m.tag === oldTag);
							if (oldTagIndex >= 0) {
								startIndex = oldTagIndex + 1;
							}
						}

						const pendingMigrations = manifestMigrations.slice(startIndex);
						if (pendingMigrations.length > 0) {
							doMigrations = {
								old_tag: oldTag,
								new_tag: lastMigrationTag,
								steps: pendingMigrations.map((m) => {
									const step: Record<string, unknown> = {};
									if (m.new_sqlite_classes) step.new_sqlite_classes = m.new_sqlite_classes;
									if (m.deleted_classes) step.deleted_classes = m.deleted_classes;
									if (m.renamed_classes) step.renamed_classes = m.renamed_classes;
									return step;
								}),
							};
						}
					}
				}
			}
		}

		// Deploy with or without assets
		if (hasAssetsZip && hasAssetsBinding) {
			// Deploy with Workers Assets API
			await this.deployWithAssets(
				workerResource.resource_name,
				workerCode,
				bindings,
				manifest,
				assetsZip,
				precomputedAssetManifest,
				mainModule.name,
				additionalModules,
				doWrapperModule,
				doMigrations,
			);
		} else {
			// Standard deployment without assets
			const allModules = doWrapperModule
				? [
						...additionalModules,
						{ name: mainModule.name, content: mainModule.content, mimeType: mainModule.mimeType },
						doWrapperModule,
					]
				: additionalModules;

			const uploadMainModule = doWrapperModule ? "__jack_do_meter.mjs" : mainModule.name;
			const uploadCode = doWrapperModule
				? new TextDecoder().decode(doWrapperModule.content)
				: workerCode;

			await this.cfClient.uploadDispatchScript(
				DISPATCH_NAMESPACE,
				workerResource.resource_name,
				uploadCode,
				bindings,
				{
					compatibilityDate: manifest.compatibility_date,
					compatibilityFlags: manifest.compatibility_flags,
					mainModule: uploadMainModule,
					additionalModules: allModules,
					migrations: doMigrations,
				},
			);

			// Enable observability (Workers Logs) for the script
			try {
				await this.cfClient.enableScriptObservability(
					DISPATCH_NAMESPACE,
					workerResource.resource_name,
				);
			} catch {
				// Non-fatal: observability is nice-to-have, don't fail deployment
			}
		}
	}

	/**
	 * Deploy worker with assets using Workers Assets API
	 * @param precomputedManifest - Optional pre-computed asset manifest from CLI (saves CPU)
	 * @param mainModuleName - Name of the main module file
	 * @param additionalModules - Additional modules (WASM, etc.) to include in the upload
	 */
	private async deployWithAssets(
		workerName: string,
		workerCode: string,
		bindings: DispatchScriptBinding[],
		manifest: ManifestData,
		assetsZip: ArrayBuffer,
		precomputedManifest?: AssetManifest,
		mainModuleName?: string,
		additionalModules?: WorkerModule[],
		doWrapperModule?: WorkerModule | null,
		doMigrations?: { old_tag: string; new_tag: string; steps: Array<Record<string, unknown>> },
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

		// 2. Use pre-computed manifest if provided, otherwise compute hashes
		const assetManifest = precomputedManifest ?? (await createAssetManifest(assetFiles));

		// 3. Create upload session
		const session = await this.cfClient.createAssetUploadSession(
			DISPATCH_NAMESPACE,
			workerName,
			assetManifest,
		);

		// 4. Upload payloads if there are files to upload
		let completionJwt = session.jwt;

		if (session.buckets.length > 0) {
			// Build a lookup from hash to content AND path (for MIME type)
			const hashToData = new Map<string, { content: Uint8Array; path: string }>();
			for (const [path, content] of assetFiles) {
				const entry = assetManifest[path];
				if (entry) {
					hashToData.set(entry.hash, { content, path });
				}
			}

			// Build payloads for each bucket with MIME type info
			const payloads: Array<Record<string, { content: string; mimeType: string }>> = [];
			for (const bucket of session.buckets) {
				const payload: Record<string, { content: string; mimeType: string }> = {};
				for (const hash of bucket) {
					const data = hashToData.get(hash);
					if (!data) {
						throw new Error(`Content not found for asset hash: ${hash}`);
					}
					// Convert to base64
					let base64 = "";
					const chunkSize = 0x8000;
					for (let i = 0; i < data.content.length; i += chunkSize) {
						const chunk = data.content.subarray(i, Math.min(i + chunkSize, data.content.length));
						base64 += String.fromCharCode.apply(null, Array.from(chunk));
					}
					payload[hash] = {
						content: btoa(base64),
						mimeType: getMimeType(data.path),
					};
				}
				payloads.push(payload);
			}

			// Upload all payloads
			completionJwt = await this.cfClient.uploadAssetPayloads(payloads, session.jwt);
		}

		// 5. Upload script with assets binding
		const assetsBinding = manifest.bindings?.assets?.binding || "ASSETS";

		// Handle DO wrapper: wrapper becomes main_module, original main becomes additional
		const allModules = additionalModules ? [...additionalModules] : [];
		let finalMainModule = mainModuleName;
		let finalWorkerCode = workerCode;

		if (doWrapperModule) {
			// Add original main module as additional module
			allModules.push({
				name: mainModuleName ?? "worker.js",
				content: new TextEncoder().encode(workerCode),
				mimeType: "application/javascript+module",
			});
			allModules.push(doWrapperModule);
			finalMainModule = "__jack_do_meter.mjs";
			finalWorkerCode = new TextDecoder().decode(doWrapperModule.content);
		}

		await this.cfClient.uploadDispatchScriptWithAssets(
			DISPATCH_NAMESPACE,
			workerName,
			finalWorkerCode,
			bindings,
			completionJwt,
			assetsBinding,
			{
				compatibilityDate: manifest.compatibility_date,
				compatibilityFlags: manifest.compatibility_flags,
				mainModule: finalMainModule,
				additionalModules: allModules,
				assetConfig: {
					html_handling: manifest.bindings?.assets?.html_handling || "auto-trailing-slash",
					not_found_handling:
						manifest.bindings?.assets?.not_found_handling || "single-page-application",
				},
				migrations: doMigrations,
			},
		);

		// Enable observability (Workers Logs) for the script
		try {
			await this.cfClient.enableScriptObservability(DISPATCH_NAMESPACE, workerName);
		} catch {
			// Non-fatal: observability is nice-to-have, don't fail deployment
		}
	}

	/**
	 * Get MIME type for a module based on file extension
	 */
	private getModuleMimeType(filename: string): string {
		const ext = filename.split(".").pop()?.toLowerCase();
		switch (ext) {
			case "js":
			case "mjs":
				return "application/javascript+module";
			case "wasm":
				return "application/wasm";
			default:
				return "application/octet-stream";
		}
	}

	/**
	 * Extract all modules from bundle ZIP
	 */
	private async extractAllModules(
		bundleZip: ArrayBuffer,
		entrypoint: string,
	): Promise<{ mainModule: WorkerModule; additionalModules: WorkerModule[] }> {
		const files = unzipSync(new Uint8Array(bundleZip));

		let entrypointName = entrypoint;
		let entrypointData = files[entrypoint];

		if (!entrypointData) {
			const variations = [entrypoint, `${entrypoint}.js`, "worker.js", "index.js"];
			for (const name of variations) {
				if (files[name]) {
					entrypointName = name;
					entrypointData = files[name];
					break;
				}
			}
		}

		if (!entrypointData) {
			throw new Error(`Entrypoint ${entrypoint} not found in bundle`);
		}

		const mainModule: WorkerModule = {
			name: entrypointName,
			content: entrypointData,
			mimeType: this.getModuleMimeType(entrypointName),
		};

		const additionalModules: WorkerModule[] = [];
		for (const [filename, content] of Object.entries(files)) {
			if (filename === entrypointName || content.length === 0) {
				continue;
			}
			additionalModules.push({
				name: filename,
				content: content,
				mimeType: this.getModuleMimeType(filename),
			});
		}

		return { mainModule, additionalModules };
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

	/**
	 * Deploy a project from a pre-built template stored in R2
	 * Templates are stored at: bundles/jack/{templateId}-v{cliVersion}/
	 */
	async deployFromPrebuiltTemplate(
		projectId: string,
		scriptName: string,
		templateId: string,
		cliVersion: string,
	): Promise<{ deploymentId: string }> {
		const r2Prefix = `bundles/jack/${templateId}-v${cliVersion}`;

		// Fetch all artifacts from R2
		const [bundleObj, assetsObj, manifestObj, assetManifestObj, sourceObj, schemaObj] =
			await Promise.all([
				this.codeBucket.get(`${r2Prefix}/bundle.zip`),
				this.codeBucket.get(`${r2Prefix}/assets.zip`),
				this.codeBucket.get(`${r2Prefix}/manifest.json`),
				this.codeBucket.get(`${r2Prefix}/asset-manifest.json`),
				this.codeBucket.get(`${r2Prefix}/source.zip`),
				this.codeBucket.get(`${r2Prefix}/schema.sql`),
			]);

		// Validate required files exist
		if (!bundleObj || !manifestObj) {
			throw new Error(`Pre-built template not found: ${templateId}-v${cliVersion}`);
		}

		// Parse manifest
		const manifestText = await manifestObj.text();
		const manifest = JSON.parse(manifestText) as ManifestData;
		const validation = validateManifest(manifest);
		if (!validation.valid) {
			throw new Error(`Invalid template manifest: ${validation.errors.join(", ")}`);
		}

		// Parse optional asset manifest
		let precomputedAssetManifest: AssetManifest | undefined;
		if (assetManifestObj) {
			try {
				precomputedAssetManifest = JSON.parse(await assetManifestObj.text()) as AssetManifest;
			} catch {
				console.warn(
					`Invalid asset-manifest.json for ${templateId}-v${cliVersion}, will compute hashes`,
				);
			}
		}

		// Build CodeDeploymentInput and delegate to unified deploy path
		const deployment = await this.createCodeDeployment({
			projectId,
			manifest,
			bundleZip: await bundleObj.arrayBuffer(),
			sourceZip: sourceObj ? await sourceObj.arrayBuffer() : null,
			schemaSql: schemaObj ? await schemaObj.text() : null,
			secretsJson: null,
			assetsZip: assetsObj ? await assetsObj.arrayBuffer() : null,
			assetManifest: precomputedAssetManifest,
			source: `prebuilt:${templateId}-v${cliVersion}`,
		});

		return { deploymentId: deployment.id };
	}
}

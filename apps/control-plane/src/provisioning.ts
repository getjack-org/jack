import { CloudflareClient, type DispatchScriptBinding } from "./cloudflare-api";
import { ProjectCacheService } from "./repositories/project-cache-service";
import type { Bindings, Project, ProjectConfig, ProjectLimits, Resource } from "./types";

const DISPATCH_NAMESPACE = "jack-tenants";

// Omakase presets for Vectorize (match Cloudflare AI embedding models)
const VECTORIZE_PRESETS = {
	cloudflare: { dimensions: 768, metric: "cosine" as const }, // bge-base-en-v1.5
	"cloudflare-small": { dimensions: 384, metric: "cosine" as const }, // bge-small-en-v1.5
	"cloudflare-large": { dimensions: 1024, metric: "cosine" as const }, // bge-large-en-v1.5
} as const;

// Minimal ES module worker that returns 503 with JSON message
const STUB_WORKER_SCRIPT = `export default {
	fetch: () => new Response(
		JSON.stringify({ error: "Project is being set up. Deploy your code with 'jack ship'." }),
		{ status: 503, headers: { "Content-Type": "application/json" } }
	)
};`;

/**
 * Normalizes a string into a URL-safe slug.
 * Applies: lowercase, replace non-alphanumeric with hyphens, trim hyphens, limit length.
 */
export function normalizeSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
}

/**
 * Validates a slug and returns an error message if invalid, or null if valid.
 */
export function validateSlug(slug: string): string | null {
	if (!slug || slug.trim() === "") {
		return "Slug cannot be empty";
	}

	const normalized = normalizeSlug(slug);

	if (normalized === "") {
		return "Slug must contain at least one alphanumeric character";
	}

	if (normalized !== slug) {
		return `Slug must be URL-safe (lowercase letters, numbers, hyphens). Did you mean: "${normalized}"?`;
	}

	return null;
}

export class ProvisioningService {
	private db: D1Database;
	private cache: KVNamespace;
	private cfClient: CloudflareClient;
	private cacheService: ProjectCacheService;

	constructor(env: Bindings) {
		this.db = env.DB;
		this.cache = env.PROJECTS_CACHE;
		this.cfClient = new CloudflareClient(env);
		this.cacheService = new ProjectCacheService(env.PROJECTS_CACHE);
	}

	/**
	 * Generate a URL-safe slug from a project name.
	 * Throws if the name cannot produce a valid slug.
	 */
	generateSlug(name: string): string {
		const slug = normalizeSlug(name);
		if (slug === "") {
			throw new Error("Project name must contain at least one alphanumeric character");
		}
		return slug;
	}

	/**
	 * Get resource names derived from project ID
	 */
	getResourceNames(projectId: string): {
		worker: string;
		d1: string;
		r2Content: string;
		codeBucketPrefix: string;
	} {
		const shortId = projectId.replace("proj_", "").slice(0, 16);
		return {
			worker: `jack-${shortId}`,
			d1: `jack-${shortId}-db`,
			r2Content: `jack-${shortId}-content`,
			codeBucketPrefix: `projects/${projectId}/`,
		};
	}

	/**
	 * Create a new project with provisioned resources
	 */
	async createProject(
		orgId: string,
		name: string,
		slug?: string,
		enableContentBucket = false,
		ownerUsername: string | null = null,
	): Promise<{ project: Project; resources: Resource[] }> {
		const projectId = `proj_${crypto.randomUUID()}`;
		const projectSlug = slug || this.generateSlug(name);

		const existingSlug = await this.db
			.prepare("SELECT id FROM projects WHERE slug = ? AND org_id = ? AND status != 'deleted'")
			.bind(projectSlug, orgId)
			.first<{ id: string }>();

		if (existingSlug) {
			throw new Error(`You already have a project with slug "${projectSlug}"`);
		}

		const resourceNames = this.getResourceNames(projectId);

		// Insert project with status 'provisioning'
		await this.db
			.prepare(
				`INSERT INTO projects (id, org_id, name, slug, status, code_bucket_prefix, content_bucket_enabled, owner_username)
         VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
			)
			.bind(
				projectId,
				orgId,
				name,
				projectSlug,
				resourceNames.codeBucketPrefix,
				enableContentBucket ? 1 : 0,
				ownerUsername,
			)
			.run();

		const resources: Resource[] = [];

		try {
			// Create D1 database
			const d1Database = await this.cfClient.createD1Database(resourceNames.d1);
			const d1Resource = await this.registerResource(
				projectId,
				"d1",
				resourceNames.d1,
				d1Database.uuid,
				"DB", // Default binding name for initial D1
			);
			resources.push(d1Resource);

			// Create R2 bucket if enabled
			let r2Resource: Resource | null = null;
			if (enableContentBucket) {
				const r2Bucket = await this.cfClient.createR2Bucket(resourceNames.r2Content);
				r2Resource = await this.registerResource(
					projectId,
					"r2_content",
					resourceNames.r2Content,
					resourceNames.r2Content,
				);
				resources.push(r2Resource);
			}

			// Build worker bindings
			const bindings: DispatchScriptBinding[] = [
				{
					type: "d1",
					name: "DB",
					id: d1Database.uuid,
				},
				{
					type: "plain_text",
					name: "PROJECT_ID",
					text: projectId,
				},
			];

			if (enableContentBucket && r2Resource) {
				bindings.push({
					type: "r2_bucket",
					name: "CONTENT",
					bucket_name: resourceNames.r2Content,
				});
			}

			// Upload stub worker to dispatch namespace
			await this.cfClient.uploadDispatchScript(
				DISPATCH_NAMESPACE,
				resourceNames.worker,
				STUB_WORKER_SCRIPT,
				bindings,
			);

			// Enable observability (Workers Logs) for the script
			try {
				await this.cfClient.enableScriptObservability(DISPATCH_NAMESPACE, resourceNames.worker);
			} catch {
				// Non-fatal: observability is nice-to-have
			}

			const workerResource = await this.registerResource(
				projectId,
				"worker",
				resourceNames.worker,
				resourceNames.worker,
			);
			resources.push(workerResource);

			// Update project status to 'active'
			await this.db
				.prepare(
					"UPDATE projects SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
				)
				.bind(projectId)
				.run();

			// Write ProjectConfig to KV cache
			const projectConfig: ProjectConfig = {
				project_id: projectId,
				org_id: orgId,
				slug: projectSlug,
				worker_name: resourceNames.worker,
				d1_database_id: d1Database.uuid,
				content_bucket_name: enableContentBucket ? resourceNames.r2Content : null,
				owner_username: ownerUsername,
				status: "active",
				updated_at: new Date().toISOString(),
			};

			await this.cacheService.setProjectConfig(projectConfig);
			await this.cacheService.setSlugLookup(orgId, projectSlug, projectId);
			await this.cacheService.clearNotFound(projectSlug, ownerUsername);

			// Fetch the final project state
			const project = await this.getProject(projectId);
			if (!project) {
				throw new Error("Failed to retrieve created project");
			}

			return { project, resources };
		} catch (error) {
			// Update project status to 'error'
			await this.db
				.prepare(
					"UPDATE projects SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
				)
				.bind(projectId)
				.run();

			// Clean up any cache entries that may have been written
			await this.cacheService.invalidateProject(projectId, projectSlug, orgId, ownerUsername);

			throw error;
		}
	}

	/**
	 * Enable content bucket for an existing project.
	 * This is idempotent: repeated calls will succeed if already enabled.
	 * Uses settings API to add binding without overwriting deployed code.
	 */
	async enableContentBucket(projectId: string): Promise<Resource> {
		const project = await this.getProject(projectId);
		if (!project) {
			throw new Error(`Project ${projectId} not found`);
		}

		const resourceNames = this.getResourceNames(projectId);

		// Check if R2 resource already exists in DB (retry-safe)
		const existingR2Resource = await this.db
			.prepare(
				"SELECT * FROM resources WHERE project_id = ? AND resource_type = 'r2_content' AND status != 'deleted'",
			)
			.bind(projectId)
			.first<Resource>();

		// If already fully enabled (DB flag + resource exists), return the existing resource
		if (project.content_bucket_enabled === 1 && existingR2Resource) {
			return existingR2Resource;
		}

		// Create R2 bucket if it doesn't exist (idempotent)
		await this.cfClient.createR2BucketIfNotExists(resourceNames.r2Content);

		// Register resource in DB if not already registered
		let r2Resource: Resource;
		if (existingR2Resource) {
			r2Resource = existingR2Resource;
		} else {
			r2Resource = await this.registerResource(
				projectId,
				"r2_content",
				resourceNames.r2Content,
				resourceNames.r2Content,
			);
		}

		// Get existing D1 resource to rebuild bindings
		const d1Resource = await this.db
			.prepare("SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1'")
			.bind(projectId)
			.first<{ provider_id: string }>();

		if (!d1Resource) {
			throw new Error("D1 database resource not found");
		}

		// Build complete bindings list (must include all bindings, not just new ones)
		const bindings: DispatchScriptBinding[] = [
			{
				type: "d1",
				name: "DB",
				id: d1Resource.provider_id,
			},
			{
				type: "plain_text",
				name: "PROJECT_ID",
				text: projectId,
			},
			{
				type: "r2_bucket",
				name: "CONTENT",
				bucket_name: resourceNames.r2Content,
			},
		];

		// Update worker settings (bindings only, preserves deployed code)
		await this.cfClient.updateDispatchScriptSettings(
			DISPATCH_NAMESPACE,
			resourceNames.worker,
			bindings,
		);

		// Only update project record AFTER settings update succeeds
		if (project.content_bucket_enabled !== 1) {
			await this.db
				.prepare(
					"UPDATE projects SET content_bucket_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
				)
				.bind(projectId)
				.run();
		}

		// Update KV cache via cache service
		const updated = await this.cacheService.updateProjectConfig(projectId, {
			content_bucket_name: resourceNames.r2Content,
		});

		if (!updated) {
			// Cache miss - rebuild and write full config
			const projectRecord = await this.db
				.prepare("SELECT * FROM projects WHERE id = ?")
				.bind(projectId)
				.first<{ id: string; org_id: string; slug: string; owner_username: string | null }>();

			if (projectRecord) {
				const workerResource = await this.db
					.prepare(
						"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'worker'",
					)
					.bind(projectId)
					.first<{ provider_id: string }>();

				const d1ResourceRecord = await this.db
					.prepare(
						"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
					)
					.bind(projectId)
					.first<{ provider_id: string }>();

				// Get existing cache to preserve d1_database_id if lookup returns nothing
				const existingCache = await this.cacheService.getProjectConfig(projectId);

				const projectConfig: ProjectConfig = {
					project_id: projectId,
					org_id: projectRecord.org_id,
					slug: projectRecord.slug,
					worker_name: workerResource?.provider_id || "",
					d1_database_id: d1ResourceRecord?.provider_id || existingCache?.d1_database_id || "",
					content_bucket_name: resourceNames.r2Content,
					owner_username: projectRecord.owner_username,
					status: "active",
					updated_at: new Date().toISOString(),
				};
				await this.cacheService.setProjectConfig(projectConfig);
			}
		}

		return r2Resource;
	}

	/**
	 * Register a resource in the database
	 */
	async registerResource(
		projectId: string,
		type: "worker" | "d1" | "r2_content",
		name: string,
		providerId: string,
		bindingName?: string,
	): Promise<Resource> {
		const resourceId = `res_${crypto.randomUUID()}`;

		if (bindingName) {
			await this.db
				.prepare(
					`INSERT INTO resources (id, project_id, resource_type, binding_name, resource_name, provider_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
				)
				.bind(resourceId, projectId, type, bindingName, name, providerId)
				.run();
		} else {
			await this.db
				.prepare(
					`INSERT INTO resources (id, project_id, resource_type, resource_name, provider_id, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
				)
				.bind(resourceId, projectId, type, name, providerId)
				.run();
		}

		const resource = await this.db
			.prepare("SELECT * FROM resources WHERE id = ?")
			.bind(resourceId)
			.first<Resource>();

		if (!resource) {
			throw new Error("Failed to retrieve created resource");
		}

		return resource;
	}

	/**
	 * Register a resource with a specific binding name.
	 * Used for user-defined bindings (e.g., R2 buckets, KV namespaces, and Vectorize indexes from wrangler.jsonc).
	 */
	async registerResourceWithBinding(
		projectId: string,
		type: "r2" | "kv" | "vectorize",
		bindingName: string,
		resourceName: string,
		providerId: string,
	): Promise<Resource> {
		const resourceId = `res_${crypto.randomUUID()}`;

		await this.db
			.prepare(
				`INSERT INTO resources (id, project_id, resource_type, binding_name, resource_name, provider_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
			)
			.bind(resourceId, projectId, type, bindingName, resourceName, providerId)
			.run();

		const resource = await this.db
			.prepare("SELECT * FROM resources WHERE id = ?")
			.bind(resourceId)
			.first<Resource>();

		if (!resource) {
			throw new Error("Failed to retrieve created resource");
		}

		return resource;
	}

	/**
	 * Provision an R2 bucket for a specific binding.
	 */
	async provisionR2Binding(
		projectId: string,
		bindingName: string,
		bucketNameHint: string,
	): Promise<Resource> {
		this.validateBindingName(bindingName);

		const resourceNames = this.getResourceNames(projectId);
		const bucketName = `${resourceNames.worker}-${this.sanitizeBucketName(bucketNameHint)}`;

		await this.cfClient.createR2BucketIfNotExists(bucketName);

		return await this.registerResourceWithBinding(
			projectId,
			"r2",
			bindingName,
			bucketName,
			bucketName,
		);
	}

	/**
	 * Validates that a binding name is a valid JavaScript identifier.
	 */
	private validateBindingName(bindingName: string): void {
		const validIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
		if (!validIdentifier.test(bindingName)) {
			throw new Error(
				`Invalid binding name "${bindingName}". ` +
					"Binding names must be valid JavaScript identifiers (e.g., CACHE, MY_KV, userSession).",
			);
		}
	}

	/**
	 * Provision a KV namespace for a specific binding.
	 */
	async provisionKVBinding(projectId: string, bindingName: string): Promise<Resource> {
		this.validateBindingName(bindingName);

		const resourceNames = this.getResourceNames(projectId);
		const title = `${resourceNames.worker}-${bindingName.toLowerCase()}`;

		const { namespace } = await this.cfClient.createKVNamespaceIfNotExists(title);

		return await this.registerResourceWithBinding(
			projectId,
			"kv",
			bindingName,
			title,
			namespace.id,
		);
	}

	/**
	 * Provision a Vectorize index for a specific binding.
	 */
	async provisionVectorizeBinding(
		projectId: string,
		bindingName: string,
		options?: {
			preset?: keyof typeof VECTORIZE_PRESETS;
			dimensions?: number;
			metric?: "cosine" | "euclidean" | "dot-product";
		},
	): Promise<Resource> {
		this.validateBindingName(bindingName);

		const resourceNames = this.getResourceNames(projectId);
		const indexName = `${resourceNames.worker}-${bindingName.toLowerCase()}`;

		// Determine dimensions and metric from options
		let dimensions: number;
		let metric: "cosine" | "euclidean" | "dot-product";

		if (options?.preset) {
			const preset = VECTORIZE_PRESETS[options.preset];
			if (!preset) {
				throw new Error(
					`Invalid Vectorize preset "${options.preset}". ` +
						`Valid presets: ${Object.keys(VECTORIZE_PRESETS).join(", ")}`,
				);
			}
			dimensions = options.dimensions ?? preset.dimensions;
			metric = options.metric ?? preset.metric;
		} else {
			// Use cloudflare default (768 dimensions, cosine) if no preset specified
			dimensions = options?.dimensions ?? VECTORIZE_PRESETS.cloudflare.dimensions;
			metric = options?.metric ?? VECTORIZE_PRESETS.cloudflare.metric;
		}

		const { index } = await this.cfClient.createVectorizeIndexIfNotExists(
			indexName,
			dimensions,
			metric,
		);

		return await this.registerResourceWithBinding(
			projectId,
			"vectorize",
			bindingName,
			indexName,
			index.name, // provider_id is the index name for Vectorize
		);
	}

	/**
	 * Sanitize a bucket name hint to be R2-compatible.
	 * R2 bucket names: 3-63 chars, lowercase letters, numbers, hyphens.
	 */
	private sanitizeBucketName(hint: string): string {
		return hint
			.toLowerCase()
			.replace(/^jack-template-/, "") // Remove template prefix
			.replace(/[^a-z0-9-]/g, "-") // Replace invalid chars with hyphens
			.replace(/-+/g, "-") // Collapse multiple hyphens
			.replace(/^-|-$/g, "") // Trim leading/trailing hyphens
			.slice(0, 30); // Limit length (leave room for prefix)
	}

	/**
	 * Get a project by ID
	 */
	async getProject(projectId: string): Promise<Project | null> {
		const project = await this.db
			.prepare("SELECT * FROM projects WHERE id = ? AND status != 'deleted'")
			.bind(projectId)
			.first<Project>();

		return project || null;
	}

	/**
	 * List all projects for an organization
	 */
	async listProjectsByOrg(orgId: string): Promise<Project[]> {
		const result = await this.db
			.prepare(
				"SELECT * FROM projects WHERE org_id = ? AND status != 'deleted' ORDER BY created_at DESC",
			)
			.bind(orgId)
			.all<Project>();

		return result.results || [];
	}

	/**
	 * Get all resources for a project
	 */
	async getProjectResources(projectId: string): Promise<Resource[]> {
		const result = await this.db
			.prepare(
				"SELECT * FROM resources WHERE project_id = ? AND status != 'deleted' ORDER BY created_at ASC",
			)
			.bind(projectId)
			.all<Resource>();

		return result.results || [];
	}

	/**
	 * Create a resource for an existing project.
	 * Supports D1 databases (KV and R2 planned for future).
	 */
	async createResourceForProject(
		projectId: string,
		resourceType: "d1" | "kv" | "r2",
		options: { name?: string; bindingName?: string } = {},
	): Promise<Resource> {
		const project = await this.getProject(projectId);
		if (!project) {
			throw new Error(`Project ${projectId} not found`);
		}

		const resourceNames = this.getResourceNames(projectId);

		switch (resourceType) {
			case "d1": {
				// Count existing D1 databases for this project
				const existingD1s = await this.db
					.prepare(
						"SELECT COUNT(*) as count FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
					)
					.bind(projectId)
					.first<{ count: number }>();

				const d1Count = existingD1s?.count ?? 0;

				// Generate resource name with suffix for additional DBs
				const suffix = options.name
					? `-${this.sanitizeBucketName(options.name)}`
					: `-db${d1Count + 1}`;
				const dbName = `${resourceNames.worker}${suffix}`;

				// Determine binding name: first DB uses "DB", others use SCREAMING_SNAKE_CASE of name or numbered
				let bindingName: string;
				if (options.bindingName) {
					bindingName = options.bindingName;
				} else if (d1Count === 0) {
					bindingName = "DB";
				} else if (options.name) {
					// Convert name to SCREAMING_SNAKE_CASE
					bindingName = options.name
						.toUpperCase()
						.replace(/[^A-Z0-9]+/g, "_")
						.replace(/^_|_$/g, "");
				} else {
					bindingName = `DB_${d1Count + 1}`;
				}

				this.validateBindingName(bindingName);

				// Create the D1 database
				const d1Database = await this.cfClient.createD1Database(dbName);

				// Register resource with binding name
				const resourceId = `res_${crypto.randomUUID()}`;
				await this.db
					.prepare(
						`INSERT INTO resources (id, project_id, resource_type, binding_name, resource_name, provider_id, status)
						 VALUES (?, ?, ?, ?, ?, ?, 'active')`,
					)
					.bind(resourceId, projectId, "d1", bindingName, dbName, d1Database.uuid)
					.run();

				const resource = await this.db
					.prepare("SELECT * FROM resources WHERE id = ?")
					.bind(resourceId)
					.first<Resource>();

				if (!resource) {
					throw new Error("Failed to retrieve created resource");
				}

				return resource;
			}

			case "kv": {
				// TODO: Implement KV namespace creation
				throw new Error(
					"KV namespace creation not yet implemented. Use provisionKVBinding() for now.",
				);
			}

			case "r2": {
				// TODO: Implement R2 bucket creation
				throw new Error(
					"R2 bucket creation not yet implemented. Use provisionR2Binding() for now.",
				);
			}

			default: {
				const _exhaustive: never = resourceType;
				throw new Error(`Unknown resource type: ${resourceType}`);
			}
		}
	}

	/**
	 * Update project limits
	 */
	async updateProjectLimits(
		projectId: string,
		limits?: { requests_per_minute?: number },
	): Promise<void> {
		if (!limits) {
			return;
		}

		let existingConfig = await this.cacheService.getProjectConfig(projectId);

		if (!existingConfig) {
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

			if (!project) {
				throw new Error(`Project ${projectId} not found`);
			}

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

			const r2Resource = project.content_bucket_enabled
				? await this.db
						.prepare(
							"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'r2_content'",
						)
						.bind(projectId)
						.first<{ provider_id: string }>()
				: null;

			existingConfig = {
				project_id: projectId,
				org_id: project.org_id,
				slug: project.slug,
				worker_name: workerResource?.provider_id || "",
				d1_database_id: d1Resource?.provider_id || "",
				content_bucket_name: r2Resource?.provider_id || null,
				owner_username: project.owner_username,
				status: "active",
				updated_at: new Date().toISOString(),
			};
		}

		const mergedLimits = { ...existingConfig.limits, ...limits };
		await this.cacheService.updateProjectConfig(projectId, { limits: mergedLimits });
	}
}

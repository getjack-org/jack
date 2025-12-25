import { verifyJwt } from "@getjack/auth";
import type { JwtPayload } from "@getjack/auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CloudflareClient } from "./cloudflare-api";
import { DeploymentService, validateManifest } from "./deployment-service";
import { ProvisioningService, normalizeSlug, validateSlug } from "./provisioning";
import type { Bindings } from "./types";

type WorkosJwtPayload = JwtPayload & {
	org_id?: string;
};

type AuthContext = {
	userId: string;
	orgId: string;
	workosUserId: string;
	workosOrgId: string | null;
	email: string;
	firstName?: string;
	lastName?: string;
};

declare module "hono" {
	interface ContextVariableMap {
		auth: AuthContext;
	}
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);

app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-control" });
});

// Registration endpoint - called by CLI after login to sync user info
app.post("/v1/register", async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "unauthorized", message: "Missing Authorization header" }, 401);
	}

	const token = authHeader.slice(7);
	let payload: WorkosJwtPayload;
	try {
		payload = (await verifyJwt(token)) as WorkosJwtPayload;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Token verification failed";
		return c.json({ error: "unauthorized", message }, 401);
	}

	if (!payload.sub) {
		return c.json({ error: "invalid_token", message: "Missing subject in token" }, 400);
	}

	// Get user info from request body (provided by CLI from token response)
	const body = await c.req.json<{ email: string; first_name?: string; last_name?: string }>();
	if (!body.email) {
		return c.json({ error: "invalid_request", message: "Email is required" }, 400);
	}

	// Create or update user
	const existing = await c.env.DB.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	const userId = existing?.id ?? `usr_${crypto.randomUUID()}`;

	await c.env.DB.prepare(
		`INSERT INTO users (id, workos_user_id, email, first_name, last_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workos_user_id) DO UPDATE SET
       email = excluded.email,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(userId, payload.sub, body.email, body.first_name ?? null, body.last_name ?? null)
		.run();

	// Ensure personal org exists
	const org = await ensureOrgForUser(c.env.DB, userId, payload);

	return c.json({
		user: { id: userId, email: body.email, first_name: body.first_name, last_name: body.last_name },
		org: { id: org.orgId, workos_org_id: org.workosOrgId },
	});
});

const api = new Hono<{ Bindings: Bindings }>();

api.use("/*", async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{ error: "unauthorized", message: "Missing or invalid Authorization header" },
			401,
		);
	}

	const token = authHeader.slice(7);
	try {
		const auth = await verifyAuth(token, c.env.DB);
		c.set("auth", auth);
		await next();
	} catch (error) {
		const message = error instanceof Error ? error.message : "Token verification failed";
		return c.json({ error: "unauthorized", message }, 401);
	}
});

api.get("/me", async (c) => {
	const auth = c.get("auth");
	const user = await c.env.DB.prepare(
		"SELECT id, email, first_name, last_name, created_at, updated_at FROM users WHERE id = ?",
	)
		.bind(auth.userId)
		.first();
	const org = await c.env.DB.prepare(
		"SELECT id, name, workos_org_id, created_at, updated_at FROM orgs WHERE id = ?",
	)
		.bind(auth.orgId)
		.first();

	return c.json({ auth, user, org });
});

api.get("/orgs", async (c) => {
	const auth = c.get("auth");
	const result = await c.env.DB.prepare(
		`SELECT orgs.id, orgs.name, orgs.workos_org_id, org_memberships.role
     FROM orgs
     JOIN org_memberships ON orgs.id = org_memberships.org_id
     WHERE org_memberships.user_id = ?
     ORDER BY org_memberships.created_at ASC`,
	)
		.bind(auth.userId)
		.all();

	return c.json({ orgs: result.results });
});

api.get("/orgs/:orgId", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");
	const org = await c.env.DB.prepare(
		`SELECT orgs.id, orgs.name, orgs.workos_org_id, org_memberships.role
     FROM orgs
     JOIN org_memberships ON orgs.id = org_memberships.org_id
     WHERE orgs.id = ? AND org_memberships.user_id = ?`,
	)
		.bind(orgId, auth.userId)
		.first();

	if (!org) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	return c.json({ org });
});

// Slug availability check
api.get("/slugs/:slug/available", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	// Validate slug format first
	const slugError = validateSlug(slug);
	if (slugError) {
		return c.json({ available: false, error: slugError }, 200);
	}

	// Check if slug exists globally
	const existing = await c.env.DB.prepare(
		"SELECT id FROM projects WHERE slug = ? AND status != 'deleted'",
	)
		.bind(slug)
		.first<{ id: string }>();

	return c.json({
		available: !existing,
		slug,
	});
});

// Project endpoints
api.post("/projects", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{ name: string; slug?: string; content_bucket?: boolean }>();

	if (!body.name) {
		return c.json({ error: "invalid_request", message: "Name is required" }, 400);
	}

	// Validate or normalize slug
	let slug: string | undefined;
	if (body.slug !== undefined) {
		// User provided a slug - validate it strictly
		const slugError = validateSlug(body.slug);
		if (slugError) {
			return c.json({ error: "invalid_request", message: slugError }, 400);
		}
		slug = body.slug;
	} else {
		// Auto-generate from name - normalize it
		const normalized = normalizeSlug(body.name);
		if (normalized === "") {
			return c.json(
				{
					error: "invalid_request",
					message: "Project name must contain at least one alphanumeric character",
				},
				400,
			);
		}
		slug = normalized;
	}

	const provisioning = new ProvisioningService(c.env);
	try {
		const result = await provisioning.createProject(
			auth.orgId,
			body.name,
			slug,
			body.content_bucket ?? false,
		);
		return c.json(result, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Project creation failed";
		if (message.includes("already exists") || message.includes("projects.slug")) {
			return c.json({ error: "conflict", message }, 409);
		}
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects", async (c) => {
	const auth = c.get("auth");
	const provisioning = new ProvisioningService(c.env);
	const projects = await provisioning.listProjectsByOrg(auth.orgId);
	return c.json({ projects });
});

api.get("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	return c.json({ project });
});

api.get("/projects/:projectId/resources", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const resources = await provisioning.getProjectResources(projectId);
	return c.json({ resources });
});

api.post("/projects/:projectId/content-bucket", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	try {
		// enableContentBucket is idempotent - repeated calls succeed
		const resource = await provisioning.enableContentBucket(projectId);
		return c.json({
			success: true,
			message: "Content bucket enabled",
			resource: { id: resource.id, resource_name: resource.resource_name },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to enable content bucket";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.patch("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Parse request body
	const body = await c.req.json<{ limits?: { requests_per_minute?: number } }>();

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Validate limits
	if (body.limits?.requests_per_minute !== undefined) {
		const rpm = body.limits.requests_per_minute;
		if (!Number.isInteger(rpm) || rpm < 1 || rpm > 100000) {
			return c.json(
				{
					error: "invalid_request",
					message: "requests_per_minute must be an integer between 1 and 100000",
				},
				400,
			);
		}
	}

	try {
		// Update project limits
		await provisioning.updateProjectLimits(projectId, body.limits);

		// Return updated project
		const updatedProject = await provisioning.getProject(projectId);
		return c.json({ project: updatedProject });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update project limits";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Database export endpoint
api.get("/projects/:projectId/database/export", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get D1 resource
	const d1Resource = await c.env.DB.prepare(
		"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ provider_id: string }>();

	if (!d1Resource) {
		return c.json({ error: "not_found", message: "No database found for project" }, 404);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const signedUrl = await cfClient.exportD1Database(d1Resource.provider_id, 60000);

		return c.json({
			success: true,
			download_url: signedUrl,
			expires_in: 3600,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Export failed";

		if (message.includes("timed out")) {
			return c.json(
				{
					error: "timeout",
					message: "Database export timed out. The database may be too large.",
				},
				504,
			);
		}

		return c.json({ error: "export_failed", message }, 500);
	}
});

// Project deletion endpoint
api.delete("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get all resources
	const resources = await c.env.DB.prepare(
		"SELECT * FROM resources WHERE project_id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.all<{ resource_type: string; resource_name: string; provider_id: string }>();

	const cfClient = new CloudflareClient(c.env);
	const deletionResults: Array<{ resource: string; success: boolean; error?: string }> = [];

	// Delete dispatch worker
	const workerResource = resources.results?.find((r) => r.resource_type === "worker");
	if (workerResource) {
		try {
			await cfClient.deleteDispatchScript("jack-tenants", workerResource.resource_name);
			deletionResults.push({ resource: "worker", success: true });
		} catch (error) {
			deletionResults.push({ resource: "worker", success: false, error: String(error) });
		}
	}

	// Delete D1 database
	const d1Resource = resources.results?.find((r) => r.resource_type === "d1");
	if (d1Resource) {
		try {
			await cfClient.deleteD1Database(d1Resource.provider_id);
			deletionResults.push({ resource: "d1", success: true });
		} catch (error) {
			deletionResults.push({ resource: "d1", success: false, error: String(error) });
		}
	}

	// Delete R2 content bucket
	const r2Resource = resources.results?.find((r) => r.resource_type === "r2_content");
	if (r2Resource) {
		try {
			await cfClient.deleteR2Bucket(r2Resource.resource_name);
			deletionResults.push({ resource: "r2_content", success: true });
		} catch (error) {
			deletionResults.push({ resource: "r2_content", success: false, error: String(error) });
		}
	}

	// Delete code bucket objects
	try {
		const prefix = `projects/${projectId}/`;
		const objects = await c.env.CODE_BUCKET.list({ prefix });
		for (const obj of objects.objects) {
			await c.env.CODE_BUCKET.delete(obj.key);
		}
		deletionResults.push({ resource: "code_bucket", success: true });
	} catch (error) {
		deletionResults.push({ resource: "code_bucket", success: false, error: String(error) });
	}

	// Delete KV cache entries
	try {
		await c.env.PROJECTS_CACHE.delete(`project:${projectId}`);
		await c.env.PROJECTS_CACHE.delete(`config:${project.slug}`);
		await c.env.PROJECTS_CACHE.delete(`slug:${project.org_id}:${project.slug}`);
		deletionResults.push({ resource: "kv_cache", success: true });
	} catch (error) {
		deletionResults.push({ resource: "kv_cache", success: false, error: String(error) });
	}

	// Soft-delete in DB
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		"UPDATE projects SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
	)
		.bind(now, now, projectId)
		.run();

	await c.env.DB.prepare("UPDATE resources SET status = 'deleted' WHERE project_id = ?")
		.bind(projectId)
		.run();

	const failures = deletionResults.filter((r) => !r.success);

	return c.json({
		success: true,
		project_id: projectId,
		deleted_at: now,
		resources: deletionResults,
		warnings:
			failures.length > 0
				? `Some resources could not be deleted: ${failures.map((f) => f.resource).join(", ")}`
				: undefined,
	});
});

// Deployment endpoints
api.post("/projects/:projectId/deployments", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse and validate request body
	const body = await c.req.json<{ source: string }>();
	if (!body.source) {
		return c.json({ error: "invalid_request", message: "Source is required" }, 400);
	}

	// Validate source format (only template: supported for now)
	if (!body.source.startsWith("template:")) {
		return c.json(
			{ error: "invalid_request", message: "Only template: sources are supported" },
			400,
		);
	}

	try {
		const deploymentService = new DeploymentService(c.env);
		const deployment = await deploymentService.createDeployment(projectId, body.source);
		return c.json(deployment, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Deployment creation failed";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.post("/projects/:projectId/deployments/upload", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse multipart form data
	const formData = await c.req.formData();

	// Extract required parts
	const manifestFile = formData.get("manifest") as File | null;
	const bundleFile = formData.get("bundle") as File | null;
	const sourceFile = formData.get("source") as File | null;
	const schemaFile = formData.get("schema") as File | null;
	const secretsFile = formData.get("secrets") as File | null;
	const assetsFile = formData.get("assets") as File | null;

	// Validate required parts
	if (!manifestFile || !bundleFile) {
		return c.json({ error: "invalid_request", message: "manifest and bundle are required" }, 400);
	}

	try {
		// Parse manifest JSON
		const manifestText = await manifestFile.text();
		const manifest = JSON.parse(manifestText);

		// Validate manifest at API boundary (defense-in-depth)
		const manifestValidation = validateManifest(manifest);
		if (!manifestValidation.valid) {
			return c.json(
				{
					error: "invalid_manifest",
					message: "Manifest validation failed",
					details: manifestValidation.errors,
				},
				400,
			);
		}

		// Validate assets consistency at API boundary
		const hasAssetsFile = !!assetsFile;
		const hasAssetsBinding = !!manifest.bindings?.assets;

		if (hasAssetsBinding && !hasAssetsFile) {
			return c.json(
				{
					error: "missing_assets",
					message:
						"Assets binding declared in manifest but assets.zip is missing. " +
						"The deployment would fail at runtime when accessing env.ASSETS.",
				},
				400,
			);
		}

		if (hasAssetsFile && !hasAssetsBinding) {
			return c.json(
				{
					error: "orphan_assets",
					message:
						"assets.zip provided but no assets binding in manifest. " +
						"Add an assets section to wrangler.jsonc to enable static file serving.",
				},
				400,
			);
		}

		// Read file contents as ArrayBuffer
		const bundleData = await bundleFile.arrayBuffer();
		const sourceData = sourceFile ? await sourceFile.arrayBuffer() : null;
		const schemaText = schemaFile ? await schemaFile.text() : null;
		const secretsText = secretsFile ? await secretsFile.text() : null;
		const secretsJson = secretsText ? JSON.parse(secretsText) : null;
		const assetsData = assetsFile ? await assetsFile.arrayBuffer() : null;

		// Call DeploymentService.createCodeDeployment()
		const deploymentService = new DeploymentService(c.env);
		const deployment = await deploymentService.createCodeDeployment({
			projectId,
			manifest,
			bundleZip: bundleData,
			sourceZip: sourceData,
			schemaSql: schemaText,
			secretsJson,
			assetsZip: assetsData,
		});

		return c.json(deployment, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Deployment creation failed";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/deployments", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const deploymentService = new DeploymentService(c.env);
	const deployments = await deploymentService.listDeployments(projectId);
	return c.json({ deployments });
});

app.route("/v1", api);

export default app;

async function verifyAuth(token: string, db: D1Database): Promise<AuthContext> {
	const payload = (await verifyJwt(token)) as WorkosJwtPayload;
	if (!payload.sub) {
		throw new Error("Missing subject in token");
	}

	// WorkOS JWTs don't include user info - look up from DB
	const existingUser = await db
		.prepare("SELECT id, email, first_name, last_name FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string; email: string; first_name: string | null; last_name: string | null }>();

	if (!existingUser) {
		// New user - they need to have logged in via CLI first which stores user info
		throw new Error("User not found. Please login via CLI first.");
	}

	const org = await ensureOrgForUser(db, existingUser.id, payload);

	return {
		userId: existingUser.id,
		orgId: org.orgId,
		workosUserId: payload.sub,
		workosOrgId: org.workosOrgId,
		email: existingUser.email,
		firstName: existingUser.first_name ?? undefined,
		lastName: existingUser.last_name ?? undefined,
	};
}

async function ensureUser(db: D1Database, payload: WorkosJwtPayload): Promise<string> {
	const existing = await db
		.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	const userId = existing?.id ?? `usr_${crypto.randomUUID()}`;

	await db
		.prepare(
			`INSERT INTO users (id, workos_user_id, email, first_name, last_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workos_user_id) DO UPDATE SET
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(userId, payload.sub, payload.email, payload.first_name ?? null, payload.last_name ?? null)
		.run();

	const row = await db
		.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	if (!row?.id) {
		throw new Error("Failed to resolve user");
	}

	return row.id;
}

async function ensureOrgForUser(
	db: D1Database,
	userId: string,
	payload: WorkosJwtPayload,
): Promise<{ orgId: string; workosOrgId: string | null }> {
	if (payload.org_id) {
		const org = await db
			.prepare("SELECT id FROM orgs WHERE workos_org_id = ?")
			.bind(payload.org_id)
			.first<{ id: string }>();

		const orgId = org?.id ?? `org_${crypto.randomUUID()}`;
		if (!org?.id) {
			await db
				.prepare("INSERT INTO orgs (id, workos_org_id, name) VALUES (?, ?, ?)")
				.bind(orgId, payload.org_id, defaultOrgName(payload))
				.run();
		}

		await ensureMembership(db, orgId, userId);
		return { orgId, workosOrgId: payload.org_id };
	}

	const existing = await db
		.prepare(
			`SELECT orgs.id as org_id, orgs.workos_org_id as workos_org_id
       FROM orgs
       JOIN org_memberships ON orgs.id = org_memberships.org_id
       WHERE org_memberships.user_id = ?
       ORDER BY org_memberships.created_at ASC
       LIMIT 1`,
		)
		.bind(userId)
		.first<{ org_id: string; workos_org_id: string | null }>();

	if (existing?.org_id) {
		return { orgId: existing.org_id, workosOrgId: existing.workos_org_id ?? null };
	}

	const orgId = `org_${crypto.randomUUID()}`;
	await db
		.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
		.bind(orgId, defaultOrgName(payload))
		.run();

	await ensureMembership(db, orgId, userId);
	return { orgId, workosOrgId: null };
}

async function ensureMembership(db: D1Database, orgId: string, userId: string) {
	await db
		.prepare(
			`INSERT INTO org_memberships (id, org_id, user_id, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO NOTHING`,
		)
		.bind(`orgmem_${crypto.randomUUID()}`, orgId, userId, "owner")
		.run();
}

function defaultOrgName(payload: WorkosJwtPayload): string {
	const base = payload.first_name ?? payload.email?.split("@")[0] ?? "Personal";
	return `${base}'s Workspace`;
}

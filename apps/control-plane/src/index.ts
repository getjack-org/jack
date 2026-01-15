import { verifyJwt } from "@getjack/auth";
import type { JwtPayload } from "@getjack/auth";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	CloudflareClient,
	getMimeType,
	type UsageMetricsAE,
	type UsageByDimension,
} from "./cloudflare-api";
import { DeploymentService, validateManifest } from "./deployment-service";
import { ProvisioningService, normalizeSlug, validateSlug } from "./provisioning";
import { ProjectCacheService } from "./repositories/project-cache-service";
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

// Username validation: 3-39 chars, lowercase alphanumeric + hyphens, must start/end with alphanumeric
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/;
const ANALYTICS_CACHE_TTL_SECONDS = 600;

function validateUsername(username: string): string | null {
	if (!username || username.trim() === "") {
		return "Username cannot be empty";
	}

	if (username.length < 3) {
		return "Username must be at least 3 characters";
	}

	if (username.length > 39) {
		return "Username must be 39 characters or less";
	}

	if (username !== username.toLowerCase()) {
		return "Username must be lowercase";
	}

	if (!USERNAME_PATTERN.test(username)) {
		return "Username must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number";
	}

	// Reserved usernames - system, product, and well-known brands
	const reserved = [
		// System & infrastructure
		"admin",
		"api",
		"www",
		"mail",
		"cdn",
		"static",
		"assets",
		"system",
		"root",
		"support",
		"help",
		"security",
		// UI routes
		"account",
		"settings",
		"profile",
		"dashboard",
		"login",
		"logout",
		"explore",
		"trending",
		// Jack product
		"jack",
		"getjack",
		"templates",
		"template",
		// Cloud & infrastructure brands
		"vercel",
		"cloudflare",
		"netlify",
		"railway",
		"render",
		"supabase",
		"neon",
		"aws",
		"azure",
		"google",
		"github",
		"gitlab",
		// Farcaster ecosystem
		"farcaster",
		"warpcast",
		"neynar",
		"privy",
		// Big tech
		"microsoft",
		"apple",
		"meta",
		"facebook",
		"twitter",
		"x",
	];
	if (reserved.includes(username)) {
		return "This username is reserved. Please choose a different one.";
	}

	// Block jack-* prefix to prevent impersonation
	if (username.startsWith("jack-") || username.startsWith("getjack-")) {
		return "Usernames starting with 'jack-' are reserved. Please choose a different one.";
	}

	return null;
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

// Feedback endpoint - no auth required
app.post("/v1/feedback", async (c) => {
	// Rate limit by IP
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	const { success } = await c.env.FEEDBACK_LIMITER.limit({ key: ip });
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many feedback submissions. Try again in a minute." },
			429,
		);
	}

	const body = await c.req.json<{
		message: string;
		email?: string | null;
		metadata?: {
			jack_version?: string;
			os?: string;
			project_name?: string | null;
			deploy_mode?: string | null;
		};
	}>();

	// Validate message
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "invalid_request", message: "Message is required" }, 400);
	}

	const message = body.message.trim();
	if (message.length === 0) {
		return c.json({ error: "invalid_request", message: "Message cannot be empty" }, 400);
	}

	if (message.length > 10000) {
		return c.json({ error: "invalid_request", message: "Message too long (max 10000 chars)" }, 400);
	}

	// Extract metadata
	const metadata = body.metadata ?? {};
	const feedbackId = `fb_${crypto.randomUUID()}`;

	try {
		await c.env.DB.prepare(
			`INSERT INTO feedback (id, message, email, jack_version, os, project_name, deploy_mode)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				feedbackId,
				message,
				body.email ?? null,
				metadata.jack_version ?? null,
				metadata.os ?? null,
				metadata.project_name ?? null,
				metadata.deploy_mode ?? null,
			)
			.run();

		return c.json({ success: true, id: feedbackId }, 201);
	} catch (error) {
		console.error("Failed to store feedback:", error);
		return c.json({ error: "internal_error", message: "Failed to store feedback" }, 500);
	}
});

// Username availability check - no auth required for UX
app.get("/v1/usernames/:name/available", async (c) => {
	// Rate limit by IP
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	const { success } = await c.env.USERNAME_CHECK_LIMITER.limit({ key: ip });
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many requests. Try again in a minute." },
			429,
		);
	}

	const name = c.req.param("name");

	// Validate username format
	const validationError = validateUsername(name);
	if (validationError) {
		return c.json({ available: false, username: name, error: validationError }, 200);
	}

	// Check if username exists
	const existing = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?")
		.bind(name)
		.first<{ id: string }>();

	return c.json({
		available: !existing,
		username: name,
	});
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
		"SELECT id, email, first_name, last_name, username, created_at, updated_at FROM users WHERE id = ?",
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

api.put("/me/username", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{ username: string }>();

	if (!body.username) {
		return c.json({ error: "invalid_request", message: "Username is required" }, 400);
	}

	// Validate username format
	const validationError = validateUsername(body.username);
	if (validationError) {
		return c.json({ error: "invalid_request", message: validationError }, 400);
	}

	// Check if user already has a username
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	if (user?.username) {
		return c.json(
			{ error: "conflict", message: "Username already set. Contact support to change it." },
			409,
		);
	}

	// Try to set username (UNIQUE constraint will catch races)
	try {
		await c.env.DB.prepare(
			"UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
			.bind(body.username, auth.userId)
			.run();

		return c.json({ success: true, username: body.username });
	} catch (error) {
		// Handle UNIQUE constraint violation
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("UNIQUE constraint") || message.includes("users.username")) {
			return c.json({ error: "conflict", message: "Username is already taken" }, 409);
		}
		throw error;
	}
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
	const body = await c.req.json<{
		name: string;
		slug?: string;
		content_bucket?: boolean;
		use_prebuilt?: boolean;
		template?: string;
	}>();

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

	// Fetch user's username for URL construction
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	const provisioning = new ProvisioningService(c.env);
	try {
		const result = await provisioning.createProject(
			auth.orgId,
			body.name,
			slug,
			body.content_bucket ?? false,
			user?.username ?? undefined,
		);

		// Construct URL with username if available
		const url = user?.username
			? `https://${user.username}-${result.project.slug}.runjack.xyz`
			: `https://${result.project.slug}.runjack.xyz`;

		// If pre-built deployment is requested, attempt it
		if (body.use_prebuilt && body.template) {
			const cliVersion = c.req.header("X-Jack-Version") || "latest";
			try {
				const deploymentService = new DeploymentService(c.env);
				await deploymentService.deployFromPrebuiltTemplate(
					result.project.id,
					result.project.slug,
					body.template,
					cliVersion,
				);
				// Return with live status and URL
				return c.json(
					{
						...result,
						status: "live",
						url,
					},
					201,
				);
			} catch (error) {
				// Pre-built deploy failed - return result with prebuilt_failed flag
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				console.error("Pre-built deploy failed:", {
					template: body.template,
					cliVersion,
					projectId: result.project.id,
					error: errorMessage,
					stack: errorStack,
				});
				return c.json(
					{
						...result,
						url,
						prebuilt_failed: true,
						prebuilt_error: errorMessage,
					},
					201,
				);
			}
		}

		return c.json({ ...result, url }, 201);
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

api.get("/projects/by-slug/:slug", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	// Find project by slug within user's orgs
	const project = await c.env.DB.prepare(
		`SELECT p.id, p.org_id, p.name, p.slug, p.status, p.created_at, p.updated_at
		 FROM projects p
		 JOIN org_memberships om ON p.org_id = om.org_id
		 WHERE p.slug = ? AND om.user_id = ? AND p.status != 'deleted'`,
	)
		.bind(slug, auth.userId)
		.first();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	return c.json({ project });
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

	// Construct URL with owner_username if available
	const url = project.owner_username
		? `https://${project.owner_username}-${project.slug}.runjack.xyz`
		: `https://${project.slug}.runjack.xyz`;

	return c.json({ project, url });
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

api.get("/projects/:projectId/usage", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
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

	// Check cache first (5 min TTL for detailed analytics)
	const cacheKey = `ae:project:${projectId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);

		// Fetch all metrics in parallel
		const [metrics, byCountry, byPath, byMethod, byCacheStatus] = await Promise.all([
			cfClient.getProjectUsageFromAE(projectId, range.from, range.to),
			cfClient.getProjectTrafficByCountry(projectId, range.from, range.to),
			cfClient.getProjectTrafficByPath(projectId, range.from, range.to),
			cfClient.getProjectTrafficByMethod(projectId, range.from, range.to),
			cfClient.getProjectCacheBreakdown(projectId, range.from, range.to),
		]);

		const response = {
			project_id: projectId,
			range,
			metrics,
			breakdown: {
				by_country: byCountry,
				by_path: byPath,
				by_method: byMethod,
				by_cache_status: byCacheStatus,
			},
		};

		// Cache for 5 minutes
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Org-level Analytics Engine usage
api.get("/orgs/:orgId/usage", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(orgId, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	const cacheKey = `ae:org:${orgId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const metrics = await cfClient.getOrgUsageFromAE(orgId, range.from, range.to);

		const response = {
			org_id: orgId,
			range,
			metrics,
		};

		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
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

// Tag validation regex: lowercase alphanumeric with colons and hyphens, must start/end with alphanumeric
const TAG_PATTERN = /^[a-z0-9][a-z0-9:-]*[a-z0-9]$|^[a-z0-9]$/;

api.put("/projects/:projectId/tags", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Parse request body
	const body = await c.req.json<{ tags: string[] }>();

	// Validate tags is an array
	if (!Array.isArray(body.tags)) {
		return c.json({ error: "invalid_request", message: "tags must be an array" }, 400);
	}

	// Validate max 20 tags
	if (body.tags.length > 20) {
		return c.json({ error: "invalid_request", message: "Maximum 20 tags allowed" }, 400);
	}

	// Validate each tag
	for (const tag of body.tags) {
		if (typeof tag !== "string") {
			return c.json({ error: "invalid_request", message: "Each tag must be a string" }, 400);
		}
		if (tag.length > 50) {
			return c.json(
				{
					error: "invalid_request",
					message: `Tag '${tag}' exceeds maximum length of 50 characters`,
				},
				400,
			);
		}
		if (!TAG_PATTERN.test(tag)) {
			return c.json(
				{
					error: "invalid_request",
					message: `Tag '${tag}' is invalid. Tags must be lowercase alphanumeric with colons and hyphens, starting and ending with alphanumeric characters`,
				},
				400,
			);
		}
	}

	// Get project and verify it exists
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

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

	// Deduplicate and sort tags
	const uniqueTags = [...new Set(body.tags)].sort();
	const tagsJson = JSON.stringify(uniqueTags);

	try {
		await c.env.DB.prepare(
			"UPDATE projects SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
			.bind(tagsJson, projectId)
			.run();

		return c.json({ success: true, tags: uniqueTags });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update tags";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/tags", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify it exists
	const project = await c.env.DB.prepare(
		"SELECT id, org_id, tags FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; tags: string | null }>();

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

	// Parse tags from JSON, default to empty array
	let tags: string[] = [];
	try {
		tags = project.tags ? JSON.parse(project.tags) : [];
	} catch {
		// If parsing fails, return empty array
		tags = [];
	}

	return c.json({ tags });
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
		.first<{ id: string; org_id: string; slug: string; owner_username: string | null }>();

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
		.all<{
			resource_type: string;
			resource_name: string;
			provider_id: string;
			binding_name: string | null;
		}>();

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

	// Delete R2 content bucket (legacy enableContentBucket flow)
	const r2ContentResource = resources.results?.find((r) => r.resource_type === "r2_content");
	if (r2ContentResource) {
		try {
			await cfClient.deleteR2Bucket(r2ContentResource.resource_name);
			deletionResults.push({ resource: "r2_content", success: true });
		} catch (error) {
			deletionResults.push({ resource: "r2_content", success: false, error: String(error) });
		}
	}

	// Delete user-defined R2 buckets (from wrangler.jsonc r2_buckets)
	const r2Resources = resources.results?.filter((r) => r.resource_type === "r2") ?? [];
	for (const r2Res of r2Resources) {
		try {
			await cfClient.deleteR2Bucket(r2Res.resource_name);
			deletionResults.push({ resource: `r2:${r2Res.resource_name}`, success: true });
		} catch (error) {
			deletionResults.push({
				resource: `r2:${r2Res.resource_name}`,
				success: false,
				error: String(error),
			});
		}
	}

	// Delete KV namespaces (from wrangler.jsonc kv_namespaces)
	const kvResources = resources.results?.filter((r) => r.resource_type === "kv") ?? [];
	for (const kvRes of kvResources) {
		try {
			await cfClient.deleteKVNamespace(kvRes.provider_id);
			deletionResults.push({
				resource: `kv:${kvRes.binding_name || kvRes.resource_name}`,
				success: true,
			});
		} catch (error) {
			deletionResults.push({
				resource: `kv:${kvRes.binding_name || kvRes.resource_name}`,
				success: false,
				error: String(error),
			});
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
		const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
		await cacheService.invalidateProject(projectId, project.slug, project.org_id, project.owner_username);
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
	const assetManifestFile = formData.get("asset-manifest") as File | null;

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
		const assetManifestText = assetManifestFile ? await assetManifestFile.text() : null;
		const assetManifest = assetManifestText ? JSON.parse(assetManifestText) : undefined;

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
			assetManifest,
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

// Secrets endpoints - never stores secrets in D1, passes directly to Cloudflare
api.post("/projects/:projectId/secrets", async (c) => {
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

	// Parse request body
	const body = await c.req.json<{ name: string; value: string }>();
	if (!body.name || !body.value) {
		return c.json({ error: "invalid_request", message: "name and value are required" }, 400);
	}

	// Validate secret name (alphanumeric and underscores only)
	if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.name)) {
		return c.json(
			{
				error: "invalid_request",
				message:
					"Secret name must start with a letter or underscore, and contain only letters, numbers, and underscores",
			},
			400,
		);
	}

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			return c.json({ error: "not_found", message: "Project has no deployed worker" }, 404);
		}

		const cfClient = new CloudflareClient(c.env);
		await cfClient.setDispatchScriptSecrets("jack-tenants", workerResource.resource_name, {
			[body.name]: body.value,
		});

		return c.json({ success: true, name: body.name }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to set secret";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/secrets", async (c) => {
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

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			// No worker deployed yet - return empty list
			return c.json({ secrets: [] });
		}

		const cfClient = new CloudflareClient(c.env);
		const secrets = await cfClient.listDispatchScriptSecrets(
			"jack-tenants",
			workerResource.resource_name,
		);

		// Only return names, not values (Cloudflare API already doesn't return values)
		return c.json({
			secrets: secrets.map((s) => ({ name: s.name })),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to list secrets";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.delete("/projects/:projectId/secrets/:secretName", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const secretName = c.req.param("secretName");
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

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			return c.json({ error: "not_found", message: "Project has no deployed worker" }, 404);
		}

		const cfClient = new CloudflareClient(c.env);
		await cfClient.deleteDispatchScriptSecret(
			"jack-tenants",
			workerResource.resource_name,
			secretName,
		);

		return c.json({ success: true, name: secretName });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to delete secret";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Enable observability (Workers Logs) for a project
api.post("/projects/:projectId/observability", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
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

	const workerResource = await c.env.DB.prepare(
		"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ resource_name: string }>();

	if (!workerResource) {
		return c.json({ error: "not_found", message: "No worker deployed" }, 404);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		await cfClient.enableScriptObservability("jack-tenants", workerResource.resource_name);

		return c.json({
			success: true,
			message: "Observability enabled. Logs will appear in the Cloudflare dashboard.",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to enable observability";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Real-time logs streaming endpoint
// NOTE: Cloudflare's Tail API doesn't support dispatch namespace scripts.
// For now, use the observability endpoint to enable Workers Logs (stored logs).
api.get("/projects/:projectId/logs/stream", async (c) => {
	return c.json(
		{
			error: "not_implemented",
			message:
				"Real-time log streaming is not yet available for managed projects. " +
				"Use POST /projects/:projectId/observability to enable stored Workers Logs. " +
				"Logs can then be viewed in the Cloudflare dashboard.",
			docs: "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/",
		},
		501,
	);
});

// Source code retrieval endpoints
api.get("/projects/:projectId/source/tree", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
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

	const deploymentService = new DeploymentService(c.env);
	const deployment = await deploymentService.getLatestDeployment(projectId);

	if (!deployment) {
		return c.json({ error: "not_found", message: "No deployment found" }, 404);
	}

	if (!deployment.artifact_bucket_key) {
		return c.json({ error: "not_found", message: "No source code available" }, 404);
	}

	// Check KV cache first
	const cacheKey = `source-tree:${deployment.id}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	// Fetch source.zip from R2
	const sourceKey = `${deployment.artifact_bucket_key}/source.zip`;
	const sourceObj = await c.env.CODE_BUCKET.get(sourceKey);

	if (!sourceObj) {
		return c.json({ error: "not_found", message: "Source code not found in storage" }, 404);
	}

	try {
		const zipData = await sourceObj.arrayBuffer();
		const files = unzipSync(new Uint8Array(zipData));

		// Build file tree
		const tree: Array<{ path: string; size: number; type: "file" | "directory" }> = [];
		const directories = new Set<string>();

		for (const [path, content] of Object.entries(files)) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) {
				directories.add(parts.slice(0, i).join("/"));
			}
			tree.push({ path, size: content.length, type: "file" });
		}

		for (const dir of directories) {
			tree.push({ path: dir, size: 0, type: "directory" });
		}

		tree.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.path.localeCompare(b.path);
		});

		const response = {
			deployment_id: deployment.id,
			files: tree,
			total_files: tree.filter((f) => f.type === "file").length,
		};

		// Cache for 1 hour
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to read source";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/source/file", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const filePath = c.req.query("path");

	if (!filePath) {
		return c.json({ error: "invalid_request", message: "path query parameter is required" }, 400);
	}

	// Path traversal protection
	if (filePath.includes("..") || filePath.includes("//")) {
		return c.json({ error: "invalid_request", message: "Invalid path" }, 400);
	}

	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
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

	const deploymentService = new DeploymentService(c.env);
	const deployment = await deploymentService.getLatestDeployment(projectId);

	if (!deployment) {
		return c.json({ error: "not_found", message: "No deployment found" }, 404);
	}

	if (!deployment.artifact_bucket_key) {
		return c.json({ error: "not_found", message: "No source code available" }, 404);
	}

	const sourceKey = `${deployment.artifact_bucket_key}/source.zip`;
	const sourceObj = await c.env.CODE_BUCKET.get(sourceKey);

	if (!sourceObj) {
		return c.json({ error: "not_found", message: "Source code not found in storage" }, 404);
	}

	try {
		const zipData = await sourceObj.arrayBuffer();
		const files = unzipSync(new Uint8Array(zipData));

		// Normalize path
		const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

		const fileContent = files[normalizedPath];
		if (!fileContent) {
			return c.json({ error: "not_found", message: `File not found: ${filePath}` }, 404);
		}

		const contentType = getMimeType(normalizedPath);
		const isText =
			contentType.startsWith("text/") ||
			contentType === "application/json" ||
			contentType === "application/javascript" ||
			contentType === "application/xml";

		if (isText) {
			const text = new TextDecoder().decode(fileContent);
			return new Response(text, {
				headers: {
					"Content-Type": `${contentType}; charset=utf-8`,
					"X-Deployment-Id": deployment.id,
				},
			});
		}

		return new Response(fileContent, {
			headers: {
				"Content-Type": contentType,
				"X-Deployment-Id": deployment.id,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to read source";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Upload source snapshot after deploy
api.post("/projects/:projectId/source", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND org_id = ? AND status != 'deleted'",
	)
		.bind(projectId, auth.orgId)
		.first();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Accept multipart form with source.zip
	const formData = await c.req.formData();
	const sourceFile = formData.get("source") as File | null;

	if (!sourceFile) {
		return c.json({ error: "invalid_request", message: "source file required" }, 400);
	}

	// Store in R2: source/{projectId}/latest.zip
	const sourceKey = `source/${projectId}/latest.zip`;
	await c.env.CODE_BUCKET.put(sourceKey, await sourceFile.arrayBuffer());

	// Update project record
	await c.env.DB.prepare(
		"UPDATE projects SET source_snapshot_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
	)
		.bind(sourceKey, projectId)
		.run();

	return c.json({ success: true, source_key: sourceKey });
});

// Download own project's source (authenticated)
api.get("/me/projects/:slug/source", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE org_id = ? AND slug = ? AND status != 'deleted'",
	)
		.bind(auth.orgId, slug)
		.first<{ slug: string; source_snapshot_key: string | null }>();

	if (!project || !project.source_snapshot_key) {
		return c.json({ error: "not_found", message: "Project or source not found" }, 404);
	}

	const sourceObj = await c.env.CODE_BUCKET.get(project.source_snapshot_key);
	if (!sourceObj) {
		return c.json(
			{ error: "source_not_available", message: "Source file not found in storage" },
			404,
		);
	}

	return new Response(sourceObj.body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${slug}-source.zip"`,
		},
	});
});

// Publish project for forking
api.post("/projects/:projectId/publish", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND org_id = ? AND status != 'deleted'",
	)
		.bind(projectId, auth.orgId)
		.first<{ slug: string; source_snapshot_key: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check user has username set
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	if (!user?.username) {
		return c.json(
			{
				error: "username_required",
				message: "Set your username first during login",
			},
			400,
		);
	}

	// Check project has source snapshot
	if (!project.source_snapshot_key) {
		return c.json(
			{
				error: "no_source",
				message: "Deploy your project first with jack ship",
			},
			400,
		);
	}

	// Update visibility and owner_username in DB
	await c.env.DB.prepare(
		`UPDATE projects
     SET visibility = 'public', owner_username = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(user.username, projectId)
		.run();

	// Update KV cache with new key format for dispatch worker routing
	// Fetch full project config to cache
	const fullProject = await c.env.DB.prepare(
		`SELECT p.*, r.provider_id as d1_database_id
		 FROM projects p
		 LEFT JOIN resources r ON r.project_id = p.id AND r.resource_type = 'd1'
		 WHERE p.id = ?`,
	)
		.bind(projectId)
		.first<{
			id: string;
			org_id: string;
			slug: string;
			content_bucket_enabled: number | null;
			status: string;
			updated_at: string;
			d1_database_id: string | null;
		}>();

	if (fullProject) {
		// Derive worker name from project ID (same logic as provisioning)
		const shortId = fullProject.id.replace("proj_", "").slice(0, 16);
		const workerName = `jack-${shortId}`;
		const contentBucketName = fullProject.content_bucket_enabled ? `jack-${shortId}-content` : null;

		const projectConfig = {
			project_id: fullProject.id,
			org_id: fullProject.org_id,
			owner_username: user.username,
			slug: fullProject.slug,
			worker_name: workerName,
			d1_database_id: fullProject.d1_database_id || "",
			content_bucket_name: contentBucketName,
			status: fullProject.status,
			updated_at: new Date().toISOString(),
		};

		const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
		await cacheService.setProjectConfig(projectConfig);
		await cacheService.clearNotFound(fullProject.slug, user.username);
	}

	return c.json({
		success: true,
		published_as: `${user.username}/${project.slug}`,
		fork_command: `jack new my-app -t ${user.username}/${project.slug}`,
	});
});

// Public endpoint for downloading published project sources (no auth required)
app.get("/v1/projects/:owner/:slug/source", async (c) => {
	const owner = c.req.param("owner");
	const slug = c.req.param("slug");

	// Find project by owner username and slug, must be public
	const project = await c.env.DB.prepare(
		`SELECT p.* FROM projects p
     WHERE p.owner_username = ? AND p.slug = ?
       AND p.visibility = 'public'
       AND p.status != 'deleted'`,
	)
		.bind(owner, slug)
		.first<{ slug: string; source_snapshot_key: string | null }>();

	if (!project || !project.source_snapshot_key) {
		return c.json({ error: "not_found", message: "Published project not found" }, 404);
	}

	const sourceObj = await c.env.CODE_BUCKET.get(project.source_snapshot_key);
	if (!sourceObj) {
		return c.json({ error: "source_not_available", message: "Source file not found" }, 404);
	}

	return new Response(sourceObj.body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${slug}-source.zip"`,
		},
	});
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

type AnalyticsRange = {
	from: string;
	to: string;
};

type AnalyticsRangeResult =
	| { ok: true; range: AnalyticsRange }
	| { ok: false; message: string };

function resolveAnalyticsRange(c: { req: { query: (key: string) => string | undefined } }): AnalyticsRangeResult {
	const fromParam = c.req.query("from");
	const toParam = c.req.query("to");
	const preset = c.req.query("preset") ?? "last_7d";
	const now = new Date();

	if (fromParam || toParam) {
		if (!fromParam || !toParam) {
			return { ok: false, message: "from and to must both be provided" };
		}

		const fromDate = new Date(fromParam);
		const toDate = new Date(toParam);

		if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
			return { ok: false, message: "from and to must be valid ISO timestamps" };
		}

		if (fromDate > toDate) {
			return { ok: false, message: "from must be before to" };
		}

		return {
			ok: true,
			range: { from: fromDate.toISOString(), to: toDate.toISOString() },
		};
	}

	if (preset !== "last_24h" && preset !== "last_7d" && preset !== "mtd") {
		return { ok: false, message: "preset must be one of last_24h, last_7d, mtd" };
	}

	let fromDate: Date;
	if (preset === "last_24h") {
		fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	} else if (preset === "mtd") {
		fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	} else {
		fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	}

	return {
		ok: true,
		range: { from: fromDate.toISOString(), to: now.toISOString() },
	};
}

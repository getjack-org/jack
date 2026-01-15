import { Hono } from "hono";
import { RateLimiter } from "./rate-limiter";
import type { Bindings, ProjectConfig } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-dispatch" });
});

/**
 * Parse hostname to extract username and slug.
 *
 * New format: {username}-{slug}.runjack.xyz
 *   - Username is the first segment (before first hyphen)
 *   - Slug is everything after the first hyphen
 *   - Example: "alice-my-api" -> { username: "alice", slug: "my-api" }
 *   - Example: "alice-my-cool-api" -> { username: "alice", slug: "my-cool-api" }
 *
 * Legacy format: {slug}.runjack.xyz
 *   - Just the slug, no username
 *   - Example: "my-api" -> { username: null, slug: "my-api" }
 *
 * Note: Usernames and slugs cannot start/end with hyphens (enforced by DB triggers),
 * so the first hyphen reliably separates username from slug.
 */
function parseHostname(host: string): { username: string | null; slug: string } | null {
	const match = host.match(/^([a-z0-9-]+)\.runjack\.xyz$/);
	if (!match?.[1]) {
		return null;
	}

	const subdomain = match[1];
	const hyphenIndex = subdomain.indexOf("-");

	if (hyphenIndex === -1) {
		// No hyphen: legacy format with just slug
		return { username: null, slug: subdomain };
	}

	// New format: username-slug
	const username = subdomain.substring(0, hyphenIndex);
	const slug = subdomain.substring(hyphenIndex + 1);

	// Validate both parts are non-empty
	if (!username || !slug) {
		return null;
	}

	return { username, slug };
}

app.all("/*", async (c) => {
	const env = c.env;
	const host = c.req.header("host");

	if (!host) {
		return c.json({ error: "Missing host header" }, 400);
	}

	// Parse hostname to extract username and slug
	const parsed = parseHostname(host);
	if (!parsed) {
		return c.json(
			{
				error: "Invalid host format",
				expected: "{username}-{slug}.runjack.xyz or {slug}.runjack.xyz",
			},
			400,
		);
	}

	const { username, slug } = parsed;
	const fullSubdomain = username ? `${username}-${slug}` : slug;

	const notFoundKey = `notfound:${fullSubdomain}`;
	const isKnownNotFound = await env.PROJECTS_CACHE.get(notFoundKey);
	if (isKnownNotFound) {
		return c.json({ error: "Project not found", subdomain: fullSubdomain }, 404);
	}

	let config: ProjectConfig | null = null;

	// Look up project config - try multiple strategies
	if (username) {
		// Has hyphen: could be new format (username-slug) or legacy format with hyphens
		// Try new format first: config:{username}:{slug}
		config = await env.PROJECTS_CACHE.get<ProjectConfig>(`config:${username}:${slug}`, "json");

		if (!config) {
			// Fallback to legacy format: treat entire subdomain as slug
			config = await env.PROJECTS_CACHE.get<ProjectConfig>(`config:${fullSubdomain}`, "json");
		}
	} else {
		// No hyphen: legacy format with simple slug
		config = await env.PROJECTS_CACHE.get<ProjectConfig>(`config:${slug}`, "json");

		if (!config) {
			// Fallback: maybe it's stored by project ID (for backwards compat)
			config = await env.PROJECTS_CACHE.get<ProjectConfig>(`project:${slug}`, "json");
		}
	}

	if (!config) {
		await env.PROJECTS_CACHE.put(notFoundKey, "1", { expirationTtl: 60 });
		return c.json({ error: "Project not found", subdomain: fullSubdomain }, 404);
	}

	// Check project status
	if (config.status !== "active") {
		return c.json({ error: "Project not available" }, 503);
	}

	// Check rate limit (use actual project_id from config)
	const rateLimiter = new RateLimiter(env.PROJECTS_CACHE);
	const limit = config.limits?.requests_per_minute || 1000;
	const rateLimit = await rateLimiter.checkAndIncrement(config.project_id, limit);

	if (!rateLimit.allowed) {
		const retryAfter = rateLimit.reset - Math.floor(Date.now() / 1000);
		return c.json({ error: "Rate limit exceeded" }, 429, {
			"Retry-After": retryAfter.toString(),
			"X-RateLimit-Limit": limit.toString(),
			"X-RateLimit-Remaining": "0",
			"X-RateLimit-Reset": rateLimit.reset.toString(),
		});
	}

	// Forward to tenant worker
	try {
		const worker = env.TENANT_DISPATCH.get(config.worker_name);
		const response = await worker.fetch(c.req.raw);

		// Clone response to add rate limit headers
		const headers = new Headers(response.headers);
		headers.set("X-RateLimit-Limit", limit.toString());
		headers.set("X-RateLimit-Remaining", rateLimit.remaining.toString());
		headers.set("X-RateLimit-Reset", rateLimit.reset.toString());

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (error) {
		console.error("Worker fetch failed:", error);
		return c.json({ error: "Service temporarily unavailable" }, 503);
	}
});

export default app;

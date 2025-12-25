import { Hono } from "hono";
import { RateLimiter } from "./rate-limiter";
import type { Bindings, ProjectConfig } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-dispatch" });
});

app.all("/*", async (c) => {
	const env = c.env;
	const host = c.req.header("host");

	if (!host) {
		return c.json({ error: "Missing host header" }, 400);
	}

	// Parse project slug from host (format: {slug}.runjack.xyz)
	const match = host.match(/^([a-z0-9-]+)\.runjack\.xyz$/);
	if (!match?.[1]) {
		return c.json({ error: "Invalid host format" }, 400);
	}

	const slug = match[1];

	// Look up project config by slug
	// First try direct slug lookup, then try as project ID for backwards compat
	let config = await env.PROJECTS_CACHE.get<ProjectConfig>(`config:${slug}`, "json");

	if (!config) {
		// Fallback: maybe it's stored by project ID
		config = await env.PROJECTS_CACHE.get<ProjectConfig>(`project:${slug}`, "json");
	}

	if (!config) {
		return c.json({ error: "Project not found" }, 404);
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

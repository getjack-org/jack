import { Hono } from "hono";
import { createUsageDataPoint } from "./metering";
import { RateLimiter } from "./rate-limiter";
import type { Bindings, ProjectConfig } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/__dispatch/health", (c) => {
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

/**
 * Sanitize and normalize hostname for safe KV lookups.
 * - Lowercase for case-insensitive matching
 * - Strip port if present
 * - Validate length and characters
 */
function sanitizeHost(rawHost: string): string | null {
	// Strip port if present (e.g., "example.com:443" -> "example.com")
	const host = rawHost.split(":")[0].toLowerCase().trim();

	// Reject empty or too long hostnames (max 253 chars per DNS spec)
	if (!host || host.length > 253) {
		return null;
	}

	// Only allow valid hostname characters (alphanumeric, hyphens, dots)
	if (!/^[a-z0-9.-]+$/.test(host)) {
		return null;
	}

	// Reject suspicious patterns
	if (host.includes("..") || host.startsWith(".") || host.startsWith("-")) {
		return null;
	}

	return host;
}

app.all("/*", async (c) => {
	const startTime = Date.now();
	const env = c.env;
	const ctx = c.executionCtx;
	const rawHost = c.req.header("host");

	if (!rawHost) {
		return c.json({ error: "Missing host header" }, 400);
	}

	const host = sanitizeHost(rawHost);
	if (!host) {
		return c.json({ error: "Invalid host header" }, 400);
	}

	let config: ProjectConfig | null = null;

	// Check for custom domains (non-runjack.xyz hosts)
	const isRunjackHost = host.endsWith(".runjack.xyz");
	const isLocalhost = host.includes("localhost");

	if (!isRunjackHost && !isLocalhost) {
		// Custom domain routing
		const notFoundKey = `notfound:custom:${host}`;
		const isKnownNotFound = await env.PROJECTS_CACHE.get(notFoundKey);
		if (isKnownNotFound) {
			return c.json({ error: "Unknown hostname", hostname: host }, 404);
		}

		// Look up custom domain config
		config = await env.PROJECTS_CACHE.get<ProjectConfig>(`custom:${host}`, "json");

		if (!config) {
			// Log suspicious activity for monitoring potential subdomain takeover attempts
			console.log(
				`[security] Unknown custom hostname: ${host}, IP: ${c.req.header("cf-connecting-ip")}`,
			);
			// Cache the not-found for 60 seconds
			await env.PROJECTS_CACHE.put(notFoundKey, "1", { expirationTtl: 60 });
			return c.json({ error: "Unknown hostname", hostname: host }, 404);
		}

		if (config.status !== "active") {
			return c.json({ error: "Project not available" }, 503);
		}

		// Verify SSL certificate is active for custom domains
		if (config.ssl_status && config.ssl_status !== "active") {
			return c.json({ error: "SSL certificate pending" }, 503);
		}
	} else {
		// Standard runjack.xyz subdomain routing
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
		const isPaid = config.tier === "pro" || config.tier === "team";
		const worker = env.TENANT_DISPATCH.get(
			config.worker_name,
			{},
			{
				limits: {
					cpuMs: isPaid ? 50 : 10,
					subRequests: isPaid ? 200 : 50,
				},
			},
		);

		// Strip sensitive headers before forwarding to tenant workers
		const sanitizedHeaders = new Headers(c.req.raw.headers);
		const sensitiveHeaders = [
			"cf-connecting-ip",
			"cf-ipcountry",
			"cf-ray",
			"cf-visitor",
			"x-forwarded-for",
			"x-real-ip",
		];
		for (const header of sensitiveHeaders) {
			sanitizedHeaders.delete(header);
		}

		const sanitizedRequest = new Request(c.req.raw.url, {
			method: c.req.raw.method,
			headers: sanitizedHeaders,
			body: c.req.raw.body,
			redirect: c.req.raw.redirect,
		});

		const response = await worker.fetch(sanitizedRequest);

		// Write usage data point (fire-and-forget, 0ms latency impact)
		ctx.waitUntil(
			Promise.resolve().then(() => {
				env.USAGE.writeDataPoint(
					createUsageDataPoint({
						projectId: config.project_id,
						orgId: config.org_id,
						tier: config.tier || "free",
						request: c.req.raw,
						response,
						startTime,
					}),
				);
			}),
		);

		// WebSocket upgrade: return original response to preserve the webSocket property.
		// Wrapping in new Response() drops it, breaking Durable Object WebSocket connections.
		if (response.status === 101) {
			return response;
		}

		// Normal response: wrap to add rate limit headers
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
		// Track errors in analytics too
		ctx.waitUntil(
			Promise.resolve().then(() => {
				env.USAGE.writeDataPoint(
					createUsageDataPoint({
						projectId: config.project_id,
						orgId: config.org_id,
						tier: config.tier || "free",
						request: c.req.raw,
						response: new Response(null, { status: 503 }),
						startTime,
					}),
				);
			}),
		);

		const errMsg = error instanceof Error ? error.message : String(error);
		console.error("Worker fetch failed:", errMsg);

		// Detect binding-related errors (e.g. DO enforcement removed bindings)
		const isBindingError =
			errMsg.includes("is not a function") ||
			errMsg.includes("Cannot read properties of undefined") ||
			errMsg.includes("is not defined");

		return c.json(
			{
				error: "Service temporarily unavailable",
				...(isBindingError && {
					hint: "A required binding may have been removed due to resource limits. Re-deploy to restore.",
				}),
			},
			503,
		);
	}
});

export default app;

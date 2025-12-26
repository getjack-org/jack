// Server-side Worker - handles API routes, keeps secrets secure

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ImageResponse } from "workers-og";

type Env = {
	DB: D1Database;
	NEYNAR_API_KEY: string;
	ASSETS: Fetcher;
	AI: Ai;
	OPENAI_API_KEY?: string;
	APP_URL?: string; // Production URL for share embeds (e.g., https://my-app.workers.dev)
};

// Get production base URL - required for valid Farcaster embeds
// Farcaster requires absolute https:// URLs (no localhost, no relative paths)
// See: https://miniapps.farcaster.xyz/docs/embeds
function getBaseUrl(
	env: Env,
	c: { req: { header: (name: string) => string | undefined; url: string } },
): string | null {
	// 1. Prefer explicit APP_URL if set (most reliable for custom domains)
	if (env.APP_URL && env.APP_URL.trim() !== "") {
		const url = env.APP_URL.replace(/\/$/, "");
		if (url.startsWith("https://")) {
			return url;
		}
		// If APP_URL is set but not https, warn and continue
		console.warn(`APP_URL should be https, got: ${url}`);
	}

	// 2. Use Host header (always set by Cloudflare in production)
	const host = c.req.header("host");
	if (host) {
		// Reject localhost - embeds won't work in local dev
		if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
			return null; // Signal that we can't generate valid embed URLs
		}

		// Get protocol: prefer cf-visitor (Cloudflare-specific), then x-forwarded-proto
		let proto = "https";
		const cfVisitor = c.req.header("cf-visitor");
		if (cfVisitor) {
			try {
				const parsed = JSON.parse(cfVisitor);
				if (parsed.scheme) proto = parsed.scheme;
			} catch {
				// Ignore parse errors
			}
		} else {
			proto = c.req.header("x-forwarded-proto") || "https";
		}

		// Workers.dev domains are always https in production
		if (host.endsWith(".workers.dev")) {
			proto = "https";
		}

		return `${proto}://${host}`;
	}

	// 3. Fallback to URL origin from request
	try {
		const url = new URL(c.req.url);
		// Reject localhost origins
		if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

// Rate limiting configuration
const AI_RATE_LIMIT = 10; // requests per window
const AI_RATE_WINDOW_MS = 60_000; // 1 minute

// Check and update rate limit, returns { allowed, remaining, resetInSeconds }
async function checkAIRateLimit(
	db: D1Database,
	identifier: string,
): Promise<{ allowed: boolean; remaining: number; resetInSeconds: number }> {
	const now = Date.now();
	const windowStart = Math.floor(now / AI_RATE_WINDOW_MS) * AI_RATE_WINDOW_MS;

	// Atomic upsert: insert new record or update existing
	// If window has expired, reset count to 1; otherwise increment
	const result = await db
		.prepare(
			`INSERT INTO ai_rate_limits (identifier, request_count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(identifier) DO UPDATE SET
         request_count = CASE
           WHEN window_start < ? THEN 1
           ELSE request_count + 1
         END,
         window_start = CASE
           WHEN window_start < ? THEN ?
           ELSE window_start
         END
       RETURNING request_count, window_start`,
		)
		.bind(identifier, windowStart, windowStart, windowStart, windowStart)
		.first<{ request_count: number; window_start: number }>();

	if (!result) {
		// Shouldn't happen, but allow the request if DB fails
		return { allowed: true, remaining: AI_RATE_LIMIT - 1, resetInSeconds: 60 };
	}

	const resetInSeconds = Math.ceil((result.window_start + AI_RATE_WINDOW_MS - now) / 1000);

	return {
		allowed: result.request_count <= AI_RATE_LIMIT,
		remaining: Math.max(0, AI_RATE_LIMIT - result.request_count),
		resetInSeconds: Math.max(1, resetInSeconds),
	};
}

const app = new Hono<{ Bindings: Env }>();
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct" as keyof AiModels;

// CORS for local dev
app.use("/api/*", cors());

// GET /api/notifications?fid=123
app.get("/api/notifications", async (c) => {
	const fid = c.req.query("fid");
	if (!fid) {
		return c.json({ error: "fid is required" }, 400);
	}

	try {
		// Proxy to Neynar API
		const neynarUrl = new URL("https://api.neynar.com/v2/farcaster/notifications/");
		neynarUrl.searchParams.set("fid", fid);
		neynarUrl.searchParams.set("limit", "15");

		const response = await fetch(neynarUrl.toString(), {
			headers: {
				"x-api-key": c.env.NEYNAR_API_KEY,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const error = await response.text();
			return c.json({ error: "Neynar API error", details: error }, 502);
		}

		return c.json(await response.json());
	} catch (error) {
		return c.json({ error: "Failed to fetch notifications" }, 500);
	}
});

// GET /api/guestbook - fetch recent entries
app.get("/api/guestbook", async (c) => {
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT * FROM guestbook ORDER BY created_at DESC LIMIT 50",
		).all();
		return c.json({ entries: results });
	} catch (error) {
		return c.json({ error: "Failed to fetch guestbook entries" }, 500);
	}
});

// POST /api/guestbook - add entry
app.post("/api/guestbook", async (c) => {
	try {
		const body = await c.req.json<{
			fid: number;
			username: string;
			displayName?: string;
			pfpUrl?: string;
			message: string;
		}>();

		// Validate
		if (!body.fid || !body.username || !body.message) {
			return c.json({ error: "fid, username, and message are required" }, 400);
		}

		// Trim and validate message (max 140 chars)
		const message = body.message.trim().slice(0, 140);
		if (!message) {
			return c.json({ error: "Message cannot be empty" }, 400);
		}

		const result = await c.env.DB.prepare(
			"INSERT INTO guestbook (fid, username, display_name, pfp_url, message) VALUES (?, ?, ?, ?, ?) RETURNING *",
		)
			.bind(body.fid, body.username, body.displayName || null, body.pfpUrl || null, message)
			.first();

		return c.json({ entry: result }, 201);
	} catch (error) {
		return c.json({ error: "Failed to add guestbook entry" }, 500);
	}
});

// POST /api/ai/analyze-profile - Analyze Farcaster profile with AI
// Fetches user data + recent casts from Neynar, then runs AI analysis
app.post("/api/ai/analyze-profile", async (c) => {
	try {
		const { fid } = await c.req.json<{ fid: number }>();
		if (!fid) {
			return c.json({ error: "fid is required" }, 400);
		}

		// Rate limiting
		const identifier =
			c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
		const rateLimit = await checkAIRateLimit(c.env.DB, identifier);
		if (!rateLimit.allowed) {
			return c.json(
				{ error: `Rate limit exceeded. Try again in ${rateLimit.resetInSeconds} seconds.` },
				429,
			);
		}

		// Fetch user profile from Neynar
		const userRes = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
			headers: { "x-api-key": c.env.NEYNAR_API_KEY },
		});
		const userData = (await userRes.json()) as {
			users?: Array<{
				username: string;
				display_name: string;
				profile?: { bio?: { text?: string } };
				follower_count?: number;
				following_count?: number;
				power_badge?: boolean;
			}>;
		};
		const user = userData.users?.[0];

		// Fetch recent casts from Neynar
		const castsRes = await fetch(
			`https://api.neynar.com/v2/farcaster/feed/user/${fid}/replies_and_recasts?limit=5`,
			{ headers: { "x-api-key": c.env.NEYNAR_API_KEY } },
		);
		const castsData = (await castsRes.json()) as {
			casts?: Array<{ text: string }>;
		};
		const recentCasts = castsData.casts?.slice(0, 5).map((c) => c.text) || [];

		// Build rich prompt
		const prompt = `Analyze this Farcaster user and categorize them. Return ONLY valid JSON.

USER PROFILE:
- Username: ${user?.username || "unknown"}
- Display name: ${user?.display_name || "unknown"}
- Bio: ${user?.profile?.bio?.text || "No bio"}
- Followers: ${user?.follower_count || 0}
- Following: ${user?.following_count || 0}
- Power badge: ${user?.power_badge ? "Yes" : "No"}

RECENT CASTS:
${recentCasts.length > 0 ? recentCasts.map((c, i) => `${i + 1}. "${c.slice(0, 200)}"`).join("\n") : "No recent casts"}

CATEGORIES (pick exactly one):
- builder: Ships code, creates tools, technical content
- creator: Makes art, memes, threads, media content
- collector: NFTs, tokens, digital collectibles focus
- connector: Community building, networking, introductions
- lurker: Mostly observes, occasional engagement

Return: {"category": "one_of_above", "reason": "2-3 sentence explanation based on their bio and casts"}`;

		// Call AI
		let result = "";
		let provider: "openai" | "workers-ai" = "workers-ai";

		if (c.env.OPENAI_API_KEY) {
			try {
				const { OpenAI } = await import("openai");
				const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY, timeout: 15_000 });
				const completion = await openai.chat.completions.create({
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: prompt }],
				});
				result = completion.choices[0]?.message?.content || "";
				provider = "openai";
			} catch {
				// Fall through to Workers AI
			}
		}

		if (!result) {
			const response = (await c.env.AI.run(AI_MODEL, {
				prompt,
			})) as { response: string };
			result = response.response || "";
		}

		// Parse and validate JSON response
		try {
			const parsed = JSON.parse(result);
			return c.json({ ...parsed, provider });
		} catch {
			return c.json({ category: "unknown", reason: result, provider });
		}
	} catch (error) {
		return c.json(
			{ error: "Analysis failed", details: error instanceof Error ? error.message : String(error) },
			500,
		);
	}
});

// POST /api/ai/generate - AI text generation
// Rate limited to 10 requests/minute per IP
// Cost: Workers AI is free; OpenAI gpt-4o-mini ~$0.0001/request
app.post("/api/ai/generate", async (c) => {
	try {
		// Rate limiting by IP address
		const identifier =
			c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
		const rateLimit = await checkAIRateLimit(c.env.DB, identifier);

		if (!rateLimit.allowed) {
			return c.json(
				{
					error: `Rate limit exceeded. Try again in ${rateLimit.resetInSeconds} seconds.`,
					retryAfter: rateLimit.resetInSeconds,
				},
				{
					status: 429,
					headers: {
						"Retry-After": String(rateLimit.resetInSeconds),
						"X-RateLimit-Limit": String(AI_RATE_LIMIT),
						"X-RateLimit-Remaining": "0",
					},
				},
			);
		}

		const body = await c.req.json<{
			prompt: string;
			schema?: object;
		}>();

		// Validate prompt
		if (!body.prompt || typeof body.prompt !== "string") {
			return c.json({ error: "prompt is required and must be a string" }, 400);
		}

		const prompt = body.prompt.trim();
		if (!prompt) {
			return c.json({ error: "prompt cannot be empty" }, 400);
		}

		// Try OpenAI first if key is available
		if (c.env.OPENAI_API_KEY) {
			try {
				// Dynamic import to avoid bundling issues
				const { OpenAI } = await import("openai");
				const openai = new OpenAI({
					apiKey: c.env.OPENAI_API_KEY,
					timeout: 15_000, // 15 second timeout
				});

				const params = {
					model: "gpt-4o-mini" as const,
					messages: [{ role: "user" as const, content: prompt }],
					...(body.schema && {
						response_format: {
							type: "json_schema" as const,
							json_schema: {
								name: "response",
								schema: body.schema as Record<string, unknown>,
								strict: true,
							},
						},
					}),
				} as const;

				const completion = await openai.chat.completions.create(params as any);
				const result = completion.choices[0]?.message?.content || "";

				return c.json(
					{ result, provider: "openai" },
					{
						headers: {
							"X-RateLimit-Limit": String(AI_RATE_LIMIT),
							"X-RateLimit-Remaining": String(rateLimit.remaining),
						},
					},
				);
			} catch (error) {
				// If OpenAI fails (timeout, rate limit, etc.), fall back to Workers AI
				console.error(
					"OpenAI failed, falling back to Workers AI:",
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		// Fallback to Workers AI (free, always available)
		try {
			const response = (await c.env.AI.run(AI_MODEL, {
				prompt,
			})) as { response: string };

			return c.json(
				{ result: response.response || "", provider: "workers-ai" },
				{
					headers: {
						"X-RateLimit-Limit": String(AI_RATE_LIMIT),
						"X-RateLimit-Remaining": String(rateLimit.remaining),
					},
				},
			);
		} catch (error) {
			return c.json(
				{
					error: "AI generation failed. Workers AI might be temporarily unavailable.",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	} catch (error) {
		return c.json(
			{
				error: "Failed to process AI request",
				details: error instanceof Error ? error.message : String(error),
			},
			500,
		);
	}
});

// GET /api/og - Generate dynamic Open Graph image for sharing
app.get("/api/og", async (c) => {
	const username = c.req.query("username") || "someone";
	const displayName = c.req.query("displayName") || username;
	const pfpUrl = c.req.query("pfpUrl");
	const message = c.req.query("message") || "signed the guestbook!";
	const appName = c.req.query("appName") || "jack-template";

	// Fetch and convert pfp to base64 if provided
	// Use timeout to prevent hanging on slow/unreachable URLs
	let pfpBase64 = "";
	if (pfpUrl) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

			const pfpResponse = await fetch(pfpUrl, { signal: controller.signal });
			clearTimeout(timeoutId);

			if (pfpResponse.ok) {
				const buffer = await pfpResponse.arrayBuffer();
				// Skip images > 500KB to prevent memory issues
				if (buffer.byteLength < 500_000) {
					const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
					const contentType = pfpResponse.headers.get("content-type") || "image/png";
					pfpBase64 = `data:${contentType};base64,${base64}`;
				}
			}
		} catch {
			// Ignore pfp fetch errors (timeout, network, etc.) - show placeholder instead
		}
	}

	// Escape HTML entities for safety (including quotes for attribute values)
	const escapeHtml = (str: string) =>
		str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

	// Truncate message for display (shorter for larger font size)
	const truncatedMessage = message.length > 50 ? `${message.slice(0, 47)}...` : message;

	// Profile picture HTML (larger for 1200x630 canvas)
	const pfpHtml = pfpBase64
		? `<img src="${pfpBase64}" width="100" height="100" style="border-radius: 50%; border: 3px solid #7c3aed; margin-right: 24px;" />`
		: `<div style="width: 100px; height: 100px; border-radius: 50%; background: #3f3f46; border: 3px solid #7c3aed; display: flex; align-items: center; justify-content: center; font-size: 40px; margin-right: 24px;">👤</div>`;

	// Standard OG image size (1200x630) with extra left padding for Farcaster's crop behavior
	const html = `
		<div style="width: 1200px; height: 630px; display: flex; flex-direction: column; background: linear-gradient(135deg, #18181b 0%, #27272a 100%); padding: 60px 60px 60px 180px; font-family: system-ui, sans-serif;">
			<div style="display: flex; align-items: center; margin-bottom: 40px;">
				${pfpHtml}
				<div style="display: flex; flex-direction: column;">
					<span style="font-size: 36px; font-weight: 600; color: #fafafa;">${escapeHtml(displayName)}</span>
					<span style="font-size: 24px; color: #a1a1aa;">@${escapeHtml(username)}</span>
				</div>
			</div>
			<div style="flex: 1; display: flex; align-items: center;">
				<p style="font-size: 40px; color: #e4e4e7; margin: 0;">"${escapeHtml(truncatedMessage)}"</p>
			</div>
			<div style="display: flex; justify-content: space-between; align-items: flex-end;">
				<span style="font-size: 20px; color: #71717a;">${escapeHtml(appName)}</span>
				<span style="font-size: 16px; color: #52525b;">powered by getjack.org</span>
			</div>
		</div>
	`;

	const response = new ImageResponse(html, {
		width: 1200,
		height: 630,
	});

	// Cache for 1 day - OG images are immutable once shared
	response.headers.set("Cache-Control", "public, max-age=86400, immutable");
	return response;
});

// GET /share - Shareable page with fc:miniapp meta tags for viral embedding
// When this URL is shared in a cast, Farcaster renders it as a clickable miniapp card
app.get("/share", (c) => {
	const url = new URL(c.req.url);
	const username = url.searchParams.get("username") || "someone";
	const displayName = url.searchParams.get("displayName") || username;
	const message = url.searchParams.get("message") || "signed the guestbook!";
	const appName = url.searchParams.get("appName") || "jack-template";

	// Get production URL - returns null in local dev (localhost not valid for embeds)
	const baseUrl = getBaseUrl(c.env, c);

	// Local development: show helpful error instead of broken embed
	if (!baseUrl) {
		const errorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Share Preview (Local Dev)</title>
	<style>
		body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
		.warning { background: #fef3c7; border: 1px solid #f59e0b; padding: 16px; border-radius: 8px; }
		code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
	</style>
</head>
<body>
	<div class="warning">
		<h2>⚠️ Share embeds require production deployment</h2>
		<p>Farcaster embeds need valid <code>https://</code> URLs. Localhost URLs won't work.</p>
		<p><strong>To test sharing:</strong></p>
		<ol>
			<li>Deploy with <code>jack ship</code></li>
			<li>Set <code>APP_URL</code> in wrangler.jsonc to your deployed URL</li>
			<li>Or access via your <code>*.workers.dev</code> URL</li>
		</ol>
	</div>
	<h3>Preview data:</h3>
	<ul>
		<li>User: ${displayName} (@${username})</li>
		<li>Message: "${message}"</li>
		<li>App: ${appName}</li>
	</ul>
</body>
</html>`;
		return c.html(errorHtml, 200);
	}

	// Build the OG image URL with same params
	const ogParams = new URLSearchParams();
	ogParams.set("username", username);
	ogParams.set("displayName", displayName);
	ogParams.set("message", message);
	ogParams.set("appName", appName);
	const pfpUrl = url.searchParams.get("pfpUrl");
	if (pfpUrl) ogParams.set("pfpUrl", pfpUrl);

	const ogImageUrl = `${baseUrl}/api/og?${ogParams.toString()}`;

	// fc:miniapp meta tag for Farcaster embed
	const miniappMeta = JSON.stringify({
		version: "1",
		imageUrl: ogImageUrl,
		button: {
			title: "Open App",
			action: {
				type: "launch_miniapp",
				name: appName,
				url: baseUrl,
			},
		},
	});

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${displayName} signed ${appName}</title>
	<meta name="fc:miniapp" content='${miniappMeta}' />
	<meta property="og:title" content="${displayName} signed the guestbook" />
	<meta property="og:description" content="${message}" />
	<meta property="og:image" content="${ogImageUrl}" />
</head>
<body>
	<script>window.location.href = "${baseUrl}";</script>
	<p>Redirecting to ${appName}...</p>
</body>
</html>`;

	return c.html(html, 200, {
		"Cache-Control": "public, max-age=86400",
	});
});

// Serve React app for all other routes
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Export type for hono/client
export type AppType = typeof app;
export default app;

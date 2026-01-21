interface Env {
	AI: Ai;
	ASSETS: Fetcher;
}

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

// Rate limiting: 10 requests per minute per IP
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now >= entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return true;
	}

	if (entry.count >= RATE_LIMIT) {
		return false;
	}

	entry.count++;
	return true;
}

// Clean up old entries periodically to prevent memory leaks
function cleanupRateLimitMap(): void {
	const now = Date.now();
	for (const [ip, entry] of rateLimitMap) {
		if (now >= entry.resetAt) {
			rateLimitMap.delete(ip);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Serve static assets for non-API routes
		if (request.method === "GET" && !url.pathname.startsWith("/api")) {
			return env.ASSETS.fetch(request);
		}

		// POST /api/chat - Streaming chat endpoint
		if (request.method === "POST" && url.pathname === "/api/chat") {
			const ip = request.headers.get("cf-connecting-ip") || "unknown";

			// Check rate limit
			if (!checkRateLimit(ip)) {
				// Cleanup old entries occasionally
				cleanupRateLimitMap();
				return Response.json(
					{ error: "Too many requests. Please wait a moment and try again." },
					{ status: 429 },
				);
			}

			try {
				const body = (await request.json()) as { messages?: ChatMessage[] };
				const messages = body.messages;

				if (!messages || !Array.isArray(messages)) {
					return Response.json(
						{ error: "Invalid request. Please provide a messages array." },
						{ status: 400 },
					);
				}

				// Stream response using SSE
				const stream = await env.AI.run(
					"@cf/mistral/mistral-7b-instruct-v0.1",
					{
						messages,
						stream: true,
						max_tokens: 1024,
					},
				);

				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			} catch (err) {
				console.error("Chat error:", err);
				return Response.json(
					{ error: "Something went wrong. Please try again." },
					{ status: 500 },
				);
			}
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

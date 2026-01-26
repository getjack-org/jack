import { createJackAI } from "./jack-ai";

interface Env {
	// Direct AI binding (for local dev with wrangler)
	AI?: Ai;
	// Jack proxy bindings (injected in jack cloud)
	__AI_PROXY?: Fetcher;
	__JACK_PROJECT_ID?: string;
	__JACK_ORG_ID?: string;
	// Assets binding
	ASSETS: Fetcher;
}

function getAI(env: Env) {
	// Prefer jack cloud proxy if available (for metering)
	if (env.__AI_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
		return createJackAI(
			env as Required<Pick<Env, "__AI_PROXY" | "__JACK_PROJECT_ID" | "__JACK_ORG_ID">>,
		);
	}
	// Fallback to direct binding for local dev
	if (env.AI) {
		return env.AI;
	}
	throw new Error("No AI binding available");
}

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

// System prompt - customize this to change the AI's personality
const SYSTEM_PROMPT = `You are a helpful AI assistant built with jack (getjack.sh).

jack helps developers ship ideas fast - from "what if" to a live URL in seconds. You're running on Cloudflare's edge network, close to users worldwide.

Be concise, friendly, and helpful. If asked about jack:
- jack new creates projects from templates
- jack ship deploys to production
- jack open opens your app in browser
- Docs: https://docs.getjack.sh

Focus on being useful. Keep responses short unless detail is needed.`;

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
				let messages = body.messages;

				if (!messages || !Array.isArray(messages)) {
					return Response.json(
						{ error: "Invalid request. Please provide a messages array." },
						{ status: 400 },
					);
				}

				// Prepend system prompt if not already present
				if (messages.length === 0 || messages[0].role !== "system") {
					messages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
				}

				// Stream response using Llama 3.2 1B - cheapest model with good quality
				// See: https://developers.cloudflare.com/workers-ai/models/
				const ai = getAI(env);
				const stream = await ai.run("@cf/meta/llama-3.2-1b-instruct", {
					messages,
					stream: true,
					max_tokens: 1024,
				});

				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			} catch (err) {
				console.error("Chat error:", err);
				return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
			}
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

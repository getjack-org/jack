import { type JackAI, createJackAI } from "./jack-ai";

interface Env {
	AI?: Ai;
	VECTORS: VectorizeIndex;
	__AI_PROXY?: Fetcher;
	DB: D1Database;
	ASSETS: Fetcher;
}

// Minimal AI interface for embedding generation
type AIClient = {
	run: (model: string, inputs: { text: string }) => Promise<{ data: number[][] } | unknown>;
};

function getAI(env: Env): AIClient {
	// Prefer jack cloud proxy if available (for metering)
	if (env.__AI_PROXY) {
		return createJackAI(env as Pick<Env, "__AI_PROXY"> & { __AI_PROXY: Fetcher }) as AIClient;
	}
	// Fallback to direct binding for local dev
	if (env.AI) {
		return env.AI as unknown as AIClient;
	}
	throw new Error("No AI binding available");
}

// Rate limiting: 10 requests per minute per IP
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now > entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return true;
	}

	if (entry.count >= RATE_LIMIT) {
		return false;
	}

	entry.count++;
	return true;
}

/**
 * Extract embedding vector from AI response
 * Handles response from @cf/baai/bge-base-en-v1.5
 */
function getEmbeddingVector(response: unknown): number[] | null {
	if (
		response &&
		typeof response === "object" &&
		"data" in response &&
		Array.isArray((response as { data: unknown }).data) &&
		(response as { data: unknown[] }).data.length > 0
	) {
		return (response as { data: number[][] }).data[0];
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Serve static assets for non-API routes
		if (request.method === "GET" && !url.pathname.startsWith("/api")) {
			return env.ASSETS.fetch(request);
		}

		// Rate limiting for API routes
		const ip = request.headers.get("cf-connecting-ip") || "unknown";
		if (!checkRateLimit(ip)) {
			return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
		}

		// POST /api/index - Index a document
		if (request.method === "POST" && url.pathname === "/api/index") {
			try {
				const body = (await request.json()) as {
					id?: string;
					content?: string;
				};
				const { id, content } = body;

				if (!id || !content) {
					return Response.json({ error: "Missing id or content" }, { status: 400 });
				}

				// Generate embedding using Cloudflare AI
				const ai = getAI(env);
				const embedding = await ai.run("@cf/baai/bge-base-en-v1.5", {
					text: content,
				});

				const embeddingVector = getEmbeddingVector(embedding);
				if (!embeddingVector) {
					return Response.json({ error: "Failed to generate embedding" }, { status: 500 });
				}

				// Store in Vectorize
				const vectors = env.VECTORS;
				await vectors.insert([
					{
						id,
						values: embeddingVector,
						metadata: { preview: content.slice(0, 100) },
					},
				]);

				// Store full content in D1
				await env.DB.prepare("INSERT OR REPLACE INTO documents (id, content) VALUES (?, ?)")
					.bind(id, content)
					.run();

				return Response.json({ success: true, id });
			} catch (err) {
				console.error("Index error:", err);
				return Response.json({ error: "Failed to index document" }, { status: 500 });
			}
		}

		// POST /api/search - Semantic search
		if (request.method === "POST" && url.pathname === "/api/search") {
			try {
				const body = (await request.json()) as {
					query?: string;
					limit?: number;
				};
				const { query, limit = 5 } = body;

				if (!query) {
					return Response.json({ error: "Missing query" }, { status: 400 });
				}

				// Generate query embedding
				const ai = getAI(env);
				const embedding = await ai.run("@cf/baai/bge-base-en-v1.5", {
					text: query,
				});

				const embeddingVector = getEmbeddingVector(embedding);
				if (!embeddingVector) {
					return Response.json({ error: "Failed to generate embedding" }, { status: 500 });
				}

				// Search Vectorize
				const vectors = env.VECTORS;
				const results = await vectors.query(embeddingVector, {
					topK: limit,
					returnMetadata: "all",
				});

				return Response.json({ results: results.matches });
			} catch (err) {
				console.error("Search error:", err);
				return Response.json({ error: "Search failed" }, { status: 500 });
			}
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

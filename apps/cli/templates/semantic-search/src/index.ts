interface Env {
	AI: Ai;
	VECTORS: VectorizeIndex;
	DB: D1Database;
	ASSETS: Fetcher;
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
 * Handles union type from @cf/baai/bge-base-en-v1.5
 */
function getEmbeddingVector(response: Awaited<ReturnType<Ai["run"]>>): number[] | null {
	if (
		response &&
		typeof response === "object" &&
		"data" in response &&
		Array.isArray(response.data) &&
		response.data.length > 0
	) {
		return response.data[0] as number[];
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

				// Generate embedding using free Cloudflare AI
				const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
					text: content,
				});

				const embeddingVector = getEmbeddingVector(embedding);
				if (!embeddingVector) {
					return Response.json({ error: "Failed to generate embedding" }, { status: 500 });
				}

				// Store in Vectorize
				await env.VECTORS.insert([
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
				const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
					text: query,
				});

				const embeddingVector = getEmbeddingVector(embedding);
				if (!embeddingVector) {
					return Response.json({ error: "Failed to generate embedding" }, { status: 500 });
				}

				// Search Vectorize
				const results = await env.VECTORS.query(embeddingVector, {
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

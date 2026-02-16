/**
 * Jack Vectorize Client - Drop-in replacement for Cloudflare Vectorize binding.
 *
 * This wrapper provides the same interface as env.VECTORS but routes calls
 * through jack's binding proxy for metering and quota enforcement.
 *
 * Usage in templates:
 * ```typescript
 * import { createJackVectorize } from "./jack-vectorize";
 *
 * interface Env {
 *   __VECTORIZE_PROXY: Fetcher;   // Service binding to binding-proxy worker
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const VECTORS = createJackVectorize(env, "my-index");
 *     const results = await VECTORS.query(vector, { topK: 10 });
 *     // Works exactly like env.VECTORS.query()
 *   }
 * };
 * ```
 *
 * The wrapper is transparent - it accepts the same parameters as the native
 * VectorizeIndex and returns the same response types.
 */

interface JackVectorizeEnv {
	__VECTORIZE_PROXY: Fetcher;
}

interface VectorizeQueryOptions {
	topK?: number;
	filter?: Record<string, unknown>;
	returnValues?: boolean;
	returnMetadata?: "none" | "indexed" | "all";
}

interface VectorizeVector {
	id: string;
	values: number[];
	metadata?: Record<string, unknown>;
	namespace?: string;
}

interface VectorizeMatch {
	id: string;
	score: number;
	values?: number[];
	metadata?: Record<string, unknown>;
}

interface VectorizeQueryResult {
	matches: VectorizeMatch[];
	count: number;
}

interface VectorizeMutationResult {
	mutationId: string;
	count: number;
	ids: string[];
}

interface VectorizeIndexDetails {
	dimensions: number;
	metric: "cosine" | "euclidean" | "dot-product";
	vectorCount: number;
}

/**
 * Creates a Jack Vectorize client that mirrors the Cloudflare VectorizeIndex interface.
 *
 * @param env - Worker environment with jack proxy bindings
 * @param indexName - Name of the Vectorize index
 * @returns VectorizeIndex-compatible object
 */
export function createJackVectorize(
	env: JackVectorizeEnv,
	indexName: string,
): {
	query: (vector: number[], options?: VectorizeQueryOptions) => Promise<VectorizeQueryResult>;
	upsert: (vectors: VectorizeVector[]) => Promise<VectorizeMutationResult>;
	insert: (vectors: VectorizeVector[]) => Promise<VectorizeMutationResult>;
	deleteByIds: (ids: string[]) => Promise<VectorizeMutationResult>;
	getByIds: (ids: string[]) => Promise<VectorizeVector[]>;
	describe: () => Promise<VectorizeIndexDetails>;
} {
	async function proxyRequest<T>(operation: string, params: unknown): Promise<T> {
		const response = await env.__VECTORIZE_PROXY.fetch("http://internal/vectorize", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				operation,
				index_name: indexName,
				params,
			}),
		});

		// Handle quota exceeded or rate limited
		if (response.status === 429) {
			const error = (await response.json()) as {
				message?: string;
				code?: string;
				resetIn?: number;
			};
			const quotaError = new Error(error.message || "Vectorize quota exceeded");
			(quotaError as Error & { code: string }).code = error.code || "VECTORIZE_QUOTA_EXCEEDED";
			(quotaError as Error & { resetIn?: number }).resetIn = error.resetIn;
			throw quotaError;
		}

		// Handle other errors
		if (!response.ok) {
			const error = (await response.json()) as { error?: string };
			throw new Error(error.error || `Vectorize ${operation} failed`);
		}

		return response.json() as Promise<T>;
	}

	return {
		async query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
			return proxyRequest<VectorizeQueryResult>("query", {
				vector,
				...options,
			});
		},

		async upsert(vectors: VectorizeVector[]): Promise<VectorizeMutationResult> {
			return proxyRequest<VectorizeMutationResult>("upsert", { vectors });
		},

		async insert(vectors: VectorizeVector[]): Promise<VectorizeMutationResult> {
			// insert is typically an alias for upsert in Vectorize
			return proxyRequest<VectorizeMutationResult>("upsert", { vectors });
		},

		async deleteByIds(ids: string[]): Promise<VectorizeMutationResult> {
			return proxyRequest<VectorizeMutationResult>("deleteByIds", { ids });
		},

		async getByIds(ids: string[]): Promise<VectorizeVector[]> {
			return proxyRequest<VectorizeVector[]>("getByIds", { ids });
		},

		async describe(): Promise<VectorizeIndexDetails> {
			return proxyRequest<VectorizeIndexDetails>("describe", {});
		},
	};
}

/**
 * Type alias for the Jack Vectorize client
 */
export type JackVectorize = ReturnType<typeof createJackVectorize>;

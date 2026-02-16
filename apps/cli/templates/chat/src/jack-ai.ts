/**
 * Jack AI Client - Drop-in replacement for Cloudflare AI binding.
 *
 * This wrapper provides the same interface as env.AI but routes calls
 * through jack's binding proxy for metering and quota enforcement.
 *
 * Usage in templates:
 * ```typescript
 * import { createJackAI } from "./jack-ai";
 *
 * interface Env {
 *   __AI_PROXY: Fetcher;        // Service binding to binding-proxy worker
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const AI = createJackAI(env);
 *     const result = await AI.run("@cf/meta/llama-3.2-1b-instruct", { messages });
 *     // Works exactly like env.AI.run()
 *   }
 * };
 * ```
 *
 * The wrapper is transparent - it accepts the same parameters as env.AI.run()
 * and returns the same response types, including streaming.
 */

interface JackAIEnv {
	__AI_PROXY: Fetcher;
}

/**
 * Creates a Jack AI client that mirrors the Cloudflare AI binding interface.
 *
 * @param env - Worker environment with jack proxy bindings
 * @returns AI-compatible object with run() method
 */
export function createJackAI(env: JackAIEnv): {
	run: <T = unknown>(
		model: string,
		inputs: unknown,
		options?: unknown,
	) => Promise<T | ReadableStream>;
} {
	return {
		async run<T = unknown>(
			model: string,
			inputs: unknown,
			options?: unknown,
		): Promise<T | ReadableStream> {
			const response = await env.__AI_PROXY.fetch("http://internal/ai/run", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model, inputs, options }),
			});

			// Handle quota exceeded
			if (response.status === 429) {
				const error = await response.json();
				const quotaError = new Error(
					(error as { message?: string }).message || "AI quota exceeded",
				);
				(quotaError as Error & { code: string }).code = "AI_QUOTA_EXCEEDED";
				(quotaError as Error & { resetIn?: number }).resetIn = (
					error as { resetIn?: number }
				).resetIn;
				throw quotaError;
			}

			// Handle other errors
			if (!response.ok) {
				const error = await response.json();
				throw new Error((error as { error?: string }).error || "AI request failed");
			}

			// Handle streaming response
			const contentType = response.headers.get("Content-Type");
			if (contentType?.includes("text/event-stream")) {
				return response.body as ReadableStream;
			}

			// Handle JSON response
			return response.json() as Promise<T>;
		},
	};
}

/**
 * Type-safe wrapper that infers return types based on model.
 * For advanced users who want full type safety.
 */
export type JackAI = ReturnType<typeof createJackAI>;

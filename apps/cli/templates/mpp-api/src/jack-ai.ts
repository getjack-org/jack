/**
 * Jack AI Client - Drop-in replacement for Cloudflare AI binding.
 *
 * Routes AI calls through jack's binding proxy for metering and quota enforcement.
 * Works transparently in both local dev (env.AI) and jack cloud (env.__AI_PROXY).
 */

interface JackAIEnv {
	__AI_PROXY: Fetcher;
}

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
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, inputs, options }),
			});

			if (response.status === 429) {
				const error = await response.json();
				const quotaError = new Error(
					(error as { message?: string }).message || "AI quota exceeded",
				);
				(quotaError as Error & { code: string }).code = "AI_QUOTA_EXCEEDED";
				throw quotaError;
			}

			if (!response.ok) {
				const error = await response.json();
				throw new Error(
					(error as { error?: string }).error || "AI request failed",
				);
			}

			const contentType = response.headers.get("Content-Type");
			if (contentType?.includes("text/event-stream")) {
				return response.body as ReadableStream;
			}

			return response.json() as Promise<T>;
		},
	};
}

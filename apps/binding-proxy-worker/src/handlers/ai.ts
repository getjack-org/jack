import { MeteringService } from "../metering";
import { QuotaManager } from "../quota";
import type { AIUsageDataPoint, Env } from "../types";

/**
 * AI Proxy Handler - receives fetch requests from user workers and forwards to real AI.
 *
 * Architecture:
 * 1. User worker calls env.AI.run() via jack's AI client wrapper
 * 2. Wrapper sends POST to this proxy via service binding fetch
 * 3. Proxy checks quota, forwards to real AI, meters usage
 * 4. Response streamed back to user worker
 *
 * Context (project_id, org_id) is passed via X-Jack-* headers.
 */
export class AIHandler {
	private quotaManager: QuotaManager;
	private meter: MeteringService;
	private ai: Ai;
	private rateLimiter: RateLimit;

	constructor(env: Env) {
		// Parse quota limit from env (for testing and tier support)
		const quotaLimit = env.AI_QUOTA_LIMIT ? Number.parseInt(env.AI_QUOTA_LIMIT) : undefined;
		this.quotaManager = new QuotaManager(env.QUOTA_KV, quotaLimit);
		this.meter = new MeteringService(env.USAGE);
		this.ai = env.AI;
		this.rateLimiter = env.AI_RATE_LIMITER;
	}

	/**
	 * Handle AI proxy request
	 */
	async handleRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
		// Extract context from headers
		const projectId = request.headers.get("X-Jack-Project-ID");
		const orgId = request.headers.get("X-Jack-Org-ID");

		if (!projectId || !orgId) {
			return Response.json(
				{
					error: "Missing project context headers. This proxy is for jack cloud deployments only.",
				},
				{ status: 400 },
			);
		}

		// 1. Rate limit check (burst protection - 100 req/10s per project)
		const { success: rateLimitOk } = await this.rateLimiter.limit({ key: projectId });
		if (!rateLimitOk) {
			return Response.json(
				{
					error: "Rate limit exceeded",
					code: "RATE_LIMITED",
					message: "Too many requests. Please slow down.",
				},
				{
					status: 429,
					headers: { "Retry-After": "10" },
				},
			);
		}

		// Parse request body
		let body: { model: string; inputs: unknown; options?: unknown };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const { model, inputs, options } = body;

		if (!model || inputs === undefined) {
			return Response.json({ error: "Missing model or inputs" }, { status: 400 });
		}

		// 2. Check daily quota
		const quota = await this.quotaManager.checkAIQuota(projectId);
		if (!quota.allowed) {
			return Response.json(
				{
					error: "AI quota exceeded",
					code: "AI_QUOTA_EXCEEDED",
					resetIn: quota.resetIn,
					message: `AI quota exceeded. Resets at midnight UTC (${quota.resetIn}s).`,
				},
				{
					status: 429,
					headers: { "Retry-After": quota.resetIn.toString() },
				},
			);
		}

		// 3. Estimate input tokens before calling AI
		const tokensIn = MeteringService.estimateInputTokens(inputs);

		// 4. Call real AI binding
		const startTime = Date.now();
		try {
			const result = await this.ai.run(
				model as Parameters<Ai["run"]>[0],
				inputs as Parameters<Ai["run"]>[1],
				options as Parameters<Ai["run"]>[2],
			);
			const duration = Date.now() - startTime;

			// 5. Handle streaming responses
			if (result instanceof ReadableStream) {
				// Wrap stream to accumulate text for token estimation
				const { readable, writable } = new TransformStream();
				const decoder = new TextDecoder();
				let outputText = "";

				const countingPipe = async () => {
					const reader = result.getReader();
					const writer = writable.getWriter();

					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) {
								// Log usage when stream completes with accurate token count
								const tokensOut = MeteringService.estimateTokens(outputText);
								this.meter.logAICall({
									project_id: projectId,
									org_id: orgId,
									model,
									duration_ms: Date.now() - startTime,
									tokens_in: tokensIn,
									tokens_out: tokensOut,
								});
								await this.quotaManager.incrementAIUsage(projectId);
								await writer.close();
								break;
							}
							// Decode chunk and accumulate for token counting
							outputText += decoder.decode(value, { stream: true });
							await writer.write(value);
						}
					} catch (error) {
						// Log partial usage on error
						const tokensOut = MeteringService.estimateTokens(outputText);
						this.meter.logAICall({
							project_id: projectId,
							org_id: orgId,
							model,
							duration_ms: Date.now() - startTime,
							tokens_in: tokensIn,
							tokens_out: tokensOut,
						});
						await writer.abort(error);
					}
				};

				// Run the counting pipe in the background
				ctx.waitUntil(countingPipe());

				return new Response(readable, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						"X-Jack-AI-Duration": duration.toString(),
						"X-Jack-Tokens-In": tokensIn.toString(),
					},
				});
			}

			// 6. Handle regular JSON responses
			// Estimate output tokens from response
			let tokensOut = 0;
			if (typeof result === "object" && result !== null) {
				const responseText = (result as Record<string, unknown>).response;
				if (typeof responseText === "string") {
					tokensOut = MeteringService.estimateTokens(responseText);
				} else {
					// Fallback: stringify and estimate with tokenx
					tokensOut = MeteringService.estimateTokens(JSON.stringify(result));
				}
			}

			// Log usage with token counts
			ctx.waitUntil(
				(async () => {
					this.meter.logAICall({
						project_id: projectId,
						org_id: orgId,
						model,
						duration_ms: duration,
						tokens_in: tokensIn,
						tokens_out: tokensOut,
					});
					await this.quotaManager.incrementAIUsage(projectId);
				})(),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-AI-Duration": duration.toString(),
					"X-Jack-Tokens-In": tokensIn.toString(),
					"X-Jack-Tokens-Out": tokensOut.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "AI request failed";

			// Still log the failed attempt with input tokens
			this.meter.logAICall({
				project_id: projectId,
				org_id: orgId,
				model,
				duration_ms: duration,
				tokens_in: tokensIn,
				tokens_out: 0,
			});

			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-AI-Duration": duration.toString() } },
			);
		}
	}
}

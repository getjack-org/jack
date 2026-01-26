import { MeteringService } from "../metering";
import { QuotaManager } from "../quota";
import type { Env, VectorizeProxyRequest, VectorizeUsageDataPoint } from "../types";

/**
 * Vectorize Proxy Handler - receives fetch requests from user workers and forwards to real Vectorize.
 *
 * Architecture:
 * 1. User worker calls env.VECTORIZE operations via jack's Vectorize client wrapper
 * 2. Wrapper sends POST to this proxy via service binding fetch
 * 3. Proxy checks quota, forwards to real Vectorize, meters usage
 * 4. Response returned to user worker
 *
 * Context (project_id, org_id) is passed via X-Jack-* headers.
 */
export class VectorizeHandler {
	private quotaManager: QuotaManager;
	private meter: MeteringService;
	private vectorize: VectorizeIndex;
	private rateLimiter: RateLimit;

	constructor(env: Env) {
		// Parse quota limits from env
		const queryLimit = env.VECTORIZE_QUERY_QUOTA_LIMIT
			? Number.parseInt(env.VECTORIZE_QUERY_QUOTA_LIMIT)
			: undefined;
		const mutationLimit = env.VECTORIZE_MUTATION_QUOTA_LIMIT
			? Number.parseInt(env.VECTORIZE_MUTATION_QUOTA_LIMIT)
			: undefined;
		this.quotaManager = new QuotaManager(
			env.QUOTA_KV,
			undefined, // aiQuotaLimit not needed here
			queryLimit,
			mutationLimit,
		);
		this.meter = new MeteringService(env.USAGE);
		this.vectorize = env.VECTORIZE;
		this.rateLimiter = env.VECTORIZE_RATE_LIMITER;
	}

	/**
	 * Handle Vectorize proxy request
	 */
	async handleRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
		// Extract context from headers (same as AI handler)
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

		// Rate limit check (burst protection - 100 req/10s per project)
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
		let body: VectorizeProxyRequest;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const { operation, index_name, params } = body;

		if (!operation || !index_name) {
			return Response.json({ error: "Missing operation or index_name" }, { status: 400 });
		}

		// Route to appropriate handler based on operation
		switch (operation) {
			case "query":
				return this.handleQuery(projectId, orgId, index_name, params, ctx);
			case "upsert":
				return this.handleUpsert(projectId, orgId, index_name, params, ctx);
			case "deleteByIds":
				return this.handleDeleteByIds(projectId, orgId, index_name, params, ctx);
			case "getByIds":
				return this.handleGetByIds(projectId, orgId, index_name, params, ctx);
			case "describe":
				return this.handleDescribe(projectId, orgId, index_name, ctx);
			default:
				return Response.json({ error: "Unknown operation" }, { status: 400 });
		}
	}

	/**
	 * Handle query operation
	 */
	private async handleQuery(
		projectId: string,
		orgId: string,
		indexName: string,
		params: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Check query quota
		const quota = await this.quotaManager.checkVectorizeQueryQuota(projectId);
		if (!quota.allowed) {
			return Response.json(
				{
					error: "Vectorize query quota exceeded",
					code: "VECTORIZE_QUERY_QUOTA_EXCEEDED",
					resetIn: quota.resetIn,
					message: `Vectorize query quota exceeded. Resets at midnight UTC (${quota.resetIn}s).`,
				},
				{
					status: 429,
					headers: { "Retry-After": quota.resetIn.toString() },
				},
			);
		}

		const startTime = Date.now();
		try {
			// params should be { vector: number[], topK?: number, filter?: object, returnValues?: boolean, returnMetadata?: string }
			const queryParams = params as VectorizeQueryOptions & { vector: number[] };
			const result = await this.vectorize.query(queryParams.vector, {
				topK: queryParams.topK,
				filter: queryParams.filter,
				returnValues: queryParams.returnValues,
				returnMetadata: queryParams.returnMetadata,
			});
			const duration = Date.now() - startTime;

			// Log and increment quota
			ctx.waitUntil(
				(async () => {
					this.meter.logVectorizeCall({
						project_id: projectId,
						org_id: orgId,
						index_name: indexName,
						operation: "query",
						duration_ms: duration,
					});
					await this.quotaManager.incrementVectorizeQueries(projectId);
				})(),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-Vectorize-Duration": duration.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "Query failed";
			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-Vectorize-Duration": duration.toString() } },
			);
		}
	}

	/**
	 * Handle upsert operation
	 */
	private async handleUpsert(
		projectId: string,
		orgId: string,
		indexName: string,
		params: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Check mutation quota
		const quota = await this.quotaManager.checkVectorizeMutationQuota(projectId);
		if (!quota.allowed) {
			return Response.json(
				{
					error: "Vectorize mutation quota exceeded",
					code: "VECTORIZE_MUTATION_QUOTA_EXCEEDED",
					resetIn: quota.resetIn,
					message: `Vectorize mutation quota exceeded. Resets at midnight UTC (${quota.resetIn}s).`,
				},
				{
					status: 429,
					headers: { "Retry-After": quota.resetIn.toString() },
				},
			);
		}

		const startTime = Date.now();
		try {
			// params should be { vectors: VectorizeVector[] }
			const upsertParams = params as { vectors: VectorizeVector[] };
			const result = await this.vectorize.upsert(upsertParams.vectors);
			const duration = Date.now() - startTime;

			ctx.waitUntil(
				(async () => {
					this.meter.logVectorizeCall({
						project_id: projectId,
						org_id: orgId,
						index_name: indexName,
						operation: "upsert",
						duration_ms: duration,
						vector_count: upsertParams.vectors.length,
					});
					await this.quotaManager.incrementVectorizeMutations(projectId);
				})(),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-Vectorize-Duration": duration.toString(),
					"X-Jack-Vector-Count": upsertParams.vectors.length.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "Upsert failed";
			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-Vectorize-Duration": duration.toString() } },
			);
		}
	}

	/**
	 * Handle deleteByIds operation
	 */
	private async handleDeleteByIds(
		projectId: string,
		orgId: string,
		indexName: string,
		params: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Check mutation quota
		const quota = await this.quotaManager.checkVectorizeMutationQuota(projectId);
		if (!quota.allowed) {
			return Response.json(
				{
					error: "Vectorize mutation quota exceeded",
					code: "VECTORIZE_MUTATION_QUOTA_EXCEEDED",
					resetIn: quota.resetIn,
					message: `Vectorize mutation quota exceeded. Resets at midnight UTC (${quota.resetIn}s).`,
				},
				{
					status: 429,
					headers: { "Retry-After": quota.resetIn.toString() },
				},
			);
		}

		const startTime = Date.now();
		try {
			// params should be { ids: string[] }
			const deleteParams = params as { ids: string[] };
			const result = await this.vectorize.deleteByIds(deleteParams.ids);
			const duration = Date.now() - startTime;

			ctx.waitUntil(
				(async () => {
					this.meter.logVectorizeCall({
						project_id: projectId,
						org_id: orgId,
						index_name: indexName,
						operation: "deleteByIds",
						duration_ms: duration,
						vector_count: deleteParams.ids.length,
					});
					await this.quotaManager.incrementVectorizeMutations(projectId);
				})(),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-Vectorize-Duration": duration.toString(),
					"X-Jack-Vector-Count": deleteParams.ids.length.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "Delete failed";
			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-Vectorize-Duration": duration.toString() } },
			);
		}
	}

	/**
	 * Handle getByIds operation
	 */
	private async handleGetByIds(
		projectId: string,
		orgId: string,
		indexName: string,
		params: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		// getByIds is a read operation, uses query quota
		const quota = await this.quotaManager.checkVectorizeQueryQuota(projectId);
		if (!quota.allowed) {
			return Response.json(
				{
					error: "Vectorize query quota exceeded",
					code: "VECTORIZE_QUERY_QUOTA_EXCEEDED",
					resetIn: quota.resetIn,
					message: `Vectorize query quota exceeded. Resets at midnight UTC (${quota.resetIn}s).`,
				},
				{
					status: 429,
					headers: { "Retry-After": quota.resetIn.toString() },
				},
			);
		}

		const startTime = Date.now();
		try {
			// params should be { ids: string[] }
			const getParams = params as { ids: string[] };
			const result = await this.vectorize.getByIds(getParams.ids);
			const duration = Date.now() - startTime;

			ctx.waitUntil(
				(async () => {
					this.meter.logVectorizeCall({
						project_id: projectId,
						org_id: orgId,
						index_name: indexName,
						operation: "getByIds",
						duration_ms: duration,
						vector_count: getParams.ids.length,
					});
					await this.quotaManager.incrementVectorizeQueries(projectId);
				})(),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-Vectorize-Duration": duration.toString(),
					"X-Jack-Vector-Count": getParams.ids.length.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "GetByIds failed";
			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-Vectorize-Duration": duration.toString() } },
			);
		}
	}

	/**
	 * Handle describe operation
	 */
	private async handleDescribe(
		projectId: string,
		orgId: string,
		indexName: string,
		ctx: ExecutionContext,
	): Promise<Response> {
		// describe is free, no quota check needed
		const startTime = Date.now();
		try {
			const result = await this.vectorize.describe();
			const duration = Date.now() - startTime;

			ctx.waitUntil(
				Promise.resolve(
					this.meter.logVectorizeCall({
						project_id: projectId,
						org_id: orgId,
						index_name: indexName,
						operation: "describe",
						duration_ms: duration,
					}),
				),
			);

			return Response.json(result, {
				headers: {
					"X-Jack-Vectorize-Duration": duration.toString(),
				},
			});
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : "Describe failed";
			return Response.json(
				{ error: errorMessage },
				{ status: 500, headers: { "X-Jack-Vectorize-Duration": duration.toString() } },
			);
		}
	}
}

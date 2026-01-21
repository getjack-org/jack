import type { QuotaCheckResult } from "./types";

// Default: 1000 AI requests per project per day
const DEFAULT_AI_QUOTA = 1000;
// Default: ~1M/month ÷ 30 days = ~33,000 queries per day
const DEFAULT_VECTORIZE_QUERY_QUOTA = 33000;
// Default: conservative daily limit for mutations
const DEFAULT_VECTORIZE_MUTATION_QUOTA = 10000;

export class QuotaManager {
	private aiQuotaLimit: number;
	private vectorizeQueryLimit: number;
	private vectorizeMutationLimit: number;

	constructor(
		private kv: KVNamespace,
		aiQuotaLimit?: number,
		vectorizeQueryLimit?: number,
		vectorizeMutationLimit?: number,
	) {
		this.aiQuotaLimit = aiQuotaLimit ?? DEFAULT_AI_QUOTA;
		this.vectorizeQueryLimit = vectorizeQueryLimit ?? DEFAULT_VECTORIZE_QUERY_QUOTA;
		this.vectorizeMutationLimit = vectorizeMutationLimit ?? DEFAULT_VECTORIZE_MUTATION_QUOTA;
	}

	/**
	 * Check if project has remaining AI quota
	 */
	async checkAIQuota(projectId: string): Promise<QuotaCheckResult> {
		const dayKey = this.getDayKey();
		const key = `ai:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			const remaining = this.aiQuotaLimit - current;
			const resetIn = this.secondsUntilMidnightUTC();

			return {
				allowed: current < this.aiQuotaLimit,
				remaining: Math.max(0, remaining),
				resetIn,
			};
		} catch {
			// Fail open on KV errors - allow request, log error
			console.error("Quota check failed, allowing request");
			return {
				allowed: true,
				remaining: this.aiQuotaLimit,
				resetIn: this.secondsUntilMidnightUTC(),
			};
		}
	}

	/**
	 * Increment AI usage counter for project
	 */
	async incrementAIUsage(projectId: string): Promise<void> {
		const dayKey = this.getDayKey();
		const key = `ai:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			await this.kv.put(key, (current + 1).toString(), {
				expirationTtl: 86400 * 2, // 2 days TTL for cleanup
			});
		} catch (error) {
			// Non-fatal: usage tracking failed, but request was served
			console.error("Failed to increment quota:", error);
		}
	}

	/**
	 * Check if project has remaining Vectorize query quota
	 */
	async checkVectorizeQueryQuota(projectId: string): Promise<QuotaCheckResult> {
		const dayKey = this.getDayKey();
		const key = `vectorize:query:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			const remaining = this.vectorizeQueryLimit - current;
			const resetIn = this.secondsUntilMidnightUTC();

			return {
				allowed: current < this.vectorizeQueryLimit,
				remaining: Math.max(0, remaining),
				resetIn,
			};
		} catch {
			// Fail open on KV errors - allow request, log error
			console.error("Vectorize query quota check failed, allowing request");
			return {
				allowed: true,
				remaining: this.vectorizeQueryLimit,
				resetIn: this.secondsUntilMidnightUTC(),
			};
		}
	}

	/**
	 * Check if project has remaining Vectorize mutation quota
	 */
	async checkVectorizeMutationQuota(projectId: string): Promise<QuotaCheckResult> {
		const dayKey = this.getDayKey();
		const key = `vectorize:mutation:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			const remaining = this.vectorizeMutationLimit - current;
			const resetIn = this.secondsUntilMidnightUTC();

			return {
				allowed: current < this.vectorizeMutationLimit,
				remaining: Math.max(0, remaining),
				resetIn,
			};
		} catch {
			// Fail open on KV errors - allow request, log error
			console.error("Vectorize mutation quota check failed, allowing request");
			return {
				allowed: true,
				remaining: this.vectorizeMutationLimit,
				resetIn: this.secondsUntilMidnightUTC(),
			};
		}
	}

	/**
	 * Increment Vectorize query counter for project
	 */
	async incrementVectorizeQueries(projectId: string): Promise<void> {
		const dayKey = this.getDayKey();
		const key = `vectorize:query:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			await this.kv.put(key, (current + 1).toString(), {
				expirationTtl: 86400 * 2, // 2 days TTL for cleanup
			});
		} catch (error) {
			// Non-fatal: usage tracking failed, but request was served
			console.error("Failed to increment Vectorize query quota:", error);
		}
	}

	/**
	 * Increment Vectorize mutation counter for project
	 */
	async incrementVectorizeMutations(projectId: string): Promise<void> {
		const dayKey = this.getDayKey();
		const key = `vectorize:mutation:${projectId}:${dayKey}`;

		try {
			const current = Number.parseInt((await this.kv.get(key)) || "0");
			await this.kv.put(key, (current + 1).toString(), {
				expirationTtl: 86400 * 2, // 2 days TTL for cleanup
			});
		} catch (error) {
			// Non-fatal: usage tracking failed, but request was served
			console.error("Failed to increment Vectorize mutation quota:", error);
		}
	}

	/**
	 * Get current day key in YYYY-MM-DD format (UTC)
	 */
	private getDayKey(): string {
		return new Date().toISOString().split("T")[0];
	}

	/**
	 * Calculate seconds until midnight UTC
	 */
	private secondsUntilMidnightUTC(): number {
		const now = new Date();
		const midnight = new Date(now);
		midnight.setUTCHours(24, 0, 0, 0);
		return Math.floor((midnight.getTime() - now.getTime()) / 1000);
	}
}

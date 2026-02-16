import type { QuotaCheckResult } from "./types";

// Default: 1000 AI requests per project per day
const DEFAULT_AI_QUOTA = 1000;

export class QuotaManager {
	private aiQuotaLimit: number;

	constructor(
		private kv: KVNamespace,
		aiQuotaLimit?: number,
	) {
		this.aiQuotaLimit = aiQuotaLimit ?? DEFAULT_AI_QUOTA;
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

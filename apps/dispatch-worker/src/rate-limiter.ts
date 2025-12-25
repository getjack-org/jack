import type { RateLimitEntry } from "./types";

export class RateLimiter {
	private kv: KVNamespace;

	constructor(kv: KVNamespace) {
		this.kv = kv;
	}

	async checkAndIncrement(
		projectId: string,
		limit: number,
	): Promise<{ allowed: boolean; remaining: number; reset: number }> {
		const now = Date.now();
		const windowStart = Math.floor(now / 60000) * 60000;
		const reset = Math.floor((windowStart + 60000) / 1000);
		const key = `ratelimit:${projectId}`;

		const existing = await this.kv.get<RateLimitEntry>(key, "json");

		if (!existing || existing.window_start !== windowStart) {
			// New window, start fresh
			await this.kv.put(
				key,
				JSON.stringify({ count: 1, window_start: windowStart } satisfies RateLimitEntry),
				{ expirationTtl: 120 }, // 2 minutes TTL to handle clock skew
			);
			return { allowed: true, remaining: limit - 1, reset };
		}

		// Same window
		if (existing.count >= limit) {
			return { allowed: false, remaining: 0, reset };
		}

		// Increment count
		const newCount = existing.count + 1;
		await this.kv.put(
			key,
			JSON.stringify({ count: newCount, window_start: windowStart } satisfies RateLimitEntry),
			{ expirationTtl: 120 },
		);

		return { allowed: true, remaining: limit - newCount, reset };
	}
}

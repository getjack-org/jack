export interface Env {
	QUOTA_KV: KVNamespace;
	USAGE: AnalyticsEngineDataset;
	AI: Ai;
	AI_RATE_LIMITER: RateLimit;
	// Configurable quota limits (for testing and tier support)
	AI_QUOTA_LIMIT?: string; // Default: 1000
}

/** Props injected at deploy time via service binding ctx.props — unforgeable by user code */
export interface ProxyProps {
	projectId: string;
	orgId: string;
}

/** Resolved identity from ctx.props */
export interface ProxyIdentity {
	projectId: string;
	orgId: string;
}

export interface AIProxyContext {
	project_id: string;
	org_id: string;
}

export interface QuotaCheckResult {
	allowed: boolean;
	remaining: number;
	resetIn: number;
}

export interface AIUsageDataPoint {
	project_id: string;
	org_id: string;
	model: string;
	duration_ms: number;
	tokens_in?: number;
	tokens_out?: number;
}

export interface Env {
	QUOTA_KV: KVNamespace;
	USAGE: AnalyticsEngineDataset;
	AI: Ai;
	AI_RATE_LIMITER: RateLimit;
	// Configurable quota limits (for testing and tier support)
	AI_QUOTA_LIMIT?: string; // Default: 1000
	VECTORIZE: VectorizeIndex;
	VECTORIZE_RATE_LIMITER: RateLimit;
	VECTORIZE_QUERY_QUOTA_LIMIT?: string; // Default: 33000
	VECTORIZE_MUTATION_QUOTA_LIMIT?: string; // Default: 10000
}

/** Props injected at deploy time via service binding ctx.props — unforgeable by user code */
export interface ProxyProps {
	projectId: string;
	orgId: string;
}

/** Resolved identity with source tracking for monitoring */
export interface ProxyIdentity {
	projectId: string;
	orgId: string;
	source: "props" | "headers";
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
	identity_source?: string;
}

export interface VectorizeUsageDataPoint {
	project_id: string;
	org_id: string;
	index_name: string;
	operation: "query" | "upsert" | "deleteByIds" | "getByIds" | "describe";
	duration_ms: number;
	vector_count?: number;
}

export interface VectorizeProxyRequest {
	operation: "query" | "upsert" | "deleteByIds" | "getByIds" | "describe";
	index_name: string;
	params: unknown; // operation-specific parameters
}

export interface Bindings {
	PROJECTS_CACHE: KVNamespace;
	TENANT_DISPATCH: DispatchNamespace;
	USAGE: AnalyticsEngineDataset;
}

export type ProjectStatus = "provisioning" | "active" | "error" | "deleted";

export interface ProjectLimits {
	requests_per_minute: number;
}

export type SSLStatus =
	| "initializing"
	| "pending_validation"
	| "pending_issuance"
	| "pending_deployment"
	| "active"
	| "deleted";

export interface ProjectConfig {
	project_id: string;
	org_id: string;
	slug: string;
	owner_username?: string;
	worker_name: string;
	d1_database_id: string;
	content_bucket_name: string | null;
	status: ProjectStatus;
	ssl_status?: SSLStatus;
	updated_at: string;
	limits?: ProjectLimits;
	tier?: "free" | "pro" | "team";
}

export interface RateLimitEntry {
	count: number;
	window_start: number;
}

export interface Bindings {
	PROJECTS_CACHE: KVNamespace;
	TENANT_DISPATCH: DispatchNamespace;
}

export type ProjectStatus = "provisioning" | "active" | "error" | "deleted";

export interface ProjectLimits {
	requests_per_minute: number;
}

export interface ProjectConfig {
	project_id: string;
	org_id: string;
	slug: string;
	worker_name: string;
	d1_database_id: string;
	content_bucket_name: string | null;
	status: ProjectStatus;
	updated_at: string;
	limits?: ProjectLimits;
}

export interface RateLimitEntry {
	count: number;
	window_start: number;
}

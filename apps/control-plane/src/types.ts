// Extended Bindings type for control-plane worker
export type Bindings = {
	DB: D1Database;
	WORKOS_API_KEY: string;
	CLOUDFLARE_API_TOKEN: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	PROJECTS_CACHE: KVNamespace;
	CODE_BUCKET: R2Bucket;
	TENANT_DISPATCH: DispatchNamespace;
	FEEDBACK_LIMITER: {
		limit: (options: { key: string }) => Promise<{ success: boolean }>;
	};
};

// Project status enum
export type ProjectStatus = "provisioning" | "active" | "error" | "deleted";

// Resource types
export type ResourceType = "worker" | "d1" | "r2_content";

// Project interface matching DB schema
export interface Project {
	id: string;
	org_id: string;
	name: string;
	slug: string;
	status: ProjectStatus;
	code_bucket_prefix: string;
	content_bucket_enabled: number; // SQLite boolean (0 or 1)
	created_at: string;
	updated_at: string;
}

// Resource interface matching DB schema
export interface Resource {
	id: string;
	project_id: string;
	resource_type: ResourceType;
	resource_name: string;
	provider_id: string;
	status: ProjectStatus;
	metadata: string | null; // JSON string
	created_at: string;
}

// API request/response types
export interface CreateProjectRequest {
	name: string;
	slug?: string;
	content_bucket?: boolean;
}

// Project limits
export interface ProjectLimits {
	requests_per_minute: number;
}

// ProjectConfig for KV cache
export interface ProjectConfig {
	project_id: string;
	org_id: string;
	slug: string;
	worker_name: string;
	d1_database_id: string;
	content_bucket_name: string | null;
	status: ProjectStatus;
	limits?: ProjectLimits;
	updated_at: string;
}

// Deployment status enum
export type DeploymentStatus = "queued" | "building" | "live" | "failed";

// Deployment interface matching DB schema
export interface Deployment {
	id: string;
	project_id: string;
	status: DeploymentStatus;
	source: string;
	artifact_bucket_key: string | null;
	worker_version_id: string | null;
	error_message: string | null;
	created_at: string;
	updated_at: string;
}

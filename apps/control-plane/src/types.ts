// Extended Bindings type for control-plane worker
export type Bindings = {
	DB: D1Database;
	WORKOS_API_KEY: string;
	CLOUDFLARE_API_TOKEN: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_ZONE_ID: string;
	PROJECTS_CACHE: KVNamespace;
	CODE_BUCKET: R2Bucket;
	TENANT_DISPATCH: DispatchNamespace;
	USAGE: AnalyticsEngineDataset;
	LOG_STREAM: DurableObjectNamespace;
	FEEDBACK_LIMITER: {
		limit: (options: { key: string }) => Promise<{ success: boolean }>;
	};
	USERNAME_CHECK_LIMITER: {
		limit: (options: { key: string }) => Promise<{ success: boolean }>;
	};
	// Stripe billing (secrets set via wrangler secret put)
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
};

// Project status enum
export type ProjectStatus = "provisioning" | "active" | "error" | "deleted";

// Resource types
export type ResourceType = "worker" | "d1" | "r2_content" | "r2" | "kv";

// Project interface matching DB schema
export interface Project {
	id: string;
	org_id: string;
	name: string;
	slug: string;
	status: ProjectStatus;
	code_bucket_prefix: string;
	content_bucket_enabled: number; // SQLite boolean (0 or 1)
	owner_username: string | null;
	tags: string; // JSON string array of tags
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
	binding_name: string | null; // The binding name used in wrangler.jsonc (e.g., "NEXT_INC_CACHE_R2_BUCKET")
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
	owner_username: string | null;
	status: ProjectStatus;
	limits?: ProjectLimits;
	tier?: PlanTier;
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

export type LogSessionStatus = "active" | "expired" | "revoked";

export interface LogSession {
	id: string;
	project_id: string;
	org_id: string;
	created_by: string;
	label: string | null;
	status: LogSessionStatus;
	created_at: string;
	updated_at: string;
	expires_at: string;
}

// Custom domain status enum (maps to Cloudflare states plus Jack states)
export type CustomDomainStatus =
	| "pending" // Request submitted, awaiting Cloudflare API response
	| "pending_owner" // Cloudflare created hostname, awaiting DNS ownership verification
	| "pending_ssl" // Ownership verified, awaiting SSL certificate issuance
	| "active" // Fully working, SSL issued
	| "blocked" // Cloudflare blocked the hostname (high-risk or abuse)
	| "moved" // Hostname no longer points to fallback origin
	| "failed" // Verification timed out or API/SSL failure
	| "deleting"; // Removal in progress

// SSL status from Cloudflare
export type CustomDomainSslStatus =
	| "pending_validation"
	| "pending_issuance"
	| "pending_deployment"
	| "active";

// Custom domain interface matching DB schema
export interface CustomDomain {
	id: string;
	project_id: string;
	org_id: string;
	hostname: string;
	cloudflare_id: string | null;
	status: CustomDomainStatus;
	ssl_status: CustomDomainSslStatus | null;
	ownership_verification_type: string | null;
	ownership_verification_name: string | null;
	ownership_verification_value: string | null;
	validation_errors: string | null; // JSON array
	created_at: string;
	updated_at: string;
}

// API response types for custom domains
export interface CustomDomainVerification {
	type: "cname";
	target: string;
	instructions: string;
}

export interface CustomDomainOwnershipVerification {
	type: "txt";
	name: string;
	value: string;
}

export interface CustomDomainResponse {
	id: string;
	hostname: string;
	status: CustomDomainStatus;
	ssl_status: CustomDomainSslStatus | null;
	verification?: CustomDomainVerification;
	ownership_verification?: CustomDomainOwnershipVerification;
	validation_errors?: string[];
	created_at: string;
	updated_at?: string;
}

// Request type for adding a domain
export interface AddCustomDomainRequest {
	hostname: string;
}

// Plan tiers
export type PlanTier = "free" | "pro" | "team";

// Plan statuses (Stripe subscription statuses)
export type PlanStatus =
	| "active"
	| "trialing"
	| "past_due"
	| "canceled"
	| "unpaid"
	| "incomplete"
	| "incomplete_expired";

// OrgBilling interface matching DB schema
export interface OrgBilling {
	org_id: string;
	plan_tier: PlanTier;
	plan_status: PlanStatus;
	current_period_start: string | null;
	current_period_end: string | null;
	cancel_at_period_end: number; // SQLite boolean (0 or 1)
	trial_end: string | null;
	stripe_customer_id: string | null;
	stripe_subscription_id: string | null;
	stripe_price_id: string | null;
	stripe_product_id: string | null;
	stripe_status: string | null;
	created_at: string;
	updated_at: string;
}

// Tier limits for feature gating
export const TIER_LIMITS: Record<PlanTier, { custom_domains: number; projects: number }> = {
	free: { custom_domains: 0, projects: Number.POSITIVE_INFINITY },
	pro: { custom_domains: 3, projects: Number.POSITIVE_INFINITY },
	team: { custom_domains: 10, projects: Number.POSITIVE_INFINITY },
};

// Statuses that grant paid access (including grace period for past_due)
export const PAID_STATUSES: PlanStatus[] = ["active", "trialing", "past_due"];

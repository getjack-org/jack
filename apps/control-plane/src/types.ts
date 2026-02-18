// Extended Bindings type for control-plane worker
export type Bindings = {
	DB: D1Database;
	WORKOS_API_KEY: string;
	CLOUDFLARE_API_TOKEN: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_ZONE_ID: string;
	PROJECTS_CACHE: KVNamespace;
	CODE_BUCKET: R2Bucket;
	ASK_INDEX_QUEUE?: Queue<unknown>;
	TENANT_DISPATCH: DispatchNamespace;
	USAGE: AnalyticsEngineDataset;
	CONTROL_USAGE?: AnalyticsEngineDataset;
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
	// Daimo billing (secrets set via wrangler secret put)
	DAIMO_API_KEY: string;
	DAIMO_WEBHOOK_SECRET: string;
	DAIMO_RECEIVER_ADDRESS: string;
	// Secrets encryption (RSA-OAEP private key JWK, set via wrangler secret put)
	SECRETS_ENCRYPTION_PRIVATE_KEY: string;
	// Optional PostHog server-side capture key for control-plane events
	POSTHOG_API_KEY?: string;
	POSTHOG_HOST?: string;
	ANTHROPIC_API_KEY?: string;
};

// Project status enum
export type ProjectStatus = "provisioning" | "active" | "error" | "deleted";

// Resource types
export type ResourceType =
	| "worker"
	| "d1"
	| "r2_content"
	| "r2"
	| "kv"
	| "vectorize"
	| "ai"
	| "durable_object";

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
	message: string | null;
	has_session_transcript: number; // SQLite boolean (0 or 1)
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
	| "pending_dns" // Waiting for user to set up CNAME record
	| "claimed" // Domain slot claimed by org, not yet assigned to a project
	| "unassigned" // Was active, unassigned from project but CF hostname kept for quick reassign
	| "pending" // Request submitted, awaiting Cloudflare API response
	| "pending_owner" // Cloudflare created hostname, awaiting DNS ownership verification
	| "pending_ssl" // Ownership verified, awaiting SSL certificate issuance
	| "active" // Fully working, SSL issued
	| "blocked" // Cloudflare blocked the hostname (high-risk or abuse)
	| "moved" // Hostname no longer points to fallback origin
	| "failed" // Verification timed out or API/SSL failure
	| "deleting" // Removal in progress
	| "expired" // pending_dns timed out after 7 days
	| "deleted"; // Soft deleted

// SSL status from Cloudflare
export type CustomDomainSslStatus =
	| "pending_validation"
	| "pending_issuance"
	| "pending_deployment"
	| "active";

// Custom domain interface matching DB schema
export interface CustomDomain {
	id: string;
	project_id: string | null;
	org_id: string;
	hostname: string;
	cloudflare_id: string | null;
	status: CustomDomainStatus;
	ssl_status: CustomDomainSslStatus | null;
	ownership_verification_type: string | null;
	ownership_verification_name: string | null;
	ownership_verification_value: string | null;
	validation_errors: string | null; // JSON array
	// DNS verification fields
	dns_verified: number; // 0 or 1
	dns_verified_at: string | null;
	dns_last_checked_at: string | null;
	dns_target: string | null;
	dns_error: string | null;
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

// DNS verification status in API response
export interface CustomDomainDnsInfo {
	verified: boolean;
	checked_at: string | null;
	current_target: string | null;
	expected_target: string;
	error: string | null;
}

// Next step guidance for domain setup
export interface CustomDomainNextStep {
	action: "add_cname" | "add_txt" | "wait" | "delete" | "none";
	record_type?: "CNAME" | "TXT";
	record_name?: string;
	record_value?: string;
	message: string;
}

export interface CustomDomainResponse {
	id: string;
	hostname: string;
	status: CustomDomainStatus;
	ssl_status: CustomDomainSslStatus | null;
	verification?: CustomDomainVerification;
	ownership_verification?: CustomDomainOwnershipVerification;
	validation_errors?: string[];
	dns?: CustomDomainDnsInfo;
	next_step?: CustomDomainNextStep;
	created_at: string;
	updated_at?: string;
}

// Request type for adding a domain
export interface AddCustomDomainRequest {
	hostname: string;
}

// Plan tiers
export type PlanTier = "free" | "pro" | "team";

// Payment providers
export type PaymentProvider = "stripe" | "daimo";

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
	daimo_payment_id: string | null;
	payment_provider: PaymentProvider | null;
	created_at: string;
	updated_at: string;
}

// Statuses that grant paid access (including grace period for past_due)
export const PAID_STATUSES: PlanStatus[] = ["active", "trialing", "past_due"];

// Credit types
export type CreditType = "referral_given" | "referral_received" | "manual";
export type CreditStatus = "pending" | "active";

export interface Credit {
	id: string;
	org_id: string;
	type: CreditType;
	status: CreditStatus;
	amount: number;
	code: string | null;
	source_org_id: string | null;
	note: string | null;
	created_at: string;
}

// Cron schedule interface matching DB schema
export interface CronSchedule {
	id: string;
	project_id: string;
	expression: string;
	expression_normalized: string;
	enabled: number; // SQLite boolean (0 or 1)
	is_running: number; // SQLite boolean (0 or 1)
	run_started_at: string | null;
	last_run_at: string | null;
	next_run_at: string;
	last_run_status: string | null;
	last_run_duration_ms: number | null;
	consecutive_failures: number;
	created_at: string;
}

// Extended cron schedule with project info for cron runner
export interface CronScheduleWithProject extends CronSchedule {
	worker_name: string;
	cron_secret: string;
}

// API token interface matching DB schema
export interface ApiToken {
	id: string;
	user_id: string;
	org_id: string;
	name: string;
	token_hash: string;
	id_prefix: string;
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
	revoked_at: string | null;
}

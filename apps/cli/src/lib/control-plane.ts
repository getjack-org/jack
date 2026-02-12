/**
 * Control Plane API client for jack cloud
 */

import { debug } from "./debug.ts";

const DEFAULT_CONTROL_API_URL = "https://control.getjack.org";

export function getControlApiUrl(): string {
	return process.env.JACK_CONTROL_URL || DEFAULT_CONTROL_API_URL;
}

export interface CreateProjectRequest {
	name: string;
	slug?: string;
	template?: string;
	use_prebuilt?: boolean;
	forked_from?: string;
}

export interface CreateManagedProjectOptions {
	slug?: string;
	template?: string;
	usePrebuilt?: boolean;
	forkedFrom?: string;
}

export interface CreateProjectResponse {
	project: {
		id: string;
		org_id: string;
		name: string;
		slug: string;
		status: string;
		created_at: string;
		updated_at: string;
	};
	resources: Array<{
		id: string;
		resource_type: string;
		resource_name: string;
		status: string;
	}>;
	status?: "live" | "created";
	url?: string;
	prebuilt_failed?: boolean;
	prebuilt_error?: string;
}

export interface SlugAvailabilityResponse {
	available: boolean;
	slug: string;
	error?: string;
}

export interface UsernameAvailabilityResponse {
	available: boolean;
	username: string;
	error?: string;
}

export interface SetUsernameResponse {
	success: boolean;
	username: string;
}

export interface UserProfile {
	id: string;
	email: string;
	first_name: string | null;
	last_name: string | null;
	username: string | null;
	created_at: string;
	updated_at: string;
}

export interface PublishProjectResponse {
	success: boolean;
	published_as: string;
	fork_command: string;
}

export interface CreateDeploymentRequest {
	source: string;
}

export interface CreateDeploymentResponse {
	id: string;
	project_id: string;
	status: "queued" | "building" | "live" | "failed";
	source: string;
	created_at: string;
}

/**
 * Create a managed project via the control plane.
 */
export async function createManagedProject(
	name: string,
	options?: CreateManagedProjectOptions,
): Promise<CreateProjectResponse> {
	const { authFetch } = await import("./auth/index.ts");
	const pkg = await import("../../package.json");

	const requestBody: CreateProjectRequest = { name };
	if (options?.slug) {
		requestBody.slug = options.slug;
	}
	if (options?.template) {
		requestBody.template = options.template;
	}
	if (options?.usePrebuilt !== undefined) {
		requestBody.use_prebuilt = options.usePrebuilt;
	}
	if (options?.forkedFrom) {
		requestBody.forked_from = options.forkedFrom;
	}

	debug("Creating managed project", {
		name,
		template: options?.template,
		usePrebuilt: options?.usePrebuilt,
	});
	const start = Date.now();

	const response = await authFetch(`${getControlApiUrl()}/v1/projects`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Jack-Version": pkg.version,
		},
		body: JSON.stringify(requestBody),
	});

	const duration = ((Date.now() - start) / 1000).toFixed(1);
	debug(`Control plane response: ${response.status} (${duration}s)`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to create managed project: ${response.status}`);
	}

	return response.json() as Promise<CreateProjectResponse>;
}

/**
 * Deploy to a managed project via the control plane.
 */
export async function deployManagedProject(
	projectId: string,
	source: string,
): Promise<CreateDeploymentResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/deployments`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source } satisfies CreateDeploymentRequest),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Managed deploy failed: ${response.status}`);
	}

	return response.json() as Promise<CreateDeploymentResponse>;
}

/**
 * Check if a project slug is available on jack cloud.
 */
export async function checkSlugAvailability(slug: string): Promise<SlugAvailabilityResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/slugs/${encodeURIComponent(slug)}/available`,
	);

	if (!response.ok) {
		throw new Error(`Failed to check slug availability: ${response.status}`);
	}

	return response.json() as Promise<SlugAvailabilityResponse>;
}

export interface DatabaseInfoResponse {
	name: string;
	id: string;
	sizeBytes: number;
	numTables: number;
	version?: string;
	createdAt?: string;
}

export interface DatabaseExportResponse {
	success: boolean;
	download_url: string;
	expires_in: number;
}

export interface ExecuteSqlResponse {
	success: boolean;
	results: unknown[];
	meta: {
		changes: number;
		duration_ms: number;
		last_row_id: number;
		rows_read: number;
		rows_written: number;
	};
	error?: string;
}

export interface DeleteProjectResponse {
	success: boolean;
	project_id: string;
	deleted_at: string;
	resources: Array<{ resource: string; success: boolean; error?: string }>;
	warnings?: string;
}

export interface ManagedProject {
	id: string;
	org_id: string;
	name: string;
	slug: string;
	status: "active" | "error" | "deleted";
	created_at: string;
	updated_at: string;
	tags?: string; // JSON string array from DB, e.g., '["backend", "api"]'
	owner_username?: string | null;
}

/**
 * Get managed project's D1 database info (size, tables, etc.)
 * This avoids calling wrangler and uses the control plane API.
 */
export async function getManagedDatabaseInfo(projectId: string): Promise<DatabaseInfoResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/database/info`);

	if (response.status === 404) {
		throw new Error("No database found for this project");
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to get database info: ${response.status}`);
	}

	return response.json() as Promise<DatabaseInfoResponse>;
}

/**
 * Export a managed project's D1 database.
 */
export async function exportManagedDatabase(projectId: string): Promise<DatabaseExportResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/database/export`,
	);

	if (response.status === 504) {
		throw new Error("Database export timed out. The database may be too large.");
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to export database: ${response.status}`);
	}

	return response.json() as Promise<DatabaseExportResponse>;
}

/**
 * Execute SQL against a managed project's D1 database.
 * Routes through control plane for Jack Cloud auth.
 */
export async function executeManagedSql(
	projectId: string,
	sql: string,
	params?: unknown[],
): Promise<ExecuteSqlResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const body: { sql: string; params?: unknown[] } = { sql };
	if (params && params.length > 0) {
		body.params = params;
	}

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/database/execute`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);

	if (response.status === 504) {
		throw new Error("SQL execution timed out. The query may be too complex.");
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to execute SQL: ${response.status}`);
	}

	return response.json() as Promise<ExecuteSqlResponse>;
}

/**
 * Delete a managed project and all its resources.
 */
export async function deleteManagedProject(projectId: string): Promise<DeleteProjectResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}`, {
		method: "DELETE",
	});

	// 404 means project doesn't exist - treat as already deleted
	if (response.status === 404) {
		return {
			success: true,
			project_id: projectId,
			deleted_at: new Date().toISOString(),
			resources: [],
			warnings: "Project was already deleted or not found",
		};
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to delete project: ${response.status}`);
	}

	return response.json() as Promise<DeleteProjectResponse>;
}

/**
 * List all managed projects from the control plane.
 */
export async function listManagedProjects(): Promise<ManagedProject[]> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to list managed projects: ${response.status}`);
	}

	const data = (await response.json()) as { projects: ManagedProject[] };
	return data.projects;
}

/**
 * Find a managed project by ID.
 */
export async function findProjectById(projectId: string): Promise<ManagedProject | null> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${encodeURIComponent(projectId)}`,
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		return null; // Silent fail - just can't look up the name
	}

	const data = (await response.json()) as { project: ManagedProject };
	return data.project;
}

/**
 * Find a managed project by slug.
 */
export async function findProjectBySlug(slug: string): Promise<ManagedProject | null> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/by-slug/${encodeURIComponent(slug)}`,
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to find project: ${response.status}`);
	}

	const data = (await response.json()) as { project: ManagedProject };
	return data.project;
}

export interface ProjectResource {
	id: string;
	resource_type: string;
	resource_name: string;
	provider_id: string;
	binding_name: string;
	status: string;
	created_at: string;
}

export interface CreateResourceResponse {
	resource_type: string;
	resource_name: string;
	provider_id: string;
	binding_name: string;
}

/**
 * Fetch all resources for a managed project.
 * Uses GET /v1/projects/:id/resources endpoint.
 */
export async function fetchProjectResources(projectId: string): Promise<ProjectResource[]> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/resources`);

	if (!response.ok) {
		if (response.status === 404) {
			return [];
		}
		throw new Error(`Failed to fetch resources: ${response.status}`);
	}

	const data = (await response.json()) as { resources: ProjectResource[] };
	return data.resources;
}

export interface DeploymentInfo {
	id: string;
	status: "queued" | "building" | "live" | "failed";
	source: string;
	error_message: string | null;
	message: string | null;
	created_at: string;
	updated_at: string;
}

export interface DeploymentListResult {
	deployments: DeploymentInfo[];
	total: number;
}

/**
 * Fetch recent deployments for a managed project.
 * Returns deployments (up to 10) and total count.
 */
export async function fetchDeployments(projectId: string): Promise<DeploymentListResult> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/deployments`);

	if (!response.ok) {
		return { deployments: [], total: 0 }; // Silent fail — deployment history is supplementary
	}

	const data = (await response.json()) as { deployments: DeploymentInfo[]; total: number };
	return { deployments: data.deployments, total: data.total };
}

export interface RollbackResponse {
	deployment: {
		id: string;
		status: string;
		source: string;
		created_at: string;
		updated_at: string;
	};
}

/**
 * Rollback a managed project to a previous deployment.
 * If no deploymentId given, rolls back to the previous successful deployment.
 */
export async function rollbackDeployment(
	projectId: string,
	deploymentId?: string,
): Promise<RollbackResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const body: Record<string, string> = {};
	if (deploymentId) {
		body.deployment_id = deploymentId;
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/rollback`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Rollback failed: ${response.status}`);
	}

	return response.json() as Promise<RollbackResponse>;
}

/**
 * Create a resource for a managed project.
 * Uses POST /v1/projects/:id/resources/:type endpoint.
 */
export async function createProjectResource(
	projectId: string,
	resourceType: "d1" | "kv" | "r2",
	options?: { name?: string; bindingName?: string },
): Promise<CreateResourceResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const body: Record<string, string> = {};
	if (options?.name) {
		body.name = options.name;
	}
	if (options?.bindingName) {
		body.binding_name = options.bindingName;
	}

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/resources/${resourceType}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to create ${resourceType} resource: ${response.status}`);
	}

	const data = (await response.json()) as { resource: CreateResourceResponse };
	return data.resource;
}

export interface DeleteResourceResponse {
	success: boolean;
	resource_id: string;
	deleted_at: string;
}

/**
 * Delete a resource from a managed project.
 * Uses DELETE /v1/projects/:id/resources/:id endpoint.
 */
export async function deleteProjectResource(
	projectId: string,
	resourceId: string,
): Promise<DeleteResourceResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/resources/${resourceId}`,
		{ method: "DELETE" },
	);

	// Handle 404 gracefully - resource may already be deleted
	if (response.status === 404) {
		return {
			success: true,
			resource_id: resourceId,
			deleted_at: new Date().toISOString(),
		};
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to delete resource: ${response.status}`);
	}

	return response.json() as Promise<DeleteResourceResponse>;
}

/**
 * Sync project tags to the control plane.
 * Fire-and-forget: errors are logged but not thrown.
 */
export async function syncProjectTags(projectId: string, tags: string[]): Promise<void> {
	const { authFetch } = await import("./auth/index.ts");
	const { debug } = await import("./debug.ts");

	try {
		const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/tags`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tags }),
		});

		if (!response.ok) {
			// Log but don't throw - tag sync is non-critical
			debug(`Tag sync failed: ${response.status}`);
		}
	} catch (error) {
		// Log but don't throw - tag sync is non-critical
		debug(`Tag sync failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Fetch project tags from the control plane.
 * Returns empty array on error.
 */
export async function fetchProjectTags(projectId: string): Promise<string[]> {
	const { authFetch } = await import("./auth/index.ts");

	try {
		const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/tags`);

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as { tags: string[] };
		return data.tags ?? [];
	} catch {
		return [];
	}
}

export interface RegisterUserRequest {
	email: string;
	first_name?: string | null;
	last_name?: string | null;
}

export interface RegisterUserResponse {
	user: {
		id: string;
		email: string;
		first_name?: string;
		last_name?: string;
	};
	org: {
		id: string;
		workos_org_id: string;
	};
}

/**
 * Register or update user in the control plane after login.
 * This must be called after device auth to create/sync the user in the database.
 */
export async function registerUser(userInfo: RegisterUserRequest): Promise<RegisterUserResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(userInfo),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to register user: ${response.status}`);
	}

	return response.json() as Promise<RegisterUserResponse>;
}

/**
 * Check if a username is available on jack cloud.
 * Does not require authentication.
 */
export async function checkUsernameAvailable(
	username: string,
): Promise<UsernameAvailabilityResponse> {
	const response = await fetch(
		`${getControlApiUrl()}/v1/usernames/${encodeURIComponent(username)}/available`,
	);

	if (!response.ok) {
		throw new Error(`Failed to check username availability: ${response.status}`);
	}

	return response.json() as Promise<UsernameAvailabilityResponse>;
}

/**
 * Set the current user's username.
 * Can only be called once per user.
 */
export async function setUsername(username: string): Promise<SetUsernameResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/me/username`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username }),
	});

	if (response.status === 409) {
		const err = (await response.json().catch(() => ({ message: "Username taken" }))) as {
			message?: string;
		};
		throw new Error(err.message || "Username is already taken");
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to set username: ${response.status}`);
	}

	return response.json() as Promise<SetUsernameResponse>;
}

export interface ApplyReferralResult {
	applied: boolean;
	reason?: "invalid" | "self_referral" | "already_referred";
}

/**
 * Apply a referral code (username) for the current user.
 * Returns whether the code was applied successfully.
 */
export async function applyReferralCode(code: string): Promise<ApplyReferralResult> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/referral/apply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});

	if (response.status === 429) {
		return { applied: false, reason: "invalid" };
	}

	if (!response.ok) {
		return { applied: false, reason: "invalid" };
	}

	return response.json() as Promise<ApplyReferralResult>;
}

/**
 * Get the current user's profile including username.
 */
export async function getCurrentUserProfile(): Promise<UserProfile | null> {
	const { authFetch } = await import("./auth/index.ts");

	try {
		const response = await authFetch(`${getControlApiUrl()}/v1/me`);

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as { user: UserProfile };
		return data.user;
	} catch {
		return null;
	}
}

/**
 * Publish a project to make it forkable by others.
 */
export async function publishProject(projectId: string): Promise<PublishProjectResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/publish`, {
		method: "POST",
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to publish project: ${response.status}`);
	}

	return response.json() as Promise<PublishProjectResponse>;
}

/**
 * Download the source snapshot for a project.
 * Returns the zip file contents as a Buffer.
 * Used by jack clone to restore managed projects.
 */
export async function downloadProjectSource(slug: string): Promise<Buffer> {
	const { authFetch } = await import("./auth/index.ts");

	// Use /me/projects endpoint to download your own project's source
	// (works for both published and unpublished projects you own)
	const response = await authFetch(
		`${getControlApiUrl()}/v1/me/projects/${encodeURIComponent(slug)}/source`,
	);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error("Project source not found. Deploy first with 'jack ship'.");
		}
		throw new Error(`Failed to download source: ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
}

export interface LogSessionInfo {
	id: string;
	project_id: string;
	label: string | null;
	status: "active" | "expired" | "revoked" | string;
	expires_at: string;
}

// ============================================================================
// Cron Schedule Types
// ============================================================================

export interface CronScheduleInfo {
	id: string;
	expression: string;
	description: string;
	enabled: boolean;
	next_run_at: string;
	last_run_at: string | null;
	last_run_status: string | null;
	last_run_duration_ms: number | null;
	consecutive_failures: number;
	created_at: string;
}

export interface CreateCronScheduleResponse {
	id: string;
	expression: string;
	description: string;
	next_run_at: string;
}

export interface TriggerCronScheduleResponse {
	triggered: boolean;
	status: string;
	duration_ms: number;
}

export interface StartLogSessionResponse {
	success: boolean;
	session: LogSessionInfo;
	stream: { url: string; type: "sse" };
}

/**
 * Start or renew a 1-hour log tailing session for a managed (jack cloud) project.
 */
export async function startLogSession(
	projectId: string,
	label?: string,
): Promise<StartLogSessionResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/logs/session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(label ? { label } : {}),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to start log session: ${response.status}`);
	}

	return response.json() as Promise<StartLogSessionResponse>;
}

// ============================================================================
// Cron Schedule Operations
// ============================================================================

/**
 * Create a cron schedule for a managed project.
 */
export async function createCronSchedule(
	projectId: string,
	expression: string,
): Promise<CreateCronScheduleResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/crons`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ expression }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to create cron schedule: ${response.status}`);
	}

	return response.json() as Promise<CreateCronScheduleResponse>;
}

/**
 * List all cron schedules for a managed project.
 */
export async function listCronSchedules(projectId: string): Promise<CronScheduleInfo[]> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/crons`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to list cron schedules: ${response.status}`);
	}

	const data = (await response.json()) as { schedules: CronScheduleInfo[] };
	return data.schedules;
}

/**
 * Delete a cron schedule from a managed project.
 */
export async function deleteCronSchedule(projectId: string, cronId: string): Promise<void> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/crons/${cronId}`,
		{ method: "DELETE" },
	);

	if (response.status === 404) {
		// Already deleted, treat as success
		return;
	}

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to delete cron schedule: ${response.status}`);
	}
}

/**
 * Manually trigger a cron schedule on a managed project.
 */
export async function triggerCronSchedule(
	projectId: string,
	expression: string,
): Promise<TriggerCronScheduleResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/crons/trigger`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ expression }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to trigger cron schedule: ${response.status}`);
	}

	return response.json() as Promise<TriggerCronScheduleResponse>;
}

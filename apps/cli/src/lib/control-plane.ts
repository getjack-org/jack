/**
 * Control Plane API client for jack cloud
 */

import { debug } from "./debug.ts";
import { formatSize } from "./format.ts";

const DEFAULT_CONTROL_API_URL = "https://control.getjack.org";

export function getControlApiUrl(): string {
	return process.env.JACK_CONTROL_URL || DEFAULT_CONTROL_API_URL;
}

export interface CreateProjectRequest {
	name: string;
	slug?: string;
	template?: string;
	use_prebuilt?: boolean;
}

export interface CreateManagedProjectOptions {
	slug?: string;
	template?: string;
	usePrebuilt?: boolean;
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

	debug("Creating managed project", { name, template: options?.template, usePrebuilt: options?.usePrebuilt });
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

export interface DatabaseExportResponse {
	success: boolean;
	download_url: string;
	expires_in: number;
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

export interface SourceSnapshotResponse {
	success: boolean;
	source_key: string;
}

/**
 * Upload a source snapshot for a project.
 * Used to enable project forking.
 */
export async function uploadSourceSnapshot(
	projectId: string,
	sourceZipPath: string,
): Promise<SourceSnapshotResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const formData = new FormData();
	const sourceFile = Bun.file(sourceZipPath);
	formData.append("source", sourceFile);

	const url = `${getControlApiUrl()}/v1/projects/${projectId}/source`;
	debug(`Source snapshot: ${formatSize(sourceFile.size)}`);

	const start = Date.now();
	const response = await authFetch(url, {
		method: "POST",
		body: formData,
	});
	debug(`Source snapshot: ${response.status} (${((Date.now() - start) / 1000).toFixed(1)}s)`);

	if (!response.ok) {
		const error = (await response.json().catch(() => ({ message: "Upload failed" }))) as {
			message?: string;
		};
		throw new Error(error.message || `Source upload failed: ${response.status}`);
	}

	return response.json() as Promise<SourceSnapshotResponse>;
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

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/by-slug/${encodeURIComponent(slug)}/source`,
	);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error("Project source not found. Deploy first with 'jack ship'.");
		}
		throw new Error(`Failed to download source: ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
}

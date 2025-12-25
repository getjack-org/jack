/**
 * Control Plane API client for jack cloud
 */

const DEFAULT_CONTROL_API_URL = "https://control.getjack.org";

export function getControlApiUrl(): string {
	return process.env.JACK_CONTROL_URL || DEFAULT_CONTROL_API_URL;
}

export interface CreateProjectRequest {
	name: string;
	slug?: string;
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
}

export interface SlugAvailabilityResponse {
	available: boolean;
	slug: string;
	error?: string;
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
	slug?: string,
): Promise<CreateProjectResponse> {
	const { authFetch } = await import("./auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, slug } satisfies CreateProjectRequest),
	});

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

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to delete project: ${response.status}`);
	}

	return response.json() as Promise<DeleteProjectResponse>;
}

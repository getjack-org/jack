const DEFAULT_CONTROL_URL = "https://control.getjack.org";

export interface ManagedProject {
	id: string;
	name: string;
	slug: string;
	org_id: string;
	created_at: string;
	updated_at: string;
}

export interface DeploymentInfo {
	id: string;
	project_id: string;
	status: "queued" | "building" | "live" | "failed";
	source: string;
	error_message: string | null;
	created_at: string;
	updated_at: string;
}

export interface LogSessionInfo {
	id: string;
	project_id: string;
	status: string;
}

export class ControlPlaneClient {
	private baseUrl: string;
	private token: string;

	constructor(token: string, controlUrl?: string) {
		this.token = token;
		this.baseUrl = controlUrl || DEFAULT_CONTROL_URL;
	}

	private async fetch(path: string, init?: RequestInit): Promise<Response> {
		return fetch(`${this.baseUrl}/v1${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...init?.headers,
			},
		});
	}

	private async jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.fetch(path, init);
		if (!response.ok) {
			const body = await response.text();
			let message: string;
			try {
				const parsed = JSON.parse(body);
				message = parsed.message || parsed.error || body;
			} catch {
				message = body;
			}
			throw new Error(`Control plane error (${response.status}): ${message}`);
		}
		return response.json() as Promise<T>;
	}

	async listProjects(): Promise<{ projects: ManagedProject[] }> {
		return this.jsonFetch("/projects");
	}

	async getProject(projectId: string): Promise<{ project: ManagedProject }> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}`);
	}

	async getLatestDeployment(projectId: string): Promise<{ deployment: DeploymentInfo | null }> {
		try {
			return await this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/deployments/latest`);
		} catch {
			return { deployment: null };
		}
	}

	async getProjectResources(
		projectId: string,
	): Promise<{ resources: Array<{ id: string; type: string; name: string }> }> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/resources`);
	}

	async createProject(
		name: string,
		slug?: string,
	): Promise<{
		project: ManagedProject;
		resources: unknown[];
		url?: string;
	}> {
		return this.jsonFetch("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, slug }),
		});
	}

	async createProjectWithPrebuilt(
		name: string,
		template: string,
		slug?: string,
	): Promise<{
		project: ManagedProject;
		resources: unknown[];
		status?: string;
		url?: string;
		prebuilt_failed?: boolean;
		prebuilt_error?: string;
	}> {
		return this.jsonFetch("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				slug,
				template,
				use_prebuilt: true,
			}),
		});
	}

	async uploadDeployment(
		projectId: string,
		manifest: object,
		bundleZip: Uint8Array,
		message?: string,
	): Promise<DeploymentInfo> {
		const formData = new FormData();

		formData.append(
			"manifest",
			new Blob([JSON.stringify(manifest)], { type: "application/json" }),
			"manifest.json",
		);

		formData.append("bundle", new Blob([bundleZip], { type: "application/zip" }), "bundle.zip");

		if (message) {
			formData.append("message", message);
		}

		const response = await this.fetch(
			`/projects/${encodeURIComponent(projectId)}/deployments/upload`,
			{
				method: "POST",
				body: formData,
			},
		);

		if (!response.ok) {
			const body = await response.text();
			let errMsg: string;
			try {
				const parsed = JSON.parse(body);
				errMsg = parsed.message || parsed.error || body;
			} catch {
				errMsg = body;
			}
			throw new Error(`Upload failed (${response.status}): ${errMsg}`);
		}

		return response.json() as Promise<DeploymentInfo>;
	}

	async startLogSession(projectId: string): Promise<{
		success: boolean;
		session: LogSessionInfo;
		stream: { url: string; type: string };
	}> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/logs/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	}

	async rollback(
		projectId: string,
		deploymentId?: string,
	): Promise<{ deployment: DeploymentInfo }> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/rollback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(deploymentId ? { deployment_id: deploymentId } : {}),
		});
	}
}

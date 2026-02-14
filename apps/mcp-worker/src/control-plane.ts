const DEFAULT_CONTROL_URL = "https://control.getjack.org";
const JACK_VERSION = "0.1.34";

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

	async getProject(projectId: string): Promise<{ project: ManagedProject; url: string }> {
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
			headers: {
				"Content-Type": "application/json",
				"X-Jack-Version": JACK_VERSION,
			},
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
		sourceZip?: Uint8Array,
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

		if (sourceZip) {
			formData.append("source", new Blob([sourceZip], { type: "application/zip" }), "source.zip");
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

	async fetchStream(streamPath: string, signal?: AbortSignal): Promise<Response> {
		const url = streamPath.startsWith("http") ? streamPath : `${this.baseUrl}${streamPath}`;
		return fetch(url, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "text/event-stream",
			},
			signal,
		});
	}

	async getSourceTree(
		projectId: string,
	): Promise<{ files: Array<{ path: string; size: number; type: string }>; total_files: number }> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/source/tree`);
	}

	async getSourceFile(projectId: string, path: string): Promise<string> {
		const response = await this.fetch(
			`/projects/${encodeURIComponent(projectId)}/source/file?path=${encodeURIComponent(path)}`,
		);
		if (!response.ok) {
			const body = await response.text();
			let message: string;
			try {
				const parsed = JSON.parse(body);
				message = parsed.message || parsed.error || body;
			} catch {
				message = body;
			}
			throw new Error(`Source file error (${response.status}): ${message}`);
		}
		return response.text();
	}

	async getAllSourceFiles(projectId: string): Promise<Record<string, string>> {
		const { files: tree } = await this.getSourceTree(projectId);
		const fileEntries = tree.filter((f) => f.type === "file");

		const results: Record<string, string> = {};
		for (let i = 0; i < fileEntries.length; i += 10) {
			const batch = fileEntries.slice(i, i + 10);
			const contents = await Promise.all(batch.map((f) => this.getSourceFile(projectId, f.path)));
			for (let j = 0; j < batch.length; j++) {
				results[batch[j].path] = contents[j];
			}
		}
		return results;
	}

	async createDatabase(
		projectId: string,
		name?: string,
		bindingName?: string,
	): Promise<{ resource: { id: string; name: string; binding_name: string } }> {
		const body: Record<string, string> = {};
		if (name) body.name = name;
		if (bindingName) body.binding_name = bindingName;
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/resources/d1`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async listDatabases(
		projectId: string,
	): Promise<{ resources: Array<{ id: string; type: string; name: string }> }> {
		const { resources } = await this.getProjectResources(projectId);
		return { resources: resources.filter((r) => r.type === "d1") };
	}

	async executeSql(projectId: string, sql: string, params?: unknown[]): Promise<unknown> {
		return this.jsonFetch(`/projects/${encodeURIComponent(projectId)}/database/execute`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql, params }),
		});
	}

	async rollbackProject(
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

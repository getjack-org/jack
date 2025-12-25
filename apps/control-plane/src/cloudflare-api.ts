import type { Bindings } from "./types";

// Cloudflare API response types
interface CloudflareResponse<T> {
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	messages: string[];
	result: T;
}

interface D1Database {
	uuid: string;
	name: string;
	version: string;
	created_at: string;
}

interface R2Bucket {
	name: string;
	creation_date: string;
}

export interface DispatchScriptBinding {
	type: string;
	name: string;
	[key: string]: unknown; // Additional binding-specific properties
}

/**
 * CloudflareClient handles authenticated API calls to Cloudflare
 */
export class CloudflareClient {
	private accountId: string;
	private apiToken: string;
	private baseUrl = "https://api.cloudflare.com/client/v4";

	constructor(env: Bindings) {
		this.accountId = env.CLOUDFLARE_ACCOUNT_ID;
		this.apiToken = env.CLOUDFLARE_API_TOKEN;
	}

	/**
	 * Makes an authenticated request to the Cloudflare API
	 */
	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}/accounts/${this.accountId}${path}`;
		const options: RequestInit = {
			method,
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<T>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}

		return data.result;
	}

	/**
	 * Creates a new D1 database
	 * @returns The created database with uuid, name, version, created_at
	 */
	async createD1Database(name: string): Promise<D1Database> {
		return this.request<D1Database>("POST", "/d1/database", { name });
	}

	/**
	 * Deletes a D1 database
	 */
	async deleteD1Database(databaseId: string): Promise<void> {
		await this.request("DELETE", `/d1/database/${databaseId}`);
	}

	/**
	 * Creates a new R2 bucket
	 */
	async createR2Bucket(name: string): Promise<R2Bucket> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/r2/buckets/${name}`;
		const options: RequestInit = {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<R2Bucket>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}

		return data.result;
	}

	/**
	 * Deletes an R2 bucket
	 */
	async deleteR2Bucket(name: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/r2/buckets/${name}`;
		const options: RequestInit = {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}
	}

	/**
	 * Uploads a worker script to a dispatch namespace
	 * @param namespace - The dispatch namespace name
	 * @param scriptName - The name of the worker script
	 * @param scriptContent - The worker JavaScript code
	 * @param bindings - Array of binding configurations
	 */
	async uploadDispatchScript(
		namespace: string,
		scriptName: string,
		scriptContent: string,
		bindings: DispatchScriptBinding[],
		options?: {
			compatibilityDate?: string;
			compatibilityFlags?: string[];
			mainModule?: string;
		},
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;

		// Create FormData with metadata and script content
		const formData = new FormData();

		// Add metadata with bindings
		const metadata: Record<string, unknown> = {
			main_module: options?.mainModule ?? "worker.js",
			bindings,
		};
		if (options?.compatibilityDate) {
			metadata.compatibility_date = options.compatibilityDate;
		}
		if (options?.compatibilityFlags?.length) {
			metadata.compatibility_flags = options.compatibilityFlags;
		}
		formData.append("metadata", JSON.stringify(metadata));

		// Add worker script as a file part
		const scriptBlob = new Blob([scriptContent], { type: "application/javascript+module" });
		formData.append("worker.js", scriptBlob, "worker.js");

		const options: RequestInit = {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
			body: formData,
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}
	}

	/**
	 * Deletes a worker script from a dispatch namespace
	 */
	async deleteDispatchScript(namespace: string, scriptName: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;
		const options: RequestInit = {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}
	}

	/**
	 * Updates settings (including bindings) for an existing dispatch script WITHOUT replacing the code.
	 * This uses the /settings endpoint which preserves deployed code.
	 */
	async updateDispatchScriptSettings(
		namespace: string,
		scriptName: string,
		bindings: DispatchScriptBinding[],
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/settings`;

		// The settings endpoint expects multipart form-data with a "settings" part
		const formData = new FormData();
		const settings = { bindings };
		formData.append("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }));

		const options: RequestInit = {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
			body: formData,
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}
	}

	/**
	 * Creates an R2 bucket. Returns true if created, false if already exists.
	 */
	async createR2BucketIfNotExists(name: string): Promise<boolean> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/r2/buckets/${name}`;
		const options: RequestInit = {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		};

		const response = await fetch(url, options);
		const data = (await response.json()) as CloudflareResponse<R2Bucket>;

		if (data.success) {
			return true;
		}

		// Check if error is "bucket already exists" (error code 10006)
		const alreadyExists = data.errors?.some(
			(e) => e.code === 10006 || e.message?.toLowerCase().includes("already exists"),
		);

		if (alreadyExists) {
			return false; // Bucket already exists, treat as success
		}

		const errorMsg =
			data.errors?.length > 0
				? data.errors.map((e) => e.message).join(", ")
				: "Unknown Cloudflare API error";
		throw new Error(`Cloudflare API error: ${errorMsg}`);
	}

	/**
	 * Execute SQL statements against a D1 database
	 */
	async executeD1Query(databaseId: string, sql: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/d1/database/${databaseId}/query`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql }),
		});

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			// Handle common errors gracefully
			const errorMsg = data.errors?.[0]?.message || "D1 query failed";

			// Ignore "table already exists" errors (idempotent schema)
			if (errorMsg.includes("already exists")) {
				return;
			}

			throw new Error(`D1 error: ${errorMsg}`);
		}
	}

	/**
	 * Set secrets on a dispatch namespace script
	 */
	async setDispatchScriptSecrets(
		namespace: string,
		scriptName: string,
		secrets: Record<string, string>,
	): Promise<void> {
		for (const [name, value] of Object.entries(secrets)) {
			const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`;

			const response = await fetch(url, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name,
					text: value,
					type: "secret_text",
				}),
			});

			const data = (await response.json()) as CloudflareResponse<unknown>;

			if (!data.success) {
				const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Secret upload failed";
				throw new Error(`Failed to set secret ${name}: ${errorMsg}`);
			}
		}
	}

	/**
	 * Upload a file to an R2 bucket
	 */
	async uploadToR2Bucket(bucketName: string, key: string, content: Uint8Array): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/r2/buckets/${bucketName}/objects/${key}`;

		const response = await fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
			body: content,
		});

		if (!response.ok) {
			throw new Error(`Failed to upload to R2: ${response.statusText}`);
		}
	}
}

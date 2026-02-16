import type { Bindings } from "./types";

/**
 * Gets MIME type from file path extension.
 * Covers common web assets; defaults to application/octet-stream for unknown types.
 */
export function getMimeType(filePath: string): string {
	const ext = filePath.includes(".") ? filePath.split(".").pop()?.toLowerCase() : "";

	const mimeTypes: Record<string, string> = {
		// HTML
		html: "text/html",
		htm: "text/html",
		// JavaScript
		js: "text/javascript",
		mjs: "text/javascript",
		// CSS
		css: "text/css",
		// JSON
		json: "application/json",
		// Images
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		ico: "image/x-icon",
		avif: "image/avif",
		// Fonts
		woff: "font/woff",
		woff2: "font/woff2",
		ttf: "font/ttf",
		otf: "font/otf",
		// Other
		pdf: "application/pdf",
		xml: "application/xml",
		txt: "text/plain",
		map: "application/json",
		webmanifest: "application/manifest+json",
	};

	return mimeTypes[ext || ""] || "application/octet-stream";
}

// =====================================================
// Workers Assets API - Overview & Limitations
// =====================================================
//
// The Workers Assets API allows uploading static files that are served by Cloudflare's
// edge network and accessible via env.ASSETS.fetch() in Worker code.
//
// SUPPORTED FEATURES:
// - Works with dispatch namespaces (Workers for Platforms)
// - Incremental uploads (only changed files need re-uploading)
// - Asset routing configuration (html_handling, not_found_handling)
// - Assets binding for programmatic access (env.ASSETS.fetch())
//
// UPLOAD FLOW:
// 1. Create upload session with manifest (file paths + hashes)
// 2. Upload file payloads in batches (grouped by API response)
// 3. Deploy script with completion JWT and assets binding
//
// LIMITATIONS:
// - Maximum asset size: Depends on account plan (see Cloudflare docs)
// - JWT validity: 1 hour for upload session
// - Hash algorithm: SHA-256 of base64(content) + extension, truncated to 32 hex chars
//
// For full documentation, see:
// https://developers.cloudflare.com/workers/static-assets/direct-upload/
//
// =====================================================

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

interface D1DatabaseInfo {
	uuid: string;
	name: string;
	version: string;
	num_tables: number;
	file_size: number;
	created_at: string;
}

export interface D1QueryResult {
	success: boolean;
	results: unknown[];
	meta: {
		changes: number;
		duration_ms: number;
		last_row_id: number;
		rows_read: number;
		rows_written: number;
	};
}

interface R2Bucket {
	name: string;
	creation_date: string;
}

interface KVNamespace {
	id: string;
	title: string;
	supports_url_encoding?: boolean;
}

interface VectorizeIndex {
	name: string;
	description?: string;
	config: {
		dimensions: number;
		metric: "cosine" | "euclidean" | "dot-product";
	};
	created_on: string;
	modified_on: string;
}

// =====================================================
// Custom Hostnames API Types (Cloudflare for SaaS)
// =====================================================

/**
 * Custom hostname from Cloudflare API response
 * Docs: https://developers.cloudflare.com/api/operations/custom-hostname-for-a-zone-list-custom-hostnames
 */
export interface CloudflareCustomHostname {
	id: string;
	hostname: string;
	status: "pending" | "active" | "pending_deletion" | "moved" | "blocked" | "deleted";
	ssl: {
		status: "pending_validation" | "pending_issuance" | "pending_deployment" | "active";
		method: string;
		type: string;
		certificate_authority: string;
		validation_errors?: Array<{ message: string }>;
	};
	ownership_verification?: {
		type: "txt";
		name: string;
		value: string;
	};
	ownership_verification_http?: {
		http_url: string;
		http_body: string;
	};
	verification_errors?: string[];
	created_at: string;
}

// =====================================================
// Workers Assets API Types & Utilities
// =====================================================

/**
 * Computes the asset hash for a file in the format expected by Cloudflare Workers Assets API.
 * Hash is: SHA-256(base64(content) + fileExtension), truncated to 32 hex characters.
 *
 * @param content - The file content as Uint8Array or ArrayBuffer
 * @param filePath - The file path (used to extract extension)
 * @returns 32 character hex hash string
 *
 * @example
 * ```typescript
 * const content = new TextEncoder().encode("<html>...</html>");
 * const hash = await computeAssetHash(content, "/index.html");
 * // Returns something like "08f1dfda4574284ab3c21666d1e2f3a4"
 * ```
 */
export async function computeAssetHash(
	content: Uint8Array | ArrayBuffer,
	filePath: string,
): Promise<string> {
	// Extract file extension (without the dot)
	const extension = filePath.includes(".") ? filePath.split(".").pop() || "" : "";

	// Convert content to base64 using a chunk-based approach for large files
	const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content;
	let base64 = "";
	const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		base64 += String.fromCharCode.apply(null, Array.from(chunk));
	}
	base64 = btoa(base64);

	// Compute SHA-256 of base64 + extension
	const hashInput = new TextEncoder().encode(base64 + extension);
	const hashBuffer = await crypto.subtle.digest("SHA-256", hashInput);

	// Convert to hex and truncate to 32 characters
	const hashArray = new Uint8Array(hashBuffer);
	let hashHex = "";
	for (let i = 0; i < hashArray.length; i++) {
		hashHex += hashArray[i]!.toString(16).padStart(2, "0");
	}

	return hashHex.slice(0, 32);
}

/**
 * Creates an asset manifest from a map of file paths to content.
 * Computes hashes and sizes for each file.
 *
 * @param files - Map of file paths (with leading slash) to content
 * @returns Asset manifest ready for createAssetUploadSession
 *
 * @example
 * ```typescript
 * const files = new Map([
 *   ["/index.html", new TextEncoder().encode("<html>...</html>")],
 *   ["/style.css", new TextEncoder().encode("body { ... }")],
 * ]);
 * const manifest = await createAssetManifest(files);
 * ```
 */
export async function createAssetManifest(files: Map<string, Uint8Array>): Promise<AssetManifest> {
	const manifest: AssetManifest = {};

	for (const [filePath, content] of files.entries()) {
		manifest[filePath] = {
			hash: await computeAssetHash(content, filePath),
			size: content.length,
		};
	}

	return manifest;
}

/**
 * Asset manifest entry - describes a file to be uploaded as a Worker asset
 */
export interface AssetManifestEntry {
	/**
	 * 32 hex character hash of the file content.
	 * Hash is computed as: sha256(base64(content) + fileExtension).slice(0, 32)
	 */
	hash: string;
	/** File size in bytes */
	size: number;
}

/**
 * Asset manifest - maps file paths to their metadata.
 * Keys are file paths with leading slash like "/index.html", "/styles/main.css"
 */
export type AssetManifest = Record<string, AssetManifestEntry>;

/**
 * Response from creating an asset upload session
 */
interface AssetUploadSessionResponse {
	/** JWT token for uploading assets (valid for 1 hour) */
	jwt: string;
	/**
	 * Buckets of file hashes that need uploading.
	 * Each inner array represents files that should be uploaded together in one request.
	 * Empty if all files were previously uploaded (use jwt as completion token directly).
	 */
	buckets: string[][];
}

/**
 * Asset upload payload entry with content and MIME type
 */
export interface AssetUploadPayloadEntry {
	/** Base64-encoded file content */
	content: string;
	/** MIME type for Content-Type header */
	mimeType: string;
}

/**
 * Asset upload payload - maps file hash to entry with content and MIME type
 */
export type AssetUploadPayload = Record<string, AssetUploadPayloadEntry>;

/**
 * Response from uploading asset payloads
 */
interface AssetUploadResponse {
	/** Completion JWT returned when all assets are uploaded (use for final script deployment) */
	jwt?: string;
}

/**
 * Asset configuration for worker deployment
 */
export interface AssetConfig {
	/** How to handle HTML files - affects trailing slashes and index.html behavior */
	html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
	/** How to handle requests that don't match any asset */
	not_found_handling?: "single-page-application" | "404-page" | "none";
}

/**
 * Worker module for uploading additional files (WASM, text, data, etc.)
 */
export interface WorkerModule {
	/** Module name (e.g., "parser.wasm", "config.json") */
	name: string;
	/** Module content as binary data */
	content: Uint8Array;
	/** MIME type (e.g., "application/wasm", "application/json") */
	mimeType: string;
}

// Supported binding types for dispatch scripts
export type DispatchBindingType =
	| "d1"
	| "r2_bucket"
	| "plain_text"
	| "ai"
	| "secret_text"
	| "kv_namespace"
	| "service"
	| "durable_object_namespace"
	| "analytics_engine";

export interface DispatchScriptBinding {
	type: DispatchBindingType | string; // Allow known types plus custom strings for extensibility
	name: string;
	/** Service binding target (for type: "service") */
	service?: string;
	/** Named entrypoint on the target worker (for type: "service" with WorkerEntrypoint) */
	entrypoint?: string;
	/** Deploy-time props injected into ctx.props — unforgeable by user code */
	props?: Record<string, unknown>;
	[key: string]: unknown; // Additional binding-specific properties
}

/**
 * CloudflareClient handles authenticated API calls to Cloudflare
 */
export class CloudflareClient {
	private accountId: string;
	private apiToken: string;
	private zoneId: string | null = null;
	private baseUrl = "https://api.cloudflare.com/client/v4";

	constructor(env: Bindings) {
		this.accountId = env.CLOUDFLARE_ACCOUNT_ID;
		this.apiToken = env.CLOUDFLARE_API_TOKEN;
	}

	/**
	 * Sets the zone ID for zone-level API operations (e.g., custom hostnames).
	 * Call this before using custom hostname methods.
	 */
	setZoneId(zoneId: string): void {
		this.zoneId = zoneId;
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
	 * Makes an authenticated request to a zone-level Cloudflare API endpoint.
	 * Used for Custom Hostnames which are zone-scoped, not account-scoped.
	 */
	private async zoneRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
		if (!this.zoneId) {
			throw new Error("Zone ID not configured. Call setZoneId() first.");
		}

		const url = `${this.baseUrl}/zones/${this.zoneId}${path}`;
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
					? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}

		return data.result;
	}

	// =====================================================
	// Custom Hostnames API Methods (Cloudflare for SaaS)
	// =====================================================

	/**
	 * Creates a custom hostname for Cloudflare for SaaS.
	 * The hostname will be validated via HTTP (CNAME) and SSL issued automatically.
	 *
	 * @param hostname - The custom hostname (e.g., api.mycompany.com)
	 * @returns The created custom hostname object
	 *
	 * Docs: https://developers.cloudflare.com/api/operations/custom-hostname-for-a-zone-create-custom-hostname
	 */
	async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
		return this.zoneRequest<CloudflareCustomHostname>("POST", "/custom_hostnames", {
			hostname,
			ssl: {
				method: "http",
				type: "dv",
			},
		});
	}

	/**
	 * Gets the current status of a custom hostname by its Cloudflare ID.
	 *
	 * @param hostnameId - The Cloudflare custom hostname ID
	 * @returns The custom hostname object with current status
	 */
	async getCustomHostname(hostnameId: string): Promise<CloudflareCustomHostname> {
		return this.zoneRequest<CloudflareCustomHostname>("GET", `/custom_hostnames/${hostnameId}`);
	}

	/**
	 * Deletes a custom hostname from Cloudflare.
	 *
	 * @param hostnameId - The Cloudflare custom hostname ID
	 */
	async deleteCustomHostname(hostnameId: string): Promise<void> {
		await this.zoneRequest<{ id: string }>("DELETE", `/custom_hostnames/${hostnameId}`);
	}

	/**
	 * Lists custom hostnames, optionally filtered by hostname.
	 * Useful for checking if a hostname already exists.
	 *
	 * @param hostname - Optional hostname to filter by (exact match)
	 * @returns Array of matching custom hostnames
	 */
	async listCustomHostnames(hostname?: string): Promise<CloudflareCustomHostname[]> {
		const params = new URLSearchParams();
		if (hostname) {
			params.set("hostname", hostname);
		}
		params.set("per_page", "50");

		const queryString = params.toString();
		const path = `/custom_hostnames${queryString ? `?${queryString}` : ""}`;

		return this.zoneRequest<CloudflareCustomHostname[]>("GET", path);
	}

	/**
	 * Refreshes SSL validation for a custom hostname.
	 * Call this when user reports they've set up DNS but domain isn't active yet.
	 *
	 * @param hostnameId - The Cloudflare custom hostname ID
	 * @returns Updated custom hostname status
	 */
	async refreshCustomHostname(hostnameId: string): Promise<CloudflareCustomHostname> {
		// PATCH with empty body triggers a refresh
		return this.zoneRequest<CloudflareCustomHostname>(
			"PATCH",
			`/custom_hostnames/${hostnameId}`,
			{},
		);
	}

	/**
	 * Creates a new D1 database with retry on transient errors
	 * @returns The created database with uuid, name, version, created_at
	 */
	async createD1Database(name: string): Promise<D1Database> {
		const maxRetries = 3;
		const baseDelayMs = 1000;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await this.request<D1Database>("POST", "/d1/database", { name });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const isTransient =
					message.includes("timeout") ||
					message.includes("D1_ERROR") ||
					message.includes("500") ||
					message.includes("503") ||
					message.includes("429");

				if (!isTransient || attempt === maxRetries) {
					throw err;
				}

				// Exponential backoff: 1s, 2s, 4s
				const delay = baseDelayMs * Math.pow(2, attempt - 1);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		// TypeScript: should never reach here, but satisfy compiler
		throw new Error("D1 database creation failed after retries");
	}

	/**
	 * Gets D1 database info including size and table count
	 */
	async getD1DatabaseInfo(databaseId: string): Promise<D1DatabaseInfo> {
		return this.request<D1DatabaseInfo>("GET", `/d1/database/${databaseId}`);
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
			additionalModules?: WorkerModule[];
			migrations?: {
				old_tag: string;
				new_tag: string;
				steps: Array<Record<string, unknown>>;
			};
		},
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;

		// Create FormData with metadata and script content
		const formData = new FormData();

		// Add metadata with bindings
		const mainModuleName = options?.mainModule ?? "worker.js";
		const metadata: Record<string, unknown> = {
			main_module: mainModuleName,
			bindings,
		};
		if (options?.compatibilityDate) {
			metadata.compatibility_date = options.compatibilityDate;
		}
		if (options?.compatibilityFlags?.length) {
			metadata.compatibility_flags = options.compatibilityFlags;
		}
		if (options?.migrations) {
			metadata.migrations = options.migrations;
		}
		formData.append("metadata", JSON.stringify(metadata));

		// Add main worker script
		const scriptBlob = new Blob([scriptContent], { type: "application/javascript+module" });
		formData.append(mainModuleName, scriptBlob, mainModuleName);

		// Add additional modules (WASM, etc.)
		if (options?.additionalModules) {
			for (const module of options.additionalModules) {
				const blob = new Blob([module.content], { type: module.mimeType });
				formData.append(module.name, blob, module.name);
			}
		}

		const fetchOptions: RequestInit = {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
			body: formData,
		};

		const response = await fetch(url, fetchOptions);

		if (response.status === 412) {
			const data = (await response.json()) as CloudflareResponse<unknown>;
			const errorMsg =
				data.errors?.map((e) => e.message).join(", ") || "Migration tag precondition failed";
			const error: Error & { status?: number; cfErrors?: unknown } = new Error(
				`Cloudflare API error (412): ${errorMsg}`,
			);
			error.status = 412;
			error.cfErrors = data.errors;
			throw error;
		}

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
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
	 * Gets the current settings (including bindings) for a dispatch namespace script.
	 */
	async getDispatchScriptSettings(
		namespace: string,
		scriptName: string,
	): Promise<{ bindings: DispatchScriptBinding[] }> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/settings`;

		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${this.apiToken}` },
		});

		const data = (await response.json()) as CloudflareResponse<{
			bindings?: DispatchScriptBinding[];
		}>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Failed to get dispatch script settings: ${errorMsg}`);
		}

		return { bindings: data.result?.bindings ?? [] };
	}

	/**
	 * Enables observability (Workers Logs) for a dispatch namespace script.
	 * This allows logs to be stored and queried via the Cloudflare dashboard.
	 */
	async enableScriptObservability(namespace: string, scriptName: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/settings`;

		const formData = new FormData();
		const settings = {
			observability: {
				enabled: true,
				head_sampling_rate: 1, // Log 100% of requests
			},
		};
		formData.append("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }));

		const response = await fetch(url, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${this.apiToken}` },
			body: formData,
		});

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `${e.code}: ${e.message}`).join(", ")
					: `HTTP ${response.status}: ${JSON.stringify(data)}`;
			throw new Error(`Failed to enable observability: ${errorMsg}`);
		}
	}

	/**
	 * Attach/detach Tail Worker consumers for a dispatch namespace script.
	 * This is the supported real-time logging mechanism for Workers for Platforms.
	 */
	async setDispatchScriptTailConsumers(
		namespace: string,
		scriptName: string,
		tailConsumers: Array<{ service: string; environment?: string; namespace?: string }>,
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/settings`;

		const formData = new FormData();
		const settings = { tail_consumers: tailConsumers };
		formData.append("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }));

		const response = await fetch(url, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${this.apiToken}` },
			body: formData,
		});

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `${e.code}: ${e.message}`).join(", ")
					: `HTTP ${response.status}: ${JSON.stringify(data)}`;
			throw new Error(`Failed to set tail consumers: ${errorMsg}`);
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
	 * Creates a new KV namespace
	 * @returns The created namespace with id and title
	 */
	async createKVNamespace(title: string): Promise<KVNamespace> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title }),
		});

		const data = (await response.json()) as CloudflareResponse<KVNamespace>;

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
	 * Lists all KV namespaces in the account
	 */
	async listKVNamespaces(): Promise<KVNamespace[]> {
		const namespaces: KVNamespace[] = [];
		let cursor: string | undefined;

		do {
			const params = new URLSearchParams();
			if (cursor) {
				params.set("cursor", cursor);
			}
			params.set("per_page", "100");

			const url = `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces?${params}`;
			const response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
				},
			});

			const data = (await response.json()) as CloudflareResponse<KVNamespace[]> & {
				result_info?: { cursor?: string };
			};

			if (!data.success) {
				const errorMsg =
					data.errors?.length > 0
						? data.errors.map((e) => e.message).join(", ")
						: "Unknown Cloudflare API error";
				throw new Error(`Cloudflare API error: ${errorMsg}`);
			}

			namespaces.push(...(data.result || []));
			cursor = data.result_info?.cursor;
		} while (cursor);

		return namespaces;
	}

	/**
	 * Creates a KV namespace if it doesn't already exist (idempotent)
	 */
	async createKVNamespaceIfNotExists(
		title: string,
	): Promise<{ namespace: KVNamespace; created: boolean }> {
		const existingNamespaces = await this.listKVNamespaces();
		const existing = existingNamespaces.find((ns) => ns.title === title);

		if (existing) {
			return { namespace: existing, created: false };
		}

		const namespace = await this.createKVNamespace(title);
		return { namespace, created: true };
	}

	/**
	 * Deletes a KV namespace
	 */
	async deleteKVNamespace(namespaceId: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}`;
		const response = await fetch(url, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}
	}

	// =====================================================
	// Vectorize API Methods
	// =====================================================

	/**
	 * Creates a new Vectorize index
	 * @returns The created index with name, config, created_on, modified_on
	 */
	async createVectorizeIndex(
		name: string,
		dimensions: number,
		metric: "cosine" | "euclidean" | "dot-product" = "cosine",
		description?: string,
	): Promise<VectorizeIndex> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/vectorize/v2/indexes`;
		const body: Record<string, unknown> = {
			name,
			config: { dimensions, metric },
		};
		if (description) {
			body.description = description;
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const data = (await response.json()) as CloudflareResponse<VectorizeIndex>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}

		return data.result;
	}

	/**
	 * Gets a Vectorize index by name
	 * @returns The index if found, null if not found
	 */
	async getVectorizeIndex(name: string): Promise<VectorizeIndex | null> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/vectorize/v2/indexes/${name}`;
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

		const data = (await response.json()) as CloudflareResponse<VectorizeIndex>;

		if (!data.success) {
			// Check if error is "index not found" (error codes and message patterns)
			const notFound = data.errors?.some(
				(e) =>
					e.code === 10043 ||
					e.code === 3000 ||
					e.message?.toLowerCase().includes("not found") ||
					e.message?.toLowerCase().includes("not_found") ||
					e.message?.toLowerCase().includes("does not exist"),
			);

			if (notFound) {
				return null;
			}

			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Cloudflare API error: ${errorMsg}`);
		}

		return data.result;
	}

	/**
	 * Deletes a Vectorize index
	 */
	async deleteVectorizeIndex(name: string): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/vectorize/v2/indexes/${name}`;
		const response = await fetch(url, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

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
	 * Creates a Vectorize index if it doesn't already exist (idempotent)
	 * @returns The index and whether it was newly created
	 */
	async createVectorizeIndexIfNotExists(
		name: string,
		dimensions: number,
		metric: "cosine" | "euclidean" | "dot-product",
	): Promise<{ index: VectorizeIndex; created: boolean }> {
		const existing = await this.getVectorizeIndex(name);

		if (existing) {
			// Validate that dimensions match - dimensions are immutable
			if (existing.config.dimensions !== dimensions) {
				throw new Error(
					`Vectorize index "${name}" already exists with different dimensions ` +
						`(${existing.config.dimensions} vs ${dimensions}). Dimensions are immutable.`,
				);
			}
			return { index: existing, created: false };
		}

		const index = await this.createVectorizeIndex(name, dimensions, metric);
		return { index, created: true };
	}

	/**
	 * Execute SQL statements against a D1 database
	 */
	async executeD1Query(
		databaseId: string,
		sql: string,
		params?: unknown[],
	): Promise<D1QueryResult> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/d1/database/${databaseId}/query`;

		const body: { sql: string; params?: unknown[] } = { sql };
		if (params && params.length > 0) {
			body.params = params;
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const data = (await response.json()) as CloudflareResponse<D1QueryResult[]>;

		if (!data.success) {
			const errorMsg = data.errors?.[0]?.message || "D1 query failed";
			throw new Error(`D1 error: ${errorMsg}`);
		}

		// Cloudflare D1 API returns an array of results (one per statement)
		// We return the first result for single-statement queries
		const result = data.result?.[0];
		if (!result) {
			// Return empty result if no data returned
			return {
				success: true,
				results: [],
				meta: {
					changes: 0,
					duration_ms: 0,
					last_row_id: 0,
					rows_read: 0,
					rows_written: 0,
				},
			};
		}

		return result;
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
	 * List secrets for a dispatch namespace script (names only, not values)
	 */
	async listDispatchScriptSecrets(
		namespace: string,
		scriptName: string,
	): Promise<Array<{ name: string; type: string }>> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`;

		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

		const data = (await response.json()) as CloudflareResponse<
			Array<{ name: string; type: string }>
		>;

		if (!data.success) {
			const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Failed to list secrets";
			throw new Error(`Failed to list secrets: ${errorMsg}`);
		}

		return data.result || [];
	}

	/**
	 * Delete a secret from a dispatch namespace script
	 */
	async deleteDispatchScriptSecret(
		namespace: string,
		scriptName: string,
		secretName: string,
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets/${secretName}`;

		const response = await fetch(url, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
		});

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Failed to delete secret";
			throw new Error(`Failed to delete secret ${secretName}: ${errorMsg}`);
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

	/**
	 * Export a D1 database to SQL format using polling-based export.
	 * @param databaseId - The D1 database UUID
	 * @param timeoutMs - Maximum time to wait for export (default: 60000ms)
	 * @returns Signed URL to download the SQL export
	 */
	async exportD1Database(databaseId: string, timeoutMs = 60000): Promise<string> {
		const startTime = Date.now();
		const pollInterval = 2000;
		const url = `${this.baseUrl}/accounts/${this.accountId}/d1/database/${databaseId}/export`;

		// Start export
		let response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ output_format: "polling" }),
		});

		let data = (await response.json()) as {
			result?: {
				status: string;
				at_bookmark?: string;
				error?: string;
				result?: { signed_url: string; filename: string };
			};
		};

		// Poll until complete
		while (data.result?.status !== "complete") {
			if (data.result?.status === "error") {
				throw new Error(`D1 export failed: ${data.result.error || "Unknown error"}`);
			}

			if (Date.now() - startTime > timeoutMs) {
				throw new Error(`D1 export timed out after ${timeoutMs}ms`);
			}

			await new Promise((resolve) => setTimeout(resolve, pollInterval));

			response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					output_format: "polling",
					current_bookmark: data.result?.at_bookmark,
				}),
			});
			data = (await response.json()) as typeof data;
		}

		if (!data.result?.result?.signed_url) {
			throw new Error("D1 export completed but no download URL returned");
		}

		return data.result.result.signed_url;
	}

	// =====================================================
	// Workers Assets API Methods
	// =====================================================

	/**
	 * Creates an asset upload session for a dispatch namespace script.
	 *
	 * This is step 1 of the Workers Assets upload flow:
	 * 1. Create upload session (this method) - get JWT and list of files to upload
	 * 2. Upload asset payloads (uploadAssetPayloads) - upload files in batches
	 * 3. Upload script with assets (uploadDispatchScriptWithAssets) - deploy with completion JWT
	 *
	 * @param namespace - The dispatch namespace name
	 * @param scriptName - The name of the worker script
	 * @param manifest - Map of file paths to {hash, size} metadata
	 * @returns JWT for uploading and buckets array indicating which files need uploading
	 *
	 * @example
	 * ```typescript
	 * const session = await client.createAssetUploadSession("my-namespace", "my-script", {
	 *   "/index.html": { hash: "abc123...", size: 1234 },
	 *   "/styles.css": { hash: "def456...", size: 567 }
	 * });
	 * // session.buckets is empty if all files already uploaded
	 * ```
	 */
	async createAssetUploadSession(
		namespace: string,
		scriptName: string,
		manifest: AssetManifest,
	): Promise<AssetUploadSessionResponse> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/assets-upload-session`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ manifest }),
		});

		const data = (await response.json()) as CloudflareResponse<AssetUploadSessionResponse>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => e.message).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Failed to create asset upload session: ${errorMsg}`);
		}

		return data.result;
	}

	/**
	 * Uploads asset payloads to Cloudflare Workers.
	 *
	 * This is step 2 of the Workers Assets upload flow.
	 * Upload files in the order specified by the buckets from createAssetUploadSession.
	 *
	 * @param payloads - Array of payload objects, each mapping hash to base64 content
	 * @param uploadJwt - JWT from createAssetUploadSession
	 * @returns Completion JWT to use when deploying the script (returned after last bucket)
	 *
	 * @example
	 * ```typescript
	 * const payloads = session.buckets.map(bucket => {
	 *   const payload: Record<string, string> = {};
	 *   for (const hash of bucket) {
	 *     payload[hash] = base64Encode(fileContentForHash(hash));
	 *   }
	 *   return payload;
	 * });
	 * const completionJwt = await client.uploadAssetPayloads(payloads, session.jwt);
	 * ```
	 */
	async uploadAssetPayloads(payloads: AssetUploadPayload[], uploadJwt: string): Promise<string> {
		// Note: The upload endpoint is account-level, not per-script
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/assets/upload?base64=true`;

		// Upload buckets in parallel batches (matches wrangler's BULK_UPLOAD_CONCURRENCY)
		const CONCURRENCY = 3;
		let completionJwt: string | undefined;

		for (let i = 0; i < payloads.length; i += CONCURRENCY) {
			const batch = payloads.slice(i, i + CONCURRENCY);

			const results = await Promise.all(
				batch.map(async (payload, batchIndex) => {
					// Create multipart form data for this bucket
					const formData = new FormData();
					for (const [hash, entry] of Object.entries(payload)) {
						// Use the provided MIME type for proper Content-Type serving
						const blob = new Blob([entry.content], { type: entry.mimeType });
						formData.append(hash, blob, hash);
					}

					const response = await fetch(url, {
						method: "POST",
						headers: {
							// Use the upload JWT for authentication (not the API token)
							Authorization: `Bearer ${uploadJwt}`,
						},
						body: formData,
					});

					const data = (await response.json()) as CloudflareResponse<AssetUploadResponse>;

					if (!data.success) {
						const errorMsg =
							data.errors?.length > 0
								? data.errors.map((e) => e.message).join(", ")
								: "Unknown Cloudflare API error";
						throw new Error(
							`Failed to upload asset payload batch ${i + batchIndex + 1}/${payloads.length}: ${errorMsg}`,
						);
					}

					return data;
				}),
			);

			// Capture completion JWT from any response that has it
			for (const data of results) {
				if (data.result?.jwt) {
					completionJwt = data.result.jwt;
				}
			}
		}

		if (!completionJwt) {
			throw new Error("Asset upload completed but no completion JWT received");
		}

		return completionJwt;
	}

	/**
	 * Uploads a worker script with assets binding to a dispatch namespace.
	 *
	 * This is step 3 of the Workers Assets upload flow.
	 * The completion JWT authorizes attaching the previously uploaded assets to this script.
	 *
	 * @param namespace - The dispatch namespace name
	 * @param scriptName - The name of the worker script
	 * @param scriptContent - The worker JavaScript/TypeScript code
	 * @param bindings - Array of binding configurations (D1, R2, KV, etc.)
	 * @param assetsJwt - Completion JWT from uploadAssetPayloads (or upload session if no files to upload)
	 * @param assetsBinding - Name of the assets binding (typically "ASSETS")
	 * @param options - Optional configuration for compatibility date/flags and asset routing
	 *
	 * @example
	 * ```typescript
	 * await client.uploadDispatchScriptWithAssets(
	 *   "my-namespace",
	 *   "my-script",
	 *   workerCode,
	 *   [{ type: "d1", name: "DB", database_id: "..." }],
	 *   completionJwt,
	 *   "ASSETS",
	 *   {
	 *     compatibilityDate: "2024-01-01",
	 *     assetConfig: { html_handling: "auto-trailing-slash" }
	 *   }
	 * );
	 * // Worker can now use: env.ASSETS.fetch(request)
	 * ```
	 */
	/**
	 * Creates a tail session for streaming logs from a dispatch namespace script.
	 *
	 * @param namespace - The dispatch namespace name
	 * @param scriptName - The name of the worker script
	 * @returns Tail session with WebSocket URL for streaming logs
	 *
	 * @example
	 * ```typescript
	 * const tail = await client.createDispatchTail("jack-tenants", "my-script");
	 * // Connect to tail.url via WebSocket to receive log messages
	 * ```
	 */
	async createDispatchTail(
		namespace: string,
		scriptName: string,
	): Promise<{ id: string; url: string; expires_at: string }> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/tails`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});

		const data = (await response.json()) as CloudflareResponse<{
			id: string;
			url: string;
			expires_at: string;
		}>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `${e.code}: ${e.message}`).join(", ")
					: `HTTP ${response.status}: ${JSON.stringify(data)}`;
			throw new Error(`Failed to create tail session: ${errorMsg}`);
		}

		return data.result;
	}

	async uploadDispatchScriptWithAssets(
		namespace: string,
		scriptName: string,
		scriptContent: string,
		bindings: DispatchScriptBinding[],
		assetsJwt: string,
		assetsBinding: string,
		options?: {
			compatibilityDate?: string;
			compatibilityFlags?: string[];
			mainModule?: string;
			assetConfig?: AssetConfig;
			additionalModules?: WorkerModule[];
			migrations?: {
				old_tag: string;
				new_tag: string;
				steps: Array<Record<string, unknown>>;
			};
		},
	): Promise<void> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;

		// Create FormData with metadata and script content
		const formData = new FormData();

		// Build the assets configuration with JWT
		const assetsConfig: Record<string, unknown> = {
			jwt: assetsJwt,
		};
		if (options?.assetConfig) {
			assetsConfig.config = options.assetConfig;
		}

		// Add the assets binding to the bindings array
		const allBindings: DispatchScriptBinding[] = [
			...bindings,
			{
				type: "assets",
				name: assetsBinding,
			},
		];

		// Build metadata with assets configuration
		const mainModuleName = options?.mainModule ?? "worker.js";
		const metadata: Record<string, unknown> = {
			main_module: mainModuleName,
			bindings: allBindings,
			assets: assetsConfig,
		};

		if (options?.compatibilityDate) {
			metadata.compatibility_date = options.compatibilityDate;
		}
		if (options?.compatibilityFlags?.length) {
			metadata.compatibility_flags = options.compatibilityFlags;
		}
		if (options?.migrations) {
			metadata.migrations = options.migrations;
		}

		formData.append("metadata", JSON.stringify(metadata));

		// Add main worker script
		const scriptBlob = new Blob([scriptContent], { type: "application/javascript+module" });
		formData.append(mainModuleName, scriptBlob, mainModuleName);

		// Add additional modules (WASM, etc.)
		if (options?.additionalModules) {
			for (const module of options.additionalModules) {
				const blob = new Blob([module.content], { type: module.mimeType });
				formData.append(module.name, blob, module.name);
			}
		}

		const fetchOptions: RequestInit = {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
			},
			body: formData,
		};

		const response = await fetch(url, fetchOptions);

		if (response.status === 412) {
			const data = (await response.json()) as CloudflareResponse<unknown>;
			const errorMsg =
				data.errors?.map((e) => e.message).join(", ") || "Migration tag precondition failed";
			const error: Error & { status?: number; cfErrors?: unknown } = new Error(
				`Cloudflare API error (412): ${errorMsg}`,
			);
			error.status = 412;
			error.cfErrors = data.errors;
			throw error;
		}

		const data = (await response.json()) as CloudflareResponse<unknown>;

		if (!data.success) {
			const errorMsg =
				data.errors?.length > 0
					? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
					: "Unknown Cloudflare API error";
			throw new Error(`Failed to upload dispatch script with assets: ${errorMsg}`);
		}
	}

	// =====================================================
	// GraphQL Analytics API
	// =====================================================

	/**
	 * Query Cloudflare GraphQL Analytics API.
	 * Docs: https://developers.cloudflare.com/analytics/graphql-api/
	 */
	async queryGraphQL(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
		const url = "https://api.cloudflare.com/client/v4/graphql";

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`GraphQL query failed: ${response.status} ${text}`);
		}

		const result = (await response.json()) as GraphQLResponse;
		if (result.errors?.length) {
			throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`);
		}

		return result;
	}

	// =====================================================
	// Analytics Engine SQL API Methods
	// =====================================================

	/**
	 * Query Analytics Engine using SQL API.
	 * Docs: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
	 */
	async queryAnalyticsEngine(sql: string): Promise<AnalyticsEngineQueryResult> {
		const url = `${this.baseUrl}/accounts/${this.accountId}/analytics_engine/sql`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "text/plain",
			},
			body: sql,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Analytics Engine query failed: ${response.status} ${text}`);
		}

		return response.json() as Promise<AnalyticsEngineQueryResult>;
	}

	/**
	 * Get aggregated usage metrics for an org from Analytics Engine.
	 */
	async getOrgUsageFromAE(orgId: string, from: string, to: string): Promise<UsageMetricsAE> {
		const escapedOrgId = this.escapeSQL(orgId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `blob1 = '${escapedOrgId}' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		const metricsQuery = `
			SELECT
				SUM(_sample_interval) as requests,
				AVG(double2) as avg_latency_ms,
				SUM(double3 * _sample_interval) as bandwidth_in_bytes,
				SUM(double4 * _sample_interval) as bandwidth_out_bytes
			FROM jack_usage
			WHERE ${whereClause}
		`;

		const statusQuery = `
			SELECT blob9 as status_class, SUM(_sample_interval) as count
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob9
		`;

		const cacheQuery = `
			SELECT blob4 as cache_status, SUM(_sample_interval) as count
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob4
		`;

		const [metricsResult, statusResult, cacheResult] = await Promise.all([
			this.queryAnalyticsEngine(metricsQuery),
			this.queryAnalyticsEngine(statusQuery),
			this.queryAnalyticsEngine(cacheQuery),
		]);

		return this.combineUsageMetrics(metricsResult, statusResult, cacheResult);
	}

	/**
	 * Get per-project breakdown for an org from Analytics Engine.
	 */
	async getOrgUsageByProjectFromAE(
		orgId: string,
		from: string,
		to: string,
		limit = 10,
	): Promise<{ project_id: string; requests: number; errors: number; percentage: number }[]> {
		const escapedOrgId = this.escapeSQL(orgId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `blob1 = '${escapedOrgId}' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		// Simple query without CASE WHEN for compatibility
		const query = `
			SELECT
				index1 as project_id,
				SUM(_sample_interval) as requests
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY index1
			ORDER BY requests DESC
			LIMIT ${limit}
		`;

		const result = await this.queryAnalyticsEngine(query);

		// Calculate total for percentages
		const total = result.data.reduce((sum, row) => sum + Number(row.requests || 0), 0);

		return result.data.map((row) => ({
			project_id: String(row.project_id || ""),
			requests: Math.round(Number(row.requests) || 0),
			errors: 0, // Not calculated in simple query
			percentage: total > 0 ? Math.round((Number(row.requests || 0) / total) * 1000) / 10 : 0,
		}));
	}

	/**
	 * Get usage metrics for a specific project from Analytics Engine.
	 */
	async getProjectUsageFromAE(
		projectId: string,
		from: string,
		to: string,
	): Promise<UsageMetricsAE> {
		const escapedProjectId = this.escapeSQL(projectId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `index1 = '${escapedProjectId}' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		const metricsQuery = `
			SELECT
				SUM(_sample_interval) as requests,
				AVG(double2) as avg_latency_ms,
				SUM(double3 * _sample_interval) as bandwidth_in_bytes,
				SUM(double4 * _sample_interval) as bandwidth_out_bytes
			FROM jack_usage
			WHERE ${whereClause}
		`;

		const statusQuery = `
			SELECT blob9 as status_class, SUM(_sample_interval) as count
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob9
		`;

		const cacheQuery = `
			SELECT blob4 as cache_status, SUM(_sample_interval) as count
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob4
		`;

		const [metricsResult, statusResult, cacheResult] = await Promise.all([
			this.queryAnalyticsEngine(metricsQuery),
			this.queryAnalyticsEngine(statusQuery),
			this.queryAnalyticsEngine(cacheQuery),
		]);

		return this.combineUsageMetrics(metricsResult, statusResult, cacheResult);
	}

	/**
	 * Combine metrics from main query with status and cache breakdowns.
	 */
	private combineUsageMetrics(
		metricsResult: AnalyticsEngineQueryResult,
		statusResult: AnalyticsEngineQueryResult,
		cacheResult: AnalyticsEngineQueryResult,
	): UsageMetricsAE {
		const row = metricsResult.data[0] || {};
		const requests = Number(row.requests) || 0;

		// Calculate errors from status breakdown (5xx responses)
		const errors = statusResult.data
			.filter((r) => r.status_class === "5xx")
			.reduce((sum, r) => sum + Number(r.count), 0);
		const errorRate = requests > 0 ? Math.round((errors / requests) * 10000) / 100 : 0;

		// Calculate cache hit rate from cache breakdown
		const cacheHits = cacheResult.data
			.filter((r) => r.cache_status === "HIT")
			.reduce((sum, r) => sum + Number(r.count), 0);
		const cacheHitRate = requests > 0 ? Math.round((cacheHits / requests) * 10000) / 100 : 0;

		return {
			requests,
			errors: Math.round(errors),
			error_rate: errorRate,
			avg_latency_ms: Math.round((Number(row.avg_latency_ms) || 0) * 100) / 100,
			bandwidth_in_bytes: Math.round(Number(row.bandwidth_in_bytes) || 0),
			bandwidth_out_bytes: Math.round(Number(row.bandwidth_out_bytes) || 0),
			cache_hit_rate: cacheHitRate,
		};
	}

	/**
	 * Get traffic breakdown by country for a project.
	 */
	async getProjectTrafficByCountry(
		projectId: string,
		from: string,
		to: string,
		limit = 10,
	): Promise<UsageByDimension[]> {
		const sql = `
			SELECT
				blob5 as country,
				SUM(_sample_interval) as requests
			FROM jack_usage
			WHERE index1 = '${this.escapeSQL(projectId)}'
				AND timestamp >= toDateTime('${this.formatTimestamp(from)}')
				AND timestamp <= toDateTime('${this.formatTimestamp(to)}')
			GROUP BY blob5
			ORDER BY requests DESC
			LIMIT ${limit}
		`;

		const result = await this.queryAnalyticsEngine(sql);
		return this.parseDimensionBreakdown(result, "country");
	}

	/**
	 * Get traffic breakdown by path for a project.
	 */
	async getProjectTrafficByPath(
		projectId: string,
		from: string,
		to: string,
		limit = 10,
	): Promise<UsageByDimension[]> {
		const sql = `
			SELECT
				blob10 as path,
				SUM(_sample_interval) as requests
			FROM jack_usage
			WHERE index1 = '${this.escapeSQL(projectId)}'
				AND timestamp >= toDateTime('${this.formatTimestamp(from)}')
				AND timestamp <= toDateTime('${this.formatTimestamp(to)}')
			GROUP BY blob10
			ORDER BY requests DESC
			LIMIT ${limit}
		`;

		const result = await this.queryAnalyticsEngine(sql);
		return this.parseDimensionBreakdown(result, "path");
	}

	/**
	 * Get traffic breakdown by HTTP method for a project.
	 */
	async getProjectTrafficByMethod(
		projectId: string,
		from: string,
		to: string,
	): Promise<UsageByDimension[]> {
		const sql = `
			SELECT
				blob3 as method,
				SUM(_sample_interval) as requests
			FROM jack_usage
			WHERE index1 = '${this.escapeSQL(projectId)}'
				AND timestamp >= toDateTime('${this.formatTimestamp(from)}')
				AND timestamp <= toDateTime('${this.formatTimestamp(to)}')
			GROUP BY blob3
			ORDER BY requests DESC
		`;

		const result = await this.queryAnalyticsEngine(sql);
		return this.parseDimensionBreakdown(result, "method");
	}

	/**
	 * Get cache status breakdown for a project.
	 */
	async getProjectCacheBreakdown(
		projectId: string,
		from: string,
		to: string,
	): Promise<UsageByDimension[]> {
		const sql = `
			SELECT
				blob4 as cache_status,
				SUM(_sample_interval) as requests
			FROM jack_usage
			WHERE index1 = '${this.escapeSQL(projectId)}'
				AND timestamp >= toDateTime('${this.formatTimestamp(from)}')
				AND timestamp <= toDateTime('${this.formatTimestamp(to)}')
			GROUP BY blob4
			ORDER BY requests DESC
		`;

		const result = await this.queryAnalyticsEngine(sql);
		return this.parseDimensionBreakdown(result, "cache_status");
	}

	/**
	 * Get AI usage metrics for a specific project from Analytics Engine.
	 * Queries binding-proxy-worker logs where blob3 = 'ai'.
	 *
	 * Schema (from binding-proxy-worker):
	 * - index1: project_id
	 * - blob1: org_id
	 * - blob3: binding_type ("ai")
	 * - blob4: model name
	 * - double1: count (always 1)
	 * - double2: duration_ms
	 * - double3: tokens_in
	 * - double4: tokens_out
	 */
	async getProjectAIUsage(
		projectId: string,
		from: string,
		to: string,
	): Promise<{ metrics: AIUsageMetrics; by_model: AIUsageByModel[] }> {
		const escapedProjectId = this.escapeSQL(projectId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `index1 = '${escapedProjectId}' AND blob3 = 'ai' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		// Aggregate metrics
		const metricsQuery = `
			SELECT
				SUM(_sample_interval) as total_requests,
				SUM(double3 * _sample_interval) as tokens_in,
				SUM(double4 * _sample_interval) as tokens_out,
				AVG(double2) as avg_latency_ms
			FROM jack_usage
			WHERE ${whereClause}
		`;

		// Breakdown by model
		const byModelQuery = `
			SELECT
				blob4 as model,
				SUM(_sample_interval) as requests,
				SUM(double3 * _sample_interval) as tokens_in,
				SUM(double4 * _sample_interval) as tokens_out
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob4
			ORDER BY requests DESC
		`;

		const [metricsResult, byModelResult] = await Promise.all([
			this.queryAnalyticsEngine(metricsQuery),
			this.queryAnalyticsEngine(byModelQuery),
		]);

		return this.combineAIUsageMetrics(metricsResult, byModelResult);
	}

	/**
	 * Get AI usage metrics for an org from Analytics Engine.
	 */
	async getOrgAIUsage(
		orgId: string,
		from: string,
		to: string,
	): Promise<{ metrics: AIUsageMetrics; by_model: AIUsageByModel[] }> {
		const escapedOrgId = this.escapeSQL(orgId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `blob1 = '${escapedOrgId}' AND blob3 = 'ai' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		const metricsQuery = `
			SELECT
				SUM(_sample_interval) as total_requests,
				SUM(double3 * _sample_interval) as tokens_in,
				SUM(double4 * _sample_interval) as tokens_out,
				AVG(double2) as avg_latency_ms
			FROM jack_usage
			WHERE ${whereClause}
		`;

		const byModelQuery = `
			SELECT
				blob4 as model,
				SUM(_sample_interval) as requests,
				SUM(double3 * _sample_interval) as tokens_in,
				SUM(double4 * _sample_interval) as tokens_out
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob4
			ORDER BY requests DESC
		`;

		const [metricsResult, byModelResult] = await Promise.all([
			this.queryAnalyticsEngine(metricsQuery),
			this.queryAnalyticsEngine(byModelQuery),
		]);

		return this.combineAIUsageMetrics(metricsResult, byModelResult);
	}

	/**
	 * Combine AI usage metrics from main query with model breakdown.
	 */
	private combineAIUsageMetrics(
		metricsResult: AnalyticsEngineQueryResult,
		byModelResult: AnalyticsEngineQueryResult,
	): { metrics: AIUsageMetrics; by_model: AIUsageByModel[] } {
		const row = metricsResult.data[0] || {};
		const tokensIn = Math.round(Number(row.tokens_in) || 0);
		const tokensOut = Math.round(Number(row.tokens_out) || 0);
		const totalRequests = Math.round(Number(row.total_requests) || 0);

		const metrics: AIUsageMetrics = {
			total_requests: totalRequests,
			tokens_in: tokensIn,
			tokens_out: tokensOut,
			total_tokens: tokensIn + tokensOut,
			avg_latency_ms: Math.round((Number(row.avg_latency_ms) || 0) * 100) / 100,
		};

		const by_model: AIUsageByModel[] = byModelResult.data.map((modelRow) => {
			const modelTokensIn = Math.round(Number(modelRow.tokens_in) || 0);
			const modelTokensOut = Math.round(Number(modelRow.tokens_out) || 0);
			const modelRequests = Math.round(Number(modelRow.requests) || 0);

			return {
				model: String(modelRow.model || "unknown"),
				requests: modelRequests,
				tokens_in: modelTokensIn,
				tokens_out: modelTokensOut,
				total_tokens: modelTokensIn + modelTokensOut,
				percentage:
					totalRequests > 0 ? Math.round((modelRequests / totalRequests) * 10000) / 100 : 0,
			};
		});

		return { metrics, by_model };
	}

	/**
	 * Get DO usage metrics for a project from Analytics Engine (jack_do_usage dataset).
	 * Returns per-class, per-method breakdown.
	 */
	async getProjectDoUsageFromAE(
		projectId: string,
		from: string,
		to: string,
	): Promise<{
		by_class: Array<{
			class_name: string;
			methods: Record<string, { requests: number; wall_time_ms: number }>;
			totals: { requests: number; wall_time_ms: number };
		}>;
		totals: { requests: number; wall_time_ms: number };
	}> {
		const escapedProjectId = this.escapeSQL(projectId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);

		const sql = `
			SELECT
				blob2 AS class_name,
				blob3 AS method,
				SUM(double1 * _sample_interval) AS wall_time_ms,
				SUM(_sample_interval) AS requests
			FROM jack_do_usage
			WHERE index1 = '${escapedProjectId}'
				AND timestamp >= toDateTime('${formattedFrom}')
				AND timestamp <= toDateTime('${formattedTo}')
			GROUP BY blob2, blob3
			ORDER BY wall_time_ms DESC
		`;

		const result = await this.queryAnalyticsEngine(sql);

		// Group by class
		const classMap = new Map<
			string,
			{
				methods: Record<string, { requests: number; wall_time_ms: number }>;
				totals: { requests: number; wall_time_ms: number };
			}
		>();

		let totalRequests = 0;
		let totalWallTime = 0;

		for (const row of result.data) {
			const className = String(row.class_name || "unknown");
			const method = String(row.method || "unknown");
			const requests = Math.round(Number(row.requests) || 0);
			const wallTimeMs = Math.round(Number(row.wall_time_ms) || 0);

			totalRequests += requests;
			totalWallTime += wallTimeMs;

			if (!classMap.has(className)) {
				classMap.set(className, {
					methods: {},
					totals: { requests: 0, wall_time_ms: 0 },
				});
			}

			const entry = classMap.get(className);
			if (entry) {
				entry.methods[method] = { requests, wall_time_ms: wallTimeMs };
				entry.totals.requests += requests;
				entry.totals.wall_time_ms += wallTimeMs;
			}
		}

		const by_class = Array.from(classMap.entries()).map(([class_name, data]) => ({
			class_name,
			...data,
		}));

		return {
			by_class,
			totals: { requests: totalRequests, wall_time_ms: totalWallTime },
		};
	}

	/**
	 * Get Vectorize usage metrics for a project from Analytics Engine.
	 * Queries metering wrapper logs where blob3 = 'vectorize'.
	 *
	 * Schema (from __jack_meter.mjs):
	 * - index1: project_id
	 * - blob1: org_id
	 * - blob2: "free" (tier)
	 * - blob3: "vectorize"
	 * - blob4: index_name
	 * - blob5: operation (query, insert, upsert, deleteByIds, getByIds, describe)
	 * - double1: 1 (call count)
	 * - double2: duration_ms
	 * - double3: vector count (mutations only)
	 */
	async getProjectVectorizeUsage(
		projectId: string,
		from: string,
		to: string,
	): Promise<{
		metrics: VectorizeUsageMetrics;
		by_index: VectorizeUsageByIndex[];
		by_operation: VectorizeUsageByOperation[];
	}> {
		const escapedProjectId = this.escapeSQL(projectId);
		const formattedFrom = this.formatTimestamp(from);
		const formattedTo = this.formatTimestamp(to);
		const whereClause = `index1 = '${escapedProjectId}' AND blob3 = 'vectorize' AND timestamp >= toDateTime('${formattedFrom}') AND timestamp <= toDateTime('${formattedTo}')`;

		const metricsQuery = `
			SELECT
				SUM(_sample_interval) as total_requests,
				AVG(double2) as avg_latency_ms,
				SUM(double3 * _sample_interval) as total_vectors
			FROM jack_usage
			WHERE ${whereClause}
		`;

		const byIndexQuery = `
			SELECT
				blob4 as index_name,
				SUM(_sample_interval) as requests,
				AVG(double2) as avg_latency_ms,
				SUM(double3 * _sample_interval) as vectors
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob4
			ORDER BY requests DESC
		`;

		const byOpQuery = `
			SELECT
				blob5 as operation,
				SUM(_sample_interval) as requests,
				AVG(double2) as avg_latency_ms,
				SUM(double3 * _sample_interval) as vectors
			FROM jack_usage
			WHERE ${whereClause}
			GROUP BY blob5
			ORDER BY requests DESC
		`;

		const [metricsResult, byIndexResult, byOpResult] = await Promise.all([
			this.queryAnalyticsEngine(metricsQuery),
			this.queryAnalyticsEngine(byIndexQuery),
			this.queryAnalyticsEngine(byOpQuery),
		]);

		const row = metricsResult.data[0] || {};
		const totalRequests = Math.round(Number(row.total_requests) || 0);

		const metrics: VectorizeUsageMetrics = {
			total_requests: totalRequests,
			avg_latency_ms: Math.round((Number(row.avg_latency_ms) || 0) * 100) / 100,
			total_vectors: Math.round(Number(row.total_vectors) || 0),
		};

		const by_index: VectorizeUsageByIndex[] = byIndexResult.data.map((r) => {
			const requests = Math.round(Number(r.requests) || 0);
			return {
				index_name: String(r.index_name || "unknown"),
				requests,
				avg_latency_ms: Math.round((Number(r.avg_latency_ms) || 0) * 100) / 100,
				vectors: Math.round(Number(r.vectors) || 0),
				percentage: totalRequests > 0 ? Math.round((requests / totalRequests) * 10000) / 100 : 0,
			};
		});

		const by_operation: VectorizeUsageByOperation[] = byOpResult.data.map((r) => {
			const requests = Math.round(Number(r.requests) || 0);
			return {
				operation: String(r.operation || "unknown"),
				requests,
				avg_latency_ms: Math.round((Number(r.avg_latency_ms) || 0) * 100) / 100,
				vectors: Math.round(Number(r.vectors) || 0),
				percentage: totalRequests > 0 ? Math.round((requests / totalRequests) * 10000) / 100 : 0,
			};
		});

		return { metrics, by_index, by_operation };
	}

	private parseDimensionBreakdown(
		result: AnalyticsEngineQueryResult,
		dimensionKey: string,
	): UsageByDimension[] {
		const total = result.data.reduce((sum, row) => sum + (Number(row.requests) || 0), 0);

		return result.data.map((row) => ({
			dimension: String(row[dimensionKey] || "unknown"),
			requests: Math.round(Number(row.requests) || 0),
			percentage: total > 0 ? Math.round((Number(row.requests) / total) * 10000) / 100 : 0,
		}));
	}

	private escapeSQL(value: string): string {
		// Basic SQL injection prevention - escape single quotes
		return value.replace(/'/g, "''");
	}

	/**
	 * Convert ISO 8601 timestamp to Analytics Engine format.
	 * Analytics Engine expects 'YYYY-MM-DD HH:MM:SS' not ISO 8601.
	 */
	private formatTimestamp(isoString: string): string {
		// Remove 'T', 'Z', and milliseconds
		return isoString
			.replace("T", " ")
			.replace("Z", "")
			.replace(/\.\d{3}$/, "");
	}
}

// GraphQL types
export interface GraphQLResponse {
	data: Record<string, unknown>;
	errors?: Array<{ message: string; path?: string[] }>;
}

// Analytics Engine types
interface AnalyticsEngineQueryResult {
	data: Array<Record<string, unknown>>;
	meta: { name: string; type: string }[];
	rows: number;
	rows_before_limit_at_least: number;
}

export interface UsageMetricsAE {
	requests: number;
	errors: number;
	error_rate: number;
	avg_latency_ms: number;
	bandwidth_in_bytes: number;
	bandwidth_out_bytes: number;
	cache_hit_rate: number;
}

export interface UsageByDimension {
	dimension: string;
	requests: number;
	percentage: number;
}

export interface AIUsageMetrics {
	total_requests: number;
	tokens_in: number;
	tokens_out: number;
	total_tokens: number;
	avg_latency_ms: number;
}

export interface AIUsageByModel {
	model: string;
	requests: number;
	tokens_in: number;
	tokens_out: number;
	total_tokens: number;
	percentage: number;
}

export interface VectorizeUsageMetrics {
	total_requests: number;
	avg_latency_ms: number;
	total_vectors: number;
}

export interface VectorizeUsageByIndex {
	index_name: string;
	requests: number;
	avg_latency_ms: number;
	vectors: number;
	percentage: number;
}

export interface VectorizeUsageByOperation {
	operation: string;
	requests: number;
	avg_latency_ms: number;
	vectors: number;
	percentage: number;
}

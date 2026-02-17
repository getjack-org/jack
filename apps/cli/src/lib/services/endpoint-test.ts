/**
 * Endpoint testing service
 *
 * Makes HTTP requests to deployed workers and optionally captures
 * runtime logs during the request. Used by MCP (test_endpoint tool).
 */

import { readProjectLink } from "../project-link.ts";
import { getProjectStatus } from "../project-operations.ts";

// ============================================================================
// Types
// ============================================================================

export interface TestEndpointOptions {
	/** Path to project directory */
	projectDir: string;
	/** URL path to test, e.g. /api/todos */
	path: string;
	/** HTTP method */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Request headers */
	headers?: Record<string, string>;
	/** Request body (JSON string for POST/PUT/PATCH) */
	body?: string;
	/** Capture runtime logs during the request (managed mode only) */
	includeLogs?: boolean;
}

export interface TestEndpointResult {
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body: string | null;
	};
	response: {
		status: number;
		status_text: string;
		headers: Record<string, string>;
		body: string;
		duration_ms: number;
	};
	logs: LogEntry[];
}

export interface LogEntry {
	level: string;
	message: unknown[];
	timestamp: string;
}

// ============================================================================
// Main Function
// ============================================================================

const REQUEST_TIMEOUT_MS = 30_000;
const LOG_SETTLE_DELAY_MS = 500;
const LOG_FLUSH_DELAY_MS = 1_500;
const LOG_COLLECT_DURATION_MS = 3_000;
const MAX_RESPONSE_BODY_SIZE = 1_000_000; // 1MB

/**
 * Test a deployed endpoint by making an HTTP request and optionally capturing logs.
 */
export async function testEndpoint(options: TestEndpointOptions): Promise<TestEndpointResult> {
	const { projectDir, path, method = "GET", headers = {}, body, includeLogs = true } = options;

	// 1. Resolve project URL
	const link = await readProjectLink(projectDir);
	const status = await getProjectStatus(undefined, projectDir);

	if (!status?.workerUrl) {
		throw new Error("Project has no deployed URL. Deploy first with 'jack ship'.");
	}

	const baseUrl = status.workerUrl.replace(/\/$/, "");
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;

	// Validate path stays on the same origin (prevent URL manipulation)
	const resolvedUrl = new URL(normalizedPath, baseUrl);
	if (resolvedUrl.origin !== new URL(baseUrl).origin) {
		throw new Error("Path must not redirect to a different host");
	}
	const fullUrl = resolvedUrl.href;

	// 2. Optionally start log session (managed only)
	let logSessionCleanup: (() => void) | null = null;
	let logCollector: Promise<LogEntry[]> | null = null;

	const isManaged = link?.deploy_mode === "managed" && link.project_id;
	if (includeLogs && isManaged) {
		const logResult = await startLogCollection(link.project_id);
		logSessionCleanup = logResult.cleanup;
		logCollector = logResult.collector;

		// Small delay for SSE connection to establish
		await sleep(LOG_SETTLE_DELAY_MS);
	}

	// 3. Make the HTTP request
	const requestHeaders: Record<string, string> = { ...headers };
	if (body && !requestHeaders["content-type"]) {
		requestHeaders["content-type"] = "application/json";
	}

	const requestStart = Date.now();
	let response: Response;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		response = await fetch(fullUrl, {
			method,
			headers: requestHeaders,
			body: body || undefined,
			signal: controller.signal,
			redirect: "follow",
		});

		clearTimeout(timeout);
	} catch (error) {
		logSessionCleanup?.();
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
		}
		throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const durationMs = Date.now() - requestStart;

	// 4. Read response + collect logs, ensuring cleanup on any failure
	try {
		const rawBody = await response.text();
		// Truncate large responses to prevent MCP message bloat (1MB limit)
		const responseBody =
			rawBody.length > MAX_RESPONSE_BODY_SIZE
				? `${rawBody.slice(0, MAX_RESPONSE_BODY_SIZE)}\n... [truncated, ${rawBody.length} bytes total]`
				: rawBody;
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		// 5. Collect logs if started
		let logs: LogEntry[] = [];
		if (logCollector) {
			// Wait for logs to flush from the worker
			await sleep(LOG_FLUSH_DELAY_MS);
			logSessionCleanup?.();
			logSessionCleanup = null;
			logs = await logCollector;
		}

		return {
			request: {
				method,
				url: fullUrl,
				headers: requestHeaders,
				body: body ?? null,
			},
			response: {
				status: response.status,
				status_text: response.statusText,
				headers: responseHeaders,
				body: responseBody,
				duration_ms: durationMs,
			},
			logs,
		};
	} finally {
		// Ensure log session is always cleaned up
		logSessionCleanup?.();
	}
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Start collecting logs from a managed project's SSE stream.
 * Returns a collector promise that resolves with accumulated log entries
 * and a cleanup function to stop the stream.
 */
async function startLogCollection(
	projectId: string,
): Promise<{ collector: Promise<LogEntry[]>; cleanup: () => void }> {
	const { startLogSession, getControlApiUrl } = await import("../control-plane.ts");
	const { authFetch } = await import("../auth/index.ts");

	const session = await startLogSession(projectId, "endpoint-test");
	const streamUrl = `${getControlApiUrl()}${session.stream.url}`;

	const controller = new AbortController();
	const cleanup = () => controller.abort();

	const collector = collectLogEvents(streamUrl, controller, authFetch);

	return { collector, cleanup };
}

/**
 * Read log events from an SSE stream until aborted or timeout.
 */
async function collectLogEvents(
	streamUrl: string,
	controller: AbortController,
	authFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<LogEntry[]> {
	const events: LogEntry[] = [];

	// Auto-timeout for safety
	const timeout = setTimeout(() => controller.abort(), LOG_COLLECT_DURATION_MS);

	try {
		const response = await authFetch(streamUrl, {
			method: "GET",
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			return events;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data) continue;

				try {
					const parsed = JSON.parse(data) as {
						type?: string;
						level?: string;
						message?: unknown[];
						timestamp?: string;
					};
					if (parsed.type === "event") {
						events.push({
							level: parsed.level ?? "log",
							message: parsed.message ?? [],
							timestamp: parsed.timestamp ?? new Date().toISOString(),
						});
					}
				} catch {}
			}
		}
	} catch (error) {
		// Abort is normal (cleanup or timeout). Non-abort errors: return whatever we collected.
		if (error instanceof Error && error.name !== "AbortError") {
			// Silently swallow — partial logs are better than no response
		}
	} finally {
		clearTimeout(timeout);
	}

	return events;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

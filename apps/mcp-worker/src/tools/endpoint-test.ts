import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

const MAX_BODY_LENGTH = 4_000;
const TIMEOUT_MS = 10_000;

export async function testEndpoint(
	client: ControlPlaneClient,
	projectId: string,
	path: string,
	method?: string,
): Promise<McpToolResult> {
	let projectUrl: string;
	try {
		const { url } = await client.getProject(projectId);
		projectUrl = url;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err("NOT_FOUND", `Could not get project URL: ${message}`);
	}

	// Normalize path
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const fullUrl = `${projectUrl}${normalizedPath}`;
	const httpMethod = (method || "GET").toUpperCase();

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

		const response = await fetch(fullUrl, {
			method: httpMethod,
			signal: controller.signal,
			redirect: "follow",
		});
		clearTimeout(timeout);

		const headers: Record<string, string> = {};
		for (const [key, value] of response.headers.entries()) {
			// Only include useful headers
			if (
				["content-type", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"].includes(
					key.toLowerCase(),
				)
			) {
				headers[key] = value;
			}
		}

		let body: string;
		const contentType = response.headers.get("content-type") || "";
		if (contentType.includes("json") || contentType.includes("text")) {
			const text = await response.text();
			body = text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH)}... (truncated)` : text;
		} else {
			body = `[Binary content: ${contentType}, ${response.headers.get("content-length") || "unknown"} bytes]`;
		}

		return ok({
			url: fullUrl,
			method: httpMethod,
			status: response.status,
			status_text: response.statusText,
			headers,
			body,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("abort")) {
			return err("TIMEOUT", `Request to ${fullUrl} timed out after ${TIMEOUT_MS / 1000}s.`);
		}
		return err("FETCH_FAILED", `Request to ${fullUrl} failed: ${message}`);
	}
}

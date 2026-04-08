import { basename } from "node:path";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { authFetch } from "../../lib/auth/index.ts";
import { getControlApiUrl, startLogSession } from "../../lib/control-plane.ts";
import { getDeployMode, getProjectId } from "../../lib/project-link.ts";
import type { DebugLogger, McpServerOptions } from "../types.ts";

export interface LogEvent {
	type: string;
	ts: number;
	outcome: string | null;
	request: { method?: string; url?: string } | null;
	logs: Array<{ ts: number | null; level: string | null; message: unknown[] }>;
	exceptions: Array<{
		ts: number | null;
		name: string | null;
		message: string | null;
	}>;
}

const ERROR_OUTCOMES = new Set([
	"exception",
	"exceededCpu",
	"exceededMemory",
	"exceededWallTime",
	"scriptNotFound",
]);

/** Determine whether a log event should trigger a channel notification. */
export function shouldEmitChannelNotification(event: LogEvent): boolean {
	if (event.exceptions.length > 0) return true;
	if (event.logs.some((l) => l.level === "error")) return true;
	if (event.outcome && ERROR_OUTCOMES.has(event.outcome)) return true;
	return false;
}

/**
 * Format a log event into channel notification content and metadata.
 */
export function formatChannelContent(event: LogEvent): {
	content: string;
	meta: Record<string, string>;
} {
	const parts: string[] = [];

	for (const exc of event.exceptions) {
		parts.push(`${exc.name ?? "Error"}: ${exc.message ?? "Unknown error"}`);
	}
	for (const log of event.logs) {
		if (log.level === "error") {
			parts.push(log.message.map(String).join(" "));
		}
	}
	// For resource-limit outcomes with no exceptions/error logs, describe the outcome
	if (parts.length === 0 && event.outcome && ERROR_OUTCOMES.has(event.outcome)) {
		parts.push(`Worker ${event.outcome}`);
	}
	if (event.request) {
		parts.push(`Request: ${event.request.method ?? "?"} ${event.request.url ?? "?"}`);
	}

	const eventType = event.exceptions.length > 0 ? "exception" : "error";

	return {
		content: parts.join("\n"),
		meta: {
			event: eventType,
			outcome: event.outcome ?? "unknown",
		},
	};
}

/**
 * Subscribe to a project's real-time log stream and emit channel notifications
 * for errors and exceptions. Runs until the server closes, with reconnect-on-failure.
 *
 * Only works for managed (Jack Cloud) projects — silently skips BYO projects.
 * Deduplicates repeated errors within a 60-second window to avoid flooding Claude's context.
 */
export async function startChannelLogSubscriber(
	server: McpServer,
	options: McpServerOptions,
	debug: DebugLogger,
): Promise<void> {
	const projectPath = options.projectPath ?? process.cwd();

	const deployMode = await getDeployMode(projectPath).catch(() => null);
	if (deployMode !== "managed") {
		debug("Channel log subscriber: not a managed project, skipping");
		return;
	}

	const projectId = await getProjectId(projectPath);
	if (!projectId) {
		debug("Channel log subscriber: no project ID found, skipping");
		return;
	}

	const projectName = basename(projectPath);

	debug("Channel log subscriber: starting", { projectId, projectName });

	// Abort when the server closes so the process can exit cleanly
	const abortController = new AbortController();
	server.onclose = () => abortController.abort();

	// Deduplicate: suppress identical error messages within a 60s window
	const DEDUP_WINDOW_MS = 60_000;
	const recentErrors = new Map<string, { count: number; firstSeen: number }>();

	function isDuplicate(content: string): boolean {
		const now = Date.now();
		// Prune expired entries
		for (const [key, entry] of recentErrors) {
			if (now - entry.firstSeen > DEDUP_WINDOW_MS) {
				recentErrors.delete(key);
			}
		}
		const existing = recentErrors.get(content);
		if (existing) {
			existing.count++;
			return true;
		}
		recentErrors.set(content, { count: 1, firstSeen: now });
		return false;
	}

	let backoff = 5000;
	const maxBackoff = 60000;

	while (!abortController.signal.aborted) {
		try {
			const session = await startLogSession(projectId, "channel");
			const streamUrl = `${getControlApiUrl()}${session.stream.url}`;

			debug("Channel log subscriber: connected to SSE stream");
			backoff = 5000;

			const response = await authFetch(streamUrl, {
				method: "GET",
				headers: { Accept: "text/event-stream" },
				signal: abortController.signal,
			});

			if (!response.ok || !response.body) {
				throw new Error(`Failed to open log stream: ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (!abortController.signal.aborted) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (!data) continue;

					let parsed: LogEvent | null = null;
					try {
						parsed = JSON.parse(data) as LogEvent;
					} catch {
						continue;
					}

					if (parsed?.type !== "event") continue;
					if (!shouldEmitChannelNotification(parsed)) continue;

					const { content, meta } = formatChannelContent(parsed);

					if (isDuplicate(content)) {
						debug("Channel: suppressed duplicate error", { content: content.slice(0, 80) });
						continue;
					}

					await server.notification({
						method: "notifications/claude/channel",
						params: {
							content,
							meta: { ...meta, project: projectName },
						},
					});

					debug("Channel: emitted error notification", {
						event: meta.event,
						project: projectName,
					});
				}
			}
		} catch (err) {
			if (abortController.signal.aborted) break;
			debug("Channel log subscriber: connection error, retrying", {
				error: String(err),
				backoff,
			});
		}

		if (abortController.signal.aborted) break;
		await new Promise((r) => setTimeout(r, backoff));
		backoff = Math.min(backoff * 1.5, maxBackoff);
	}

	debug("Channel log subscriber: stopped");
}

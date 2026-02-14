import type { ControlPlaneClient } from "../control-plane.ts";
import { type McpToolResult, err, ok } from "../utils.ts";

export async function getLogs(
	client: ControlPlaneClient,
	projectId: string,
): Promise<McpToolResult> {
	const sessionResult = await client.startLogSession(projectId);

	if (!sessionResult.success || !sessionResult.stream?.url) {
		return err("INTERNAL_ERROR", "Failed to start log session");
	}

	const logs: string[] = [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);

	try {
		const response = await client.fetchStream(sessionResult.stream.url, controller.signal);

		if (!response.ok || !response.body) {
			clearTimeout(timeout);
			return ok({
				session_id: sessionResult.session.id,
				logs: [],
				note: "Log stream started but no entries yet. Logs appear when the worker receives requests.",
			});
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const lines = chunk.split("\n");

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data && data !== "[DONE]") {
							logs.push(data);
						}
					}
				}

				if (logs.length >= 50) break;
			}
		} catch {
			// AbortError expected after timeout
		} finally {
			reader.releaseLock();
		}
	} catch {
		// AbortError or network error — return whatever we collected
	} finally {
		clearTimeout(timeout);
	}

	return ok({
		session_id: sessionResult.session.id,
		logs,
	});
}

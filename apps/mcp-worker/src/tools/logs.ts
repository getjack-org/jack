import type { ControlPlaneClient } from "../control-plane.ts";

export async function getLogs(
	client: ControlPlaneClient,
	projectId: string,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const sessionResult = await client.startLogSession(projectId);

	if (!sessionResult.success || !sessionResult.stream?.url) {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						success: false,
						error: "Failed to start log session",
					}),
				},
			],
		};
	}

	// Collect logs from SSE stream for a short window
	const logs: string[] = [];
	const controller = new AbortController();

	// Collect for up to 5 seconds
	const timeout = setTimeout(() => controller.abort(), 5000);

	try {
		const response = await fetch(sessionResult.stream.url, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			clearTimeout(timeout);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							data: {
								session_id: sessionResult.session.id,
								logs: [],
								note: "Log stream started but no entries yet. Logs appear when the worker receives requests.",
							},
						}),
					},
				],
			};
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

				// Cap at 50 entries
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

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						success: true,
						data: {
							session_id: sessionResult.session.id,
							log_count: logs.length,
							logs,
						},
					},
					null,
					2,
				),
			},
		],
	};
}

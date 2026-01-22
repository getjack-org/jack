import { existsSync } from "node:fs";
import { output } from "../lib/output.ts";
import { getDeployMode, getProjectId } from "../lib/project-link.ts";
import { authFetch } from "../lib/auth/index.ts";
import { getControlApiUrl, startLogSession } from "../lib/control-plane.ts";

// Lines containing these strings will be filtered out
const FILTERED_PATTERNS = ["⛅️ wrangler"];

const shouldFilter = (line: string) => FILTERED_PATTERNS.some((pattern) => line.includes(pattern));

export interface LogsOptions {
	label?: string;
}

async function streamManagedLogs(projectId: string, label?: string): Promise<void> {
	const session = await startLogSession(projectId, label);
	const streamUrl = `${getControlApiUrl()}${session.stream.url}`;

	output.info(`Log session active until ${session.session.expires_at}`);
	output.info("Streaming logs (JSON). Press Ctrl+C to stop.\n");

	const response = await authFetch(streamUrl, {
		method: "GET",
		headers: { Accept: "text/event-stream" },
	});

	if (!response.ok || !response.body) {
		const err = (await response.json().catch(() => ({ message: "Failed to open log stream" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Failed to open log stream: ${response.status}`);
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
				const parsed = JSON.parse(data) as { type?: string };
				if (parsed.type === "heartbeat") continue;
			} catch {
				// If it's not JSON, pass through.
			}
			process.stdout.write(`${data}\n`);
		}
	}
}

export default async function logs(options: LogsOptions = {}): Promise<void> {
	// Check if this is a managed project (read from .jack/project.json)
	const deployMode = await getDeployMode(process.cwd());
	if (deployMode === "managed") {
		const projectId = await getProjectId(process.cwd());
		if (!projectId) {
			output.error("No .jack/project.json found");
			output.info("Run this from a linked jack cloud project directory");
			process.exit(1);
		}

		try {
			await streamManagedLogs(projectId, options.label);
			return;
		} catch (err) {
			output.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}

	// BYOC requires a wrangler config in the working directory.
	const hasWranglerJson = existsSync("wrangler.jsonc") || existsSync("wrangler.json");
	const hasWranglerToml = existsSync("wrangler.toml");

	if (!hasWranglerJson && !hasWranglerToml) {
		output.error("No wrangler config found");
		output.info("Run this from a jack project directory");
		process.exit(1);
	}

	// BYOC project - use wrangler tail
	output.info("Streaming logs from Cloudflare Worker...");
	output.info("Press Ctrl+C to stop\n");

	// Run wrangler tail and filter out noisy lines
	const proc = Bun.spawn(["wrangler", "tail", "--format", "pretty"], {
		stdout: "pipe",
		stderr: "pipe",
	});

	// Filter and forward stdout
	const filterStream = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (shouldFilter(line)) continue;
				target.write(`${line}\n`);
			}
		}

		// Flush remaining buffer
		if (buffer && !shouldFilter(buffer)) {
			target.write(buffer);
		}
	};

	await Promise.all([
		filterStream(proc.stdout, process.stdout),
		filterStream(proc.stderr, process.stderr),
	]);

	await proc.exited;
}

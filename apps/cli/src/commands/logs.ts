import { existsSync } from "node:fs";
import { output } from "../lib/output.ts";
import { getDeployMode } from "../lib/project-link.ts";

// Lines containing these strings will be filtered out
const FILTERED_PATTERNS = ["⛅️ wrangler"];

const shouldFilter = (line: string) => FILTERED_PATTERNS.some((pattern) => line.includes(pattern));

export default async function logs(): Promise<void> {
	// Check for wrangler config
	const hasWranglerJson = existsSync("wrangler.jsonc") || existsSync("wrangler.json");
	const hasWranglerToml = existsSync("wrangler.toml");

	if (!hasWranglerJson && !hasWranglerToml) {
		output.error("No wrangler config found");
		output.info("Run this from a jack project directory");
		process.exit(1);
	}

	// Check if this is a managed project (read from .jack/project.json)
	const deployMode = await getDeployMode(process.cwd());
	if (deployMode === "managed") {
		output.warn("Real-time logs not yet available for managed projects");
		output.info("Logs are being collected - web UI coming soon");
		output.info("Track progress: https://github.com/getjack-org/jack/issues/2");
		return;
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

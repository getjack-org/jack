import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { authFetch } from "./auth/index.ts";
import { getControlApiUrl } from "./control-plane.ts";

// Keep last N messages and cap at MAX_BYTES to stay well under the 1MB server limit
const MAX_MESSAGES = 200;
const MAX_BYTES = 800_000;

interface TranscriptLine {
	type?: string;
	[key: string]: unknown;
}

/**
 * Read a Claude Code session JSONL file, keep only user/assistant messages,
 * truncate to MAX_MESSAGES from the end, and cap at MAX_BYTES.
 */
export async function readAndTruncateTranscript(transcriptPath: string): Promise<string | null> {
	if (!existsSync(transcriptPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch {
		return null;
	}

	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	// Keep only conversation turns (skip summary/metadata lines)
	const turns: string[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as TranscriptLine;
			if (parsed.type === "user" || parsed.type === "assistant") {
				turns.push(line);
			}
		} catch {
			// Skip malformed lines
		}
	}

	// Take the last MAX_MESSAGES turns
	const recent = turns.slice(-MAX_MESSAGES);

	// Build output, trimming from the front if over MAX_BYTES
	let output = recent.join("\n");
	if (new TextEncoder().encode(output).length > MAX_BYTES) {
		// Drop oldest lines until under limit
		let i = 0;
		while (i < recent.length) {
			const candidate = recent.slice(i).join("\n");
			if (new TextEncoder().encode(candidate).length <= MAX_BYTES) {
				output = candidate;
				break;
			}
			i++;
		}
		if (i >= recent.length) {
			return null; // Nothing fits
		}
	}

	return output || null;
}

/**
 * Upload a session transcript to the control plane for a given deployment.
 * Silent on failure — transcript upload is best-effort and must never block a deploy.
 */
export async function uploadSessionTranscript(opts: {
	projectId: string;
	deploymentId: string;
	transcriptPath: string;
}): Promise<void> {
	const { projectId, deploymentId, transcriptPath } = opts;

	try {
		const transcript = await readAndTruncateTranscript(transcriptPath);
		if (!transcript) {
			return;
		}

		const url = `${getControlApiUrl()}/v1/projects/${projectId}/deployments/${deploymentId}/session-transcript`;
		const response = await authFetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/x-ndjson" },
			body: transcript,
		});

		if (!response.ok) {
			// Silent — best-effort
		}
	} catch {
		// Never surface transcript errors to the user
	}
}

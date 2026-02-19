import { existsSync, readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authFetch } from "./auth/index.ts";
import { getControlApiUrl } from "./control-plane.ts";
import { readProjectLink, updateProjectLink } from "./project-link.ts";

// Keep last N messages and cap at MAX_BYTES to stay well under the 1MB server limit
const MAX_MESSAGES = 200;
const MAX_BYTES = 800_000;

interface TranscriptLine {
	type?: string;
	[key: string]: unknown;
}

/**
 * Find the transcript path for the current session.
 *
 * Resolution order:
 * 1. CLAUDE_TRANSCRIPT_PATH env var (works if CLAUDE_ENV_FILE ever gets fixed)
 * 2. Filesystem discovery when running inside Claude Code (CLAUDECODE=1)
 *    — finds the most recently modified .jsonl in ~/.claude/projects/<encoded-path>/
 *
 * Returns null when not running inside Claude Code or no transcript found.
 */
export function findTranscriptPath(projectDir: string): string | null {
	// 1. Env var (works if CLAUDE_ENV_FILE gets fixed upstream, or set manually)
	if (process.env.CLAUDE_TRANSCRIPT_PATH) {
		return process.env.CLAUDE_TRANSCRIPT_PATH;
	}

	// 2. Filesystem discovery — only when running inside Claude Code
	if (process.env.CLAUDECODE !== "1") {
		return null;
	}

	try {
		const absPath = resolve(projectDir);
		// Claude Code encodes project paths by replacing both "/" and "." with "-"
		const encoded = absPath.replaceAll("/", "-").replaceAll(".", "-");
		const dir = join(homedir(), ".claude", "projects", encoded);

		if (!existsSync(dir)) return null;

		// Find the most recently modified .jsonl file
		const entries = readdirSync(dir);
		let newest: { path: string; mtime: number } | null = null;

		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const full = join(dir, entry);
			try {
				const s = statSync(full);
				if (!s.isFile()) continue;
				if (!newest || s.mtimeMs > newest.mtime) {
					newest = { path: full, mtime: s.mtimeMs };
				}
			} catch {
				continue;
			}
		}

		return newest?.path ?? null;
	} catch {
		return null;
	}
}

/**
 * Read only new transcript content since the last upload.
 * Returns the filtered JSONL string and the new byte offset, or null if nothing new.
 */
export async function readDeltaTranscript(
	transcriptPath: string,
	lastByteOffset: number,
): Promise<{ transcript: string; newByteOffset: number } | null> {
	if (!existsSync(transcriptPath)) {
		return null;
	}

	let fileSize: number;
	try {
		const fileStat = await stat(transcriptPath);
		fileSize = fileStat.size;
	} catch {
		return null;
	}

	// If offset is beyond file size, file was replaced — reset to 0
	let offset = lastByteOffset;
	if (offset > fileSize) {
		offset = 0;
	}

	// Nothing new since last upload
	if (offset >= fileSize) {
		return null;
	}

	let raw: string;
	try {
		const file = Bun.file(transcriptPath);
		// Bound the slice to fileSize so the read is consistent with the recorded offset.
		// Without the upper bound, appends between stat() and read would be read
		// but not reflected in newByteOffset, causing duplicate turns on next deploy.
		const slice = file.slice(offset, fileSize);
		raw = await slice.text();
	} catch {
		return null;
	}

	const lines = raw.split("\n").filter(Boolean);

	// Filter to user/assistant turns, skipping partial first line at slice boundary
	const turns: string[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line.trim()) as TranscriptLine;
			if (parsed.type === "user" || parsed.type === "assistant") {
				turns.push(line.trim());
			}
		} catch {
			// Skip malformed/partial lines (e.g. partial first line at slice boundary)
		}
	}

	if (turns.length === 0) {
		return { transcript: "", newByteOffset: fileSize };
	}

	// Apply same caps as full transcript
	const recent = turns.slice(-MAX_MESSAGES);

	let output = recent.join("\n");
	if (new TextEncoder().encode(output).length > MAX_BYTES) {
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
			return null;
		}
	}

	return { transcript: output, newByteOffset: fileSize };
}

/**
 * Upload only new transcript content since the last deploy.
 * Tracks byte offset in .jack/project.json so each deploy gets only its delta.
 * Silent on failure — must never block a deploy.
 */
export async function uploadDeltaSessionTranscript(opts: {
	projectId: string;
	deploymentId: string;
	transcriptPath: string;
	projectDir: string;
}): Promise<void> {
	const { projectId, deploymentId, transcriptPath, projectDir } = opts;

	try {
		const link = await readProjectLink(projectDir);
		if (!link) return;

		// Determine byte offset: reset to 0 if transcript path changed (new session)
		let lastOffset = 0;
		if (link.last_transcript_path === transcriptPath && link.last_transcript_byte_offset != null) {
			lastOffset = link.last_transcript_byte_offset;
		}

		const delta = await readDeltaTranscript(transcriptPath, lastOffset);
		if (!delta) return;

		// Skip upload if delta is empty (no new turns), but still advance offset
		if (delta.transcript) {
			const url = `${getControlApiUrl()}/v1/projects/${projectId}/deployments/${deploymentId}/session-transcript`;
			const response = await authFetch(url, {
				method: "PUT",
				headers: { "Content-Type": "application/x-ndjson" },
				body: delta.transcript,
			});

			if (!response.ok) {
				// Upload failed — don't persist offset so next deploy retries
				return;
			}
		}

		// Persist offset only on success
		await updateProjectLink(projectDir, {
			last_transcript_path: transcriptPath,
			last_transcript_byte_offset: delta.newByteOffset,
		});
	} catch {
		// Never surface transcript errors to the user
	}
}

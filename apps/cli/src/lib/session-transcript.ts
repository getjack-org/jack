import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { authFetch } from "./auth/index.ts";
import { getControlApiUrl } from "./control-plane.ts";
import { readProjectLink, updateProjectLink } from "./project-link.ts";
import { redactSensitiveData } from "./redact.ts";
import {
	detectTranscriptSource,
	findAnyTranscriptPath,
	getTranscriptAdapterById,
} from "./transcript-adapters/index.ts";
import {
	type AdapterCheckpoint,
	CANONICAL_EVENT_SCHEMA,
	type TranscriptSource,
} from "./transcript-adapters/types.ts";

// Legacy caps kept for backward-compatible readDeltaTranscript behavior used in tests.
const MAX_MESSAGES = 200;
const MAX_LEGACY_BYTES = 800_000;
const MAX_UPLOAD_BYTES = 1_000_000;
const MAX_DELTA_READ_ATTEMPTS = 5;
const DELTA_READ_RETRY_MS = 700;

interface TranscriptLine {
	type?: string;
	[key: string]: unknown;
}

interface TranscriptCheckpointRecord {
	source_id: string;
	cursor: string;
	updated_at: string;
}

interface TranscriptSessionCheckpointRecord extends TranscriptCheckpointRecord {
	provider_session_id: string | null;
}

interface TranscriptStats {
	event_count: number;
	message_count: number;
	tool_call_count: number;
	tool_result_count: number;
	reasoning_count: number;
	other_event_count: number;
	turn_count: number;
	user_turn_count: number;
	assistant_turn_count: number;
	first_turn_at: string | null;
	last_turn_at: string | null;
}

interface TranscriptUploadPayload {
	schema_version: "jack.transcript-upload.v1";
	provider: string;
	provider_session_id?: string | null;
	canonical_format: typeof CANONICAL_EVENT_SCHEMA;
	canonical_ndjson: string;
	raw_ndjson?: string;
	stats: TranscriptStats;
}

/**
 * Find transcript path for the current coding session (Claude or Codex).
 * Returns null when not running in a supported provider environment.
 */
export function findTranscriptPath(projectDir: string): string | null {
	return findAnyTranscriptPath(projectDir);
}

/**
 * Backward-compatible helper for reading user/assistant delta from a transcript JSONL file.
 * This is retained for existing tests and legacy behavior compatibility.
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
		fileSize = (await stat(transcriptPath)).size;
	} catch {
		return null;
	}

	let offset = lastByteOffset;
	if (offset > fileSize) {
		offset = 0;
	}
	if (offset >= fileSize) {
		return null;
	}

	let raw: string;
	try {
		raw = await Bun.file(transcriptPath).slice(offset, fileSize).text();
	} catch {
		return null;
	}

	const lines = raw.split("\n").filter(Boolean);
	const turns: string[] = [];

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line.trim()) as TranscriptLine;
			if (parsed.type === "user" || parsed.type === "assistant") {
				turns.push(redactSensitiveData(line.trim()));
			}
		} catch {
			// Skip malformed/partial lines.
		}
	}

	if (turns.length === 0) {
		return { transcript: "", newByteOffset: fileSize };
	}

	const recent = turns.slice(-MAX_MESSAGES);
	const output = keepTailWithinBytes(recent, MAX_LEGACY_BYTES).join("\n");
	if (!output) {
		return { transcript: "", newByteOffset: fileSize };
	}

	return { transcript: output, newByteOffset: fileSize };
}

function normalizeTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return null;
	return new Date(parsed).toISOString();
}

function parseStatsFromCanonicalLines(lines: string[]): TranscriptStats {
	const stats: TranscriptStats = {
		event_count: 0,
		message_count: 0,
		tool_call_count: 0,
		tool_result_count: 0,
		reasoning_count: 0,
		other_event_count: 0,
		turn_count: 0,
		user_turn_count: 0,
		assistant_turn_count: 0,
		first_turn_at: null,
		last_turn_at: null,
	};

	let firstTsMs: number | null = null;
	let lastTsMs: number | null = null;

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.type !== "string" || parsed.type.length === 0) continue;

			stats.event_count++;
			if (parsed.type === "user" || parsed.type === "assistant" || parsed.type === "message") {
				stats.message_count++;
			} else if (parsed.type === "tool_call") {
				stats.tool_call_count++;
			} else if (parsed.type === "tool_result") {
				stats.tool_result_count++;
			} else if (parsed.type === "reasoning") {
				stats.reasoning_count++;
			} else {
				stats.other_event_count++;
			}

			if (parsed.type === "user" || parsed.type === "assistant") {
				if (parsed.message) {
					stats.turn_count++;
					if (parsed.type === "user") stats.user_turn_count++;
					if (parsed.type === "assistant") stats.assistant_turn_count++;
				}
			}

			const meta = parsed.meta as Record<string, unknown> | undefined;
			const ts = normalizeTimestamp(meta?.timestamp);
			if (!ts) continue;
			const tsMs = Date.parse(ts);
			if (Number.isNaN(tsMs)) continue;

			if (firstTsMs == null || tsMs < firstTsMs) {
				firstTsMs = tsMs;
				stats.first_turn_at = new Date(tsMs).toISOString();
			}
			if (lastTsMs == null || tsMs > lastTsMs) {
				lastTsMs = tsMs;
				stats.last_turn_at = new Date(tsMs).toISOString();
			}
		} catch {
			// Ignore malformed lines.
		}
	}

	return stats;
}

function keepTailWithinBytes(lines: string[], maxBytes: number): string[] {
	if (lines.length === 0) return [];

	const encoder = new TextEncoder();
	const kept: string[] = [];
	let totalBytes = 0;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line == null) continue;
		const lineBytes = encoder.encode(line).length;
		const delimiterBytes = kept.length > 0 ? 1 : 0; // newline between lines
		if (totalBytes + lineBytes + delimiterBytes > maxBytes) {
			break;
		}
		kept.unshift(line);
		totalBytes += lineBytes + delimiterBytes;
	}

	return kept;
}

function getCheckpoint(
	adapterId: string,
	source: TranscriptSource,
	link: Awaited<ReturnType<typeof readProjectLink>>,
): AdapterCheckpoint | null {
	if (!link) return null;

	const typedSessionCheckpoints = link.transcript_session_checkpoints as
		| Record<string, Record<string, TranscriptSessionCheckpointRecord>>
		| undefined;
	const sessionExisting = typedSessionCheckpoints?.[adapterId]?.[source.sessionKey];
	if (sessionExisting) {
		return {
			sourceId: sessionExisting.source_id,
			cursor: sessionExisting.cursor,
			updatedAt: sessionExisting.updated_at,
		};
	}

	const typedCheckpoints = link.transcript_checkpoints as
		| Record<string, TranscriptCheckpointRecord>
		| undefined;
	const existing = typedCheckpoints?.[adapterId];
	if (existing && existing.source_id === source.sourceId) {
		return {
			sourceId: existing.source_id,
			cursor: existing.cursor,
			updatedAt: existing.updated_at,
		};
	}

	// Legacy fallback for file-based cursor compatibility.
	if (
		link.last_transcript_path === source.sourceId &&
		link.last_transcript_byte_offset != null
	) {
		return {
			sourceId: source.sourceId,
			cursor: String(link.last_transcript_byte_offset),
		};
	}

	return null;
}

async function persistCheckpoint(opts: {
	projectDir: string;
	adapterId: string;
	source: TranscriptSource;
	cursor: string;
}): Promise<void> {
	const { projectDir, adapterId, source, cursor } = opts;
	const existing = await readProjectLink(projectDir);
	if (!existing) return;

	const currentSessionCheckpoints = (existing.transcript_session_checkpoints ?? {}) as Record<
		string,
		Record<string, TranscriptSessionCheckpointRecord>
	>;
	const current = (existing.transcript_checkpoints ?? {}) as Record<
		string,
		TranscriptCheckpointRecord
	>;
	const updatedSessionCheckpoints: Record<string, Record<string, TranscriptSessionCheckpointRecord>> =
		{
			...currentSessionCheckpoints,
			[adapterId]: {
				...(currentSessionCheckpoints[adapterId] ?? {}),
				[source.sessionKey]: {
					provider_session_id: source.providerSessionId,
					source_id: source.sourceId,
					cursor,
					updated_at: new Date().toISOString(),
				},
			},
		};
	const updatedCheckpoints: Record<string, TranscriptCheckpointRecord> = {
		...current,
		[adapterId]: {
			source_id: source.sourceId,
			cursor,
			updated_at: new Date().toISOString(),
		},
	};

	const updates: Record<string, unknown> = {
		transcript_session_checkpoints: updatedSessionCheckpoints,
		transcript_checkpoints: updatedCheckpoints,
	};

	// Dual-write legacy cursor fields for compatibility with existing state.
	const parsedCursor = Number.parseInt(cursor, 10);
	if (!Number.isNaN(parsedCursor) && parsedCursor >= 0) {
		updates.last_transcript_path = source.sourceId;
		updates.last_transcript_byte_offset = parsedCursor;
	}

	await updateProjectLink(projectDir, updates);
}

/**
 * Upload only new transcript content since the last deploy.
 * Uses adapter checkpoints in .jack/project.json and keeps legacy fields in sync.
 * Silent on failure — transcript upload must never block deploy.
 */
export async function uploadDeltaSessionTranscript(opts: {
	projectId: string;
	deploymentId: string;
	transcriptPath?: string;
	projectDir: string;
}): Promise<void> {
	const { projectId, deploymentId, transcriptPath, projectDir } = opts;

	try {
		const link = await readProjectLink(projectDir);
		if (!link) return;

		const source = await detectTranscriptSource(projectDir, transcriptPath);
		if (!source) return;

		const adapter = getTranscriptAdapterById(source.adapterId);
		if (!adapter) return;

		const checkpoint = getCheckpoint(adapter.id, source, link);

		let delta = await adapter.readDelta(source, checkpoint);
		if (!delta || delta.canonicalEvents.length === 0) {
			for (let attempt = 1; attempt < MAX_DELTA_READ_ATTEMPTS; attempt++) {
				await Bun.sleep(DELTA_READ_RETRY_MS);
				delta = await adapter.readDelta(source, checkpoint);
				if (delta && delta.canonicalEvents.length > 0) {
					break;
				}
			}
		}

		if (!delta) return;
		if (delta.canonicalEvents.length === 0) {
			await persistCheckpoint({
				projectDir,
				adapterId: adapter.id,
				source,
				cursor: delta.cursor,
			});
			return;
		}

		const canonicalLines = keepTailWithinBytes(
			delta.canonicalEvents.map((event) => JSON.stringify(event)),
			MAX_UPLOAD_BYTES,
		);

		// All canonical events exceeded upload byte cap: advance checkpoint.
		if (canonicalLines.length === 0) {
			await persistCheckpoint({
				projectDir,
				adapterId: adapter.id,
				source,
				cursor: delta.cursor,
			});
			return;
		}

		const rawLines = keepTailWithinBytes(delta.rawLines, MAX_UPLOAD_BYTES);
		const canonicalNdjson = canonicalLines.join("\n");
		const rawNdjson = rawLines.join("\n");
		const stats = parseStatsFromCanonicalLines(canonicalLines);

		const payload: TranscriptUploadPayload = {
			schema_version: "jack.transcript-upload.v1",
			provider: adapter.id,
			canonical_format: CANONICAL_EVENT_SCHEMA,
			canonical_ndjson: canonicalNdjson,
			stats,
		};
		if (source.providerSessionId) {
			payload.provider_session_id = source.providerSessionId;
		}
		if (rawNdjson) {
			payload.raw_ndjson = rawNdjson;
		}

		const url = `${getControlApiUrl()}/v1/projects/${projectId}/deployments/${deploymentId}/session-transcript`;
		const response = await authFetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			// Upload failed — don't persist checkpoint so next deploy retries this delta.
			return;
		}

		await persistCheckpoint({
			projectDir,
			adapterId: adapter.id,
			source,
			cursor: delta.cursor,
		});
	} catch {
		// Never surface transcript errors to the user.
	}
}

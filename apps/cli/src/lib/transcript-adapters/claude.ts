import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	type AdapterCheckpoint,
	type AdapterDelta,
	CANONICAL_EVENT_SCHEMA,
	type CanonicalEvent,
	type CanonicalMessageRole,
	type TranscriptAdapter,
	type TranscriptSource,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

interface ClaudeTranscriptLine {
	type?: string;
	sessionId?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
	toolUseResult?: unknown;
	timestamp?: string;
}

function normalizeTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return null;
	return new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (typeof item !== "object" || item === null) return "";
				const block = item as Record<string, unknown>;
				return typeof block.text === "string" ? block.text : "";
			})
			.filter(Boolean)
			.join(" ")
			.trim();
	}
	if (typeof content === "object" && content !== null) {
		const block = content as Record<string, unknown>;
		if (typeof block.text === "string") {
			return block.text.trim();
		}
	}
	return "";
}

function normalizeRole(role: unknown): CanonicalMessageRole {
	if (role === "user" || role === "assistant" || role === "developer" || role === "system") {
		return role;
	}
	return "unknown";
}

function roleToEventType(role: CanonicalMessageRole): "user" | "assistant" | "message" {
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	return "message";
}

function extractThinkingText(block: JsonRecord): string | null {
	const direct = block.text;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}
	const thinking = block.thinking;
	if (typeof thinking === "string" && thinking.trim().length > 0) {
		return thinking.trim();
	}
	return null;
}

function makeSource(path: string): TranscriptSource {
	const providerSessionId = readClaudeProviderSessionId(path);
	return {
		adapterId: "claude-code",
		sourceId: path,
		path,
		providerSessionId,
		sessionKey: providerSessionId ?? path,
	};
}

function getHomeDir(): string {
	const homeFromEnv = process.env.HOME?.trim();
	if (homeFromEnv) return homeFromEnv;
	return homedir();
}

function findNewestTranscriptInDir(dir: string): { path: string; mtime: number } | null {
	if (!existsSync(dir)) return null;

	let newest: { path: string; mtime: number } | null = null;
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const full = join(dir, entry);
		try {
			const fileStat = statSync(full);
			if (!fileStat.isFile()) continue;
			if (!newest || fileStat.mtimeMs > newest.mtime) {
				newest = { path: full, mtime: fileStat.mtimeMs };
			}
		} catch {}
	}

	return newest;
}

function readClaudeProviderSessionId(path: string): string | null {
	try {
		const raw = readFileSync(path, "utf8").slice(0, 64_000);
		const lines = raw.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line.trim()) as ClaudeTranscriptLine;
				if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
					return parsed.sessionId;
				}
			} catch {}
		}
	} catch {}

	const stem = basename(path, ".jsonl").trim();
	return stem.length > 0 ? stem : null;
}

function isClaudeTranscriptPath(path: string): boolean {
	const resolvedPath = resolve(path);
	const envHint = process.env.CLAUDE_TRANSCRIPT_PATH;
	if (envHint && resolve(envHint) === resolvedPath) {
		return true;
	}

	const claudeProjectsRoot = `${join(getHomeDir(), ".claude", "projects")}/`;
	return resolvedPath.startsWith(claudeProjectsRoot) && resolvedPath.endsWith(".jsonl");
}

export function findClaudeTranscriptPath(projectDir: string): string | null {
	if (process.env.CLAUDE_TRANSCRIPT_PATH && existsSync(process.env.CLAUDE_TRANSCRIPT_PATH)) {
		return process.env.CLAUDE_TRANSCRIPT_PATH;
	}

	try {
		const absPath = resolve(projectDir);
		const projectsRoot = join(getHomeDir(), ".claude", "projects");
		const encodedSlashOnly = absPath.replaceAll("/", "-");
		const encodedSlashAndDot = encodedSlashOnly.replaceAll(".", "-");
		const candidateDirs = [encodedSlashOnly, encodedSlashAndDot]
			.filter((value, index, arr) => arr.indexOf(value) === index)
			.map((encoded) => join(projectsRoot, encoded));

		let newest: { path: string; mtime: number } | null = null;
		for (const dir of candidateDirs) {
			const candidate = findNewestTranscriptInDir(dir);
			if (!candidate) continue;
			if (!newest || candidate.mtime > newest.mtime) {
				newest = candidate;
			}
		}

		return newest?.path ?? null;
	} catch {
		return null;
	}
}

export const claudeTranscriptAdapter: TranscriptAdapter = {
	id: "claude-code",
	async detect(projectDir: string): Promise<TranscriptSource | null> {
		const transcriptPath = findClaudeTranscriptPath(projectDir);
		return transcriptPath ? makeSource(transcriptPath) : null;
	},
	async sourceFromHint(hintPath: string): Promise<TranscriptSource | null> {
		if (!hintPath || !existsSync(hintPath)) return null;
		if (!isClaudeTranscriptPath(hintPath)) return null;
		return makeSource(hintPath);
	},
	async readDelta(
		source: TranscriptSource,
		checkpoint: AdapterCheckpoint | null,
	): Promise<AdapterDelta | null> {
		if (!existsSync(source.path)) {
			return null;
		}

		let fileSize: number;
		try {
			fileSize = (await stat(source.path)).size;
		} catch {
			return null;
		}

		let offset = 0;
		if (checkpoint && checkpoint.sourceId === source.sourceId) {
			const parsedOffset = Number.parseInt(checkpoint.cursor, 10);
			if (!Number.isNaN(parsedOffset) && parsedOffset >= 0) {
				offset = parsedOffset;
			}
		}
		if (offset > fileSize) {
			offset = 0;
		}
		if (offset >= fileSize) {
			return null;
		}

		let raw: string;
		try {
			raw = await Bun.file(source.path).slice(offset, fileSize).text();
		} catch {
			return null;
		}

		const lines = raw.split("\n").filter(Boolean);
		const rawLines: string[] = [];
		const canonicalEvents: CanonicalEvent[] = [];
		let sequence = 0;
		let currentTimestamp: string | null = null;
		let currentSourceType = "unknown";
		let currentSourceSubtype: string | null = null;

		const pushEvent = (event: Omit<CanonicalEvent, "meta"> & { sourceSubtype?: string | null }) => {
			const { sourceSubtype, ...rest } = event;
			sequence += 1;
			canonicalEvents.push({
				...rest,
				meta: {
					provider: "claude-code",
					schema: CANONICAL_EVENT_SCHEMA,
					timestamp: currentTimestamp,
					source_type: currentSourceType,
					source_subtype: sourceSubtype ?? currentSourceSubtype,
					sequence,
				},
			});
		};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			rawLines.push(trimmed);

			try {
				const parsed = JSON.parse(trimmed) as ClaudeTranscriptLine;
				currentTimestamp = normalizeTimestamp(parsed.timestamp);
				currentSourceType =
					typeof parsed.type === "string" && parsed.type.length > 0 ? parsed.type : "unknown";
				currentSourceSubtype = null;

				if (parsed.type !== "user" && parsed.type !== "assistant") {
					pushEvent({
						type: "event",
						event: {
							name: currentSourceType,
							data: parsed,
						},
						provider_payload: parsed,
					});
					continue;
				}

				const defaultRole = parsed.type;
				const role = normalizeRole(parsed.message?.role ?? defaultRole);
				const messageType = roleToEventType(role);
				const content = parsed.message?.content;
				let emitted = false;

				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "string") {
							const text = block.trim();
							if (!text) continue;
							pushEvent({
								type: messageType,
								message: {
									role,
									content: [{ type: "text", text }],
								},
								provider_payload: block,
							});
							emitted = true;
							continue;
						}

						if (!isRecord(block)) continue;
						const blockType =
							typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";

						if (blockType === "text") {
							const text = extractText(block);
							if (!text) continue;
							pushEvent({
								type: messageType,
								message: {
									role,
									content: [{ type: "text", text }],
								},
								provider_payload: block,
							});
							emitted = true;
							continue;
						}

						if (blockType === "tool_use") {
							pushEvent({
								type: "tool_call",
								tool_call: {
									id: typeof block.id === "string" ? block.id : null,
									name: typeof block.name === "string" ? block.name : null,
									input: block.input ?? null,
								},
								provider_payload: block,
							});
							emitted = true;
							continue;
						}

						if (blockType === "tool_result") {
							const toolUseId =
								typeof block.tool_use_id === "string" ? block.tool_use_id : null;
							const isError = typeof block.is_error === "boolean" ? block.is_error : null;
							pushEvent({
								type: "tool_result",
								tool_result: {
									tool_call_id: toolUseId,
									output:
										isRecord(parsed) && "toolUseResult" in parsed && parsed.toolUseResult != null
											? parsed.toolUseResult
											: block.content ?? null,
									is_error: isError,
								},
								provider_payload: {
									block,
									toolUseResult: parsed.toolUseResult ?? null,
								},
							});
							emitted = true;
							continue;
						}

						if (blockType === "thinking") {
							pushEvent({
								type: "reasoning",
								reasoning: {
									content: extractThinkingText(block),
									summary: [],
									encrypted_content:
										typeof block.signature === "string" ? block.signature : null,
								},
								provider_payload: block,
							});
							emitted = true;
							continue;
						}

						if (blockType === "image") {
							pushEvent({
								type: messageType,
								message: {
									role,
									content: [{ type: "text", text: "[image]" }],
								},
								provider_payload: block,
							});
							emitted = true;
							continue;
						}

						pushEvent({
							type: "event",
							event: {
								name: "message_block",
								data: block,
							},
							provider_payload: block,
							sourceSubtype: blockType,
						});
						emitted = true;
					}
				} else {
					const text = extractText(content);
					if (text) {
						pushEvent({
							type: messageType,
							message: {
								role,
								content: [{ type: "text", text }],
							},
							provider_payload: content,
						});
						emitted = true;
					}
				}

				if (!emitted) {
					pushEvent({
						type: "event",
						event: {
							name: parsed.type,
							data: parsed,
						},
						provider_payload: parsed,
					});
				}
			} catch {
				// Ignore malformed/partial line boundaries.
			}
		}

		return {
			source,
			cursor: String(fileSize),
			canonicalEvents,
			rawLines,
		};
	},
};

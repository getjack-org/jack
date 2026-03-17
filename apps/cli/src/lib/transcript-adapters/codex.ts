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

interface CodexSessionMetaLine {
	type?: string;
	payload?: {
		cwd?: unknown;
		id?: unknown;
	};
}

interface CodexTranscriptLine {
	type?: string;
	timestamp?: unknown;
	payload?: unknown;
}

function getCodexSessionsRoot(): string {
	const explicitSessionsRoot = process.env.CODEX_SESSIONS_ROOT?.trim();
	if (explicitSessionsRoot) {
		return resolve(explicitSessionsRoot);
	}

	const codexHome = process.env.CODEX_HOME?.trim();
	if (codexHome) {
		return resolve(codexHome, "sessions");
	}

	return join(homedir(), ".codex", "sessions");
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

function walkSessionJsonlFiles(rootDir: string): string[] {
	if (!existsSync(rootDir)) return [];
	const output: string[] = [];
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		let entries: string[] = [];
		try {
			entries = readdirSync(current);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const full = join(current, entry);
			try {
				const fileStat = statSync(full);
				if (fileStat.isDirectory()) {
					stack.push(full);
					continue;
				}
				if (fileStat.isFile() && entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
					output.push(full);
				}
			} catch {}
		}
	}

	return output;
}

function extractSessionIdFromFilename(filePath: string): string | null {
	const match = basename(filePath).match(
		/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/,
	);
	return match?.[1] ?? null;
}

function readSessionMetaInfo(filePath: string): {
	cwd: string | null;
	providerSessionId: string | null;
} {
	try {
		const raw = readFileSync(filePath, "utf8").slice(0, 64_000);
		const lines = raw.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line.trim()) as CodexSessionMetaLine;
				if (parsed.type !== "session_meta") continue;
				const cwd = parsed.payload?.cwd;
				const providerSessionId =
					typeof parsed.payload?.id === "string" && parsed.payload.id.length > 0
						? parsed.payload.id
						: extractSessionIdFromFilename(filePath);
				return {
					cwd: typeof cwd === "string" && cwd.length > 0 ? resolve(cwd) : null,
					providerSessionId,
				};
			} catch {}
		}
		return {
			cwd: null,
			providerSessionId: extractSessionIdFromFilename(filePath),
		};
	} catch {
		return {
			cwd: null,
			providerSessionId: extractSessionIdFromFilename(filePath),
		};
	}
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
				if (typeof block.text === "string") return block.text;
				return "";
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

function parseReasoningSummary(summary: unknown): string[] {
	if (!Array.isArray(summary)) return [];
	const output: string[] = [];
	for (const item of summary) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed) output.push(trimmed);
			continue;
		}
		if (!isRecord(item)) continue;
		const text = item.summary_text;
		if (typeof text === "string" && text.trim().length > 0) {
			output.push(text.trim());
		}
	}
	return output;
}

function makeSource(path: string): TranscriptSource {
	const info = readSessionMetaInfo(path);
	return {
		adapterId: "codex",
		sourceId: path,
		path,
		providerSessionId: info.providerSessionId,
		sessionKey: info.providerSessionId ?? path,
	};
}

function isCodexTranscriptPath(path: string): boolean {
	const resolvedPath = resolve(path);
	const codexSessionsRoot = `${getCodexSessionsRoot()}/`;
	return (
		resolvedPath.startsWith(codexSessionsRoot) &&
		basename(resolvedPath).startsWith("rollout-") &&
		resolvedPath.endsWith(".jsonl")
	);
}

function pickNewest(paths: string[]): string | null {
	let newest: { path: string; mtime: number } | null = null;
	for (const path of paths) {
		try {
			const fileStat = statSync(path);
			if (!fileStat.isFile()) continue;
			if (!newest || fileStat.mtimeMs > newest.mtime) {
				newest = { path, mtime: fileStat.mtimeMs };
			}
		} catch {}
	}
	return newest?.path ?? null;
}

export function findCodexTranscriptPath(projectDir: string): string | null {
	const sessionsRoot = getCodexSessionsRoot();
	const allFiles = walkSessionJsonlFiles(sessionsRoot);
	if (allFiles.length === 0) return null;
	const absProjectDir = resolve(projectDir);

	const threadId = process.env.CODEX_THREAD_ID?.trim();
	let matchingThreadFiles: string[] = [];
	if (threadId) {
		matchingThreadFiles = allFiles.filter((path) => path.includes(threadId));
		const matchingThreadProjectFiles = matchingThreadFiles.filter((path) => {
			const cwd = readSessionMetaInfo(path).cwd;
			return cwd === absProjectDir;
		});
		const newestThreadProjectFile = pickNewest(matchingThreadProjectFiles);
		if (newestThreadProjectFile) {
			return newestThreadProjectFile;
		}
	}

	const matchingCwdFiles = allFiles.filter((path) => {
		const cwd = readSessionMetaInfo(path).cwd;
		return cwd === absProjectDir;
	});
	const newestProjectCwdFile = pickNewest(matchingCwdFiles);
	if (newestProjectCwdFile) {
		return newestProjectCwdFile;
	}

	// If no project-cwd transcript exists yet, allow thread-id files without session_meta.
	if (matchingThreadFiles.length > 0) {
		const threadFilesWithoutCwd = matchingThreadFiles.filter(
			(path) => readSessionMetaInfo(path).cwd === null,
		);
		const newestThreadFileWithoutCwd = pickNewest(threadFilesWithoutCwd);
		if (newestThreadFileWithoutCwd) {
			return newestThreadFileWithoutCwd;
		}
	}

	return null;
}

export const codexTranscriptAdapter: TranscriptAdapter = {
	id: "codex",
	async detect(projectDir: string): Promise<TranscriptSource | null> {
		const transcriptPath = findCodexTranscriptPath(projectDir);
		return transcriptPath ? makeSource(transcriptPath) : null;
	},
	async sourceFromHint(hintPath: string): Promise<TranscriptSource | null> {
		if (!hintPath || !existsSync(hintPath)) return null;
		if (!isCodexTranscriptPath(hintPath)) return null;
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

		const pushEvent = (event: Omit<CanonicalEvent, "meta"> & { sourceSubtype?: string | null }) => {
			const { sourceSubtype, ...rest } = event;
			sequence += 1;
			canonicalEvents.push({
				...rest,
				meta: {
					provider: "codex",
					schema: CANONICAL_EVENT_SCHEMA,
					timestamp: currentTimestamp,
					source_type: currentSourceType,
					source_subtype: sourceSubtype ?? currentSourceSubtype,
					sequence,
				},
			});
		};

		let currentTimestamp: string | null = null;
		let currentSourceType = "unknown";
		let currentSourceSubtype: string | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			rawLines.push(trimmed);

			try {
				const parsed = JSON.parse(trimmed) as CodexTranscriptLine;
				currentTimestamp = normalizeTimestamp(parsed.timestamp);
				currentSourceType = typeof parsed.type === "string" && parsed.type.length > 0 ? parsed.type : "unknown";
				currentSourceSubtype = null;

				if (parsed.type !== "response_item") {
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

				const payload = isRecord(parsed.payload) ? parsed.payload : null;
				const payloadType =
					typeof payload?.type === "string" && payload.type.length > 0 ? payload.type : "unknown";
				currentSourceSubtype = payloadType;

				if (payloadType === "message") {
					const role = normalizeRole(payload?.role);
					const eventType = roleToEventType(role);
					const content = payload?.content;
					let emitted = false;

					if (Array.isArray(content)) {
						for (const block of content) {
							if (typeof block === "string") {
								const text = block.trim();
								if (!text) continue;
								pushEvent({
									type: eventType,
									message: { role, content: [{ type: "text", text }] },
									provider_payload: block,
								});
								emitted = true;
								continue;
							}

							if (!isRecord(block)) continue;
							const blockType =
								typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";
							if (
								blockType === "input_text" ||
								blockType === "output_text" ||
								blockType === "text"
							) {
								const text = extractText(block);
								if (!text) continue;
								pushEvent({
									type: eventType,
									message: { role, content: [{ type: "text", text }] },
									provider_payload: block,
								});
								emitted = true;
								continue;
							}

							if (blockType === "input_image") {
								pushEvent({
									type: eventType,
									message: {
										role,
										content: [{ type: "text", text: "[input_image]" }],
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
								type: eventType,
								message: { role, content: [{ type: "text", text }] },
								provider_payload: content,
							});
							emitted = true;
						}
					}

					if (!emitted) {
						pushEvent({
							type: "event",
							event: {
								name: "message",
								data: payload ?? parsed,
							},
							provider_payload: payload ?? parsed,
						});
					}
					continue;
				}

				if (
					payloadType === "function_call" ||
					payloadType === "custom_tool_call" ||
					payloadType === "web_search_call"
				) {
					const id =
						typeof payload?.call_id === "string" && payload.call_id.length > 0
							? payload.call_id
							: typeof payload?.id === "string" && payload.id.length > 0
								? payload.id
								: null;
					const name =
						typeof payload?.name === "string" && payload.name.length > 0
							? payload.name
							: payloadType;
					const input =
						payloadType === "web_search_call"
							? payload?.action ?? null
							: payload?.input ?? payload?.arguments ?? null;

					pushEvent({
						type: "tool_call",
						tool_call: {
							id,
							name,
							input,
						},
						provider_payload: payload ?? parsed,
					});
					continue;
				}

				if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
					const toolCallId =
						typeof payload?.call_id === "string" && payload.call_id.length > 0
							? payload.call_id
							: null;
					const isError = typeof payload?.is_error === "boolean" ? payload.is_error : null;
					pushEvent({
						type: "tool_result",
						tool_result: {
							tool_call_id: toolCallId,
							output: payload?.output ?? null,
							is_error: isError,
						},
						provider_payload: payload ?? parsed,
					});
					continue;
				}

				if (payloadType === "reasoning") {
					pushEvent({
						type: "reasoning",
						reasoning: {
							content: typeof payload?.content === "string" ? payload.content : null,
							summary: parseReasoningSummary(payload?.summary),
							encrypted_content:
								typeof payload?.encrypted_content === "string"
									? payload.encrypted_content
									: null,
						},
						provider_payload: payload ?? parsed,
					});
					continue;
				}

				pushEvent({
					type: "event",
					event: {
						name: payloadType,
						data: payload ?? parsed,
					},
					provider_payload: payload ?? parsed,
				});
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

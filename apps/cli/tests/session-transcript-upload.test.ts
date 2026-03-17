import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalProjectLink } from "../src/lib/project-link.ts";
import { uploadDeltaSessionTranscript } from "../src/lib/session-transcript.ts";

interface CapturedRequest {
	headers: Record<string, string>;
	body: unknown;
	rawBody: string;
}

let tempDir: string;
let projectDir: string;
let originalControlUrl: string | undefined;
let originalApiToken: string | undefined;
let originalClaudeTranscriptPath: string | undefined;
let originalCodexSessionsRoot: string | undefined;
let originalJackTranscriptProvider: string | undefined;
let originalHome: string | undefined;
let originalFetch: typeof fetch;
let requests: CapturedRequest[] = [];

function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "session-transcript-upload-test-"));
	projectDir = join(tempDir, "project");
	await mkdir(projectDir, { recursive: true });

	originalControlUrl = process.env.JACK_CONTROL_URL;
	originalApiToken = process.env.JACK_API_TOKEN;
	originalClaudeTranscriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
	originalCodexSessionsRoot = process.env.CODEX_SESSIONS_ROOT;
	originalJackTranscriptProvider = process.env.JACK_TRANSCRIPT_PROVIDER;
	originalHome = process.env.HOME;
	originalFetch = globalThis.fetch;

	requests = [];

	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		const rawBody = typeof init?.body === "string" ? init.body : "";
		let body: unknown = rawBody;
		try {
			body = JSON.parse(rawBody);
		} catch {
			// Keep raw text body.
		}

		requests.push({
			headers: Object.fromEntries(headers.entries()),
			body,
			rawBody,
		});

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	process.env.JACK_CONTROL_URL = "https://control.test.local";
	process.env.JACK_API_TOKEN = "jkt_test_token";
	process.env.CODEX_SESSIONS_ROOT = join(tempDir, ".codex", "sessions");
	process.env.HOME = tempDir;
	await mkdir(process.env.CODEX_SESSIONS_ROOT, { recursive: true });
	unsetEnv("JACK_TRANSCRIPT_PROVIDER");
});

afterEach(async () => {
	if (originalControlUrl === undefined) unsetEnv("JACK_CONTROL_URL");
	else process.env.JACK_CONTROL_URL = originalControlUrl;
	if (originalApiToken === undefined) unsetEnv("JACK_API_TOKEN");
	else process.env.JACK_API_TOKEN = originalApiToken;
	if (originalClaudeTranscriptPath === undefined) unsetEnv("CLAUDE_TRANSCRIPT_PATH");
	else process.env.CLAUDE_TRANSCRIPT_PATH = originalClaudeTranscriptPath;
	if (originalCodexSessionsRoot === undefined) unsetEnv("CODEX_SESSIONS_ROOT");
	else process.env.CODEX_SESSIONS_ROOT = originalCodexSessionsRoot;
	if (originalJackTranscriptProvider === undefined) unsetEnv("JACK_TRANSCRIPT_PROVIDER");
	else process.env.JACK_TRANSCRIPT_PROVIDER = originalJackTranscriptProvider;
	if (originalHome === undefined) unsetEnv("HOME");
	else process.env.HOME = originalHome;
	globalThis.fetch = originalFetch;

	await rm(tempDir, { recursive: true, force: true });
});

async function writeProjectLink(link: Partial<LocalProjectLink> = {}): Promise<void> {
	const jackDir = join(projectDir, ".jack");
	await mkdir(jackDir, { recursive: true });

	const base: LocalProjectLink = {
		version: 1,
		project_id: "proj_test",
		deploy_mode: "managed",
		linked_at: new Date("2026-02-20T00:00:00.000Z").toISOString(),
	};

	await writeFile(join(jackDir, "project.json"), JSON.stringify({ ...base, ...link }, null, 2));
}

function claudeLine(line: Record<string, unknown>): string {
	return `${JSON.stringify(line)}\n`;
}

async function writeJsonlFile(path: string, lines: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function readProjectLinkJson(): Promise<LocalProjectLink> {
	return JSON.parse(await readFile(join(projectDir, ".jack", "project.json"), "utf8")) as LocalProjectLink;
}

describe("uploadDeltaSessionTranscript", () => {
	test("uploads JSON payload with full canonical/raw content and dual-writes checkpoints", async () => {
		const transcriptPath = join(tempDir, "claude-transcript.jsonl");
		const secret = "sk_test_SUPERSECRET123456789";
		const transcriptContent =
			claudeLine({
				type: "user",
				sessionId: "claude-session-primary",
				timestamp: "2026-02-20T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: `token ${secret}` }] },
			}) +
			claudeLine({
				type: "assistant",
				sessionId: "claude-session-primary",
				timestamp: "2026-02-20T10:00:01.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
			});
		await writeFile(transcriptPath, transcriptContent, "utf8");
		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPath;

		await writeProjectLink();

		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_test",
			projectDir,
			transcriptPath,
		});

		expect(requests).toHaveLength(1);
		const payload = requests[0]?.body as Record<string, unknown>;
		expect(requests[0]?.headers["content-type"]).toContain("application/json");
		expect(payload.schema_version).toBe("jack.transcript-upload.v1");
		expect(payload.provider).toBe("claude-code");
		expect(payload.provider_session_id).toBe("claude-session-primary");
		expect(payload.canonical_format).toBe("jack.event.v1");

		const canonical = String(payload.canonical_ndjson ?? "");
		const raw = String(payload.raw_ndjson ?? "");
		expect(canonical).toContain(secret);
		expect(raw).toContain(secret);

		const stats = payload.stats as Record<string, unknown>;
		expect(stats.event_count).toBe(2);
		expect(stats.message_count).toBe(2);
		expect(stats.turn_count).toBe(2);
		expect(stats.user_turn_count).toBe(1);
		expect(stats.assistant_turn_count).toBe(1);

		const link = await readProjectLinkJson();
		const expectedCursor = String(Buffer.byteLength(transcriptContent));
		expect(link.transcript_session_checkpoints?.["claude-code"]?.["claude-session-primary"]).toEqual({
			provider_session_id: "claude-session-primary",
			source_id: transcriptPath,
			cursor: expectedCursor,
			updated_at: expect.any(String),
		});
		expect(link.transcript_checkpoints?.["claude-code"]?.source_id).toBe(transcriptPath);
		expect(link.transcript_checkpoints?.["claude-code"]?.cursor).toBe(expectedCursor);
		expect(link.last_transcript_path).toBe(transcriptPath);
		expect(link.last_transcript_byte_offset).toBe(Buffer.byteLength(transcriptContent));
	});

	test("reads legacy checkpoint fields when adapter checkpoint is missing", async () => {
		const transcriptPath = join(tempDir, "claude-transcript.jsonl");
		const firstChunk = claudeLine({
			type: "user",
			timestamp: "2026-02-20T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "first" }] },
		});
		const secondChunk = claudeLine({
			type: "assistant",
			timestamp: "2026-02-20T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "second" }] },
		});
		const full = `${firstChunk}${secondChunk}`;
		await writeFile(transcriptPath, full, "utf8");
		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPath;

		await writeProjectLink({
			last_transcript_path: transcriptPath,
			last_transcript_byte_offset: Buffer.byteLength(firstChunk),
		});

		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_test",
			projectDir,
			transcriptPath,
		});

		expect(requests).toHaveLength(1);
		const payload = requests[0]?.body as Record<string, unknown>;
		const canonical = String(payload.canonical_ndjson ?? "");
		expect(canonical).toContain("second");
		expect(canonical).not.toContain("first");

		const link = await readProjectLinkJson();
		const sessionKey = transcriptPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
		expect(link.transcript_session_checkpoints?.["claude-code"]?.[sessionKey]).toEqual({
			provider_session_id: sessionKey,
			source_id: transcriptPath,
			cursor: String(Buffer.byteLength(full)),
			updated_at: expect.any(String),
		});
		expect(link.transcript_checkpoints?.["claude-code"]?.cursor).toBe(
			String(Buffer.byteLength(full)),
		);
	});

	test("skips upload on malformed-only delta but still advances checkpoint", async () => {
		const transcriptPath = join(tempDir, "claude-transcript.jsonl");
		const malformedOnly = "{not-json}\n";
		await writeFile(transcriptPath, malformedOnly, "utf8");
		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPath;

		await writeProjectLink();

		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_test",
			projectDir,
			transcriptPath,
		});

		expect(requests).toHaveLength(0);

		const link = await readProjectLinkJson();
		const expectedSize = Buffer.byteLength(malformedOnly);
		expect(link.transcript_session_checkpoints?.["claude-code"]?.[transcriptPath.replace(/^.*\//, "").replace(/\.jsonl$/, "")]?.cursor).toBe(
			String(expectedSize),
		);
		expect(link.transcript_checkpoints?.["claude-code"]?.cursor).toBe(String(expectedSize));
		expect(link.last_transcript_path).toBe(transcriptPath);
		expect(link.last_transcript_byte_offset).toBe(expectedSize);
	});

	test("generic upload picks detector result instead of a Claude-first hint", async () => {
		const encodedProjectPath = projectDir.replaceAll("/", "-");
		const claudePath = join(tempDir, ".claude", "projects", encodedProjectPath, "transcript.jsonl");
		const codexPath = join(
			process.env.CODEX_SESSIONS_ROOT!,
			"2026",
			"02",
			"21",
			"rollout-2026-02-21T10-00-00-codex-session-generic.jsonl",
		);

		await writeJsonlFile(claudePath, [
			{
				type: "user",
				sessionId: "claude-session-generic",
				timestamp: "2026-02-21T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "from-claude" }] },
			},
		]);
		await writeJsonlFile(codexPath, [
			{ type: "session_meta", payload: { id: "codex-session-generic", cwd: projectDir } },
			{
				type: "response_item",
				timestamp: "2026-02-21T11:00:00.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "from-codex" }],
				},
			},
		]);
		process.env.CLAUDE_TRANSCRIPT_PATH = claudePath;
		await utimes(claudePath, new Date("2026-02-21T10:00:00.000Z"), new Date("2026-02-21T10:00:00.000Z"));
		await utimes(codexPath, new Date("2026-02-21T11:00:00.000Z"), new Date("2026-02-21T11:00:00.000Z"));

		await writeProjectLink();

		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_test",
			projectDir,
		});

		expect(requests).toHaveLength(1);
		const payload = requests[0]?.body as Record<string, unknown>;
		expect(payload.provider).toBe("codex");
		expect(payload.provider_session_id).toBe("codex-session-generic");
		expect(String(payload.canonical_ndjson ?? "")).toContain("from-codex");
	});

	test("explicit transcript hints override cross-provider arbitration", async () => {
		const encodedProjectPath = projectDir.replaceAll("/", "-");
		const claudePath = join(tempDir, ".claude", "projects", encodedProjectPath, "transcript.jsonl");
		const codexPath = join(
			process.env.CODEX_SESSIONS_ROOT!,
			"2026",
			"02",
			"21",
			"rollout-2026-02-21T10-00-00-codex-session-hint.jsonl",
		);

		await writeJsonlFile(claudePath, [
			{
				type: "user",
				sessionId: "claude-session-hint",
				timestamp: "2026-02-21T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "forced-claude" }] },
			},
		]);
		await writeJsonlFile(codexPath, [
			{ type: "session_meta", payload: { id: "codex-session-hint", cwd: projectDir } },
			{
				type: "response_item",
				timestamp: "2026-02-21T11:00:00.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "newer-codex" }],
				},
			},
		]);
		process.env.CLAUDE_TRANSCRIPT_PATH = claudePath;
		await utimes(claudePath, new Date("2026-02-21T10:00:00.000Z"), new Date("2026-02-21T10:00:00.000Z"));
		await utimes(codexPath, new Date("2026-02-21T11:00:00.000Z"), new Date("2026-02-21T11:00:00.000Z"));

		await writeProjectLink();

		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_test",
			projectDir,
			transcriptPath: claudePath,
		});

		expect(requests).toHaveLength(1);
		const payload = requests[0]?.body as Record<string, unknown>;
		expect(payload.provider).toBe("claude-code");
		expect(payload.provider_session_id).toBe("claude-session-hint");
		expect(String(payload.canonical_ndjson ?? "")).toContain("forced-claude");
	});

	test("tracks independent checkpoints for concurrent same-provider sessions", async () => {
		const transcriptPathA = join(tempDir, "claude-session-a.jsonl");
		const transcriptPathB = join(tempDir, "claude-session-b.jsonl");
		const firstA = claudeLine({
			type: "user",
			sessionId: "claude-session-a",
			timestamp: "2026-02-22T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "session-a-first" }] },
		});
		const secondA = claudeLine({
			type: "assistant",
			sessionId: "claude-session-a",
			timestamp: "2026-02-22T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "session-a-second" }] },
		});
		const onlyB = claudeLine({
			type: "user",
			sessionId: "claude-session-b",
			timestamp: "2026-02-22T10:05:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "session-b-only" }] },
		});

		await writeFile(transcriptPathA, firstA, "utf8");
		await writeFile(transcriptPathB, onlyB, "utf8");
		await writeProjectLink();

		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPathA;
		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_a1",
			projectDir,
			transcriptPath: transcriptPathA,
		});
		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPathB;
		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_b1",
			projectDir,
			transcriptPath: transcriptPathB,
		});

		await writeFile(transcriptPathA, `${firstA}${secondA}`, "utf8");

		process.env.CLAUDE_TRANSCRIPT_PATH = transcriptPathA;
		await uploadDeltaSessionTranscript({
			projectId: "proj_test",
			deploymentId: "dep_a2",
			projectDir,
			transcriptPath: transcriptPathA,
		});

		expect(requests).toHaveLength(3);
		const thirdPayload = requests[2]?.body as Record<string, unknown>;
		const thirdCanonical = String(thirdPayload.canonical_ndjson ?? "");
		expect(thirdPayload.provider_session_id).toBe("claude-session-a");
		expect(thirdCanonical).toContain("session-a-second");
		expect(thirdCanonical).not.toContain("session-a-first");

		const link = await readProjectLinkJson();
		expect(link.transcript_session_checkpoints?.["claude-code"]?.["claude-session-a"]?.cursor).toBe(
			String(Buffer.byteLength(`${firstA}${secondA}`)),
		);
		expect(link.transcript_session_checkpoints?.["claude-code"]?.["claude-session-b"]?.cursor).toBe(
			String(Buffer.byteLength(onlyB)),
		);
		expect(link.transcript_checkpoints?.["claude-code"]?.source_id).toBe(transcriptPathA);
	});
});

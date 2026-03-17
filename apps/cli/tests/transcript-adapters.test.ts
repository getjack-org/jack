import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	claudeTranscriptAdapter,
	findClaudeTranscriptPath,
} from "../src/lib/transcript-adapters/claude.ts";
import {
	codexTranscriptAdapter,
	findCodexTranscriptPath,
} from "../src/lib/transcript-adapters/codex.ts";
import { detectTranscriptSource } from "../src/lib/transcript-adapters/index.ts";

let tempDir: string;
let codexSessionsRoot: string;
let originalCodexThreadId: string | undefined;
let originalClaudeTranscriptPath: string | undefined;
let originalCodexSessionsRoot: string | undefined;
let originalCodexHome: string | undefined;
let originalHome: string | undefined;
let originalJackTranscriptProvider: string | undefined;

function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "transcript-adapters-test-"));
	codexSessionsRoot = join(tempDir, ".codex", "sessions");
	await mkdir(codexSessionsRoot, { recursive: true });

	originalCodexThreadId = process.env.CODEX_THREAD_ID;
	originalClaudeTranscriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
	originalCodexSessionsRoot = process.env.CODEX_SESSIONS_ROOT;
	originalCodexHome = process.env.CODEX_HOME;
	originalHome = process.env.HOME;
	originalJackTranscriptProvider = process.env.JACK_TRANSCRIPT_PROVIDER;

	process.env.CODEX_SESSIONS_ROOT = codexSessionsRoot;
	process.env.HOME = tempDir;
	unsetEnv("CODEX_HOME");
	unsetEnv("CODEX_THREAD_ID");
	unsetEnv("CLAUDE_TRANSCRIPT_PATH");
	unsetEnv("JACK_TRANSCRIPT_PROVIDER");
});

afterEach(async () => {
	if (originalCodexThreadId === undefined) unsetEnv("CODEX_THREAD_ID");
	else process.env.CODEX_THREAD_ID = originalCodexThreadId;
	if (originalClaudeTranscriptPath === undefined) unsetEnv("CLAUDE_TRANSCRIPT_PATH");
	else process.env.CLAUDE_TRANSCRIPT_PATH = originalClaudeTranscriptPath;
	if (originalCodexSessionsRoot === undefined) unsetEnv("CODEX_SESSIONS_ROOT");
	else process.env.CODEX_SESSIONS_ROOT = originalCodexSessionsRoot;
	if (originalCodexHome === undefined) unsetEnv("CODEX_HOME");
	else process.env.CODEX_HOME = originalCodexHome;
	if (originalHome === undefined) unsetEnv("HOME");
	else process.env.HOME = originalHome;
	if (originalJackTranscriptProvider === undefined) unsetEnv("JACK_TRANSCRIPT_PROVIDER");
	else process.env.JACK_TRANSCRIPT_PROVIDER = originalJackTranscriptProvider;

	await rm(tempDir, { recursive: true, force: true });
});

async function writeJsonl(path: string, lines: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const payload = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
	await writeFile(path, payload, "utf8");
}

describe("codex transcript detection", () => {
	test("prefers CODEX_THREAD_ID match", async () => {
		const projectDir = "/Users/me/project";
		const threadId = "jack-transcript-thread-test-987654321";
		const sessionsDir = join(codexSessionsRoot, "2026", "02", "20");
		const threadPath = join(sessionsDir, `rollout-2026-02-20T10-00-00-${threadId}.jsonl`);
		const otherPath = join(sessionsDir, "rollout-2026-02-20T10-00-01-other.jsonl");

		await writeJsonl(threadPath, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		await writeJsonl(otherPath, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		await utimes(
			threadPath,
			new Date("2026-02-20T10:00:10.000Z"),
			new Date("2026-02-20T10:00:10.000Z"),
		);
		await utimes(otherPath, new Date("2026-02-20T10:00:20.000Z"), new Date("2026-02-20T10:00:20.000Z"));

		process.env.CODEX_THREAD_ID = threadId;
		const detected = findCodexTranscriptPath(projectDir);
		expect(detected).toBe(threadPath);
	});

	test("extracts codex provider session id from session_meta payload", async () => {
		const projectDir = "/Users/me/project";
		const sessionsDir = join(codexSessionsRoot, "2026", "02", "20");
		const transcriptPath = join(sessionsDir, "rollout-2026-02-20T10-00-00-session-fallback.jsonl");

		await writeJsonl(transcriptPath, [
			{ type: "session_meta", payload: { id: "codex-session-123", cwd: projectDir } },
		]);

		const source = await codexTranscriptAdapter.detect(projectDir);
		expect(source?.providerSessionId).toBe("codex-session-123");
		expect(source?.sessionKey).toBe("codex-session-123");
	});

	test("ignores CODEX_THREAD_ID matches from other cwd and falls back to project cwd", async () => {
		const projectDir = "/Users/me/project";
		const threadId = "jack-transcript-thread-test-111111111";
		const sessionsDir = join(codexSessionsRoot, "2026", "02", "20");
		const threadPath = join(sessionsDir, `rollout-2026-02-20T10-00-00-${threadId}.jsonl`);
		const projectPath = join(sessionsDir, "rollout-2026-02-20T10-00-01-project.jsonl");

		await writeJsonl(threadPath, [{ type: "session_meta", payload: { cwd: "/elsewhere" } }]);
		await writeJsonl(projectPath, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		await utimes(
			threadPath,
			new Date("2026-02-20T10:00:30.000Z"),
			new Date("2026-02-20T10:00:30.000Z"),
		);
		await utimes(
			projectPath,
			new Date("2026-02-20T10:00:20.000Z"),
			new Date("2026-02-20T10:00:20.000Z"),
		);

		process.env.CODEX_THREAD_ID = threadId;
		const detected = findCodexTranscriptPath(projectDir);
		expect(detected).toBe(projectPath);
	});

	test("falls back to newest session_meta cwd match", async () => {
		const projectDir = "/Users/me/project";
		const sessionsDir = join(codexSessionsRoot, "2026", "02", "20");
		const olderMatch = join(sessionsDir, "rollout-2026-02-20T09-00-00-a.jsonl");
		const newestMatch = join(sessionsDir, "rollout-2026-02-20T10-00-00-b.jsonl");
		const nonMatch = join(sessionsDir, "rollout-2026-02-20T11-00-00-c.jsonl");

		await writeJsonl(olderMatch, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		await writeJsonl(newestMatch, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		await writeJsonl(nonMatch, [{ type: "session_meta", payload: { cwd: "/other" } }]);

		await utimes(
			olderMatch,
			new Date("2026-02-20T09:00:00.000Z"),
			new Date("2026-02-20T09:00:00.000Z"),
		);
		await utimes(
			newestMatch,
			new Date("2026-02-20T10:00:00.000Z"),
			new Date("2026-02-20T10:00:00.000Z"),
		);
		await utimes(
			nonMatch,
			new Date("2026-02-20T11:00:00.000Z"),
			new Date("2026-02-20T11:00:00.000Z"),
		);

		const detected = findCodexTranscriptPath(projectDir);
		expect(detected).toBe(newestMatch);
	});
});

describe("claude transcript detection", () => {
	test("detects transcript paths for projects under dot-prefixed directories", async () => {
		const projectDir = "/Users/me/.jack/projects/project-x";
		const encoded = projectDir.replaceAll("/", "-").replaceAll(".", "-");
		const transcriptPath = join(tempDir, ".claude", "projects", encoded, "transcript.jsonl");

		await writeJsonl(transcriptPath, [{ type: "user", message: { role: "user", content: "hello" } }]);

		const detected = findClaudeTranscriptPath(projectDir);
		expect(detected).toBe(transcriptPath);
	});

	test("extracts claude provider session id from transcript lines", async () => {
		const projectDir = "/Users/me/project";
		const encoded = projectDir.replaceAll("/", "-");
		const transcriptPath = join(tempDir, ".claude", "projects", encoded, "transcript.jsonl");

		await writeJsonl(transcriptPath, [
			{
				type: "user",
				sessionId: "claude-session-456",
				message: { role: "user", content: "hello" },
			},
		]);

		const source = await claudeTranscriptAdapter.detect(projectDir);
		expect(source?.providerSessionId).toBe("claude-session-456");
		expect(source?.sessionKey).toBe("claude-session-456");
	});
});

describe("adapter canonicalization", () => {
	test("normalizes codex messages, tools, reasoning, and system events", async () => {
		const transcriptPath = join(
			codexSessionsRoot,
			"2026",
			"02",
			"20",
			"rollout-2026-02-20T10-00-00-jack-transcript-thread-test-987654321.jsonl",
		);

		await writeJsonl(transcriptPath, [
			{ type: "session_meta", payload: { cwd: "/Users/me/project" } },
			{ type: "turn_context", payload: { cwd: "/Users/me/project" } },
			{
				type: "response_item",
				timestamp: "2026-02-20T10:00:01.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hello" }],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-02-20T10:00:02.000Z",
				payload: {
					type: "function_call",
					call_id: "call_1",
					name: "exec_command",
					arguments: "{\"cmd\":\"ls\"}",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-02-20T10:00:03.000Z",
				payload: {
					type: "function_call_output",
					call_id: "call_1",
					output: "ok",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-02-20T10:00:04.000Z",
				payload: {
					type: "reasoning",
					content: "thinking",
					summary: [{ type: "summary_text", summary_text: "step 1" }],
					encrypted_content: "enc",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-02-20T10:00:05.000Z",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi" }],
				},
			},
		]);

		const delta = await codexTranscriptAdapter.readDelta(
			{
				adapterId: "codex",
				sourceId: transcriptPath,
				path: transcriptPath,
				providerSessionId: "jack-transcript-thread-test-987654321",
				sessionKey: "jack-transcript-thread-test-987654321",
			},
			null,
		);

		expect(delta).not.toBeNull();
		expect(delta?.canonicalEvents.length).toBeGreaterThanOrEqual(7);
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("user");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("assistant");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("tool_call");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("tool_result");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("reasoning");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("event");

		const userEvent = delta?.canonicalEvents.find((event) => event.type === "user");
		expect(userEvent?.message?.content[0]?.text).toBe("hello");
		expect(userEvent?.meta.provider).toBe("codex");

		const toolCall = delta?.canonicalEvents.find((event) => event.type === "tool_call");
		expect(toolCall?.tool_call?.name).toBe("exec_command");
		expect(toolCall?.tool_call?.id).toBe("call_1");

		const toolResult = delta?.canonicalEvents.find((event) => event.type === "tool_result");
		expect(toolResult?.tool_result?.tool_call_id).toBe("call_1");

		const sequences = (delta?.canonicalEvents ?? []).map((event) => event.meta.sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
	});

	test("normalizes claude messages, tools, reasoning, and system events", async () => {
		const transcriptPath = join(
			tempDir,
			".claude",
			"projects",
			"users-me-project",
			"transcript.jsonl",
		);

		await writeJsonl(transcriptPath, [
			{
				type: "user",
				timestamp: "2026-02-20T10:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			},
			{
				type: "assistant",
				timestamp: "2026-02-20T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
						{ type: "text", text: "hi" },
						{ type: "thinking", thinking: "plan" },
					],
				},
			},
			{
				type: "user",
				timestamp: "2026-02-20T10:00:03.000Z",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool_1", content: "done" }],
				},
				toolUseResult: { stdout: "done" },
			},
			{ type: "system", message: { role: "system", content: "skip" } },
		]);

		const delta = await claudeTranscriptAdapter.readDelta(
			{
				adapterId: "claude-code",
				sourceId: transcriptPath,
				path: transcriptPath,
				providerSessionId: "users-me-project",
				sessionKey: "users-me-project",
			},
			null,
		);

		expect(delta).not.toBeNull();
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("user");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("assistant");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("tool_call");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("tool_result");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("reasoning");
		expect(delta?.canonicalEvents.map((event) => event.type)).toContain("event");

		const assistantEvent = delta?.canonicalEvents.find((event) => event.type === "assistant");
		expect(assistantEvent?.meta.provider).toBe("claude-code");
		expect(assistantEvent?.message?.content[0]?.text).toBe("hi");

		const toolCall = delta?.canonicalEvents.find((event) => event.type === "tool_call");
		expect(toolCall?.tool_call?.id).toBe("tool_1");
		expect(toolCall?.tool_call?.name).toBe("Bash");

		const toolResult = delta?.canonicalEvents.find((event) => event.type === "tool_result");
		expect(toolResult?.tool_result?.tool_call_id).toBe("tool_1");
	});
});

describe("hint adapter selection", () => {
	test("selects codex adapter for codex hint path", async () => {
		const projectDir = "/Users/me/project";
		const codexPath = join(
			codexSessionsRoot,
			"2026",
			"02",
			"20",
			"rollout-2026-02-20T10-00-00-jack-transcript-thread-test-987654321.jsonl",
		);
		await writeJsonl(codexPath, [
			{ type: "session_meta", payload: { id: "codex-hint-session", cwd: projectDir } },
		]);

		const source = await detectTranscriptSource(projectDir, codexPath);
		expect(source?.adapterId).toBe("codex");
		expect(source?.providerSessionId).toBe("codex-hint-session");
	});

	test("selects claude adapter for claude hint path", async () => {
		const projectDir = "/Users/me/project";
		const claudePath = join(tempDir, ".claude", "projects", "users-me-project", "transcript.jsonl");
		await writeJsonl(claudePath, [
			{ type: "user", sessionId: "claude-hint-session", message: { content: "hello" } },
		]);
		process.env.CLAUDE_TRANSCRIPT_PATH = claudePath;

		const source = await detectTranscriptSource(projectDir, claudePath);
		expect(source?.adapterId).toBe("claude-code");
		expect(source?.providerSessionId).toBe("claude-hint-session");
	});
});

describe("cross-provider source selection", () => {
	test("chooses newest transcript source across adapters", async () => {
		const projectDir = join(tempDir, "project-a");
		const encodedProjectPath = projectDir.replaceAll("/", "-");
		const claudePath = join(
			tempDir,
			".claude",
			"projects",
			encodedProjectPath,
			"transcript.jsonl",
		);
		const codexPath = join(
			codexSessionsRoot,
			"2026",
			"02",
			"21",
			"rollout-2026-02-21T10-00-00-test-thread.jsonl",
		);

		await mkdir(projectDir, { recursive: true });
		await writeJsonl(claudePath, [{ type: "user", message: { role: "user", content: "from-claude" } }]);
		await writeJsonl(codexPath, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		process.env.CLAUDE_TRANSCRIPT_PATH = claudePath;

		await utimes(claudePath, new Date("2026-02-21T10:00:00.000Z"), new Date("2026-02-21T10:00:00.000Z"));
		await utimes(codexPath, new Date("2026-02-21T11:00:00.000Z"), new Date("2026-02-21T11:00:00.000Z"));

		const firstPick = await detectTranscriptSource(projectDir);
		expect(firstPick?.adapterId).toBe("codex");

		await utimes(claudePath, new Date("2026-02-21T12:00:00.000Z"), new Date("2026-02-21T12:00:00.000Z"));
		const secondPick = await detectTranscriptSource(projectDir);
		expect(secondPick?.adapterId).toBe("claude-code");
	});

	test("respects JACK_TRANSCRIPT_PROVIDER override when both sources exist", async () => {
		const projectDir = join(tempDir, "project-b");
		const encodedProjectPath = projectDir.replaceAll("/", "-");
		const claudePath = join(
			tempDir,
			".claude",
			"projects",
			encodedProjectPath,
			"transcript.jsonl",
		);
		const codexPath = join(
			codexSessionsRoot,
			"2026",
			"02",
			"21",
			"rollout-2026-02-21T10-00-00-test-thread-2.jsonl",
		);

		await mkdir(projectDir, { recursive: true });
		await writeJsonl(claudePath, [{ type: "user", message: { role: "user", content: "from-claude" } }]);
		await writeJsonl(codexPath, [{ type: "session_meta", payload: { cwd: projectDir } }]);
		process.env.CLAUDE_TRANSCRIPT_PATH = claudePath;
		await utimes(claudePath, new Date("2026-02-21T10:00:00.000Z"), new Date("2026-02-21T10:00:00.000Z"));
		await utimes(codexPath, new Date("2026-02-21T11:00:00.000Z"), new Date("2026-02-21T11:00:00.000Z"));

		process.env.JACK_TRANSCRIPT_PROVIDER = "claude-code";
		const forcedClaude = await detectTranscriptSource(projectDir);
		expect(forcedClaude?.adapterId).toBe("claude-code");

		process.env.JACK_TRANSCRIPT_PROVIDER = "codex";
		const forcedCodex = await detectTranscriptSource(projectDir);
		expect(forcedCodex?.adapterId).toBe("codex");
	});
});

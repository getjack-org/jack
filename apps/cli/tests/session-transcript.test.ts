import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeltaTranscript } from "../src/lib/session-transcript.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "transcript-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function jsonl(...lines: Record<string, unknown>[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("readDeltaTranscript", () => {
	test("reads full file when offset is 0", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const content = jsonl(
			{ type: "user", message: "hello" },
			{ type: "assistant", message: "hi" },
		);
		await Bun.write(path, content);

		const result = await readDeltaTranscript(path, 0);
		expect(result).not.toBeNull();
		expect(result!.transcript).toContain('"type":"user"');
		expect(result!.transcript).toContain('"type":"assistant"');
		expect(result!.newByteOffset).toBe(Buffer.byteLength(content));
	});

	test("reads only new content after offset", async () => {
		const path = join(tempDir, "transcript.jsonl");

		// Write initial content
		const first = jsonl(
			{ type: "user", message: "first" },
			{ type: "assistant", message: "first reply" },
		);
		await Bun.write(path, first);
		const offsetAfterFirst = Buffer.byteLength(first);

		// Append new content
		const second = jsonl(
			{ type: "user", message: "second" },
			{ type: "assistant", message: "second reply" },
		);
		await Bun.write(path, first + second);

		const result = await readDeltaTranscript(path, offsetAfterFirst);
		expect(result).not.toBeNull();
		expect(result!.transcript).toContain("second");
		expect(result!.transcript).not.toContain("first");
		expect(result!.newByteOffset).toBe(Buffer.byteLength(first + second));
	});

	test("filters out non-user/assistant lines", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const content = jsonl(
			{ type: "summary", data: "some summary" },
			{ type: "user", message: "hello" },
			{ type: "system", message: "system msg" },
			{ type: "assistant", message: "hi" },
		);
		await Bun.write(path, content);

		const result = await readDeltaTranscript(path, 0);
		expect(result).not.toBeNull();
		const lines = result!.transcript.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('"type":"user"');
		expect(lines[1]).toContain('"type":"assistant"');
	});

	test("returns null when file does not exist", async () => {
		const result = await readDeltaTranscript(join(tempDir, "nope.jsonl"), 0);
		expect(result).toBeNull();
	});

	test("returns null when offset equals file size (nothing new)", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const content = jsonl({ type: "user", message: "hello" });
		await Bun.write(path, content);

		const result = await readDeltaTranscript(path, Buffer.byteLength(content));
		expect(result).toBeNull();
	});

	test("resets to 0 when offset exceeds file size (file replaced)", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const content = jsonl({ type: "user", message: "new session" });
		await Bun.write(path, content);

		// Offset way beyond file size — should reset and read full file
		const result = await readDeltaTranscript(path, 999_999);
		expect(result).not.toBeNull();
		expect(result!.transcript).toContain("new session");
	});

	test("skips partial first line at slice boundary", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const line1 = JSON.stringify({ type: "user", message: "first" });
		const line2 = JSON.stringify({ type: "user", message: "second" });
		const content = line1 + "\n" + line2 + "\n";
		await Bun.write(path, content);

		// Slice into the middle of line1 — should skip the partial line, get line2
		const midOffset = Math.floor(line1.length / 2);
		const result = await readDeltaTranscript(path, midOffset);
		expect(result).not.toBeNull();
		expect(result!.transcript).toContain("second");
		expect(result!.transcript).not.toContain('"message":"first"');
	});

	test("returns empty transcript when delta has no user/assistant turns", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const first = jsonl({ type: "user", message: "hello" });
		await Bun.write(path, first);
		const offset = Buffer.byteLength(first);

		// Append only system lines
		const second = jsonl({ type: "system", data: "metadata" });
		await Bun.write(path, first + second);

		const result = await readDeltaTranscript(path, offset);
		expect(result).not.toBeNull();
		expect(result!.transcript).toBe("");
		expect(result!.newByteOffset).toBe(Buffer.byteLength(first + second));
	});

	test("handles multi-byte UTF-8 characters", async () => {
		const path = join(tempDir, "transcript.jsonl");
		const first = jsonl({ type: "user", message: "café ☕" });
		await Bun.write(path, first);
		const offset = Buffer.byteLength(first);

		const second = jsonl({ type: "assistant", message: "日本語テスト 🎉" });
		await Bun.write(path, first + second);

		const result = await readDeltaTranscript(path, offset);
		expect(result).not.toBeNull();
		expect(result!.transcript).toContain("日本語テスト");
		expect(result!.transcript).not.toContain("café");
	});
});

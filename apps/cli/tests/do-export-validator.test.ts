import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDoExports } from "../src/lib/do-export-validator.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "do-export-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("validateDoExports", () => {
	test("returns empty when all classes exported", async () => {
		await Bun.write(
			join(tempDir, "index.js"),
			`export class Counter { fetch() {} }\nexport class ChatRoom { fetch() {} }\nexport default { fetch() {} };`,
		);
		const missing = await validateDoExports(tempDir, "index.js", ["Counter", "ChatRoom"]);
		expect(missing).toEqual([]);
	});

	test("returns missing class names", async () => {
		await Bun.write(
			join(tempDir, "index.js"),
			`export class Counter { fetch() {} }\nexport default { fetch() {} };`,
		);
		const missing = await validateDoExports(tempDir, "index.js", ["Counter", "ChatRoom"]);
		expect(missing).toEqual(["ChatRoom"]);
	});

	test("detects class present but not exported", async () => {
		await Bun.write(
			join(tempDir, "index.js"),
			`class Counter { fetch() {} }\nexport default { fetch() {} };`,
		);
		const missing = await validateDoExports(tempDir, "index.js", ["Counter"]);
		expect(missing).toEqual(["Counter"]);
	});
});

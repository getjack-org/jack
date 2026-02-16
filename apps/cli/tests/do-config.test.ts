import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBindings } from "../src/lib/binding-validator.ts";
import { ensureMigrations, ensureNodejsCompat } from "../src/lib/do-config.ts";
import { parseJsonc } from "../src/lib/jsonc.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "do-config-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<string> {
	const path = join(tempDir, "wrangler.jsonc");
	await Bun.write(path, content);
	return path;
}

async function readConfig(path: string) {
	return parseJsonc(await Bun.file(path).text());
}

// --- ensureNodejsCompat ---

describe("ensureNodejsCompat", () => {
	test("adds compatibility_flags when missing entirely", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"durable_objects": {
		"bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
	}
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const modified = await ensureNodejsCompat(path, config);

		expect(modified).toBe(true);
		const result: any = await readConfig(path);
		expect(result.compatibility_flags).toContain("nodejs_compat");
	});

	test("appends to existing flags array", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"compatibility_flags": ["some_other_flag"],
	"durable_objects": {
		"bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
	}
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const modified = await ensureNodejsCompat(path, config);

		expect(modified).toBe(true);
		const result: any = await readConfig(path);
		expect(result.compatibility_flags).toEqual(["some_other_flag", "nodejs_compat"]);
	});

	test("no-op when nodejs_compat already present", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"compatibility_flags": ["nodejs_compat"]
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const modified = await ensureNodejsCompat(path, config);

		expect(modified).toBe(false);
	});

	test("preserves comments", async () => {
		const path = await writeConfig(`{
	// project name
	"name": "test",
	"durable_objects": {
		"bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
	}
}`);
		const config = parseJsonc(await Bun.file(path).text());
		await ensureNodejsCompat(path, config);

		const raw = await Bun.file(path).text();
		expect(raw).toContain("// project name");
		expect(raw).toContain("nodejs_compat");
	});
});

// --- ensureMigrations ---

describe("ensureMigrations", () => {
	test("creates migrations section when missing", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"durable_objects": {
		"bindings": [
			{ "name": "COUNTER", "class_name": "Counter" },
			{ "name": "CHAT", "class_name": "ChatRoom" }
		]
	}
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const migrated = await ensureMigrations(path, config);

		expect(migrated).toEqual(["Counter", "ChatRoom"]);
		const result: any = await readConfig(path);
		expect(result.migrations).toHaveLength(1);
		expect(result.migrations[0].tag).toBe("v1");
		expect(result.migrations[0].new_sqlite_classes).toEqual(["Counter", "ChatRoom"]);
	});

	test("appends migration step for uncovered classes", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"durable_objects": {
		"bindings": [
			{ "name": "COUNTER", "class_name": "Counter" },
			{ "name": "LIMITER", "class_name": "RateLimiter" }
		]
	},
	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["Counter"] }
	]
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const migrated = await ensureMigrations(path, config);

		expect(migrated).toEqual(["RateLimiter"]);
		const result: any = await readConfig(path);
		expect(result.migrations).toHaveLength(2);
		expect(result.migrations[1].tag).toBe("v2");
		expect(result.migrations[1].new_sqlite_classes).toEqual(["RateLimiter"]);
	});

	test("no-op when all classes covered", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"durable_objects": {
		"bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
	},
	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["Counter"] }
	]
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const migrated = await ensureMigrations(path, config);

		expect(migrated).toEqual([]);
	});

	test("no-op when no DO bindings", async () => {
		const path = await writeConfig(`{ "name": "test" }`);
		const config = parseJsonc(await Bun.file(path).text());
		const migrated = await ensureMigrations(path, config);

		expect(migrated).toEqual([]);
	});
});

// --- new_classes rejection (binding validator) ---

describe("new_classes rejection", () => {
	test("rejects new_classes in migrations", () => {
		const config = {
			durable_objects: {
				bindings: [{ name: "COUNTER", class_name: "Counter" }],
			},
			compatibility_flags: ["nodejs_compat"],
			migrations: [{ tag: "v1", new_classes: ["Counter"] }],
		};
		const result = validateBindings(config as any, tempDir);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("new_sqlite_classes");
	});

	test("accepts new_sqlite_classes in migrations", () => {
		const config = {
			durable_objects: {
				bindings: [{ name: "COUNTER", class_name: "Counter" }],
			},
			compatibility_flags: ["nodejs_compat"],
			migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
		};
		const result = validateBindings(config as any, tempDir);

		expect(result.valid).toBe(true);
	});
});

// --- non-DO project regression ---

describe("non-DO project", () => {
	test("ensureMigrations skips when no durable_objects", async () => {
		const path = await writeConfig(`{
	"name": "test",
	"main": "src/index.ts"
}`);
		const config = parseJsonc(await Bun.file(path).text());
		const migrated = await ensureMigrations(path, config);

		expect(migrated).toEqual([]);
		const raw = await Bun.file(path).text();
		expect(raw).not.toContain("migrations");
	});

	test("validateBindings passes for non-DO project", () => {
		const config = { main: "src/index.ts" };
		const result = validateBindings(config as any, tempDir);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

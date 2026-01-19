/**
 * Unit tests for wrangler-config.ts
 *
 * Tests adding D1 bindings to wrangler.jsonc while preserving comments.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addD1Binding, getExistingD1Bindings, type D1BindingConfig } from "./wrangler-config.ts";

// ============================================================================
// Test Helpers
// ============================================================================

let testDir: string;

function createTestConfig(content: string): string {
	const configPath = join(testDir, "wrangler.jsonc");
	writeFileSync(configPath, content);
	return configPath;
}

async function readTestConfig(configPath: string): Promise<string> {
	return await Bun.file(configPath).text();
}

// ============================================================================
// Tests
// ============================================================================

describe("wrangler-config", () => {
	beforeEach(() => {
		testDir = join(tmpdir(), `wrangler-config-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("getExistingD1Bindings", () => {
		it("returns empty array when no d1_databases", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"main": "src/index.ts"
}`);

			const bindings = await getExistingD1Bindings(configPath);

			expect(bindings).toHaveLength(0);
		});

		it("returns existing D1 bindings", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db",
			"database_id": "abc-123"
		}
	]
}`);

			const bindings = await getExistingD1Bindings(configPath);

			expect(bindings).toHaveLength(1);
			expect(bindings[0]).toEqual({
				binding: "DB",
				database_name: "my-db",
				database_id: "abc-123",
			});
		});

		it("returns multiple D1 bindings", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "main-db",
			"database_id": "abc-123"
		},
		{
			"binding": "ANALYTICS_DB",
			"database_name": "analytics-db",
			"database_id": "def-456"
		}
	]
}`);

			const bindings = await getExistingD1Bindings(configPath);

			expect(bindings).toHaveLength(2);
			expect(bindings[0]?.binding).toBe("DB");
			expect(bindings[1]?.binding).toBe("ANALYTICS_DB");
		});

		it("filters out incomplete bindings", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db"
		}
	]
}`);

			const bindings = await getExistingD1Bindings(configPath);

			expect(bindings).toHaveLength(0);
		});

		it("throws error when config file does not exist", async () => {
			const configPath = join(testDir, "nonexistent.jsonc");

			expect(getExistingD1Bindings(configPath)).rejects.toThrow("wrangler.jsonc not found");
		});

		it("handles JSONC with comments", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	// Database configuration
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db", // main database
			"database_id": "abc-123"
		}
	]
}`);

			const bindings = await getExistingD1Bindings(configPath);

			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.binding).toBe("DB");
		});
	});

	describe("addD1Binding", () => {
		const testBinding: D1BindingConfig = {
			binding: "DB",
			database_name: "test-db",
			database_id: "abc-123-def-456",
		};

		it("throws error when config file does not exist", async () => {
			const configPath = join(testDir, "nonexistent.jsonc");

			expect(addD1Binding(configPath, testBinding)).rejects.toThrow("wrangler.jsonc not found");
		});

		it("adds d1_databases section when it does not exist", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"main": "src/index.ts"
}`);

			await addD1Binding(configPath, testBinding);

			const content = await readTestConfig(configPath);
			expect(content).toContain('"d1_databases"');
			expect(content).toContain('"binding": "DB"');
			expect(content).toContain('"database_name": "test-db"');
			expect(content).toContain('"database_id": "abc-123-def-456"');
		});

		it("appends to existing d1_databases array", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"d1_databases": [
		{
			"binding": "MAIN_DB",
			"database_name": "main-db",
			"database_id": "existing-id"
		}
	]
}`);

			await addD1Binding(configPath, {
				binding: "SECONDARY_DB",
				database_name: "secondary-db",
				database_id: "new-id",
			});

			const content = await readTestConfig(configPath);
			expect(content).toContain('"binding": "MAIN_DB"');
			expect(content).toContain('"binding": "SECONDARY_DB"');
		});

		it("preserves comments when adding d1_databases section", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	// This is the main entry point
	"main": "src/index.ts"
}`);

			await addD1Binding(configPath, testBinding);

			const content = await readTestConfig(configPath);
			expect(content).toContain("// This is the main entry point");
			expect(content).toContain('"d1_databases"');
		});

		it("preserves comments when appending to existing array", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	// Database configuration
	"d1_databases": [
		{
			"binding": "MAIN_DB",
			"database_name": "main-db", // Primary database
			"database_id": "existing-id"
		}
	]
}`);

			await addD1Binding(configPath, {
				binding: "SECONDARY_DB",
				database_name: "secondary-db",
				database_id: "new-id",
			});

			const content = await readTestConfig(configPath);
			expect(content).toContain("// Database configuration");
			expect(content).toContain("// Primary database");
			expect(content).toContain('"binding": "SECONDARY_DB"');
		});

		it("handles empty d1_databases array", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"d1_databases": []
}`);

			await addD1Binding(configPath, testBinding);

			const content = await readTestConfig(configPath);
			expect(content).toContain('"binding": "DB"');
		});

		it("handles real-world miniapp template format", async () => {
			const configPath = createTestConfig(`{
	"name": "jack-template",
	"main": "src/worker.ts",
	"compatibility_date": "2024-12-01",
	"assets": {
		"binding": "ASSETS",
		"directory": "dist/client",
		"not_found_handling": "single-page-application",
		// Required for dynamic routes (/share, /api/og) to work alongside static assets
		// Without this, Cloudflare serves static files directly, bypassing the worker
		"run_worker_first": true
	},
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "jack-template-db"
		}
	],
	"ai": {
		"binding": "AI"
	},
	"vars": {
		// Set this after first deploy - required for share embeds
		// Get your URL from: jack projects or wrangler deployments list
		// Example: "APP_URL": "https://my-app.username.workers.dev"
		"APP_URL": ""
	}
}`);

			await addD1Binding(configPath, {
				binding: "ANALYTICS_DB",
				database_name: "analytics-db",
				database_id: "analytics-uuid",
			});

			const content = await readTestConfig(configPath);
			// Verify original comments preserved
			expect(content).toContain("// Required for dynamic routes");
			expect(content).toContain("// Set this after first deploy");
			// Verify new binding added
			expect(content).toContain('"binding": "ANALYTICS_DB"');
			expect(content).toContain('"database_name": "analytics-db"');
		});

		it("produces valid JSON output", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"main": "src/index.ts"
}`);

			await addD1Binding(configPath, testBinding);

			const content = await readTestConfig(configPath);
			// Strip comments and parse
			const { parseJsonc } = await import("./jsonc.ts");
			const parsed = parseJsonc<{ d1_databases: D1BindingConfig[] }>(content);
			expect(parsed.d1_databases).toBeDefined();
			expect(parsed.d1_databases[0]?.binding).toBe("DB");
		});

		it("handles config with trailing comma", async () => {
			const configPath = createTestConfig(`{
	"name": "test-app",
	"main": "src/index.ts",
}`);

			await addD1Binding(configPath, testBinding);

			const content = await readTestConfig(configPath);
			const { parseJsonc } = await import("./jsonc.ts");
			const parsed = parseJsonc<{ d1_databases: D1BindingConfig[] }>(content);
			expect(parsed.d1_databases).toBeDefined();
		});
	});
});

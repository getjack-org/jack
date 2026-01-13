/**
 * Unit tests for project-link.ts
 *
 * Tests the .jack/project.json linking system.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ensureGitignored,
	generateByoProjectId,
	getDeployMode,
	getJackDir,
	getProjectId,
	getProjectLinkPath,
	getTemplatePath,
	isLinked,
	linkProject,
	readProjectLink,
	readTemplateMetadata,
	unlinkProject,
	updateProjectLink,
	writeTemplateMetadata,
} from "./project-link.ts";

let testDir: string;

/**
 * Create a unique temp directory for each test
 */
async function createTestDir(): Promise<string> {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(7);
	const dir = join(tmpdir(), `jack-link-test-${timestamp}-${random}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("project-link", () => {
	beforeEach(async () => {
		testDir = await createTestDir();
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("path helpers", () => {
		it("getJackDir returns correct path", () => {
			const jackDir = getJackDir(testDir);
			expect(jackDir).toBe(join(testDir, ".jack"));
		});

		it("getProjectLinkPath returns correct path", () => {
			const linkPath = getProjectLinkPath(testDir);
			expect(linkPath).toBe(join(testDir, ".jack", "project.json"));
		});

		it("getTemplatePath returns correct path", () => {
			const templatePath = getTemplatePath(testDir);
			expect(templatePath).toBe(join(testDir, ".jack", "template.json"));
		});
	});

	describe("generateByoProjectId", () => {
		it("generates unique IDs", () => {
			const id1 = generateByoProjectId();
			const id2 = generateByoProjectId();

			expect(id1).not.toBe(id2);
		});

		it("generates IDs with byo_ prefix", () => {
			const id = generateByoProjectId();
			expect(id.startsWith("byo_")).toBe(true);
		});

		it("generates valid format", () => {
			const id = generateByoProjectId();
			// Format: byo_<uuid-like>
			expect(id.length).toBeGreaterThan(10);
			expect(id).toMatch(/^byo_[a-f0-9-]+$/);
		});
	});

	describe("linkProject", () => {
		it("creates .jack directory and project.json", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const jackDir = getJackDir(testDir);
			const linkPath = getProjectLinkPath(testDir);

			expect(existsSync(jackDir)).toBe(true);
			expect(existsSync(linkPath)).toBe(true);
		});

		it("writes correct managed project data", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const link = await readProjectLink(testDir);

			expect(link).not.toBeNull();
			expect(link?.version).toBe(1);
			expect(link?.project_id).toBe("proj_abc123");
			expect(link?.deploy_mode).toBe("managed");
			expect(link?.linked_at).toBeDefined();
		});

		it("writes correct BYO project data", async () => {
			const byoId = generateByoProjectId();
			await linkProject(testDir, byoId, "byo");

			const link = await readProjectLink(testDir);

			expect(link).not.toBeNull();
			expect(link?.version).toBe(1);
			expect(link?.project_id).toBe(byoId);
			expect(link?.deploy_mode).toBe("byo");
		});

		it("overwrites existing link", async () => {
			await linkProject(testDir, "proj_old", "managed");
			await linkProject(testDir, "proj_new", "byo");

			const link = await readProjectLink(testDir);

			expect(link?.project_id).toBe("proj_new");
			expect(link?.deploy_mode).toBe("byo");
		});

		it("auto-adds .jack/ to .gitignore", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const gitignorePath = join(testDir, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);

			const content = await readFile(gitignorePath, "utf-8");
			expect(content).toContain(".jack/");
		});
	});

	describe("unlinkProject", () => {
		it("removes .jack directory", async () => {
			await linkProject(testDir, "proj_abc123", "managed");
			expect(existsSync(getJackDir(testDir))).toBe(true);

			await unlinkProject(testDir);
			expect(existsSync(getJackDir(testDir))).toBe(false);
		});

		it("handles non-existent .jack directory gracefully", async () => {
			// Should not throw
			await unlinkProject(testDir);
			expect(existsSync(getJackDir(testDir))).toBe(false);
		});

		it("removes template.json along with project.json", async () => {
			await linkProject(testDir, "proj_abc123", "managed");
			await writeTemplateMetadata(testDir, { type: "builtin", name: "miniapp" });

			expect(existsSync(getTemplatePath(testDir))).toBe(true);

			await unlinkProject(testDir);
			expect(existsSync(getTemplatePath(testDir))).toBe(false);
		});
	});

	describe("readProjectLink", () => {
		it("returns null for non-existent directory", async () => {
			const link = await readProjectLink(join(testDir, "nonexistent"));
			expect(link).toBeNull();
		});

		it("returns null for directory without .jack", async () => {
			const link = await readProjectLink(testDir);
			expect(link).toBeNull();
		});

		it("returns null for invalid JSON", async () => {
			const jackDir = getJackDir(testDir);
			await mkdir(jackDir, { recursive: true });
			await writeFile(getProjectLinkPath(testDir), "{ invalid json");

			const link = await readProjectLink(testDir);
			expect(link).toBeNull();
		});

		it("returns null for missing required fields", async () => {
			const jackDir = getJackDir(testDir);
			await mkdir(jackDir, { recursive: true });
			await writeFile(getProjectLinkPath(testDir), JSON.stringify({ version: 1 }));

			const link = await readProjectLink(testDir);
			expect(link).toBeNull();
		});

		it("returns valid link data", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const link = await readProjectLink(testDir);

			expect(link).not.toBeNull();
			expect(link?.project_id).toBe("proj_abc123");
		});
	});

	describe("isLinked", () => {
		it("returns false for unlinked directory", async () => {
			const linked = await isLinked(testDir);
			expect(linked).toBe(false);
		});

		it("returns true for linked directory", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const linked = await isLinked(testDir);
			expect(linked).toBe(true);
		});

		it("returns false for corrupted link", async () => {
			const jackDir = getJackDir(testDir);
			await mkdir(jackDir, { recursive: true });
			await writeFile(getProjectLinkPath(testDir), "not json");

			const linked = await isLinked(testDir);
			expect(linked).toBe(false);
		});
	});

	describe("getProjectId", () => {
		it("returns null for unlinked directory", async () => {
			const id = await getProjectId(testDir);
			expect(id).toBeNull();
		});

		it("returns project ID for linked directory", async () => {
			await linkProject(testDir, "proj_xyz789", "managed");

			const id = await getProjectId(testDir);
			expect(id).toBe("proj_xyz789");
		});
	});

	describe("getDeployMode", () => {
		it("returns 'byo' for unlinked directory (default)", async () => {
			const mode = await getDeployMode(testDir);
			expect(mode).toBe("byo");
		});

		it("returns 'managed' for managed project", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const mode = await getDeployMode(testDir);
			expect(mode).toBe("managed");
		});

		it("returns 'byo' for BYO project", async () => {
			await linkProject(testDir, "byo_123", "byo");

			const mode = await getDeployMode(testDir);
			expect(mode).toBe("byo");
		});
	});

	describe("ensureGitignored", () => {
		it("creates .gitignore if not exists", async () => {
			await ensureGitignored(testDir);

			const gitignorePath = join(testDir, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);

			const content = await readFile(gitignorePath, "utf-8");
			expect(content).toContain(".jack/");
			expect(content).toContain("# Jack project link");
		});

		it("appends to existing .gitignore", async () => {
			const gitignorePath = join(testDir, ".gitignore");
			await writeFile(gitignorePath, "node_modules/\n");

			await ensureGitignored(testDir);

			const content = await readFile(gitignorePath, "utf-8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".jack/");
		});

		it("does not duplicate .jack/ entry", async () => {
			await ensureGitignored(testDir);
			await ensureGitignored(testDir); // Call twice

			const gitignorePath = join(testDir, ".gitignore");
			const content = await readFile(gitignorePath, "utf-8");

			// Count occurrences of .jack/
			const matches = content.match(/\.jack\//g) || [];
			expect(matches.length).toBe(1);
		});

		it("recognizes .jack without trailing slash", async () => {
			const gitignorePath = join(testDir, ".gitignore");
			await writeFile(gitignorePath, ".jack\n");

			await ensureGitignored(testDir);

			const content = await readFile(gitignorePath, "utf-8");
			// Should not add another entry since .jack is present
			const matches = content.match(/\.jack/g) || [];
			expect(matches.length).toBe(1);
		});

		it("handles .gitignore without trailing newline", async () => {
			const gitignorePath = join(testDir, ".gitignore");
			await writeFile(gitignorePath, "node_modules/"); // No trailing newline

			await ensureGitignored(testDir);

			const content = await readFile(gitignorePath, "utf-8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".jack/");
		});
	});

	describe("writeTemplateMetadata", () => {
		it("creates template.json for builtin template", async () => {
			await writeTemplateMetadata(testDir, { type: "builtin", name: "miniapp" });

			const templatePath = getTemplatePath(testDir);
			expect(existsSync(templatePath)).toBe(true);

			const template = await readTemplateMetadata(testDir);
			expect(template).toEqual({ type: "builtin", name: "miniapp" });
		});

		it("creates template.json for published template", async () => {
			await writeTemplateMetadata(testDir, {
				type: "published",
				name: "alice/my-api",
			});

			const template = await readTemplateMetadata(testDir);
			expect(template).toEqual({ type: "published", name: "alice/my-api" });
		});

		it("creates .jack directory if not exists", async () => {
			await writeTemplateMetadata(testDir, { type: "builtin", name: "api" });

			expect(existsSync(getJackDir(testDir))).toBe(true);
		});
	});

	describe("readTemplateMetadata", () => {
		it("returns null for non-existent template.json", async () => {
			const template = await readTemplateMetadata(testDir);
			expect(template).toBeNull();
		});

		it("returns null for invalid JSON", async () => {
			await mkdir(getJackDir(testDir), { recursive: true });
			await writeFile(getTemplatePath(testDir), "not json");

			const template = await readTemplateMetadata(testDir);
			expect(template).toBeNull();
		});

		it("returns null for missing required fields", async () => {
			await mkdir(getJackDir(testDir), { recursive: true });
			await writeFile(getTemplatePath(testDir), JSON.stringify({ type: "builtin" }));

			const template = await readTemplateMetadata(testDir);
			expect(template).toBeNull();
		});

		it("returns valid template data", async () => {
			await writeTemplateMetadata(testDir, { type: "builtin", name: "hello" });

			const template = await readTemplateMetadata(testDir);
			expect(template).toEqual({ type: "builtin", name: "hello" });
		});
	});

	describe("updateProjectLink", () => {
		it("updates existing link", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			// Get original linked_at
			const original = await readProjectLink(testDir);
			expect(original).not.toBeNull();

			// Update with new linked_at
			await updateProjectLink(testDir, { linked_at: "2024-01-01T00:00:00.000Z" });

			const updated = await readProjectLink(testDir);
			expect(updated?.project_id).toBe("proj_abc123"); // Unchanged
			expect(updated?.deploy_mode).toBe("managed"); // Unchanged
			expect(updated?.linked_at).toBe("2024-01-01T00:00:00.000Z"); // Updated
		});

		it("throws error for unlinked directory", async () => {
			await expect(
				updateProjectLink(testDir, { linked_at: "2024-01-01T00:00:00.000Z" }),
			).rejects.toThrow("Project is not linked");
		});

		it("can update project_id", async () => {
			await linkProject(testDir, "proj_old", "managed");
			await updateProjectLink(testDir, { project_id: "proj_new" });

			const link = await readProjectLink(testDir);
			expect(link?.project_id).toBe("proj_new");
		});

		it("can update deploy_mode", async () => {
			await linkProject(testDir, "proj_abc123", "managed");
			await updateProjectLink(testDir, { deploy_mode: "byo" });

			const link = await readProjectLink(testDir);
			expect(link?.deploy_mode).toBe("byo");
		});
	});

	describe("edge cases", () => {
		it("handles paths with spaces", async () => {
			const spacePath = join(testDir, "path with spaces");
			await mkdir(spacePath, { recursive: true });

			await linkProject(spacePath, "proj_spaces", "managed");

			const linked = await isLinked(spacePath);
			expect(linked).toBe(true);
		});

		it("handles nested directories", async () => {
			const nestedPath = join(testDir, "a", "b", "c", "project");
			await mkdir(nestedPath, { recursive: true });

			await linkProject(nestedPath, "proj_nested", "managed");

			const link = await readProjectLink(nestedPath);
			expect(link?.project_id).toBe("proj_nested");
		});

		it("preserves ISO date format in linked_at", async () => {
			await linkProject(testDir, "proj_abc123", "managed");

			const link = await readProjectLink(testDir);
			expect(link).not.toBeNull();
			// Should be valid ISO 8601 date
			if (link) {
				expect(new Date(link.linked_at).toISOString()).toBe(link.linked_at);
			}
		});
	});
});

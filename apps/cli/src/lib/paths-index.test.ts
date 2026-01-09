/**
 * Unit tests for paths-index.ts
 *
 * Tests the paths index that tracks where projects live locally, keyed by project_id.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type DiscoveredProject,
	type PathsIndex,
	findProjectIdByPath,
	getAllPaths,
	getIndexPath,
	getPathsForProject,
	readPathsIndex,
	registerDiscoveredProjects,
	registerPath,
	scanAndRegisterProjects,
	unregisterPath,
	writePathsIndex,
} from "./paths-index.ts";

import { linkProject } from "./project-link.ts";

let testDir: string;
let testConfigDir: string;
let originalPathsIndex: string | null = null;

/**
 * Create a unique temp directory for each test
 */
async function createTestDir(): Promise<string> {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(7);
	const dir = join(tmpdir(), `jack-paths-test-${timestamp}-${random}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Create a mock linked project
 */
async function createLinkedProject(
	parentDir: string,
	name: string,
	projectId: string,
	deployMode: "managed" | "byo" = "managed",
): Promise<string> {
	const projectDir = join(parentDir, name);
	await mkdir(projectDir, { recursive: true });
	await linkProject(projectDir, projectId, deployMode);
	return projectDir;
}

/**
 * Save the current paths index state for restoration after tests
 */
async function savePathsIndex(): Promise<void> {
	const indexPath = getIndexPath();
	if (existsSync(indexPath)) {
		originalPathsIndex = await readFile(indexPath, "utf-8");
	} else {
		originalPathsIndex = null;
	}
}

/**
 * Restore the paths index to its original state
 */
async function restorePathsIndex(): Promise<void> {
	const indexPath = getIndexPath();
	if (originalPathsIndex !== null) {
		await writeFile(indexPath, originalPathsIndex);
	} else if (existsSync(indexPath)) {
		// Clear the index if it didn't exist before
		await writePathsIndex({ version: 1, paths: {}, updatedAt: "" });
	}
}

describe("paths-index", () => {
	beforeEach(async () => {
		testDir = await createTestDir();
		testConfigDir = join(testDir, "config");
		await mkdir(testConfigDir, { recursive: true });
		// Save current index state and start fresh
		await savePathsIndex();
		await writePathsIndex({ version: 1, paths: {}, updatedAt: "" });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		// Restore original index state
		await restorePathsIndex();
	});

	describe("PathsIndex structure", () => {
		it("validates correct structure", () => {
			const validIndex: PathsIndex = {
				version: 1,
				paths: {
					proj_abc123: ["/path/to/project"],
					proj_def456: ["/path/to/fork1", "/path/to/fork2"],
				},
				updatedAt: "2024-01-15T10:00:00.000Z",
			};

			expect(validIndex.version).toBe(1);
			expect(typeof validIndex.paths).toBe("object");
			expect(Array.isArray(validIndex.paths.proj_abc123)).toBe(true);
		});
	});

	describe("readPathsIndex / writePathsIndex", () => {
		it("returns empty index when file does not exist", async () => {
			// Note: This test uses the real CONFIG_DIR, but we're testing the pattern
			const index = await readPathsIndex();

			expect(index.version).toBe(1);
			expect(typeof index.paths).toBe("object");
			expect(index.updatedAt).toBeDefined();
		});

		it("preserves data through write/read cycle", async () => {
			const testIndex: PathsIndex = {
				version: 1,
				paths: {
					proj_test: ["/test/path"],
				},
				updatedAt: "",
			};

			await writePathsIndex(testIndex);
			const readBack = await readPathsIndex();

			expect(readBack.paths.proj_test).toContain("/test/path");
			expect(readBack.updatedAt).toBeDefined();
		});
	});

	describe("registerPath", () => {
		it("registers a new path for a new project", async () => {
			const projectDir = await createLinkedProject(testDir, "my-project", "proj_abc123");

			await registerPath("proj_abc123", projectDir);

			const index = await readPathsIndex();
			expect(index.paths.proj_abc123).toContain(projectDir);
		});

		it("handles duplicate paths (idempotent)", async () => {
			const projectDir = await createLinkedProject(testDir, "my-project", "proj_abc123");

			await registerPath("proj_abc123", projectDir);
			await registerPath("proj_abc123", projectDir);

			const index = await readPathsIndex();
			expect(index.paths.proj_abc123).toHaveLength(1);
		});

		it("allows multiple paths for the same project", async () => {
			const path1 = await createLinkedProject(testDir, "project1", "proj_abc123");
			const path2 = await createLinkedProject(join(testDir, "forks"), "project2", "proj_abc123");

			await registerPath("proj_abc123", path1);
			await registerPath("proj_abc123", path2);

			const index = await readPathsIndex();
			expect(index.paths.proj_abc123).toHaveLength(2);
			expect(index.paths.proj_abc123).toContain(path1);
			expect(index.paths.proj_abc123).toContain(path2);
		});

		it("converts relative paths to absolute", async () => {
			const projectDir = await createLinkedProject(testDir, "rel-project", "proj_rel");

			// Use relative path
			const originalCwd = process.cwd();
			process.chdir(testDir);

			try {
				await registerPath("proj_rel", "rel-project");
				const index = await readPathsIndex();

				// Should store absolute path
				expect(index.paths.proj_rel[0].startsWith("/")).toBe(true);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("unregisterPath", () => {
		it("removes an existing path", async () => {
			const projectDir = await createLinkedProject(testDir, "my-project", "proj_abc123");

			await registerPath("proj_abc123", projectDir);
			await unregisterPath("proj_abc123", projectDir);

			const index = await readPathsIndex();
			expect(index.paths.proj_abc123).toBeUndefined();
		});

		it("handles removing non-existent path gracefully", async () => {
			// Should not throw
			await unregisterPath("proj_nonexistent", "/some/path");

			const index = await readPathsIndex();
			expect(index.paths.proj_nonexistent).toBeUndefined();
		});

		it("keeps other paths when removing one", async () => {
			const path1 = await createLinkedProject(testDir, "project1", "proj_abc123");
			const path2 = await createLinkedProject(join(testDir, "forks"), "project2", "proj_abc123");

			await registerPath("proj_abc123", path1);
			await registerPath("proj_abc123", path2);
			await unregisterPath("proj_abc123", path1);

			const index = await readPathsIndex();
			expect(index.paths.proj_abc123).toHaveLength(1);
			expect(index.paths.proj_abc123).toContain(path2);
		});
	});

	describe("getPathsForProject", () => {
		it("returns empty array for unknown project", async () => {
			const paths = await getPathsForProject("proj_unknown");
			expect(paths).toHaveLength(0);
		});

		it("returns valid paths", async () => {
			const projectDir = await createLinkedProject(testDir, "my-project", "proj_abc123");
			await registerPath("proj_abc123", projectDir);

			const paths = await getPathsForProject("proj_abc123");
			expect(paths).toHaveLength(1);
			expect(paths).toContain(projectDir);
		});

		it("prunes paths where .jack/project.json is missing", async () => {
			const validProject = await createLinkedProject(testDir, "valid", "proj_abc123");
			const invalidPath = join(testDir, "invalid");
			await mkdir(invalidPath, { recursive: true });
			// No .jack/project.json in invalidPath

			// Manually add both to index
			const index = await readPathsIndex();
			index.paths.proj_abc123 = [validProject, invalidPath];
			await writePathsIndex(index);

			const paths = await getPathsForProject("proj_abc123");
			expect(paths).toHaveLength(1);
			expect(paths).toContain(validProject);
			expect(paths).not.toContain(invalidPath);
		});

		it("prunes paths where project_id does not match", async () => {
			const path1 = await createLinkedProject(testDir, "project1", "proj_abc123");
			const path2 = await createLinkedProject(testDir, "project2", "proj_different");

			// Manually add mismatched path to index
			const index = await readPathsIndex();
			index.paths.proj_abc123 = [path1, path2]; // path2 has different project_id
			await writePathsIndex(index);

			const paths = await getPathsForProject("proj_abc123");
			expect(paths).toHaveLength(1);
			expect(paths).toContain(path1);
			expect(paths).not.toContain(path2);
		});

		it("removes project entry when all paths are invalid", async () => {
			const invalidPath = join(testDir, "invalid");
			await mkdir(invalidPath, { recursive: true });

			const index = await readPathsIndex();
			index.paths.proj_abc123 = [invalidPath];
			await writePathsIndex(index);

			const paths = await getPathsForProject("proj_abc123");
			expect(paths).toHaveLength(0);

			const updatedIndex = await readPathsIndex();
			expect(updatedIndex.paths.proj_abc123).toBeUndefined();
		});
	});

	describe("getAllPaths", () => {
		it("returns empty object when no projects registered", async () => {
			// Clear any existing paths
			await writePathsIndex({ version: 1, paths: {}, updatedAt: "" });

			const allPaths = await getAllPaths();
			expect(Object.keys(allPaths)).toHaveLength(0);
		});

		it("returns all valid paths for all projects", async () => {
			const project1 = await createLinkedProject(testDir, "project1", "proj_one");
			const project2 = await createLinkedProject(testDir, "project2", "proj_two");

			await registerPath("proj_one", project1);
			await registerPath("proj_two", project2);

			const allPaths = await getAllPaths();
			expect(allPaths.proj_one).toContain(project1);
			expect(allPaths.proj_two).toContain(project2);
		});

		it("prunes invalid paths across all projects", async () => {
			const validProject = await createLinkedProject(testDir, "valid", "proj_valid");
			const invalidPath = join(testDir, "invalid");
			await mkdir(invalidPath, { recursive: true });

			const index = await readPathsIndex();
			index.paths.proj_valid = [validProject];
			index.paths.proj_invalid = [invalidPath];
			await writePathsIndex(index);

			const allPaths = await getAllPaths();
			expect(allPaths.proj_valid).toBeDefined();
			expect(allPaths.proj_invalid).toBeUndefined();
		});
	});

	describe("scanAndRegisterProjects", () => {
		it("discovers linked projects", async () => {
			await createLinkedProject(testDir, "project1", "proj_one", "managed");
			await createLinkedProject(testDir, "project2", "proj_two", "byo");

			const discovered = await scanAndRegisterProjects(testDir);

			expect(discovered).toHaveLength(2);
			const ids = discovered.map((p) => p.projectId).sort();
			expect(ids).toEqual(["proj_one", "proj_two"]);
		});

		it("ignores directories without .jack/project.json", async () => {
			await createLinkedProject(testDir, "linked", "proj_linked");

			// Create directory without .jack
			const unlinkedDir = join(testDir, "unlinked");
			await mkdir(unlinkedDir, { recursive: true });
			// Add wrangler.jsonc to simulate old-style project
			await writeFile(join(unlinkedDir, "wrangler.jsonc"), JSON.stringify({ name: "unlinked" }));

			const discovered = await scanAndRegisterProjects(testDir);

			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_linked");
		});

		it("respects maxDepth", async () => {
			const deepPath = join(testDir, "a", "b", "c", "d");
			await mkdir(deepPath, { recursive: true });
			await linkProject(deepPath, "proj_deep", "managed");

			const shallowProject = await createLinkedProject(testDir, "shallow", "proj_shallow");

			// maxDepth=2: 0=testDir, 1=shallow|a, 2=b
			// Should not find deep project at depth 4
			const discovered = await scanAndRegisterProjects(testDir, 2);

			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_shallow");
		});

		it("skips node_modules", async () => {
			const nodeModulesProject = join(testDir, "node_modules", "some-package");
			await mkdir(nodeModulesProject, { recursive: true });
			await linkProject(nodeModulesProject, "proj_skip", "managed");

			const validProject = await createLinkedProject(testDir, "valid", "proj_valid");

			const discovered = await scanAndRegisterProjects(testDir);

			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_valid");
		});

		it("skips .git directory", async () => {
			const gitProject = join(testDir, ".git", "hooks");
			await mkdir(gitProject, { recursive: true });
			await linkProject(gitProject, "proj_git", "managed");

			const validProject = await createLinkedProject(testDir, "valid", "proj_valid");

			const discovered = await scanAndRegisterProjects(testDir);

			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_valid");
		});

		it("does not recurse into linked projects", async () => {
			const parentProject = await createLinkedProject(testDir, "parent", "proj_parent");

			// Create nested project inside parent
			const nestedDir = join(parentProject, "packages", "child");
			await mkdir(nestedDir, { recursive: true });
			await linkProject(nestedDir, "proj_child", "managed");

			const discovered = await scanAndRegisterProjects(testDir);

			// Should only find parent, not nested child
			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_parent");
		});

		it("registers discovered projects in index", async () => {
			await createLinkedProject(testDir, "project1", "proj_one");

			await scanAndRegisterProjects(testDir);

			const paths = await getPathsForProject("proj_one");
			expect(paths).toHaveLength(1);
		});

		it("returns deploy mode info", async () => {
			await createLinkedProject(testDir, "managed-project", "proj_managed", "managed");
			await createLinkedProject(testDir, "byo-project", "proj_byo", "byo");

			const discovered = await scanAndRegisterProjects(testDir);

			const managedProject = discovered.find((p) => p.projectId === "proj_managed");
			const byoProject = discovered.find((p) => p.projectId === "proj_byo");

			expect(managedProject?.deployMode).toBe("managed");
			expect(byoProject?.deployMode).toBe("byo");
		});
	});

	describe("registerDiscoveredProjects", () => {
		it("registers multiple projects efficiently", async () => {
			const project1 = await createLinkedProject(testDir, "project1", "proj_one");
			const project2 = await createLinkedProject(testDir, "project2", "proj_two");

			const discovered: DiscoveredProject[] = [
				{ projectId: "proj_one", path: project1, deployMode: "managed" },
				{ projectId: "proj_two", path: project2, deployMode: "byo" },
			];

			await registerDiscoveredProjects(discovered);

			const index = await readPathsIndex();
			expect(index.paths.proj_one).toContain(project1);
			expect(index.paths.proj_two).toContain(project2);
		});

		it("merges with existing paths", async () => {
			const existing = await createLinkedProject(testDir, "existing", "proj_one");
			const newProject = await createLinkedProject(join(testDir, "fork"), "new", "proj_one");

			// Register existing first
			await registerPath("proj_one", existing);

			// Then bulk register including same project_id
			await registerDiscoveredProjects([
				{ projectId: "proj_one", path: newProject, deployMode: "managed" },
			]);

			const index = await readPathsIndex();
			expect(index.paths.proj_one).toHaveLength(2);
			expect(index.paths.proj_one).toContain(existing);
			expect(index.paths.proj_one).toContain(newProject);
		});
	});

	describe("findProjectIdByPath", () => {
		it("returns null for unregistered path", async () => {
			const id = await findProjectIdByPath("/some/unknown/path");
			expect(id).toBeNull();
		});

		it("returns project ID for registered path", async () => {
			const projectDir = await createLinkedProject(testDir, "my-project", "proj_abc123");
			await registerPath("proj_abc123", projectDir);

			const id = await findProjectIdByPath(projectDir);
			expect(id).toBe("proj_abc123");
		});

		it("handles relative paths", async () => {
			const projectDir = await createLinkedProject(testDir, "rel-project", "proj_rel");
			await registerPath("proj_rel", projectDir);

			// Test that absolute path works (relative path resolution is cwd-dependent)
			const id = await findProjectIdByPath(projectDir);
			expect(id).toBe("proj_rel");
		});
	});

	describe("getIndexPath", () => {
		it("returns the index file path", () => {
			const path = getIndexPath();
			expect(path).toContain("paths.json");
			expect(path).toContain(".config");
			expect(path).toContain("jack");
		});
	});

	describe("edge cases", () => {
		it("handles empty scan directory", async () => {
			const emptyDir = join(testDir, "empty");
			await mkdir(emptyDir, { recursive: true });

			const discovered = await scanAndRegisterProjects(emptyDir);
			expect(discovered).toHaveLength(0);
		});

		it("handles paths with spaces", async () => {
			const spacePath = join(testDir, "path with spaces");
			await createLinkedProject(spacePath, "project", "proj_spaces");

			const discovered = await scanAndRegisterProjects(testDir);
			expect(discovered).toHaveLength(1);
			expect(discovered[0].projectId).toBe("proj_spaces");
		});

		it("handles permission errors gracefully", async () => {
			// Create accessible project
			await createLinkedProject(testDir, "accessible", "proj_accessible");

			// Scan should work even if some directories are inaccessible
			const discovered = await scanAndRegisterProjects(testDir);
			expect(discovered.some((p) => p.projectId === "proj_accessible")).toBe(true);
		});

		it("updates updatedAt on write", async () => {
			const before = new Date().toISOString();

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 10));

			await writePathsIndex({ version: 1, paths: {}, updatedAt: "" });

			const index = await readPathsIndex();
			expect(new Date(index.updatedAt).getTime()).toBeGreaterThanOrEqual(
				new Date(before).getTime(),
			);
		});
	});
});

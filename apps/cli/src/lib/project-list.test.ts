/**
 * Unit tests for project-list.ts
 *
 * Tests the data layer and formatters for jack ls command.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";

import {
	type ProjectListItem,
	filterByStatus,
	groupProjects,
	shortenPath,
	sortByUpdated,
	toListItems,
	truncatePath,
} from "./project-list.ts";
import type { ResolvedProject } from "./project-resolver.ts";

// ============================================================================
// Test Data Factories
// ============================================================================

/**
 * Create a mock ResolvedProject for testing
 */
function createMockResolvedProject(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
	return {
		name: "test-project",
		slug: "test-project",
		status: "live",
		url: "https://test-project.runjack.xyz",
		sources: {
			controlPlane: true,
			filesystem: false,
		},
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-15T10:00:00.000Z",
		...overrides,
	};
}

/**
 * Create a mock ProjectListItem for testing
 */
function createMockListItem(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
	return {
		name: "test-project",
		status: "live",
		url: "https://test-project.runjack.xyz",
		localPath: null,
		updatedAt: "2024-01-15T10:00:00.000Z",
		isLocal: false,
		isCloudOnly: true,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("project-list", () => {
	describe("toListItems", () => {
		it("converts managed project to list item", () => {
			const managed = createMockResolvedProject({
				name: "my-api",
				status: "live",
				url: "https://my-api.runjack.xyz",
				sources: { controlPlane: true, filesystem: false },
				updatedAt: "2024-01-20T12:00:00.000Z",
			});

			const [item] = toListItems([managed]);

			expect(item).toBeDefined();
			expect(item?.name).toBe("my-api");
			expect(item?.status).toBe("live");
			expect(item?.url).toBe("https://my-api.runjack.xyz");
			expect(item?.localPath).toBeNull();
			expect(item?.updatedAt).toBe("2024-01-20T12:00:00.000Z");
			expect(item?.isLocal).toBe(false);
			expect(item?.isCloudOnly).toBe(true);
		});

		it("converts BYO/local-only project to list item", () => {
			const byo = createMockResolvedProject({
				name: "local-app",
				status: "local-only",
				url: undefined,
				localPath: "/Users/dev/projects/local-app",
				sources: { controlPlane: false, filesystem: true },
				deployMode: "byo",
			});

			const [item] = toListItems([byo]);

			expect(item).toBeDefined();
			expect(item?.name).toBe("local-app");
			expect(item?.status).toBe("local-only");
			expect(item?.url).toBeNull();
			expect(item?.localPath).toBe("/Users/dev/projects/local-app");
			expect(item?.isLocal).toBe(true);
			expect(item?.isCloudOnly).toBe(false);
		});

		it("handles error status with error message", () => {
			const errorProject = createMockResolvedProject({
				name: "broken-project",
				status: "error",
				errorMessage: "deployment failed",
				url: undefined,
			});

			const [item] = toListItems([errorProject]);

			expect(item).toBeDefined();
			expect(item?.status).toBe("error");
			expect(item?.errorMessage).toBe("deployment failed");
		});

		it("handles project with both local and cloud sources", () => {
			const hybrid = createMockResolvedProject({
				name: "hybrid-project",
				status: "live",
				url: "https://hybrid-project.runjack.xyz",
				localPath: "/Users/dev/projects/hybrid-project",
				sources: { controlPlane: true, filesystem: true },
			});

			const [item] = toListItems([hybrid]);

			expect(item).toBeDefined();
			expect(item?.isLocal).toBe(true);
			expect(item?.isCloudOnly).toBe(false);
			expect(item?.url).toBe("https://hybrid-project.runjack.xyz");
			expect(item?.localPath).toBe("/Users/dev/projects/hybrid-project");
		});

		it("converts multiple projects", () => {
			const projects = [
				createMockResolvedProject({ name: "project-a" }),
				createMockResolvedProject({ name: "project-b" }),
				createMockResolvedProject({ name: "project-c" }),
			];

			const items = toListItems(projects);

			expect(items).toHaveLength(3);
			expect(items.map((i) => i.name)).toEqual(["project-a", "project-b", "project-c"]);
		});

		it("handles empty array", () => {
			const items = toListItems([]);
			expect(items).toHaveLength(0);
		});

		it("handles syncing status", () => {
			const syncingProject = createMockResolvedProject({
				name: "syncing-project",
				status: "syncing",
			});

			const [item] = toListItems([syncingProject]);

			expect(item?.status).toBe("syncing");
		});
	});

	describe("sortByUpdated", () => {
		it("sorts items by updatedAt descending (most recent first)", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "oldest", updatedAt: "2024-01-01T00:00:00.000Z" }),
				createMockListItem({ name: "newest", updatedAt: "2024-01-20T00:00:00.000Z" }),
				createMockListItem({ name: "middle", updatedAt: "2024-01-10T00:00:00.000Z" }),
			];

			const sorted = sortByUpdated(items);

			expect(sorted.map((i) => i.name)).toEqual(["newest", "middle", "oldest"]);
		});

		it("puts items without dates at the end", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "no-date-1", updatedAt: null }),
				createMockListItem({ name: "has-date", updatedAt: "2024-01-15T00:00:00.000Z" }),
				createMockListItem({ name: "no-date-2", updatedAt: null }),
			];

			const sorted = sortByUpdated(items);

			expect(sorted[0]?.name).toBe("has-date");
			// Items without dates sorted alphabetically among themselves
			expect(sorted[1]?.name).toBe("no-date-1");
			expect(sorted[2]?.name).toBe("no-date-2");
		});

		it("sorts items without dates alphabetically by name", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "zebra", updatedAt: null }),
				createMockListItem({ name: "alpha", updatedAt: null }),
				createMockListItem({ name: "beta", updatedAt: null }),
			];

			const sorted = sortByUpdated(items);

			expect(sorted.map((i) => i.name)).toEqual(["alpha", "beta", "zebra"]);
		});

		it("handles all items having dates", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "a", updatedAt: "2024-01-05T00:00:00.000Z" }),
				createMockListItem({ name: "b", updatedAt: "2024-01-15T00:00:00.000Z" }),
			];

			const sorted = sortByUpdated(items);

			expect(sorted.map((i) => i.name)).toEqual(["b", "a"]);
		});

		it("handles all items without dates", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "charlie", updatedAt: null }),
				createMockListItem({ name: "alice", updatedAt: null }),
			];

			const sorted = sortByUpdated(items);

			expect(sorted.map((i) => i.name)).toEqual(["alice", "charlie"]);
		});

		it("does not mutate original array", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "b", updatedAt: "2024-01-01T00:00:00.000Z" }),
				createMockListItem({ name: "a", updatedAt: "2024-01-15T00:00:00.000Z" }),
			];

			const originalOrder = items.map((i) => i.name);
			sortByUpdated(items);

			expect(items.map((i) => i.name)).toEqual(originalOrder);
		});

		it("handles empty array", () => {
			const sorted = sortByUpdated([]);
			expect(sorted).toHaveLength(0);
		});
	});

	describe("groupProjects", () => {
		it("groups error projects into errors array", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "error-1", status: "error" }),
				createMockListItem({ name: "error-2", status: "error" }),
			];

			const grouped = groupProjects(items);

			expect(grouped.errors).toHaveLength(2);
			expect(grouped.local).toHaveLength(0);
			expect(grouped.cloudOnly).toHaveLength(0);
		});

		it("groups projects with localPath into local array", () => {
			const items: ProjectListItem[] = [
				createMockListItem({
					name: "local-1",
					status: "live",
					localPath: "/path/to/local-1",
					isLocal: true,
					isCloudOnly: false,
				}),
				createMockListItem({
					name: "local-2",
					status: "local-only",
					localPath: "/path/to/local-2",
					isLocal: true,
					isCloudOnly: false,
				}),
			];

			const grouped = groupProjects(items);

			expect(grouped.local).toHaveLength(2);
			expect(grouped.errors).toHaveLength(0);
			expect(grouped.cloudOnly).toHaveLength(0);
		});

		it("groups cloud-only projects into cloudOnly array", () => {
			const items: ProjectListItem[] = [
				createMockListItem({
					name: "cloud-1",
					status: "live",
					localPath: null,
					isLocal: false,
					isCloudOnly: true,
				}),
				createMockListItem({
					name: "cloud-2",
					status: "live",
					localPath: null,
					isLocal: false,
					isCloudOnly: true,
				}),
			];

			const grouped = groupProjects(items);

			expect(grouped.cloudOnly).toHaveLength(2);
			expect(grouped.errors).toHaveLength(0);
			expect(grouped.local).toHaveLength(0);
		});

		it("groups mixed projects correctly", () => {
			const items: ProjectListItem[] = [
				createMockListItem({ name: "error-proj", status: "error" }),
				createMockListItem({
					name: "local-proj",
					status: "live",
					localPath: "/path/to/local",
					isLocal: true,
					isCloudOnly: false,
				}),
				createMockListItem({
					name: "cloud-proj",
					status: "live",
					localPath: null,
					isLocal: false,
					isCloudOnly: true,
				}),
			];

			const grouped = groupProjects(items);

			expect(grouped.errors).toHaveLength(1);
			expect(grouped.errors[0]?.name).toBe("error-proj");
			expect(grouped.local).toHaveLength(1);
			expect(grouped.local[0]?.name).toBe("local-proj");
			expect(grouped.cloudOnly).toHaveLength(1);
			expect(grouped.cloudOnly[0]?.name).toBe("cloud-proj");
		});

		it("error status takes precedence over local/cloud categorization", () => {
			const items: ProjectListItem[] = [
				createMockListItem({
					name: "error-with-local-path",
					status: "error",
					localPath: "/path/to/project",
					isLocal: true,
					isCloudOnly: false,
				}),
			];

			const grouped = groupProjects(items);

			expect(grouped.errors).toHaveLength(1);
			expect(grouped.local).toHaveLength(0);
		});

		it("handles empty array", () => {
			const grouped = groupProjects([]);

			expect(grouped.errors).toHaveLength(0);
			expect(grouped.local).toHaveLength(0);
			expect(grouped.cloudOnly).toHaveLength(0);
		});

		it("projects that are neither local nor cloudOnly are excluded", () => {
			const items: ProjectListItem[] = [
				createMockListItem({
					name: "orphan",
					status: "syncing",
					localPath: null,
					isLocal: false,
					isCloudOnly: false,
				}),
			];

			const grouped = groupProjects(items);

			expect(grouped.errors).toHaveLength(0);
			expect(grouped.local).toHaveLength(0);
			expect(grouped.cloudOnly).toHaveLength(0);
		});
	});

	describe("filterByStatus", () => {
		const mixedItems: ProjectListItem[] = [
			createMockListItem({ name: "live-1", status: "live" }),
			createMockListItem({ name: "live-2", status: "live" }),
			createMockListItem({ name: "error-1", status: "error" }),
			createMockListItem({ name: "local-only-1", status: "local-only" }),
			createMockListItem({ name: "syncing-1", status: "syncing" }),
		];

		it("filters by 'error' status", () => {
			const filtered = filterByStatus(mixedItems, "error");

			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.name).toBe("error-1");
		});

		it("filters by 'live' status", () => {
			const filtered = filterByStatus(mixedItems, "live");

			expect(filtered).toHaveLength(2);
			expect(filtered.map((i) => i.name)).toEqual(["live-1", "live-2"]);
		});

		it("filters by 'local-only' status", () => {
			const filtered = filterByStatus(mixedItems, "local-only");

			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.name).toBe("local-only-1");
		});

		it("treats 'local' as alias for 'local-only'", () => {
			const filtered = filterByStatus(mixedItems, "local");

			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.name).toBe("local-only-1");
		});

		it("filters by 'syncing' status", () => {
			const filtered = filterByStatus(mixedItems, "syncing");

			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.name).toBe("syncing-1");
		});

		it("returns empty array for non-matching status", () => {
			const filtered = filterByStatus(mixedItems, "nonexistent");

			expect(filtered).toHaveLength(0);
		});

		it("handles empty array", () => {
			const filtered = filterByStatus([], "live");

			expect(filtered).toHaveLength(0);
		});
	});

	describe("shortenPath", () => {
		it("replaces home directory with ~", () => {
			const home = homedir();
			const path = `${home}/projects/my-app`;

			const shortened = shortenPath(path);

			expect(shortened).toBe("~/projects/my-app");
		});

		it("handles home directory root", () => {
			const home = homedir();

			const shortened = shortenPath(home);

			expect(shortened).toBe("~");
		});

		it("leaves paths not in home directory unchanged", () => {
			const path = "/var/www/my-app";

			const shortened = shortenPath(path);

			expect(shortened).toBe("/var/www/my-app");
		});

		it("leaves relative paths unchanged", () => {
			const path = "projects/my-app";

			const shortened = shortenPath(path);

			expect(shortened).toBe("projects/my-app");
		});

		it("handles nested home directory paths", () => {
			const home = homedir();
			const path = `${home}/a/b/c/d/project`;

			const shortened = shortenPath(path);

			expect(shortened).toBe("~/a/b/c/d/project");
		});

		it("handles path starting with home prefix (current behavior replaces)", () => {
			const home = homedir();
			// Note: Current implementation replaces any path starting with home string
			// e.g., if home is /Users/alice, /Users/alicesmith becomes ~smith
			// This tests the current behavior - a stricter implementation would check for /
			const fakePath = `${home}smith/project`;

			const shortened = shortenPath(fakePath);

			// Current behavior: replaces the home prefix regardless of directory boundary
			expect(shortened).toBe("~smith/project");
		});
	});

	describe("truncatePath", () => {
		it("returns short paths unchanged", () => {
			const path = "~/projects/app";

			const truncated = truncatePath(path, 50);

			expect(truncated).toBe("~/projects/app");
		});

		it("truncates long paths with ... in middle", () => {
			const path = "~/very/long/directory/path/to/my/project";

			const truncated = truncatePath(path, 25);

			expect(truncated).toContain("...");
			expect(truncated.length).toBeLessThanOrEqual(25);
		});

		it("keeps first and last parts when truncating", () => {
			const path = "~/first/middle1/middle2/middle3/last";

			const truncated = truncatePath(path, 20);

			expect(truncated).toContain("~");
			expect(truncated).toContain("last");
			expect(truncated).toContain("...");
		});

		it("handles paths with few parts by simple truncation", () => {
			const path = "~/ab/cd";

			const truncated = truncatePath(path, 5);

			expect(truncated.length).toBeLessThanOrEqual(5);
			expect(truncated).toContain("...");
		});

		it("returns path as-is when exactly at max length", () => {
			const path = "~/projects/app";
			const maxLen = path.length;

			const truncated = truncatePath(path, maxLen);

			expect(truncated).toBe(path);
		});

		it("handles empty path", () => {
			const truncated = truncatePath("", 10);

			expect(truncated).toBe("");
		});

		it("handles single segment path", () => {
			const path = "verylongsinglesegment";

			const truncated = truncatePath(path, 10);

			expect(truncated.length).toBeLessThanOrEqual(10);
			expect(truncated).toContain("...");
		});

		it("handles absolute paths", () => {
			const path = "/usr/local/bin/very/long/path/to/executable";

			const truncated = truncatePath(path, 25);

			expect(truncated).toContain("...");
			expect(truncated.length).toBeLessThanOrEqual(25);
		});

		it("falls back to simple truncation when first/last is too long", () => {
			const path = "~/a/verylongdirectoryname";

			const truncated = truncatePath(path, 15);

			// The truncated result should fit within maxLen
			expect(truncated.length).toBeLessThanOrEqual(15);
		});
	});
});

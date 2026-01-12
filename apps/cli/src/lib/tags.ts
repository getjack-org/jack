/**
 * Tags Library
 *
 * Provides tag management for Jack projects.
 * Tags are stored in .jack/project.json alongside other project link data.
 *
 * Design:
 * - Tags are lowercase alphanumeric with colons and hyphens allowed
 * - Single character tags are valid (e.g., "a", "1")
 * - Multi-character tags must start and end with alphanumeric characters
 * - Maximum 20 tags per project, 50 characters per tag
 * - Tags are stored in sorted order for consistency
 */

import { getAllPaths } from "./paths-index.ts";
import { readProjectLink, updateProjectLink } from "./project-link.ts";

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex for valid tag format:
 * - Single alphanumeric character, OR
 * - Multiple characters: starts with alphanumeric, ends with alphanumeric,
 *   middle can contain alphanumeric, colons, or hyphens
 */
export const TAG_REGEX = /^[a-z0-9][a-z0-9:-]*[a-z0-9]$|^[a-z0-9]$/;

/** Maximum length of a single tag */
export const MAX_TAG_LENGTH = 50;

/** Maximum number of tags per project */
export const MAX_TAGS_PER_PROJECT = 20;

// ============================================================================
// Types
// ============================================================================

/**
 * Result of tag validation
 */
export interface TagValidationResult {
	valid: boolean;
	errors: string[];
	/** Tags that passed validation (normalized to lowercase) */
	validTags: string[];
	/** Tags that failed validation with reasons */
	invalidTags: Array<{ tag: string; reason: string }>;
}

/**
 * Result of a tag operation (add/remove)
 */
export interface TagOperationResult {
	success: boolean;
	/** Current tags after the operation */
	tags: string[];
	/** Tags that were added (for add operation) */
	added?: string[];
	/** Tags that were removed (for remove operation) */
	removed?: string[];
	/** Tags that were skipped (already existed for add, didn't exist for remove) */
	skipped?: string[];
	/** Error message if operation failed */
	error?: string;
}

/**
 * Tag with usage count across projects
 */
export interface TagCount {
	tag: string;
	count: number;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if a single tag is valid
 */
export function isValidTag(tag: string): boolean {
	if (!tag || typeof tag !== "string") {
		return false;
	}

	const normalized = tag.toLowerCase().trim();

	if (normalized.length === 0) {
		return false;
	}

	if (normalized.length > MAX_TAG_LENGTH) {
		return false;
	}

	return TAG_REGEX.test(normalized);
}

/**
 * Validate an array of tags
 * Returns validation result with valid tags normalized to lowercase
 */
export function validateTags(tags: string[]): TagValidationResult {
	const errors: string[] = [];
	const validTags: string[] = [];
	const invalidTags: Array<{ tag: string; reason: string }> = [];
	const seen = new Set<string>();

	for (const tag of tags) {
		const normalized = tag.toLowerCase().trim();

		// Check for empty
		if (!normalized) {
			invalidTags.push({ tag, reason: "Tag cannot be empty" });
			continue;
		}

		// Check for duplicates within the input
		if (seen.has(normalized)) {
			invalidTags.push({ tag, reason: "Duplicate tag" });
			continue;
		}

		// Check length
		if (normalized.length > MAX_TAG_LENGTH) {
			invalidTags.push({
				tag,
				reason: `Tag exceeds maximum length of ${MAX_TAG_LENGTH} characters`,
			});
			continue;
		}

		// Check format
		if (!TAG_REGEX.test(normalized)) {
			invalidTags.push({
				tag,
				reason:
					"Tag must contain only lowercase letters, numbers, colons, and hyphens, and must start and end with a letter or number",
			});
			continue;
		}

		seen.add(normalized);
		validTags.push(normalized);
	}

	if (invalidTags.length > 0) {
		errors.push(`Invalid tags: ${invalidTags.map((t) => `"${t.tag}" (${t.reason})`).join(", ")}`);
	}

	return {
		valid: invalidTags.length === 0,
		errors,
		validTags,
		invalidTags,
	};
}

// ============================================================================
// Tag Operations
// ============================================================================

/**
 * Get all tags for a project
 * Returns empty array if project is not linked or has no tags
 */
export async function getProjectTags(projectPath: string): Promise<string[]> {
	const link = await readProjectLink(projectPath);

	if (!link) {
		return [];
	}

	return link.tags ?? [];
}

/**
 * Add tags to a project
 * Tags are deduplicated and sorted
 */
export async function addTags(projectPath: string, newTags: string[]): Promise<TagOperationResult> {
	const link = await readProjectLink(projectPath);

	if (!link) {
		return {
			success: false,
			tags: [],
			error: "Project is not linked. Run 'jack init' first.",
		};
	}

	// Validate new tags
	const validation = validateTags(newTags);
	if (!validation.valid) {
		return {
			success: false,
			tags: link.tags ?? [],
			error: validation.errors.join("; "),
		};
	}

	const currentTags = new Set(link.tags ?? []);
	const added: string[] = [];
	const skipped: string[] = [];

	for (const tag of validation.validTags) {
		if (currentTags.has(tag)) {
			skipped.push(tag);
		} else {
			currentTags.add(tag);
			added.push(tag);
		}
	}

	// Check max tags limit
	if (currentTags.size > MAX_TAGS_PER_PROJECT) {
		return {
			success: false,
			tags: link.tags ?? [],
			error: `Cannot add tags: would exceed maximum of ${MAX_TAGS_PER_PROJECT} tags per project`,
		};
	}

	// Sort tags for consistent ordering
	const sortedTags = Array.from(currentTags).sort();

	// Update project link
	await updateProjectLink(projectPath, { tags: sortedTags });

	return {
		success: true,
		tags: sortedTags,
		added,
		skipped,
	};
}

/**
 * Remove tags from a project
 */
export async function removeTags(
	projectPath: string,
	tagsToRemove: string[],
): Promise<TagOperationResult> {
	const link = await readProjectLink(projectPath);

	if (!link) {
		return {
			success: false,
			tags: [],
			error: "Project is not linked. Run 'jack init' first.",
		};
	}

	const currentTags = new Set(link.tags ?? []);
	const removed: string[] = [];
	const skipped: string[] = [];

	// Normalize tags to remove
	const normalizedToRemove = tagsToRemove.map((t) => t.toLowerCase().trim());

	for (const tag of normalizedToRemove) {
		if (currentTags.has(tag)) {
			currentTags.delete(tag);
			removed.push(tag);
		} else {
			skipped.push(tag);
		}
	}

	// Sort tags for consistent ordering
	const sortedTags = Array.from(currentTags).sort();

	// Update project link (use empty array if no tags, or undefined to remove the field)
	await updateProjectLink(projectPath, {
		tags: sortedTags.length > 0 ? sortedTags : undefined,
	});

	return {
		success: true,
		tags: sortedTags,
		removed,
		skipped,
	};
}

// ============================================================================
// Tag Discovery
// ============================================================================

/**
 * Get all unique tags across all projects with their usage counts
 * Returns tags sorted by count (descending), then alphabetically
 */
export async function getAllTagsWithCounts(): Promise<TagCount[]> {
	const allPaths = await getAllPaths();
	const tagCounts = new Map<string, number>();

	for (const paths of Object.values(allPaths)) {
		// Use the first path for each project (they should all have the same tags)
		const projectPath = paths[0];
		if (!projectPath) continue;

		const tags = await getProjectTags(projectPath);
		for (const tag of tags) {
			tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
		}
	}

	// Convert to array and sort
	const result: TagCount[] = Array.from(tagCounts.entries()).map(([tag, count]) => ({
		tag,
		count,
	}));

	// Sort by count descending, then alphabetically
	result.sort((a, b) => {
		if (b.count !== a.count) {
			return b.count - a.count;
		}
		return a.tag.localeCompare(b.tag);
	});

	return result;
}

/**
 * Find a project path by project name
 * Searches through all indexed paths and checks package.json or wrangler config for name
 * Returns the first matching path, or null if not found
 */
export async function findProjectPathByName(name: string): Promise<string | null> {
	const allPaths = await getAllPaths();

	for (const paths of Object.values(allPaths)) {
		for (const projectPath of paths) {
			// Check package.json for name
			try {
				const packageJsonPath = `${projectPath}/package.json`;
				const packageJson = await Bun.file(packageJsonPath).json();
				if (packageJson.name === name) {
					return projectPath;
				}
			} catch {
				// No package.json or invalid JSON, continue
			}

			// Check wrangler.toml for name
			try {
				const wranglerPath = `${projectPath}/wrangler.toml`;
				const wranglerContent = await Bun.file(wranglerPath).text();
				// Simple regex to find name = "..." in TOML
				const nameMatch = wranglerContent.match(/^name\s*=\s*["']([^"']+)["']/m);
				if (nameMatch && nameMatch[1] === name) {
					return projectPath;
				}
			} catch {
				// No wrangler.toml or can't read, continue
			}

			// Check wrangler.jsonc for name
			try {
				const wranglerJsonPath = `${projectPath}/wrangler.jsonc`;
				const wranglerJson = await Bun.file(wranglerJsonPath).json();
				if (wranglerJson.name === name) {
					return projectPath;
				}
			} catch {
				// No wrangler.jsonc or invalid JSON, continue
			}

			// Check wrangler.json for name
			try {
				const wranglerJsonPath = `${projectPath}/wrangler.json`;
				const wranglerJson = await Bun.file(wranglerJsonPath).json();
				if (wranglerJson.name === name) {
					return projectPath;
				}
			} catch {
				// No wrangler.json or invalid JSON, continue
			}
		}
	}

	return null;
}

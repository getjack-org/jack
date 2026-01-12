/**
 * Project List - data layer and formatters for jack ls
 *
 * Provides:
 * - ProjectListItem interface for display
 * - Conversion from ResolvedProject
 * - Sorting/filtering helpers
 * - Output formatters for grouped and flat views
 */

import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ResolvedProject } from "./project-resolver.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Display-focused project representation
 */
export interface ProjectListItem {
	name: string;
	status: "live" | "error" | "local-only" | "syncing";
	url: string | null;
	localPath: string | null;
	updatedAt: string | null;
	isLocal: boolean;
	isCloudOnly: boolean;
	errorMessage?: string;
	tags?: string[];
}

/**
 * Projects grouped by display section
 */
export interface GroupedProjects {
	errors: ProjectListItem[];
	local: ProjectListItem[];
	cloudOnly: ProjectListItem[];
}

// ============================================================================
// Colors
// ============================================================================

const isColorEnabled = !process.env.NO_COLOR && process.stderr.isTTY !== false;

export const colors = {
	reset: isColorEnabled ? "\x1b[0m" : "",
	dim: isColorEnabled ? "\x1b[90m" : "",
	green: isColorEnabled ? "\x1b[32m" : "",
	yellow: isColorEnabled ? "\x1b[33m" : "",
	red: isColorEnabled ? "\x1b[31m" : "",
	cyan: isColorEnabled ? "\x1b[36m" : "",
	bold: isColorEnabled ? "\x1b[1m" : "",
};

// ============================================================================
// Status Icons
// ============================================================================

export const STATUS_ICONS: Record<ProjectListItem["status"], string> = {
	live: "\u25CF", // ●
	error: "\u2716", // ✖
	"local-only": "\u25CC", // ◌
	syncing: "\u25D0", // ◐
};

// ============================================================================
// Data Transformation
// ============================================================================

/**
 * Convert ResolvedProject[] to ProjectListItem[]
 */
export function toListItems(projects: ResolvedProject[]): ProjectListItem[] {
	return projects.map((proj) => ({
		name: proj.name,
		status: proj.status as ProjectListItem["status"],
		url: proj.url || null,
		localPath: proj.localPath || null,
		updatedAt: proj.updatedAt || null,
		isLocal: !!proj.localPath && proj.sources.filesystem,
		isCloudOnly: !proj.localPath && proj.sources.controlPlane,
		errorMessage: proj.errorMessage,
		tags: proj.tags,
	}));
}

// ============================================================================
// Sorting & Filtering
// ============================================================================

/**
 * Sort by updatedAt descending (most recent first)
 * Items without updatedAt are sorted to the end
 */
export function sortByUpdated(items: ProjectListItem[]): ProjectListItem[] {
	return [...items].sort((a, b) => {
		// Items without dates go to the end
		if (!a.updatedAt && !b.updatedAt) return a.name.localeCompare(b.name);
		if (!a.updatedAt) return 1;
		if (!b.updatedAt) return -1;

		// Most recent first
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});
}

/**
 * Group projects into sections for display
 */
export function groupProjects(items: ProjectListItem[]): GroupedProjects {
	const errors: ProjectListItem[] = [];
	const local: ProjectListItem[] = [];
	const cloudOnly: ProjectListItem[] = [];

	for (const item of items) {
		if (item.status === "error") {
			errors.push(item);
		} else if (item.isLocal) {
			local.push(item);
		} else if (item.isCloudOnly) {
			cloudOnly.push(item);
		}
	}

	return { errors, local, cloudOnly };
}

/**
 * Filter items by status
 */
export function filterByStatus(items: ProjectListItem[], status: string): ProjectListItem[] {
	// Handle "local" as an alias for "local-only"
	const normalizedStatus = status === "local" ? "local-only" : status;
	return items.filter((item) => item.status === normalizedStatus);
}

/**
 * Filter items by tag
 * When multiple tags provided, uses AND logic (project must have ALL tags)
 */
export function filterByTag(items: ProjectListItem[], tags: string[]): ProjectListItem[] {
	if (tags.length === 0) return items;

	return items.filter((item) => {
		const projectTags = item.tags ?? [];
		// AND logic: project must have ALL specified tags
		return tags.every((tag) => projectTags.includes(tag));
	});
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Replace home directory with ~
 */
export function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * Truncate long paths: ~/very/long/path/here -> ~/very/.../here
 */
export function truncatePath(path: string, maxLen: number): string {
	if (path.length <= maxLen) return path;

	// Keep first and last parts
	const parts = path.split("/");
	if (parts.length <= 3) {
		// Too few parts to truncate meaningfully
		return `${path.slice(0, maxLen - 3)}...`;
	}

	// Try to keep first and last part with ... in middle
	const first = parts[0] || "";
	const last = parts[parts.length - 1] || "";

	// Check if we have room for first/...last
	const truncated = `${first}/.../${last}`;
	if (truncated.length <= maxLen) {
		return truncated;
	}

	// Fall back to simple truncation
	return `${path.slice(0, maxLen - 3)}...`;
}

// ============================================================================
// Formatters
// ============================================================================

/**
 * Format tags for inline display after project name
 * - Returns empty string if no tags
 * - Shows up to 3 tags: [api, prod, my-saas]
 * - Truncates with +N if more: [api, prod, +2]
 * - Uses dim color for brackets
 */
export function formatTagsInline(tags: string[] | undefined): string {
	if (!tags || tags.length === 0) return "";

	const maxTags = 3;
	if (tags.length <= maxTags) {
		return `${colors.dim}[${colors.reset}${tags.join(", ")}${colors.dim}]${colors.reset}`;
	}

	// Show first 2 tags + count of remaining
	const shown = tags.slice(0, 2);
	const remaining = tags.length - 2;
	return `${colors.dim}[${colors.reset}${shown.join(", ")}, ${colors.dim}+${remaining}]${colors.reset}`;
}

export interface FormatLineOptions {
	indent?: number;
	showUrl?: boolean;
}

/**
 * Format a single project line
 */
export function formatProjectLine(item: ProjectListItem, options: FormatLineOptions = {}): string {
	const { indent = 4, showUrl = true } = options;
	const padding = " ".repeat(indent);

	const icon = STATUS_ICONS[item.status];
	const statusColor =
		item.status === "error"
			? colors.red
			: item.status === "live"
				? colors.green
				: item.status === "syncing"
					? colors.yellow
					: colors.dim;

	const name = item.name.slice(0, 20).padEnd(20);
	const tags = formatTagsInline(item.tags);
	const status = item.status.padEnd(12);

	let url = "";
	if (showUrl && item.url) {
		url = item.url.replace("https://", "");
	} else if (showUrl && item.status === "error" && item.errorMessage) {
		url = `${colors.dim}${item.errorMessage}${colors.reset}`;
	}

	return `${padding}${statusColor}${icon}${colors.reset} ${name}${tags ? ` ${tags}` : ""} ${statusColor}${status}${colors.reset} ${url}`;
}

/**
 * Format the "Needs attention" (errors) section
 */
export function formatErrorSection(items: ProjectListItem[]): string {
	if (items.length === 0) return "";

	const lines: string[] = [];
	lines.push(
		`  ${colors.red}${STATUS_ICONS.error} Needs attention (${items.length})${colors.reset}`,
	);

	for (const item of items) {
		lines.push(formatProjectLine(item, { indent: 4 }));
	}

	return lines.join("\n");
}

/**
 * Format the "Local" section, grouped by parent directory
 */
export function formatLocalSection(items: ProjectListItem[]): string {
	if (items.length === 0) return "";

	// Group by parent directory
	interface DirGroup {
		displayPath: string;
		projects: ProjectListItem[];
	}

	const groups = new Map<string, DirGroup>();

	for (const item of items) {
		if (!item.localPath) continue;
		const parent = dirname(item.localPath);
		if (!groups.has(parent)) {
			groups.set(parent, {
				displayPath: shortenPath(parent),
				projects: [],
			});
		}
		groups.get(parent)?.projects.push(item);
	}

	const lines: string[] = [];

	for (const [_parentPath, group] of groups) {
		lines.push(`    ${colors.dim}${group.displayPath}/${colors.reset}`);

		const sortedProjects = group.projects.sort((a, b) => a.name.localeCompare(b.name));

		for (let i = 0; i < sortedProjects.length; i++) {
			const proj = sortedProjects[i];
			if (!proj) continue;
			const isLast = i === sortedProjects.length - 1;
			const prefix = isLast ? "\u2514\u2500\u2500" : "\u251C\u2500\u2500"; // └── or ├──

			const icon = STATUS_ICONS[proj.status];
			const statusColor =
				proj.status === "error"
					? colors.red
					: proj.status === "live"
						? colors.green
						: proj.status === "syncing"
							? colors.yellow
							: colors.dim;

			const url = proj.url ? proj.url.replace("https://", "") : "";
			const tags = formatTagsInline(proj.tags);

			lines.push(
				`    ${colors.dim}${prefix}${colors.reset} ${proj.name}${tags ? ` ${tags}` : ""}  ${statusColor}${proj.status}${colors.reset}${url ? `  ${url}` : ""}`,
			);
		}
	}

	return lines.join("\n");
}

export interface FormatCloudSectionOptions {
	limit: number;
	total: number;
}

/**
 * Format the "Cloud" section
 */
export function formatCloudSection(
	items: ProjectListItem[],
	options: FormatCloudSectionOptions,
): string {
	if (items.length === 0) return "";

	const { limit, total } = options;
	const showing = items.slice(0, limit);
	const remaining = total - showing.length;

	const lines: string[] = [];
	lines.push(
		`  ${colors.green}${STATUS_ICONS.live} Cloud (showing ${showing.length} of ${total})${colors.reset}`,
	);

	for (const item of showing) {
		lines.push(formatProjectLine(item, { indent: 4 }));
	}

	if (remaining > 0) {
		lines.push(`      ${colors.dim}... ${remaining} more${colors.reset}`);
	}

	return lines.join("\n");
}

/**
 * Interactive fuzzy project picker
 *
 * Features:
 * - Fuzzy search as you type
 * - Arrow keys/j/k to navigate
 * - Enter to select
 * - Esc to cancel
 * - Cloud-only projects shown separately
 */

import { isCancel } from "@clack/core";
import { formatRelativeTime } from "./format.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { type ProjectListItem, shortenPath, sortByUpdated, toListItems } from "./project-list.ts";
import { listAllProjects } from "./project-resolver.ts";
import { restoreTty } from "./tty.ts";

// ============================================================================
// Types
// ============================================================================

export interface PickerResult {
	project: ProjectListItem;
	action: "select";
}

export interface PickerCancelResult {
	action: "cancel";
}

export interface PickProjectOptions {
	cloudOnly?: boolean;
}

// ============================================================================
// Colors (compatible with project-list.ts)
// ============================================================================

const isColorEnabled = !process.env.NO_COLOR && process.stderr.isTTY !== false;

const colors = {
	reset: isColorEnabled ? "\x1b[0m" : "",
	dim: isColorEnabled ? "\x1b[90m" : "",
	green: isColorEnabled ? "\x1b[32m" : "",
	yellow: isColorEnabled ? "\x1b[33m" : "",
	red: isColorEnabled ? "\x1b[31m" : "",
	cyan: isColorEnabled ? "\x1b[36m" : "",
	bold: isColorEnabled ? "\x1b[1m" : "",
	inverse: isColorEnabled ? "\x1b[7m" : "",
	// Bright/neon colors for visual pop
	brightCyan: isColorEnabled ? "\x1b[96m" : "",
	brightMagenta: isColorEnabled ? "\x1b[95m" : "",
	brightGreen: isColorEnabled ? "\x1b[92m" : "",
};

// ============================================================================
// TTY Safety
// ============================================================================

/**
 * Check if we're running in an interactive TTY environment.
 * Only checks stdin - stdout may be a pipe (e.g., shell wrapper capturing output)
 * while still being interactive (user can type, picker UI goes to stderr).
 */
export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY);
}

/**
 * Exit with error if not running in a TTY
 */
export function requireTTY(): void {
	if (!isTTY()) {
		console.error("Interactive mode requires a terminal.");
		console.error("Run 'jack ls' to list projects or 'jack cd <name>' to navigate.");
		process.exit(1);
	}
}

// ============================================================================
// Project Picker Implementation
// ============================================================================

/**
 * Interactive project picker using @clack/core primitives
 * @param options.cloudOnly - If true, only shows cloud-only projects (for linking)
 */
export async function pickProject(
	options?: PickProjectOptions,
): Promise<PickerResult | PickerCancelResult> {
	// Fetch all projects
	let allProjects: ProjectListItem[];
	try {
		const resolved = await listAllProjects();
		allProjects = sortByUpdated(toListItems(resolved));
	} catch {
		console.error("Could not fetch projects. Check your connection.");
		process.exit(1);
	}

	// Separate local and cloud-only projects
	const cloudOnlyProjects = allProjects.filter((p) => p.isCloudOnly);
	const localProjects = options?.cloudOnly ? [] : allProjects.filter((p) => p.isLocal);

	// Check for empty state
	if (options?.cloudOnly && cloudOnlyProjects.length === 0) {
		console.error("No cloud-only projects to link.");
		console.error("Run 'jack new <name>' to create a project.");
		process.exit(1);
	}

	if (!options?.cloudOnly && allProjects.length === 0) {
		console.error("No projects found.");
		console.error("Run 'jack new <name>' to create your first project.");
		process.exit(1);
	}

	// Run the interactive picker
	const result = await runPicker(localProjects, cloudOnlyProjects);

	return result;
}

/**
 * Run the interactive picker UI
 */
async function runPicker(
	localProjects: ProjectListItem[],
	cloudOnlyProjects: ProjectListItem[],
): Promise<PickerResult | PickerCancelResult> {
	return new Promise((resolve) => {
		let query = "";
		let cursor = 0;
		let scrollOffset = 0;
		let filteredLocal = localProjects;
		let filteredCloud = cloudOnlyProjects;

		// Calculate visible window size (leave room for header, footer, cloud header)
		// Use stderr.rows since UI is on stderr (stdout may be a pipe)
		const getMaxVisible = () => Math.max(5, (process.stderr.rows || process.stdout.rows || 20) - 8);

		// Calculate total items for navigation
		const getTotalItems = () => filteredLocal.length + filteredCloud.length;

		// Get item at cursor position (across both lists)
		const getItemAtCursor = (): ProjectListItem | null => {
			if (cursor < filteredLocal.length) {
				return filteredLocal[cursor] ?? null;
			}
			const cloudIndex = cursor - filteredLocal.length;
			return filteredCloud[cloudIndex] ?? null;
		};

		// Update filtered lists based on query
		const updateFilter = () => {
			if (!query) {
				filteredLocal = localProjects;
				filteredCloud = cloudOnlyProjects;
			} else {
				filteredLocal = fuzzyFilter(query, localProjects, (p) => p.name);
				filteredCloud = fuzzyFilter(query, cloudOnlyProjects, (p) => p.name);
			}
			// Reset cursor if out of bounds
			const total = getTotalItems();
			if (cursor >= total) {
				cursor = Math.max(0, total - 1);
			}
		};

		// Adjust scroll offset to keep cursor visible
		const adjustScroll = () => {
			const maxVisible = getMaxVisible();
			const total = getTotalItems();

			// If all items fit, no scrolling needed
			if (total <= maxVisible) {
				scrollOffset = 0;
				return;
			}

			// Keep cursor within visible window
			if (cursor < scrollOffset) {
				scrollOffset = cursor;
			} else if (cursor >= scrollOffset + maxVisible) {
				scrollOffset = cursor - maxVisible + 1;
			}

			// Clamp scroll offset
			scrollOffset = Math.max(0, Math.min(scrollOffset, total - maxVisible));
		};

		// Render the picker UI
		const render = () => {
			adjustScroll();

			// Clear screen and move cursor to top
			process.stderr.write("\x1b[2J\x1b[H");

			// Header
			process.stderr.write(
				`${colors.brightCyan}${colors.bold}Select a project${colors.reset} ${colors.dim}↑↓ move · enter select · esc cancel${colors.reset}\n\n`,
			);

			const maxVisible = getMaxVisible();
			const total = getTotalItems();
			const showScrollUp = scrollOffset > 0;
			const showScrollDown = scrollOffset + maxVisible < total;

			// Show scroll-up indicator
			if (showScrollUp) {
				process.stderr.write(`  ${colors.dim}↑ ${scrollOffset} more above${colors.reset}\n`);
			}

			// Build combined list for scrolling
			const allItems: { project: ProjectListItem; isCloud: boolean; isCloudHeader?: boolean }[] =
				[];

			for (const project of filteredLocal) {
				allItems.push({ project, isCloud: false });
			}

			if (filteredCloud.length > 0) {
				// Add cloud header as a special item
				allItems.push({ project: filteredCloud[0]!, isCloud: true, isCloudHeader: true });
				for (const project of filteredCloud) {
					allItems.push({ project, isCloud: true });
				}
			}

			// Render visible window
			let renderedCount = 0;
			let lineIndex = 0;
			let cloudHeaderShown = false;

			for (const project of filteredLocal) {
				if (lineIndex >= scrollOffset && renderedCount < maxVisible) {
					const isSelected = lineIndex === cursor;
					const line = formatPickerLine(project, isSelected, false);
					process.stderr.write(`${line}\n`);
					renderedCount++;
				}
				lineIndex++;
			}

			// Cloud-only section
			if (filteredCloud.length > 0) {
				// Check if cloud header should be visible
				const cloudStartIndex = filteredLocal.length;
				const cloudEndIndex = cloudStartIndex + filteredCloud.length;

				// Show header if any cloud items are in the visible window
				if (cloudEndIndex > scrollOffset && cloudStartIndex < scrollOffset + maxVisible) {
					// Only show header if we haven't filled up yet and cloud section is visible
					if (renderedCount < maxVisible && lineIndex >= scrollOffset) {
						process.stderr.write(
							`\n  ${colors.brightMagenta}☁ cloud-only${colors.reset} ${colors.dim}(will restore on select)${colors.reset}\n`,
						);
						cloudHeaderShown = true;
					}
				}

				for (const project of filteredCloud) {
					if (lineIndex >= scrollOffset && renderedCount < maxVisible) {
						// Show cloud header just before first visible cloud item if not shown yet
						if (!cloudHeaderShown && lineIndex === cloudStartIndex) {
							process.stderr.write(
								`\n  ${colors.brightMagenta}☁ cloud-only${colors.reset} ${colors.dim}(will restore on select)${colors.reset}\n`,
							);
							cloudHeaderShown = true;
						}
						const isSelected = lineIndex === cursor;
						const line = formatPickerLine(project, isSelected, true);
						process.stderr.write(`${line}\n`);
						renderedCount++;
					}
					lineIndex++;
				}
			}

			// Show scroll-down indicator
			if (showScrollDown) {
				const remaining = total - scrollOffset - maxVisible;
				process.stderr.write(`  ${colors.dim}↓ ${remaining} more below${colors.reset}\n`);
			}

			// Empty state
			if (getTotalItems() === 0) {
				process.stderr.write(`  ${colors.dim}No matching projects${colors.reset}\n`);
			}

			// Search input
			const searchPrompt = query
				? `${colors.brightCyan}/${colors.reset} ${query}${colors.dim}▌${colors.reset}`
				: `${colors.dim}/ type to filter${colors.reset}`;
			process.stderr.write(`\n  ${searchPrompt}\n`);
		};

		// Format a single picker line
		const formatPickerLine = (
			project: ProjectListItem,
			isSelected: boolean,
			isCloudOnly: boolean,
		): string => {
			const prefix = isSelected ? `${colors.brightCyan}▸${colors.reset}` : " ";
			const name = project.name.padEnd(22);
			const time = project.updatedAt
				? colors.dim + formatRelativeTime(project.updatedAt).padEnd(10) + colors.reset
				: "".padEnd(10);

			let location = "";
			if (!isCloudOnly && project.localPath) {
				location = colors.dim + shortenPath(project.localPath) + colors.reset;
			}

			const nameColor = isSelected ? colors.brightGreen + colors.bold : "";
			return `  ${prefix} ${nameColor}${name}${colors.reset} ${time} ${location}`;
		};

		// Handle keyboard input
		const handleKey = (key: Buffer) => {
			const char = key.toString();
			const total = getTotalItems();

			// Escape - cancel
			if (char === "\x1b" && key.length === 1) {
				cleanup();
				resolve({ action: "cancel" });
				return;
			}

			// Ctrl+C - cancel
			if (char === "\x03") {
				cleanup();
				resolve({ action: "cancel" });
				return;
			}

			// Enter - select
			if (char === "\r" || char === "\n") {
				const item = getItemAtCursor();
				if (item) {
					cleanup();
					resolve({ project: item, action: "select" });
				}
				return;
			}

			// Arrow up or k
			if (char === "\x1b[A" || char === "k") {
				if (total > 0) {
					cursor = cursor > 0 ? cursor - 1 : total - 1;
					render();
				}
				return;
			}

			// Arrow down or j
			if (char === "\x1b[B" || char === "j") {
				if (total > 0) {
					cursor = cursor < total - 1 ? cursor + 1 : 0;
					render();
				}
				return;
			}

			// Backspace
			if (char === "\x7f" || char === "\b") {
				if (query.length > 0) {
					query = query.slice(0, -1);
					updateFilter();
					render();
				}
				return;
			}

			// Regular character input (printable ASCII)
			if (char.length === 1 && char >= " " && char <= "~") {
				// Skip j/k when used for navigation (already handled above)
				// But allow them in query if typed with other chars
				query += char;
				updateFilter();
				render();
				return;
			}
		};

		// Cleanup function
		const cleanup = () => {
			process.stdin.removeListener("data", handleKey);
			restoreTty();
			// Clear the picker UI
			process.stderr.write("\x1b[2J\x1b[H");
		};

		// Set up raw mode for keyboard input
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		process.stdin.on("data", handleKey);

		// Initial render
		render();
	});
}

export { isCancel };

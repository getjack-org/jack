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
import { shortenPath, type ProjectListItem, toListItems, sortByUpdated } from "./project-list.ts";
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
};

// ============================================================================
// TTY Safety
// ============================================================================

/**
 * Check if we're running in an interactive TTY environment
 */
export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
 */
export async function pickProject(): Promise<PickerResult | PickerCancelResult> {
	// Fetch all projects
	let allProjects: ProjectListItem[];
	try {
		const resolved = await listAllProjects();
		allProjects = sortByUpdated(toListItems(resolved));
	} catch {
		console.error("Could not fetch projects. Check your connection.");
		process.exit(1);
	}

	if (allProjects.length === 0) {
		console.error("No projects found.");
		console.error("Run 'jack new <name>' to create your first project.");
		process.exit(1);
	}

	// Separate local and cloud-only projects
	const localProjects = allProjects.filter((p) => p.isLocal);
	const cloudOnlyProjects = allProjects.filter((p) => p.isCloudOnly);

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
		let filteredLocal = localProjects;
		let filteredCloud = cloudOnlyProjects;

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

		// Render the picker UI
		const render = () => {
			// Clear screen and move cursor to top
			process.stderr.write("\x1b[2J\x1b[H");

			// Header
			process.stderr.write(
				`${colors.bold}Select a project${colors.reset} ${colors.dim}(arrows to move, enter to select, esc to cancel)${colors.reset}\n\n`,
			);

			let lineIndex = 0;

			// Local projects section
			if (filteredLocal.length > 0) {
				for (const project of filteredLocal) {
					const isSelected = lineIndex === cursor;
					const line = formatPickerLine(project, isSelected, false);
					process.stderr.write(`${line}\n`);
					lineIndex++;
				}
			}

			// Cloud-only section header and projects
			if (filteredCloud.length > 0) {
				process.stderr.write(`\n  ${colors.dim}[cloud-only]${colors.reset}\n`);
				for (const project of filteredCloud) {
					const isSelected = lineIndex === cursor;
					const line = formatPickerLine(project, isSelected, true);
					process.stderr.write(`${line}\n`);
					lineIndex++;
				}
			}

			// Empty state
			if (getTotalItems() === 0) {
				process.stderr.write(`  ${colors.dim}No matching projects${colors.reset}\n`);
			}

			// Search input
			process.stderr.write(
				`\n  ${colors.dim}Type to filter:${colors.reset} ${query}${colors.dim}_${colors.reset}\n`,
			);
		};

		// Format a single picker line
		const formatPickerLine = (
			project: ProjectListItem,
			isSelected: boolean,
			isCloudOnly: boolean,
		): string => {
			const prefix = isSelected ? `${colors.green}>${colors.reset}` : " ";
			const name = project.name.padEnd(20);
			const time = project.updatedAt
				? formatRelativeTime(project.updatedAt).padEnd(14)
				: "".padEnd(14);

			let location: string;
			if (isCloudOnly) {
				location = `${colors.dim}(will restore from cloud)${colors.reset}`;
			} else if (project.localPath) {
				location = colors.dim + shortenPath(project.localPath) + colors.reset;
			} else {
				location = "";
			}

			const nameColor = isSelected ? colors.bold : "";
			return `  ${prefix} ${nameColor}${name}${colors.reset} ${colors.dim}${time}${colors.reset} ${location}`;
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

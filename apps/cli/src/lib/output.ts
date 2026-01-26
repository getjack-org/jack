import yoctoSpinner from "yocto-spinner";
import type { OperationReporter } from "./project-operations.ts";

const isColorEnabled = !process.env.NO_COLOR && process.stderr.isTTY !== false;

/**
 * Quiet mode detection for AI agents and CI environments.
 * Reduces token usage by simplifying output (no spinners, no decorative boxes).
 */
export const isQuietMode =
	!process.stderr.isTTY ||
	process.env.CI === "true" ||
	process.env.CI === "1" ||
	process.env.JACK_QUIET === "1";

/**
 * ANSI color codes for terminal output
 */
export const colors = {
	green: isColorEnabled ? "\x1b[32m" : "",
	red: isColorEnabled ? "\x1b[31m" : "",
	yellow: isColorEnabled ? "\x1b[33m" : "",
	cyan: isColorEnabled ? "\x1b[36m" : "",
	dim: isColorEnabled ? "\x1b[90m" : "",
	bold: isColorEnabled ? "\x1b[1m" : "",
	reset: isColorEnabled ? "\x1b[0m" : "",
};

let currentSpinner: ReturnType<typeof yoctoSpinner> | null = null;

/**
 * Spinner object with start/stop methods
 */
export const output = {
	start(text: string) {
		if (isQuietMode) {
			console.error(text);
			return;
		}
		if (currentSpinner) {
			currentSpinner.stop();
		}
		currentSpinner = yoctoSpinner({ text }).start();
	},
	stop() {
		if (isQuietMode) {
			return;
		}
		if (currentSpinner) {
			currentSpinner.stop();
			currentSpinner = null;
		}
	},
	success,
	error,
	info,
	warn,
	item,
	box,
	celebrate,
};

/**
 * Create a spinner for long-running operations
 */
export function spinner(text: string) {
	if (isQuietMode) {
		console.error(text);
		let currentText = text;
		return {
			success(message: string) {
				success(message);
			},
			error(message: string) {
				error(message);
			},
			stop() {},
			get text() {
				return currentText;
			},
			set text(value: string | undefined) {
				currentText = value ?? "";
			},
		};
	}

	const spin = yoctoSpinner({ text }).start();

	return {
		success(message: string) {
			spin.stop();
			success(message);
		},
		error(message: string) {
			spin.stop();
			error(message);
		},
		stop() {
			spin.stop();
		},
		get text() {
			return spin.text;
		},
		set text(value: string | undefined) {
			spin.text = value ?? "";
		},
	};
}

/**
 * Print a success message with checkmark
 */
export function success(message: string): void {
	const mark = isColorEnabled ? "\x1b[32m✓\x1b[0m" : "✓";
	console.error(`${mark} ${message}`);
}

/**
 * Print an error message with cross
 */
export function error(message: string): void {
	const mark = isColorEnabled ? "\x1b[31m✗\x1b[0m" : "✗";
	console.error(`${mark} ${message}`);
}

/**
 * Print an info message with arrow
 */
export function info(message: string): void {
	const mark = isColorEnabled ? "\x1b[36m→\x1b[0m" : "→";
	console.error(`${mark} ${message}`);
}

/**
 * Print a warning message
 */
export function warn(message: string): void {
	const mark = isColorEnabled ? "\x1b[33m!\x1b[0m" : "!";
	console.error(`${mark} ${message}`);
}

/**
 * Print a list item
 */
export function item(message: string): void {
	console.error(`  ${message}`);
}

/**
 * Random neon purple for cyberpunk styling
 */
export function getRandomPurple(): string {
	const purples = [177, 165, 141, 129];
	const colorCode = purples[Math.floor(Math.random() * purples.length)];
	return `\x1b[38;5;${colorCode}m`;
}

/**
 * Print a boxed message for important info (cyberpunk style)
 */
export function box(title: string, lines: string[]): void {
	if (isQuietMode) {
		return; // Skip decorative boxes in quiet mode
	}
	// Respect terminal width (leave room for box borders + indent)
	const termWidth = process.stderr.columns || process.stdout.columns || 80;
	const maxBoxWidth = Math.max(30, termWidth - 6); // 2 indent + 2 borders + 2 padding

	const contentMaxLen = Math.max(title.length, ...lines.map((l) => l.length));
	const maxLen = Math.min(contentMaxLen, maxBoxWidth - 4);
	const innerWidth = maxLen + 4;

	const purple = isColorEnabled ? getRandomPurple() : "";
	const bold = isColorEnabled ? "\x1b[1m" : "";
	const reset = isColorEnabled ? "\x1b[0m" : "";

	const bar = "═".repeat(innerWidth);
	const fill = "▓".repeat(innerWidth);
	const gradient = "░".repeat(innerWidth);

	// Truncate text if too long for box
	const truncate = (text: string) => (text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text);

	// Pad plain text first, then apply colors (ANSI codes break padEnd calculation)
	const pad = (text: string) => `  ${truncate(text).padEnd(maxLen)}  `;
	const padTitle = (text: string) => {
		const t = truncate(text);
		return `  ${bold}${t}${reset}${purple}${" ".repeat(maxLen - t.length)}  `;
	};

	console.error("");
	console.error(`  ${purple}╔${bar}╗${reset}`);
	console.error(`  ${purple}║${fill}║${reset}`);
	console.error(`  ${purple}║${padTitle(title)}║${reset}`);
	console.error(`  ${purple}║${"─".repeat(innerWidth)}║${reset}`);
	for (const line of lines) {
		console.error(`  ${purple}║${pad(line)}║${reset}`);
	}
	console.error(`  ${purple}║${gradient}║${reset}`);
	console.error(`  ${purple}╚${bar}╝${reset}`);
	console.error("");
}

/**
 * Print a celebration box (for final success after setup)
 */
export function celebrate(title: string, lines: string[]): void {
	if (isQuietMode) {
		return; // Skip decorative boxes in quiet mode
	}
	// Respect terminal width (leave room for box borders + indent)
	const termWidth = process.stderr.columns || process.stdout.columns || 80;
	const maxBoxWidth = Math.max(30, termWidth - 6); // 2 indent + 2 borders + 2 padding

	const contentMaxLen = Math.max(title.length, ...lines.map((l) => l.length));
	const maxLen = Math.min(contentMaxLen, maxBoxWidth - 4);
	const innerWidth = maxLen + 4;

	const purple = isColorEnabled ? getRandomPurple() : "";
	const bold = isColorEnabled ? "\x1b[1m" : "";
	const reset = isColorEnabled ? "\x1b[0m" : "";

	const bar = "═".repeat(innerWidth);
	const fill = "▓".repeat(innerWidth);
	const gradient = "░".repeat(innerWidth);
	const space = " ".repeat(innerWidth);

	// Truncate text if too long for box
	const truncate = (text: string) => (text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text);

	// Center text based on visual length, then apply colors
	const center = (text: string, applyBold = false) => {
		const t = truncate(text);
		const left = Math.floor((innerWidth - t.length) / 2);
		const right = innerWidth - t.length - left;
		const centered = " ".repeat(left) + t + " ".repeat(right);
		return applyBold ? centered.replace(t, bold + t + reset + purple) : centered;
	};

	console.error("");
	console.error(`  ${purple}╔${bar}╗${reset}`);
	console.error(`  ${purple}║${fill}║${reset}`);
	console.error(`  ${purple}║${space}║${reset}`);
	console.error(`  ${purple}║${center(title, true)}║${reset}`);
	console.error(`  ${purple}║${space}║${reset}`);
	for (const line of lines) {
		console.error(`  ${purple}║${center(line)}║${reset}`);
	}
	console.error(`  ${purple}║${space}║${reset}`);
	console.error(`  ${purple}║${gradient}║${reset}`);
	console.error(`  ${purple}╚${bar}╝${reset}`);
	console.error("");
}

/**
 * Create a standard reporter object for project operations.
 * Respects quiet mode for reduced output in CI/agent environments.
 */
export function createReporter(): OperationReporter {
	return {
		start: output.start,
		stop: output.stop,
		spinner,
		info,
		warn,
		error,
		success,
		box,
		celebrate,
	};
}

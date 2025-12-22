import yoctoSpinner from "yocto-spinner";

const isColorEnabled = !process.env.NO_COLOR && process.stderr.isTTY !== false;

let currentSpinner: ReturnType<typeof yoctoSpinner> | null = null;

/**
 * Spinner object with start/stop methods
 */
export const output = {
	start(text: string) {
		if (currentSpinner) {
			currentSpinner.stop();
		}
		currentSpinner = yoctoSpinner({ text }).start();
	},
	stop() {
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
};

/**
 * Create a spinner for long-running operations
 */
export function spinner(text: string) {
	return yoctoSpinner({ text }).start();
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
 * Print a boxed message for important info
 */
export function box(title: string, lines: string[]): void {
	const maxLen = Math.max(title.length, ...lines.map((l) => l.length));
	const width = maxLen + 4;
	const border = isColorEnabled ? "\x1b[90m" : "";
	const reset = isColorEnabled ? "\x1b[0m" : "";
	const titleColor = isColorEnabled ? "\x1b[1m" : "";

	console.error("");
	console.error(`${border}┌${"─".repeat(width)}┐${reset}`);
	console.error(
		`${border}│${reset}  ${titleColor}${title.padEnd(maxLen)}${reset}  ${border}│${reset}`,
	);
	console.error(`${border}├${"─".repeat(width)}┤${reset}`);
	for (const line of lines) {
		console.error(`${border}│${reset}  ${line.padEnd(maxLen)}  ${border}│${reset}`);
	}
	console.error(`${border}└${"─".repeat(width)}┘${reset}`);
	console.error("");
}

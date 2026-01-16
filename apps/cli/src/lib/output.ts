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
	celebrate,
};

/**
 * Create a spinner for long-running operations
 */
export function spinner(text: string) {
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

// Random neon purple for cyberpunk styling
function getRandomPurple(): string {
	const purples = [177, 165, 141, 129];
	const colorCode = purples[Math.floor(Math.random() * purples.length)];
	return `\x1b[38;5;${colorCode}m`;
}

/**
 * Print a boxed message for important info (cyberpunk style)
 */
export function box(title: string, lines: string[]): void {
	const maxLen = Math.max(title.length, ...lines.map((l) => l.length));
	const innerWidth = maxLen + 4;

	const purple = isColorEnabled ? getRandomPurple() : "";
	const bold = isColorEnabled ? "\x1b[1m" : "";
	const reset = isColorEnabled ? "\x1b[0m" : "";

	const bar = "═".repeat(innerWidth);
	const fill = "▓".repeat(innerWidth);
	const gradient = "░".repeat(innerWidth);

	const pad = (text: string) => `  ${text.padEnd(maxLen)}  `;

	console.error("");
	console.error(`  ${purple}╔${bar}╗${reset}`);
	console.error(`  ${purple}║${fill}║${reset}`);
	console.error(`  ${purple}║${pad(bold + title + reset + purple)}║${reset}`);
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
	const maxLen = Math.max(title.length, ...lines.map((l) => l.length));
	const innerWidth = maxLen + 4;

	const purple = isColorEnabled ? getRandomPurple() : "";
	const bold = isColorEnabled ? "\x1b[1m" : "";
	const reset = isColorEnabled ? "\x1b[0m" : "";

	const bar = "═".repeat(innerWidth);
	const fill = "▓".repeat(innerWidth);
	const gradient = "░".repeat(innerWidth);
	const space = " ".repeat(innerWidth);

	const center = (text: string) => {
		const left = Math.floor((innerWidth - text.length) / 2);
		return " ".repeat(left) + text + " ".repeat(innerWidth - text.length - left);
	};

	console.error("");
	console.error(`  ${purple}╔${bar}╗${reset}`);
	console.error(`  ${purple}║${fill}║${reset}`);
	console.error(`  ${purple}║${space}║${reset}`);
	console.error(`  ${purple}║${center(bold + title + reset + purple)}║${reset}`);
	console.error(`  ${purple}║${space}║${reset}`);
	for (const line of lines) {
		console.error(`  ${purple}║${center(line)}║${reset}`);
	}
	console.error(`  ${purple}║${space}║${reset}`);
	console.error(`  ${purple}║${gradient}║${reset}`);
	console.error(`  ${purple}╚${bar}╝${reset}`);
	console.error("");
}

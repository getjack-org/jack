// Debug utilities for timing and verbose logging

let debugEnabled =
	process.env.JACK_DEBUG === "1" || process.env.JACK_DEBUG === "true";
const timers: Map<string, number> = new Map();
const startTime = Date.now();

export function enableDebug() {
	debugEnabled = true;
}

export function isDebug(): boolean {
	return debugEnabled;
}

/**
 * Log debug message (only shown when --debug flag is set)
 */
export function debug(message: string, data?: unknown) {
	if (!debugEnabled) return;

	const elapsed = Date.now() - startTime;
	const prefix = `\x1b[90m[${elapsed}ms]\x1b[0m`;

	if (data !== undefined) {
		console.error(`${prefix} ${message}`, data);
	} else {
		console.error(`${prefix} ${message}`);
	}
}

/**
 * Start a timer for a step
 */
export function timerStart(label: string) {
	timers.set(label, Date.now());
	if (debugEnabled) {
		debug(`⏱ START: ${label}`);
	}
}

/**
 * End a timer and return duration in ms
 */
export function timerEnd(label: string): number {
	const start = timers.get(label);
	if (!start) return 0;

	const duration = Date.now() - start;
	timers.delete(label);

	if (debugEnabled) {
		const color = duration > 5000 ? "\x1b[31m" : duration > 2000 ? "\x1b[33m" : "\x1b[32m";
		debug(`⏱ END: ${label} ${color}${duration}ms\x1b[0m`);
	}

	return duration;
}

/**
 * Time an async function and return the duration in ms
 */
export async function time(label: string, fn: () => Promise<void>): Promise<number> {
	timerStart(label);
	try {
		await fn();
		return timerEnd(label);
	} catch (error) {
		timerEnd(label); // Clean up timer even on failure
		throw error;
	}
}

/**
 * Print timing summary at the end
 */
export function printTimingSummary(timings: Array<{ label: string; duration: number }>) {
	if (!debugEnabled) return;

	const total = Date.now() - startTime;

	console.error("");
	console.error("\x1b[1m📊 Timing Summary\x1b[0m");
	console.error("─".repeat(50));

	// Sort by duration descending
	const sorted = [...timings].sort((a, b) => b.duration - a.duration);

	for (const { label, duration } of sorted) {
		const pct = ((duration / total) * 100).toFixed(1);
		const bar = "█".repeat(Math.ceil((duration / total) * 20));
		const color = duration > 5000 ? "\x1b[31m" : duration > 2000 ? "\x1b[33m" : "\x1b[32m";
		console.error(
			`${label.padEnd(20)} ${color}${String(duration).padStart(6)}ms\x1b[0m (${pct}%) ${bar}`,
		);
	}

	console.error("─".repeat(50));
	console.error(`${"Total".padEnd(20)} ${String(total).padStart(6)}ms`);
	console.error("");
}

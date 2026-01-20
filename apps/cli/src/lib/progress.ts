/**
 * Progress tracker with delayed bar display
 * Shows a simple spinner initially, then reveals a progress bar
 * after a configurable delay (aligned with SPIRIT.md principles)
 */

import { formatSize } from "./format.ts";
import { colors, getRandomPurple } from "./output.ts";

export interface ProgressOptions {
	total: number;
	delayMs?: number;
	barWidth?: number;
	label?: string;
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Creates a progress tracker that shows a spinner initially,
 * then reveals a progress bar after a delay.
 *
 * Usage:
 *   const progress = createProgressTracker({ total: fileSize });
 *   progress.start();
 *   // ... during upload
 *   progress.update(bytesUploaded);
 *   // ... when done
 *   progress.complete();
 */
export function createProgressTracker(options: ProgressOptions) {
	const { total, delayMs = 2000, barWidth = 25, label = "Uploading" } = options;
	const startTime = Date.now();
	let frame = 0;
	let intervalId: Timer | null = null;
	let current = 0;

	function render() {
		const elapsed = Date.now() - startTime;
		const pct = Math.min(Math.round((current / total) * 100), 100);

		clearLine();

		if (elapsed < delayMs) {
			// Just spinner for first N seconds
			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} ${label}...`,
			);
		} else {
			// Show progress bar after delay
			const purple = getRandomPurple();
			const filled = Math.round((pct / 100) * barWidth);
			const empty = barWidth - filled;
			const bar = "▓".repeat(filled) + "░".repeat(empty);

			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} ${label} ${purple}[${bar}]${colors.reset} ${pct}% ${colors.dim}(${formatSize(current)} / ${formatSize(total)})${colors.reset}`,
			);
		}
	}

	return {
		start() {
			render();
			intervalId = setInterval(render, 80);
		},

		update(bytes: number) {
			current = bytes;
		},

		complete() {
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
			clearLine();
		},
	};
}

function clearLine() {
	if (process.stderr.isTTY) {
		process.stderr.write("\r\x1b[K");
	}
}

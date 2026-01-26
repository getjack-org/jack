#!/usr/bin/env bun
/**
 * Demo script for progress indicator and debug output options
 * Run: ./scripts/demo-progress.ts
 *
 * Tests different visual styles for:
 * - Upload progress indicators
 * - Debug output during uploads
 * - Time-delayed progress appearance
 */

const isColorEnabled = !process.env.NO_COLOR && process.stderr.isTTY !== false;

// Colors matching output.ts
const colors = {
	green: isColorEnabled ? "\x1b[32m" : "",
	red: isColorEnabled ? "\x1b[31m" : "",
	yellow: isColorEnabled ? "\x1b[33m" : "",
	cyan: isColorEnabled ? "\x1b[36m" : "",
	dim: isColorEnabled ? "\x1b[90m" : "",
	bold: isColorEnabled ? "\x1b[1m" : "",
	reset: isColorEnabled ? "\x1b[0m" : "",
};

// Random neon purple for cyberpunk styling (from output.ts)
function getRandomPurple(): string {
	if (!isColorEnabled) return "";
	const purples = [177, 165, 141, 129];
	const colorCode = purples[Math.floor(Math.random() * purples.length)];
	return `\x1b[38;5;${colorCode}m`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function clearLine() {
	process.stderr.write("\r\x1b[K");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SECTION HEADER
// ============================================================================

function sectionHeader(title: string) {
	const purple = getRandomPurple();
	const line = "─".repeat(60);
	console.error("");
	console.error(`${purple}${line}${colors.reset}`);
	console.error(`${purple}${colors.bold}  ${title}${colors.reset}`);
	console.error(`${purple}${line}${colors.reset}`);
	console.error("");
}

// ============================================================================
// OPTION 1: Simple Spinner with Updating Text (Current Approach)
// ============================================================================

async function demo1_simpleSpinner() {
	sectionHeader("Option 1: Simple Spinner (Current)");

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let i = 0;

	const stages = ["Syncing source to storage...", "Uploading files...", "Finalizing..."];

	for (const stage of stages) {
		for (let j = 0; j < 10; j++) {
			clearLine();
			process.stderr.write(`${colors.cyan}${frames[i++ % frames.length]}${colors.reset} ${stage}`);
			await sleep(100);
		}
	}

	clearLine();
	console.error(`${colors.green}✓${colors.reset} Synced source (42 files)`);
}

// ============================================================================
// OPTION 2: Progress Bar with Percentage
// ============================================================================

async function demo2_progressBar() {
	sectionHeader("Option 2: Progress Bar");

	const total = 5.4 * 1024 * 1024; // 5.4MB
	const barWidth = 30;

	for (let progress = 0; progress <= 100; progress += 5) {
		const filled = Math.round((progress / 100) * barWidth);
		const empty = barWidth - filled;
		const current = (progress / 100) * total;

		// Style A: Block characters
		const barA = "█".repeat(filled) + "░".repeat(empty);

		clearLine();
		process.stderr.write(
			`${colors.cyan}↑${colors.reset} Uploading ${colors.dim}[${barA}]${colors.reset} ${progress}% ${colors.dim}(${formatSize(current)} / ${formatSize(total)})${colors.reset}`,
		);
		await sleep(80);
	}

	clearLine();
	console.error(`${colors.green}✓${colors.reset} Uploaded ${formatSize(total)}`);

	await sleep(500);

	// Style B: Cyberpunk gradient
	console.error("");
	console.error(`${colors.dim}  Alternative bar styles:${colors.reset}`);

	const purple = getRandomPurple();
	const barB = "▓".repeat(20) + "░".repeat(10);
	console.error(`  ${purple}[${barB}]${colors.reset} 67%`);

	const barC = "━".repeat(20) + "─".repeat(10);
	console.error(`  ${colors.cyan}${barC}${colors.reset} 67%`);

	const barD = "●".repeat(7) + "○".repeat(3);
	console.error(`  ${colors.green}${barD}${colors.reset} 70%`);
}

// ============================================================================
// OPTION 3: File Counter
// ============================================================================

async function demo3_fileCounter() {
	sectionHeader("Option 3: File Counter");

	const files = [
		"src/index.ts",
		"src/lib/auth.ts",
		"src/lib/database.ts",
		"src/components/Button.tsx",
		"src/components/Card.tsx",
		"package.json",
		"wrangler.jsonc",
	];

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;

	for (let i = 0; i < files.length; i++) {
		for (let j = 0; j < 5; j++) {
			clearLine();
			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} Uploading ${colors.dim}(${i + 1}/${files.length})${colors.reset} ${files[i]}`,
			);
			await sleep(60);
		}
	}

	clearLine();
	console.error(`${colors.green}✓${colors.reset} Uploaded ${files.length} files`);
}

// ============================================================================
// OPTION 4: Minimal - Delayed Progress (SPIRIT.md aligned)
// ============================================================================

async function demo4_delayedProgress() {
	sectionHeader("Option 4: Delayed Progress (SPIRIT.md)");
	console.error(`${colors.dim}  Progress only appears after 2 seconds${colors.reset}`);
	console.error("");

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;

	const totalMs = 4000;
	const delayMs = 2000;
	const startTime = Date.now();

	let showingProgress = false;
	const total = 5.4 * 1024 * 1024;

	while (Date.now() - startTime < totalMs) {
		const elapsed = Date.now() - startTime;
		const progress = Math.min(elapsed / totalMs, 1);
		const current = progress * total;

		clearLine();

		if (elapsed < delayMs) {
			// Just spinner for first 2 seconds
			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} Uploading...`,
			);
		} else {
			// Show progress after 2 seconds
			if (!showingProgress) {
				showingProgress = true;
			}
			const pct = Math.round(progress * 100);
			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} Uploading... ${colors.dim}${pct}% (${formatSize(current)} / ${formatSize(total)})${colors.reset}`,
			);
		}

		await sleep(50);
	}

	clearLine();
	console.error(`${colors.green}✓${colors.reset} Uploaded ${formatSize(total)}`);
}

// ============================================================================
// OPTION 5: Staged Progress for Multi-Step
// ============================================================================

async function demo5_stagedProgress() {
	sectionHeader("Option 5: Staged Progress");

	const stages = [
		{ name: "Scanning files", duration: 800 },
		{ name: "Creating archive", duration: 1200 },
		{ name: "Uploading to cloud", duration: 2000 },
		{ name: "Verifying", duration: 500 },
	];

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;

	for (let s = 0; s < stages.length; s++) {
		const stage = stages[s];
		const stageStart = Date.now();

		while (Date.now() - stageStart < stage.duration) {
			clearLine();
			const stageInfo = `${colors.dim}(${s + 1}/${stages.length})${colors.reset}`;
			process.stderr.write(
				`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} ${stage.name} ${stageInfo}`,
			);
			await sleep(50);
		}

		clearLine();
		console.error(`${colors.green}✓${colors.reset} ${stage.name}`);
	}
}

// ============================================================================
// OPTION 6: Debug Output Styles
// ============================================================================

async function demo6_debugOutput() {
	sectionHeader("Option 6: Debug Output (--debug flag)");

	// Style A: Timestamped
	console.error(`${colors.dim}Style A: Timestamped${colors.reset}`);
	console.error("");
	console.error(`${colors.dim}[0ms]${colors.reset} Starting source upload`);
	console.error(`${colors.dim}[12ms]${colors.reset} Scanning project files...`);
	console.error(
		`${colors.dim}[45ms]${colors.reset} Found 42 files (${formatSize(5.4 * 1024 * 1024)} total)`,
	);
	console.error(`${colors.dim}[52ms]${colors.reset} Creating source.zip...`);
	console.error(
		`${colors.dim}[180ms]${colors.reset} Compressed to ${formatSize(1.2 * 1024 * 1024)}`,
	);
	console.error(`${colors.dim}[185ms]${colors.reset} Uploading to control-plane...`);
	console.error(
		`${colors.dim}[2340ms]${colors.reset} ${colors.green}Upload complete${colors.reset}`,
	);
	console.error("");

	await sleep(1000);

	// Style B: Indented tree
	console.error(`${colors.dim}Style B: Tree structure${colors.reset}`);
	console.error("");
	console.error(`${colors.cyan}→${colors.reset} Uploading source`);
	console.error(
		`  ${colors.dim}├─${colors.reset} src/index.ts ${colors.dim}(2.1KB)${colors.reset}`,
	);
	console.error(
		`  ${colors.dim}├─${colors.reset} src/lib/auth.ts ${colors.dim}(4.5KB)${colors.reset}`,
	);
	console.error(
		`  ${colors.dim}├─${colors.reset} src/lib/database.ts ${colors.dim}(3.2KB)${colors.reset}`,
	);
	console.error(`  ${colors.dim}├─${colors.reset} ... ${colors.dim}(38 more files)${colors.reset}`);
	console.error(
		`  ${colors.dim}└─${colors.reset} package.json ${colors.dim}(1.1KB)${colors.reset}`,
	);
	console.error(
		`${colors.green}✓${colors.reset} 42 files uploaded (${formatSize(5.4 * 1024 * 1024)})`,
	);
	console.error("");

	await sleep(1000);

	// Style C: Compact with summary
	console.error(`${colors.dim}Style C: Compact summary${colors.reset}`);
	console.error("");
	console.error(
		`${colors.cyan}→${colors.reset} Source: 42 files, ${formatSize(5.4 * 1024 * 1024)} → ${formatSize(1.2 * 1024 * 1024)} compressed`,
	);
	console.error(
		`${colors.cyan}→${colors.reset} Largest: src/assets/logo.png (${formatSize(245 * 1024)})`,
	);
	console.error(`${colors.green}✓${colors.reset} Uploaded in 2.3s`);
}

// ============================================================================
// OPTION 7: Warning for Large Uploads
// ============================================================================

async function demo7_largeUploadWarning() {
	sectionHeader("Option 7: Large Upload Warning");

	const purple = getRandomPurple();

	// Non-blocking warning
	console.error(
		`${colors.yellow}!${colors.reset} Large upload detected: ${formatSize(340 * 1024 * 1024)}`,
	);
	console.error(`  ${colors.dim}Consider adding to .jackignore:${colors.reset}`);
	console.error(
		`  ${colors.dim}  - public/videos/  (${formatSize(280 * 1024 * 1024)})${colors.reset}`,
	);
	console.error(
		`  ${colors.dim}  - assets/raw/     (${formatSize(45 * 1024 * 1024)})${colors.reset}`,
	);
	console.error("");

	// Continue anyway
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;

	for (let i = 0; i < 30; i++) {
		clearLine();
		const pct = Math.round((i / 30) * 100);
		process.stderr.write(
			`${colors.cyan}${frames[frame++ % frames.length]}${colors.reset} Uploading... ${colors.dim}${pct}%${colors.reset}`,
		);
		await sleep(100);
	}

	clearLine();
	console.error(`${colors.green}✓${colors.reset} Uploaded ${formatSize(340 * 1024 * 1024)}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	const purple = getRandomPurple();

	console.error("");
	console.error(
		`${purple}╔════════════════════════════════════════════════════════════╗${colors.reset}`,
	);
	console.error(
		`${purple}║${colors.bold}  JACK PROGRESS INDICATOR DEMO                              ${colors.reset}${purple}║${colors.reset}`,
	);
	console.error(
		`${purple}║${colors.dim}  Testing visual options for upload feedback                ${colors.reset}${purple}║${colors.reset}`,
	);
	console.error(
		`${purple}╚════════════════════════════════════════════════════════════╝${colors.reset}`,
	);

	await demo1_simpleSpinner();
	await sleep(800);

	await demo2_progressBar();
	await sleep(800);

	await demo3_fileCounter();
	await sleep(800);

	await demo4_delayedProgress();
	await sleep(800);

	await demo5_stagedProgress();
	await sleep(800);

	await demo6_debugOutput();
	await sleep(800);

	await demo7_largeUploadWarning();

	sectionHeader("Summary");
	console.error(`${colors.cyan}→${colors.reset} Option 1: Current approach - simple spinner`);
	console.error(
		`${colors.cyan}→${colors.reset} Option 2: Progress bar - good for single large file`,
	);
	console.error(`${colors.cyan}→${colors.reset} Option 3: File counter - good for many files`);
	console.error(
		`${colors.cyan}→${colors.reset} Option 4: Delayed progress - SPIRIT.md aligned (recommended)`,
	);
	console.error(`${colors.cyan}→${colors.reset} Option 5: Staged progress - multi-step operations`);
	console.error(`${colors.cyan}→${colors.reset} Option 6: Debug output - enhanced --debug flag`);
	console.error(
		`${colors.cyan}→${colors.reset} Option 7: Large upload warning - non-blocking alert`,
	);
	console.error("");

	console.error(
		`${colors.dim}Recommendation: Option 4 (delayed) + Option 6 Style C (debug) + Option 7 (warning)${colors.reset}`,
	);
	console.error("");
}

main().catch(console.error);

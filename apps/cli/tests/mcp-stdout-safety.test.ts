import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src");
const LIB_DIR = join(SRC_DIR, "lib");
const MCP_DIR = join(SRC_DIR, "mcp");

/**
 * Recursively collect all .ts files in a directory.
 */
function collectTsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTsFiles(fullPath));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

/**
 * Check files for a pattern, returning matches with file path and line info.
 */
function findViolations(
	files: string[],
	pattern: RegExp,
	ignorePattern?: RegExp,
): { file: string; line: number; text: string }[] {
	const violations: { file: string; line: number; text: string }[] = [];
	for (const file of files) {
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (pattern.test(line) && (!ignorePattern || !ignorePattern.test(line))) {
				violations.push({
					file: file.replace(SRC_DIR + "/", ""),
					line: i + 1,
					text: line.trim(),
				});
			}
		}
	}
	return violations;
}

describe("MCP stdout safety", () => {
	const libFiles = collectTsFiles(LIB_DIR);
	const mcpFiles = collectTsFiles(MCP_DIR);

	test("no console.log() calls in src/lib/ (use console.error for MCP safety)", () => {
		const violations = findViolations(
			libFiles,
			/\bconsole\.log\s*\(/,
			// Ignore comments and string literals mentioning console.log
			/^\s*(\/\/|\/\*|\*|["'`].*console\.log)/,
		);
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  ${v.file}:${v.line} → ${v.text}`)
				.join("\n");
			throw new Error(
				`Found console.log() in src/lib/ which would corrupt MCP stdout:\n${report}\n\nUse console.error() instead, or gate behind an 'interactive' flag.`,
			);
		}
	});

	test("no console.log() calls in src/mcp/ (use console.error for MCP safety)", () => {
		const violations = findViolations(
			mcpFiles,
			/\bconsole\.log\s*\(/,
			/^\s*(\/\/|\/\*|\*|["'`].*console\.log)/,
		);
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  ${v.file}:${v.line} → ${v.text}`)
				.join("\n");
			throw new Error(
				`Found console.log() in src/mcp/ which would corrupt MCP stdout:\n${report}\n\nUse console.error() instead.`,
			);
		}
	});

	test("no unconditional stdout: 'inherit' in src/lib/ (must be gated on interactive flag)", () => {
		// Match stdout: "inherit" that is NOT preceded by a ternary condition (interactive ? ...)
		const violations = findViolations(
			libFiles,
			/stdout:\s*["']inherit["']/,
			// Allow: stdout: interactive ? "inherit" : "pipe"
			/\?\s*["']inherit["']/,
		);
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  ${v.file}:${v.line} → ${v.text}`)
				.join("\n");
			throw new Error(
				`Found unconditional stdout: "inherit" in src/lib/ which would corrupt MCP stdout:\n${report}\n\nUse: stdout: interactive ? "inherit" : "pipe"`,
			);
		}
	});

	test("no process.stdout.write() in src/lib/ (would corrupt MCP protocol)", () => {
		const violations = findViolations(
			libFiles,
			/process\.stdout\.write\s*\(/,
			/^\s*(\/\/|\/\*|\*)/,
		);
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  ${v.file}:${v.line} → ${v.text}`)
				.join("\n");
			throw new Error(
				`Found process.stdout.write() in src/lib/ which would corrupt MCP stdout:\n${report}\n\nUse console.error() or pass output through a reporter.`,
			);
		}
	});
});

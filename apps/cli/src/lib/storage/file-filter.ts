/**
 * File filtering logic with include/exclude patterns and .jackignore support
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";

export interface FileFilterConfig {
	includes: string[];
	excludes: string[];
}

export interface FilteredFile {
	path: string;
	absolutePath: string;
	size: number;
}

export const DEFAULT_INCLUDES: string[] = [
	"*.ts",
	"*.tsx",
	"*.js",
	"*.jsx",
	"*.mjs",
	"*.cjs",
	"*.json",
	"*.jsonc",
	"*.toml",
	"*.md",
	"*.css",
	"*.scss",
	"*.html",
	"*.sql",
	"src/**",
	"lib/**",
	"public/**",
	"assets/**",
];

export const DEFAULT_EXCLUDES: string[] = [
	"node_modules/**",
	".git/**",
	".env",
	".env.*",
	".dev.vars",
	".secrets.json",
	"*.log",
	".DS_Store",
	"dist/**",
	"build/**",
	"coverage/**",
	".wrangler/**",
	"*.lock",
	"bun.lock",
	"package-lock.json",
];

/**
 * Loads patterns from .jackignore file if it exists
 * @param projectDir - Absolute path to project directory
 * @returns Array of ignore patterns (empty if file doesn't exist)
 */
export async function loadJackignore(projectDir: string): Promise<string[]> {
	const jackignorePath = join(projectDir, ".jackignore");
	try {
		const content = await readFile(jackignorePath, "utf-8");
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
	} catch {
		// File doesn't exist or can't be read
		return [];
	}
}

/**
 * Checks if a file should be included based on filter configuration
 * @param relativePath - Path relative to project root
 * @param config - Filter configuration with includes/excludes
 * @returns true if file should be included
 */
export function shouldIncludeFile(relativePath: string, config: FileFilterConfig): boolean {
	// Check excludes first (they take precedence)
	for (const pattern of config.excludes) {
		const glob = new Glob(pattern);
		if (glob.match(relativePath)) {
			return false;
		}
	}

	// If no includes specified, include everything not excluded
	if (config.includes.length === 0) {
		return true;
	}

	// Check if matches any include pattern
	for (const pattern of config.includes) {
		const glob = new Glob(pattern);
		if (glob.match(relativePath)) {
			return true;
		}
	}

	return false;
}

/**
 * Scans project directory and returns filtered files
 * @param projectDir - Absolute path to project directory
 * @returns Array of filtered files with metadata
 */
export async function scanProjectFiles(projectDir: string): Promise<FilteredFile[]> {
	const jackignorePatterns = await loadJackignore(projectDir);

	const config: FileFilterConfig = {
		includes: DEFAULT_INCLUDES,
		excludes: [...DEFAULT_EXCLUDES, ...jackignorePatterns],
	};

	const files: FilteredFile[] = [];

	// Use recursive readdir to get all files
	const entries = await readdir(projectDir, {
		recursive: true,
		withFileTypes: true,
	});

	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		// parentPath is available when using recursive: true
		const parentDir = entry.parentPath ?? projectDir;
		const absolutePath = join(parentDir, entry.name);
		const relativePath = relative(projectDir, absolutePath);

		if (shouldIncludeFile(relativePath, config)) {
			const stats = await stat(absolutePath);
			files.push({
				path: relativePath,
				absolutePath,
				size: stats.size,
			});
		}
	}

	return files;
}

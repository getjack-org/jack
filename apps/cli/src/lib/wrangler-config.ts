/**
 * Utilities for modifying wrangler.jsonc while preserving comments
 */

import { existsSync } from "node:fs";
import { parseJsonc } from "./jsonc.ts";

export interface D1BindingConfig {
	binding: string; // e.g., "DB" or "ANALYTICS_DB"
	database_name: string; // e.g., "my-app-db"
	database_id: string; // UUID from Cloudflare
}

interface WranglerConfig {
	d1_databases?: Array<{
		binding: string;
		database_name?: string;
		database_id?: string;
	}>;
	[key: string]: unknown;
}

/**
 * Get existing D1 bindings from wrangler.jsonc
 */
export async function getExistingD1Bindings(configPath: string): Promise<D1BindingConfig[]> {
	if (!existsSync(configPath)) {
		throw new Error(`wrangler.jsonc not found at ${configPath}`);
	}

	const content = await Bun.file(configPath).text();
	const config = parseJsonc<WranglerConfig>(content);

	if (!config.d1_databases || !Array.isArray(config.d1_databases)) {
		return [];
	}

	return config.d1_databases
		.filter((db) => db.binding && db.database_name && db.database_id)
		.map((db) => ({
			binding: db.binding,
			database_name: db.database_name as string,
			database_id: db.database_id as string,
		}));
}

/**
 * Add a D1 database binding to wrangler.jsonc while preserving comments.
 *
 * Uses text manipulation to preserve comments rather than full JSON parsing.
 */
export async function addD1Binding(configPath: string, binding: D1BindingConfig): Promise<void> {
	if (!existsSync(configPath)) {
		throw new Error(
			`wrangler.jsonc not found at ${configPath}. Create a wrangler.jsonc file first or run 'jack new' to create a new project.`,
		);
	}

	const content = await Bun.file(configPath).text();

	// Parse to understand existing structure
	const config = parseJsonc<WranglerConfig>(content);

	// Format the new binding entry
	const bindingJson = formatD1BindingEntry(binding);

	let newContent: string;

	if (config.d1_databases && Array.isArray(config.d1_databases)) {
		// d1_databases exists - append to the array
		newContent = appendToD1DatabasesArray(content, bindingJson);
	} else {
		// d1_databases doesn't exist - add it before closing brace
		newContent = addD1DatabasesSection(content, bindingJson);
	}

	await Bun.write(configPath, newContent);
}

/**
 * Format a D1 binding as a JSON object string with proper indentation
 */
function formatD1BindingEntry(binding: D1BindingConfig): string {
	return `{
			"binding": "${binding.binding}",
			"database_name": "${binding.database_name}",
			"database_id": "${binding.database_id}"
		}`;
}

/**
 * Append a new entry to an existing d1_databases array.
 * Finds the closing bracket of the array and inserts before it.
 */
function appendToD1DatabasesArray(content: string, bindingJson: string): string {
	// Find "d1_databases" and then find its closing bracket
	const d1Match = content.match(/"d1_databases"\s*:\s*\[/);
	if (!d1Match || d1Match.index === undefined) {
		throw new Error("Could not find d1_databases array in config");
	}

	const arrayStartIndex = d1Match.index + d1Match[0].length;

	// Find the matching closing bracket, accounting for nested structures
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");
	if (closingBracketIndex === -1) {
		throw new Error("Could not find closing bracket for d1_databases array");
	}

	// Check if array is empty or has content
	const arrayContent = content.slice(arrayStartIndex, closingBracketIndex).trim();
	const isEmpty = arrayContent === "" || isOnlyCommentsAndWhitespace(arrayContent);

	// Build the insertion
	let insertion: string;
	if (isEmpty) {
		// Empty array - just add the entry
		insertion = `\n\t\t${bindingJson}\n\t`;
	} else {
		// Has existing entries - add comma and new entry
		insertion = `,\n\t\t${bindingJson}`;
	}

	// Find position just before the closing bracket
	// We want to insert after the last non-whitespace content but before the bracket
	const beforeBracket = content.slice(0, closingBracketIndex);
	const afterBracket = content.slice(closingBracketIndex);

	if (isEmpty) {
		return beforeBracket + insertion + afterBracket;
	}

	// For non-empty arrays, find the last closing brace of an object in the array
	const lastObjectEnd = findLastObjectEndInArray(content, arrayStartIndex, closingBracketIndex);
	if (lastObjectEnd === -1) {
		// Fallback: insert before closing bracket
		return beforeBracket + insertion + afterBracket;
	}

	return content.slice(0, lastObjectEnd + 1) + insertion + content.slice(lastObjectEnd + 1);
}

/**
 * Add a new d1_databases section to the config.
 * Inserts before the final closing brace.
 */
function addD1DatabasesSection(content: string, bindingJson: string): string {
	// Find the last closing brace in the file
	const lastBraceIndex = content.lastIndexOf("}");
	if (lastBraceIndex === -1) {
		throw new Error("Invalid JSON: no closing brace found");
	}

	// Check what comes before the last brace to determine if we need a comma
	const beforeBrace = content.slice(0, lastBraceIndex);
	const needsComma = shouldAddCommaBefore(beforeBrace);

	// Build the d1_databases section
	const d1Section = `"d1_databases": [
		${bindingJson}
	]`;

	// Find proper insertion point - look for last non-whitespace content
	const trimmedBefore = beforeBrace.trimEnd();
	const whitespaceAfterContent = beforeBrace.slice(trimmedBefore.length);

	let insertion: string;
	if (needsComma) {
		insertion = `,\n\t${d1Section}`;
	} else {
		insertion = `\n\t${d1Section}`;
	}

	// Reconstruct: content before + insertion + newline + closing brace
	return trimmedBefore + insertion + "\n" + content.slice(lastBraceIndex);
}

/**
 * Find the matching closing bracket/brace for an opening one
 */
function findMatchingBracket(
	content: string,
	startIndex: number,
	openChar: string,
	closeChar: string,
): number {
	let depth = 0;
	let inString = false;
	let stringChar = "";
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = startIndex; i < content.length; i++) {
		const char = content[i] ?? "";
		const next = content[i + 1] ?? "";

		// Handle line comments
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
			}
			continue;
		}

		// Handle block comments
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		// Handle strings
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = "";
			}
			continue;
		}

		// Check for comment start
		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		// Check for string start
		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			continue;
		}

		// Track bracket depth
		if (char === openChar) {
			depth++;
		} else if (char === closeChar) {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}

	return -1;
}

/**
 * Check if content is only whitespace and comments
 */
function isOnlyCommentsAndWhitespace(content: string): boolean {
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i] ?? "";
		const next = content[i + 1] ?? "";

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		if (!/\s/.test(char)) {
			return false;
		}
	}

	return true;
}

/**
 * Find the last closing brace of an object within an array range
 */
function findLastObjectEndInArray(content: string, startIndex: number, endIndex: number): number {
	let lastBraceIndex = -1;
	let inString = false;
	let stringChar = "";
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = startIndex; i < endIndex; i++) {
		const char = content[i] ?? "";
		const next = content[i + 1] ?? "";

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = "";
			}
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			continue;
		}

		if (char === "}") {
			lastBraceIndex = i;
		}
	}

	return lastBraceIndex;
}

/**
 * Determine if we need to add a comma before new content.
 * Looks at the last non-whitespace, non-comment character.
 */
function shouldAddCommaBefore(content: string): boolean {
	// Strip trailing comments and whitespace to find last meaningful char
	let i = content.length - 1;
	let inLineComment = false;

	// First pass: find where any trailing line comment starts
	for (let j = content.length - 1; j >= 0; j--) {
		if (content[j] === "\n") {
			// Check if there's a // comment on this line
			const lineStart = content.lastIndexOf("\n", j - 1) + 1;
			const line = content.slice(lineStart, j);
			const commentIndex = findLineCommentStart(line);
			if (commentIndex !== -1) {
				i = lineStart + commentIndex - 1;
			}
			break;
		}
	}

	// Skip whitespace
	while (i >= 0 && /\s/.test(content[i] ?? "")) {
		i--;
	}

	if (i < 0) return false;

	const lastChar = content[i];
	// Need comma if last char is }, ], ", number, or identifier char
	// Don't need comma if last char is { or [ or ,
	return lastChar !== "{" && lastChar !== "[" && lastChar !== ",";
}

/**
 * Find the start of a line comment (//) in a string, respecting strings
 */
function findLineCommentStart(line: string): number {
	let inString = false;
	let stringChar = "";
	let escaped = false;

	for (let i = 0; i < line.length - 1; i++) {
		const char = line[i] ?? "";
		const next = line[i + 1] ?? "";

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = "";
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			continue;
		}

		if (char === "/" && next === "/") {
			return i;
		}
	}

	return -1;
}

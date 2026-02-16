/**
 * Utilities for modifying wrangler.jsonc while preserving comments
 */

import { existsSync } from "node:fs";
import {
	addSectionBeforeClosingBrace,
	findLastObjectEndInArray,
	findMatchingBracket,
	isOnlyCommentsAndWhitespace,
	shouldAddCommaBefore,
} from "./jsonc-edit.ts";
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
	return addSectionBeforeClosingBrace(content, `"d1_databases": [\n\t\t${bindingJson}\n\t]`);
}

/**
 * Remove a D1 database binding from wrangler.jsonc by database_name.
 * Preserves comments and formatting.
 *
 * @returns true if binding was found and removed, false if not found
 */
export async function removeD1Binding(configPath: string, databaseName: string): Promise<boolean> {
	if (!existsSync(configPath)) {
		throw new Error(`wrangler.jsonc not found at ${configPath}. Cannot remove binding.`);
	}

	const content = await Bun.file(configPath).text();

	// Parse to understand existing structure
	const config = parseJsonc<WranglerConfig>(content);

	// Check if d1_databases exists and has entries
	if (!config.d1_databases || !Array.isArray(config.d1_databases)) {
		return false;
	}

	// Find the binding to remove
	const bindingIndex = config.d1_databases.findIndex((db) => db.database_name === databaseName);

	if (bindingIndex === -1) {
		return false; // Binding not found
	}

	// Use text manipulation to remove the binding while preserving formatting
	const newContent = removeD1DatabaseEntryFromContent(content, databaseName);

	if (newContent === content) {
		return false; // Nothing changed
	}

	await Bun.write(configPath, newContent);
	return true;
}

/**
 * Remove a specific D1 database entry from the d1_databases array in content.
 * Handles comma placement and preserves comments.
 */
function removeD1DatabaseEntryFromContent(content: string, databaseName: string): string {
	// Find the d1_databases array
	const d1Match = content.match(/"d1_databases"\s*:\s*\[/);
	if (!d1Match || d1Match.index === undefined) {
		return content;
	}

	const arrayStartIndex = d1Match.index + d1Match[0].length;
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");

	if (closingBracketIndex === -1) {
		return content;
	}

	const arrayContent = content.slice(arrayStartIndex, closingBracketIndex);

	// Find the object containing this database_name
	const escapedName = databaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const dbNamePattern = new RegExp(`"database_name"\\s*:\\s*"${escapedName}"`);

	const match = dbNamePattern.exec(arrayContent);
	if (!match) {
		return content;
	}

	// Find the enclosing object boundaries
	const matchPosInArray = match.index;
	const objectStart = findObjectStartBefore(arrayContent, matchPosInArray);
	const objectEnd = findObjectEndAfter(arrayContent, matchPosInArray);

	if (objectStart === -1 || objectEnd === -1) {
		return content;
	}

	// Determine comma handling
	let removeStart = objectStart;
	let removeEnd = objectEnd + 1;

	// Check for trailing comma after the object
	const afterObject = arrayContent.slice(objectEnd + 1);
	const trailingCommaMatch = afterObject.match(/^\s*,/);

	// Check for leading comma before the object
	const beforeObject = arrayContent.slice(0, objectStart);
	const leadingCommaMatch = beforeObject.match(/,\s*$/);

	if (trailingCommaMatch) {
		// Remove trailing comma
		removeEnd = objectEnd + 1 + trailingCommaMatch[0].length;
	} else if (leadingCommaMatch) {
		// Remove leading comma
		removeStart = objectStart - leadingCommaMatch[0].length;
	}

	// Build new array content
	const newArrayContent = arrayContent.slice(0, removeStart) + arrayContent.slice(removeEnd);

	// Check if array is now effectively empty (only whitespace/comments)
	const trimmedArray = newArrayContent.replace(/\/\/[^\n]*/g, "").trim();
	if (trimmedArray === "" || trimmedArray === "[]") {
		// Remove the entire d1_databases property
		return removeD1DatabasesProperty(content, d1Match.index, closingBracketIndex);
	}

	return content.slice(0, arrayStartIndex) + newArrayContent + content.slice(closingBracketIndex);
}

/**
 * Find the start of the object (opening brace) before the given position.
 */
function findObjectStartBefore(content: string, fromPos: number): number {
	let depth = 0;
	for (let i = fromPos; i >= 0; i--) {
		const char = content[i];
		if (char === "}") depth++;
		if (char === "{") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/**
 * Find the end of the object (closing brace) after the given position.
 */
function findObjectEndAfter(content: string, fromPos: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = fromPos; i < content.length; i++) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") depth++;
		if (char === "}") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/**
 * Remove the entire d1_databases property when it becomes empty.
 */
function removeD1DatabasesProperty(
	content: string,
	propertyStart: number,
	arrayEnd: number,
): string {
	let removeStart = propertyStart;
	let removeEnd = arrayEnd + 1;

	// Look backward for a comma to remove
	const beforeProperty = content.slice(0, propertyStart);
	const leadingCommaMatch = beforeProperty.match(/,\s*$/);

	// Look forward for a trailing comma
	const afterProperty = content.slice(arrayEnd + 1);
	const trailingCommaMatch = afterProperty.match(/^\s*,/);

	if (leadingCommaMatch) {
		removeStart = propertyStart - leadingCommaMatch[0].length;
	} else if (trailingCommaMatch) {
		removeEnd = arrayEnd + 1 + trailingCommaMatch[0].length;
	}

	return content.slice(0, removeStart) + content.slice(removeEnd);
}

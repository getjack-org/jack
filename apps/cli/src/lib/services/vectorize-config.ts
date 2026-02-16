/**
 * Utilities for reading and modifying Vectorize bindings in wrangler.jsonc
 */

import { existsSync } from "node:fs";
import {
	addSectionBeforeClosingBrace,
	findLastObjectEndInArray,
	findMatchingBracket,
	isOnlyCommentsAndWhitespace,
} from "../jsonc-edit.ts";
import { parseJsonc } from "../jsonc.ts";

export interface VectorizeBindingConfig {
	binding: string; // e.g., "VECTORS" or "SEARCH_INDEX"
	index_name: string; // e.g., "my-app-vectors"
}

interface WranglerConfig {
	vectorize?: Array<{
		binding: string;
		index_name?: string;
	}>;
	[key: string]: unknown;
}

/**
 * Get existing Vectorize bindings from wrangler.jsonc
 */
export async function getExistingVectorizeBindings(
	configPath: string,
): Promise<VectorizeBindingConfig[]> {
	if (!existsSync(configPath)) {
		return [];
	}

	const content = await Bun.file(configPath).text();
	const config = parseJsonc<WranglerConfig>(content);

	if (!config.vectorize || !Array.isArray(config.vectorize)) {
		return [];
	}

	return config.vectorize
		.filter((v) => v.binding && v.index_name)
		.map((v) => ({
			binding: v.binding,
			index_name: v.index_name as string,
		}));
}

/**
 * Add a Vectorize binding to wrangler.jsonc while preserving comments.
 */
export async function addVectorizeBinding(
	configPath: string,
	binding: VectorizeBindingConfig,
): Promise<void> {
	if (!existsSync(configPath)) {
		throw new Error(
			`wrangler.jsonc not found at ${configPath}. Create a wrangler.jsonc file first or run 'jack new' to create a new project.`,
		);
	}

	const content = await Bun.file(configPath).text();
	const config = parseJsonc<WranglerConfig>(content);

	// Format the new binding entry
	const bindingJson = formatVectorizeBindingEntry(binding);

	let newContent: string;

	if (config.vectorize && Array.isArray(config.vectorize)) {
		// vectorize exists - append to the array
		newContent = appendToVectorizeArray(content, bindingJson);
	} else {
		// vectorize doesn't exist - add it before closing brace
		newContent = addVectorizeSection(content, bindingJson);
	}

	await Bun.write(configPath, newContent);
}

/**
 * Format a Vectorize binding as a JSON object string with proper indentation
 */
function formatVectorizeBindingEntry(binding: VectorizeBindingConfig): string {
	return `{
			"binding": "${binding.binding}",
			"index_name": "${binding.index_name}"
		}`;
}

/**
 * Append a new entry to an existing vectorize array.
 */
function appendToVectorizeArray(content: string, bindingJson: string): string {
	// Find "vectorize" and then find its closing bracket
	const vecMatch = content.match(/"vectorize"\s*:\s*\[/);
	if (!vecMatch || vecMatch.index === undefined) {
		throw new Error("Could not find vectorize array in config");
	}

	const arrayStartIndex = vecMatch.index + vecMatch[0].length;
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");
	if (closingBracketIndex === -1) {
		throw new Error("Could not find closing bracket for vectorize array");
	}

	// Check if array is empty or has content
	const arrayContent = content.slice(arrayStartIndex, closingBracketIndex).trim();
	const isEmpty = arrayContent === "" || isOnlyCommentsAndWhitespace(arrayContent);

	let insertion: string;
	if (isEmpty) {
		insertion = `\n\t\t${bindingJson}\n\t`;
	} else {
		insertion = `,\n\t\t${bindingJson}`;
	}

	const beforeBracket = content.slice(0, closingBracketIndex);
	const afterBracket = content.slice(closingBracketIndex);

	if (isEmpty) {
		return beforeBracket + insertion + afterBracket;
	}

	// For non-empty arrays, find the last closing brace of an object in the array
	const lastObjectEnd = findLastObjectEndInArray(content, arrayStartIndex, closingBracketIndex);
	if (lastObjectEnd === -1) {
		return beforeBracket + insertion + afterBracket;
	}

	return content.slice(0, lastObjectEnd + 1) + insertion + content.slice(lastObjectEnd + 1);
}

/**
 * Add a new vectorize section to the config.
 */
function addVectorizeSection(content: string, bindingJson: string): string {
	return addSectionBeforeClosingBrace(content, `"vectorize": [\n\t\t${bindingJson}\n\t]`);
}

/**
 * Remove a Vectorize binding from wrangler.jsonc by index_name.
 *
 * @returns true if binding was found and removed, false if not found
 */
export async function removeVectorizeBinding(
	configPath: string,
	indexName: string,
): Promise<boolean> {
	if (!existsSync(configPath)) {
		throw new Error(`wrangler.jsonc not found at ${configPath}. Cannot remove binding.`);
	}

	const content = await Bun.file(configPath).text();
	const config = parseJsonc<WranglerConfig>(content);

	if (!config.vectorize || !Array.isArray(config.vectorize)) {
		return false;
	}

	const bindingIndex = config.vectorize.findIndex((v) => v.index_name === indexName);
	if (bindingIndex === -1) {
		return false;
	}

	const newContent = removeVectorizeEntryFromContent(content, indexName);
	if (newContent === content) {
		return false;
	}

	await Bun.write(configPath, newContent);
	return true;
}

/**
 * Remove a specific Vectorize entry from the vectorize array in content.
 */
function removeVectorizeEntryFromContent(content: string, indexName: string): string {
	const vecMatch = content.match(/"vectorize"\s*:\s*\[/);
	if (!vecMatch || vecMatch.index === undefined) {
		return content;
	}

	const arrayStartIndex = vecMatch.index + vecMatch[0].length;
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");

	if (closingBracketIndex === -1) {
		return content;
	}

	const arrayContent = content.slice(arrayStartIndex, closingBracketIndex);

	// Find the object containing this index_name
	const escapedName = indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const indexNamePattern = new RegExp(`"index_name"\\s*:\\s*"${escapedName}"`);

	const match = indexNamePattern.exec(arrayContent);
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

	let removeStart = objectStart;
	let removeEnd = objectEnd + 1;

	// Check for trailing comma after the object
	const afterObject = arrayContent.slice(objectEnd + 1);
	const trailingCommaMatch = afterObject.match(/^\s*,/);

	// Check for leading comma before the object
	const beforeObject = arrayContent.slice(0, objectStart);
	const leadingCommaMatch = beforeObject.match(/,\s*$/);

	if (trailingCommaMatch) {
		removeEnd = objectEnd + 1 + trailingCommaMatch[0].length;
	} else if (leadingCommaMatch) {
		removeStart = objectStart - leadingCommaMatch[0].length;
	}

	const newArrayContent = arrayContent.slice(0, removeStart) + arrayContent.slice(removeEnd);

	// Check if array is now effectively empty
	const trimmedArray = newArrayContent.replace(/\/\/[^\n]*/g, "").trim();
	if (trimmedArray === "" || trimmedArray === "[]") {
		return removeVectorizeProperty(content, vecMatch.index, closingBracketIndex);
	}

	return content.slice(0, arrayStartIndex) + newArrayContent + content.slice(closingBracketIndex);
}

/**
 * Remove the entire vectorize property when it becomes empty.
 */
function removeVectorizeProperty(content: string, propertyStart: number, arrayEnd: number): string {
	let removeStart = propertyStart;
	let removeEnd = arrayEnd + 1;

	const beforeProperty = content.slice(0, propertyStart);
	const leadingCommaMatch = beforeProperty.match(/,\s*$/);

	const afterProperty = content.slice(arrayEnd + 1);
	const trailingCommaMatch = afterProperty.match(/^\s*,/);

	if (leadingCommaMatch) {
		removeStart = propertyStart - leadingCommaMatch[0].length;
	} else if (trailingCommaMatch) {
		removeEnd = arrayEnd + 1 + trailingCommaMatch[0].length;
	}

	return content.slice(0, removeStart) + content.slice(removeEnd);
}

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

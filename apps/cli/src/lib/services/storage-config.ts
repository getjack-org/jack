/**
 * R2 storage binding configuration utilities for wrangler.jsonc
 */

import { existsSync } from "node:fs";
import {
	addSectionBeforeClosingBrace,
	findLastObjectEndInArray,
	findMatchingBracket,
	isOnlyCommentsAndWhitespace,
} from "../jsonc-edit.ts";
import { parseJsonc } from "../jsonc.ts";

export interface R2BindingConfig {
	binding: string; // e.g., "STORAGE" or "IMAGES"
	bucket_name: string; // e.g., "my-app-storage"
}

interface WranglerConfig {
	r2_buckets?: Array<{
		binding: string;
		bucket_name?: string;
	}>;
	[key: string]: unknown;
}

/**
 * Get existing R2 bindings from wrangler.jsonc
 */
export async function getExistingR2Bindings(configPath: string): Promise<R2BindingConfig[]> {
	if (!existsSync(configPath)) {
		throw new Error(`wrangler.jsonc not found at ${configPath}`);
	}

	const content = await Bun.file(configPath).text();
	const config = parseJsonc<WranglerConfig>(content);

	if (!config.r2_buckets || !Array.isArray(config.r2_buckets)) {
		return [];
	}

	return config.r2_buckets
		.filter((bucket) => bucket.binding && bucket.bucket_name)
		.map((bucket) => ({
			binding: bucket.binding,
			bucket_name: bucket.bucket_name as string,
		}));
}

/**
 * Convert a bucket name to SCREAMING_SNAKE_CASE for the binding name.
 * Special case: first bucket in a project gets "STORAGE" as the binding.
 */
export function toStorageBindingName(bucketName: string, isFirst: boolean): string {
	if (isFirst) {
		return "STORAGE";
	}
	// Convert kebab-case/snake_case to SCREAMING_SNAKE_CASE
	return bucketName
		.replace(/-/g, "_")
		.replace(/[^a-zA-Z0-9_]/g, "")
		.toUpperCase();
}

/**
 * Generate a unique bucket name for a project.
 * First bucket: {project}-storage
 * Subsequent buckets: {project}-storage-{n}
 */
export function generateBucketName(projectName: string, existingCount: number): string {
	if (existingCount === 0) {
		return `${projectName}-storage`;
	}
	return `${projectName}-storage-${existingCount + 1}`;
}

/**
 * Format an R2 binding as a JSON object string with proper indentation
 */
function formatR2BindingEntry(binding: R2BindingConfig): string {
	return `{
			"binding": "${binding.binding}",
			"bucket_name": "${binding.bucket_name}"
		}`;
}

/**
 * Add an R2 bucket binding to wrangler.jsonc while preserving comments.
 *
 * Uses text manipulation to preserve comments rather than full JSON parsing.
 */
export async function addR2Binding(configPath: string, binding: R2BindingConfig): Promise<void> {
	if (!existsSync(configPath)) {
		throw new Error(
			`wrangler.jsonc not found at ${configPath}. Create a wrangler.jsonc file first or run 'jack new' to create a new project.`,
		);
	}

	const content = await Bun.file(configPath).text();

	// Parse to understand existing structure
	const config = parseJsonc<WranglerConfig>(content);

	// Format the new binding entry
	const bindingJson = formatR2BindingEntry(binding);

	let newContent: string;

	if (config.r2_buckets && Array.isArray(config.r2_buckets)) {
		// r2_buckets exists - append to the array
		newContent = appendToR2BucketsArray(content, bindingJson);
	} else {
		// r2_buckets doesn't exist - add it before closing brace
		newContent = addR2BucketsSection(content, bindingJson);
	}

	await Bun.write(configPath, newContent);
}

/**
 * Append a new entry to an existing r2_buckets array.
 * Finds the closing bracket of the array and inserts before it.
 */
function appendToR2BucketsArray(content: string, bindingJson: string): string {
	// Find "r2_buckets" and then find its closing bracket
	const r2Match = content.match(/"r2_buckets"\s*:\s*\[/);
	if (!r2Match || r2Match.index === undefined) {
		throw new Error("Could not find r2_buckets array in config");
	}

	const arrayStartIndex = r2Match.index + r2Match[0].length;

	// Find the matching closing bracket, accounting for nested structures
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");
	if (closingBracketIndex === -1) {
		throw new Error("Could not find closing bracket for r2_buckets array");
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
 * Add a new r2_buckets section to the config.
 * Inserts before the final closing brace.
 */
function addR2BucketsSection(content: string, bindingJson: string): string {
	return addSectionBeforeClosingBrace(content, `"r2_buckets": [\n\t\t${bindingJson}\n\t]`);
}

/**
 * Remove an R2 bucket binding from wrangler.jsonc by bucket_name.
 * Preserves comments and formatting.
 *
 * @returns true if binding was found and removed, false if not found
 */
export async function removeR2Binding(configPath: string, bucketName: string): Promise<boolean> {
	if (!existsSync(configPath)) {
		throw new Error(`wrangler.jsonc not found at ${configPath}. Cannot remove binding.`);
	}

	const content = await Bun.file(configPath).text();

	// Parse to understand existing structure
	const config = parseJsonc<WranglerConfig>(content);

	// Check if r2_buckets exists and has entries
	if (!config.r2_buckets || !Array.isArray(config.r2_buckets)) {
		return false;
	}

	// Find the binding to remove
	const bindingIndex = config.r2_buckets.findIndex((bucket) => bucket.bucket_name === bucketName);

	if (bindingIndex === -1) {
		return false; // Binding not found
	}

	// Use text manipulation to remove the binding while preserving formatting
	const newContent = removeR2BucketEntryFromContent(content, bucketName);

	if (newContent === content) {
		return false; // Nothing changed
	}

	await Bun.write(configPath, newContent);
	return true;
}

/**
 * Remove a specific R2 bucket entry from the r2_buckets array in content.
 * Handles comma placement and preserves comments.
 */
function removeR2BucketEntryFromContent(content: string, bucketName: string): string {
	// Find the r2_buckets array
	const r2Match = content.match(/"r2_buckets"\s*:\s*\[/);
	if (!r2Match || r2Match.index === undefined) {
		return content;
	}

	const arrayStartIndex = r2Match.index + r2Match[0].length;
	const closingBracketIndex = findMatchingBracket(content, arrayStartIndex - 1, "[", "]");

	if (closingBracketIndex === -1) {
		return content;
	}

	const arrayContent = content.slice(arrayStartIndex, closingBracketIndex);

	// Find the object containing this bucket_name
	const escapedName = bucketName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const bucketNamePattern = new RegExp(`"bucket_name"\\s*:\\s*"${escapedName}"`);

	const match = bucketNamePattern.exec(arrayContent);
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
		// Remove the entire r2_buckets property
		return removeR2BucketsProperty(content, r2Match.index, closingBracketIndex);
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
 * Remove the entire r2_buckets property when it becomes empty.
 */
function removeR2BucketsProperty(content: string, propertyStart: number, arrayEnd: number): string {
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

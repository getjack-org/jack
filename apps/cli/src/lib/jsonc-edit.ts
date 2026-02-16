/**
 * Shared JSONC text-manipulation helpers.
 *
 * These operate on raw JSONC strings so that comments and formatting
 * are preserved when adding/removing sections.
 */

/**
 * Find the matching closing bracket/brace for an opening one,
 * respecting strings and comments.
 */
export function findMatchingBracket(
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

		if (inLineComment) {
			if (char === "\n") inLineComment = false;
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

		if (char === openChar) {
			depth++;
		} else if (char === closeChar) {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}

/**
 * Check if content is only whitespace and comments.
 */
export function isOnlyCommentsAndWhitespace(content: string): boolean {
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i] ?? "";
		const next = content[i + 1] ?? "";

		if (inLineComment) {
			if (char === "\n") inLineComment = false;
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

		if (!/\s/.test(char)) return false;
	}

	return true;
}

/**
 * Find the last closing brace of an object within an array range.
 */
export function findLastObjectEndInArray(
	content: string,
	startIndex: number,
	endIndex: number,
): number {
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
			if (char === "\n") inLineComment = false;
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

		if (char === "}") lastBraceIndex = i;
	}

	return lastBraceIndex;
}

/**
 * Find the start of a line comment (//) in a string, respecting strings.
 */
export function findLineCommentStart(line: string): number {
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

		if (char === "/" && next === "/") return i;
	}

	return -1;
}

/**
 * Determine if we need to add a comma before new content.
 * Looks at the last non-whitespace, non-comment character.
 */
export function shouldAddCommaBefore(content: string): boolean {
	let i = content.length - 1;

	// First pass: find where any trailing line comment starts
	for (let j = content.length - 1; j >= 0; j--) {
		if (content[j] === "\n") {
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
	return lastChar !== "{" && lastChar !== "[" && lastChar !== ",";
}

/**
 * Add a new top-level section (key + value) to a JSONC file before the
 * final closing brace, preserving existing comments and formatting.
 *
 * @param content  Raw JSONC file content
 * @param sectionJson  The `"key": value` string to insert (no trailing comma)
 * @returns Updated file content
 */
export function addSectionBeforeClosingBrace(content: string, sectionJson: string): string {
	const lastBraceIndex = content.lastIndexOf("}");
	if (lastBraceIndex === -1) {
		throw new Error("Invalid JSON: no closing brace found");
	}

	const beforeBrace = content.slice(0, lastBraceIndex);
	const needsComma = shouldAddCommaBefore(beforeBrace);
	const trimmedBefore = beforeBrace.trimEnd();

	const insertion = needsComma ? `,\n\t${sectionJson}` : `\n\t${sectionJson}`;

	return `${trimmedBefore + insertion}\n${content.slice(lastBraceIndex)}`;
}

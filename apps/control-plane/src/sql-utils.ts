/**
 * SQL Read-Only Validation
 *
 * Validates that SQL statements are read-only for the /database/query endpoint.
 * Ported from apps/cli/src/lib/services/sql-classifier.ts (minimal subset).
 */

/**
 * Patterns for detecting SQL operations.
 */
const SQL_PATTERNS = {
	// Destructive operations
	drop: /^\s*DROP\b/i,
	truncate: /^\s*TRUNCATE\b/i,

	// Write operations
	insert: /^\s*INSERT\b/i,
	update: /^\s*UPDATE\b/i,
	delete: /^\s*DELETE\b/i,
	replace: /^\s*REPLACE\b/i,
	create: /^\s*CREATE\b/i,
	alter: /^\s*ALTER\b/i,
	pragma_write: /^\s*PRAGMA\s+\w+\s*=/i, // PRAGMA setting = value

	// CTE pattern
	with_cte: /^\s*WITH\b/i,
};

/**
 * Strip comments from SQL for classification purposes.
 */
function stripComments(sql: string): string {
	return sql
		.replace(/--.*$/gm, "") // Single line comments
		.replace(/\/\*[\s\S]*?\*\//g, "") // Multi-line comments
		.trim();
}

/**
 * Extract the primary operation from a CTE (WITH) statement.
 */
function extractCTEOperation(sql: string): string {
	const cleaned = sql.trim().toUpperCase();

	// Find the main operation by looking for DML keyword after CTE definitions close
	// Pattern: ) followed by optional whitespace then SELECT/INSERT/UPDATE/DELETE
	const cteEndMatch = cleaned.match(/\)\s*(SELECT|INSERT|UPDATE|DELETE)\b/i);
	if (cteEndMatch) {
		return cteEndMatch[1].toUpperCase();
	}

	// Fallback: if no match, look for any of these operations
	if (/\bDELETE\b/.test(cleaned)) return "DELETE";
	if (/\bUPDATE\b/.test(cleaned)) return "UPDATE";
	if (/\bINSERT\b/.test(cleaned)) return "INSERT";
	if (/\bSELECT\b/.test(cleaned)) return "SELECT";

	return "UNKNOWN";
}

/**
 * Check if a SQL statement is read-only.
 * Returns the operation name if non-read, null if read-only.
 */
export function getNonReadOperation(sql: string): string | null {
	const cleaned = stripComments(sql);

	if (!cleaned) return null;

	// Handle CTE (WITH) statements - check the actual operation
	if (SQL_PATTERNS.with_cte.test(cleaned)) {
		const operation = extractCTEOperation(cleaned);
		if (operation !== "SELECT" && operation !== "UNKNOWN") {
			return operation;
		}
		return null; // WITH...SELECT is read-only
	}

	// Check destructive operations first
	if (SQL_PATTERNS.drop.test(cleaned)) return "DROP";
	if (SQL_PATTERNS.truncate.test(cleaned)) return "TRUNCATE";

	// Check write operations
	if (SQL_PATTERNS.insert.test(cleaned)) return "INSERT";
	if (SQL_PATTERNS.update.test(cleaned)) return "UPDATE";
	if (SQL_PATTERNS.delete.test(cleaned)) return "DELETE";
	if (SQL_PATTERNS.replace.test(cleaned)) return "REPLACE";
	if (SQL_PATTERNS.create.test(cleaned)) return "CREATE";
	if (SQL_PATTERNS.alter.test(cleaned)) return "ALTER";
	if (SQL_PATTERNS.pragma_write.test(cleaned)) return "PRAGMA";

	// Read operations (SELECT, EXPLAIN, PRAGMA reads) or unknown - let D1 handle
	return null;
}

/**
 * Split SQL into individual statements.
 * Handles semicolons inside strings and comments.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let inString: string | null = null;
	let inComment = false;
	let inMultilineComment = false;

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const nextChar = sql[i + 1];

		// Handle multiline comments
		if (!inString && !inComment && char === "/" && nextChar === "*") {
			inMultilineComment = true;
			current += char;
			continue;
		}

		if (inMultilineComment && char === "*" && nextChar === "/") {
			current += "*/";
			i++; // Skip the /
			inMultilineComment = false;
			continue;
		}

		if (inMultilineComment) {
			current += char;
			continue;
		}

		// Handle single-line comments
		if (!inString && char === "-" && nextChar === "-") {
			inComment = true;
			current += char;
			continue;
		}

		if (inComment && char === "\n") {
			inComment = false;
			current += char;
			continue;
		}

		if (inComment) {
			current += char;
			continue;
		}

		// Handle strings
		if (!inString && (char === "'" || char === '"')) {
			inString = char;
			current += char;
			continue;
		}

		if (inString === char) {
			// Check for escaped quote
			if (nextChar === char) {
				current += char + char;
				i++; // Skip the escaped quote
				continue;
			}
			inString = null;
			current += char;
			continue;
		}

		if (inString) {
			current += char;
			continue;
		}

		// Handle statement terminator
		if (char === ";") {
			const trimmed = current.trim();
			if (trimmed) {
				statements.push(trimmed);
			}
			current = "";
			continue;
		}

		current += char;
	}

	// Add final statement if present
	const trimmed = current.trim();
	if (trimmed) {
		statements.push(trimmed);
	}

	return statements;
}

/**
 * Validate that all statements in SQL are read-only.
 * Returns error message if any are non-read, null if all OK.
 */
export function validateReadOnly(sql: string): string | null {
	const statements = splitStatements(sql);

	for (const stmt of statements) {
		const operation = getNonReadOperation(stmt);
		if (operation) {
			return `${operation} statements are not allowed in read-only queries`;
		}
	}

	return null;
}

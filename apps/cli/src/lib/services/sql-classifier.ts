/**
 * SQL Risk Classification
 *
 * Classifies SQL statements by risk level to enable security guardrails:
 * - read: SELECT, EXPLAIN, PRAGMA (read-only) - safe to run
 * - write: INSERT, UPDATE, DELETE (with WHERE) - requires --write flag
 * - destructive: DROP, TRUNCATE, DELETE (no WHERE), ALTER - requires --write + confirmation
 *
 * Uses simple regex-based classification since D1 uses SQLite with a limited SQL surface.
 */

export type RiskLevel = "read" | "write" | "destructive";

export interface ClassifiedStatement {
	sql: string;
	risk: RiskLevel;
	operation: string; // SELECT, INSERT, DROP, etc.
}

/**
 * Patterns for detecting SQL operations.
 * Order matters for operations that might overlap.
 */
const SQL_PATTERNS = {
	// Read operations (safe)
	select: /^\s*SELECT\b/i,
	explain: /^\s*EXPLAIN\b/i,
	pragma_read: /^\s*PRAGMA\s+\w+\s*(?:;?\s*$|\()/i, // PRAGMA table_info(...) or PRAGMA journal_mode;
	// CTE (WITH) - handled specially in classifyStatement based on actual operation

	// Destructive operations (dangerous - require confirmation)
	drop: /^\s*DROP\b/i,
	truncate: /^\s*TRUNCATE\b/i,
	alter: /^\s*ALTER\b/i,

	// Write operations (require --write flag)
	insert: /^\s*INSERT\b/i,
	update: /^\s*UPDATE\b/i,
	delete: /^\s*DELETE\b/i,
	replace: /^\s*REPLACE\b/i,
	create: /^\s*CREATE\b/i,
	pragma_write: /^\s*PRAGMA\s+\w+\s*=\s*/i, // PRAGMA setting = value

	// CTE pattern (just to detect WITH statements)
	with_cte: /^\s*WITH\b/i,
};

/**
 * Strip comments from SQL for classification purposes.
 * Preserves the actual SQL content after comments.
 */
function stripComments(sql: string): string {
	return sql
		.replace(/--.*$/gm, "") // Single line comments
		.replace(/\/\*[\s\S]*?\*\//g, "") // Multi-line comments
		.trim();
}

/**
 * Check if a DELETE statement has a WHERE clause.
 * DELETE without WHERE is destructive (deletes all rows).
 */
function isDeleteWithoutWhere(sql: string): boolean {
	// Remove comments and normalize whitespace
	const cleaned = sql
		.replace(/--.*$/gm, "") // Single line comments
		.replace(/\/\*[\s\S]*?\*\//g, "") // Multi-line comments
		.replace(/\s+/g, " ")
		.trim();

	// Check if it's a DELETE statement
	if (!SQL_PATTERNS.delete.test(cleaned)) {
		return false;
	}

	// Check for WHERE clause (case-insensitive)
	// Match WHERE followed by anything (column name, space, etc.)
	const hasWhere = /\bWHERE\b/i.test(cleaned);

	return !hasWhere;
}

/**
 * Extract the primary operation from a SQL statement.
 * For CTEs (WITH clauses), finds the actual operation after the CTE definitions.
 */
function extractOperation(sql: string): string {
	const cleaned = sql.trim().toUpperCase();

	// Handle WITH clauses (CTEs)
	// The actual operation comes after all the CTE definitions end
	// Pattern: WITH name AS (...), name2 AS (...) <ACTUAL_OPERATION>
	if (cleaned.startsWith("WITH")) {
		// Find the main operation by looking for DML keyword after CTE definitions close
		// CTE definitions are enclosed in parentheses, so find the operation after the
		// last `)` that matches the CTE pattern
		// Look for: ) followed by optional whitespace then SELECT/INSERT/UPDATE/DELETE
		const cteEndMatch = cleaned.match(/\)\s*(SELECT|INSERT|UPDATE|DELETE)\b/i);
		if (cteEndMatch) {
			return cteEndMatch[1].toUpperCase();
		}

		// Fallback: if no match, look for any of these operations
		// (handles malformed or edge cases)
		if (/\bDELETE\b/.test(cleaned)) return "DELETE";
		if (/\bUPDATE\b/.test(cleaned)) return "UPDATE";
		if (/\bINSERT\b/.test(cleaned)) return "INSERT";
		if (/\bSELECT\b/.test(cleaned)) return "SELECT";

		return "WITH";
	}

	// Extract first keyword
	const match = cleaned.match(/^\s*(\w+)/);
	return match?.[1] ?? "UNKNOWN";
}

/**
 * Classify a single SQL statement by risk level.
 */
export function classifyStatement(sql: string): ClassifiedStatement {
	const trimmed = sql.trim();
	// Strip comments for classification but preserve original SQL
	const cleaned = stripComments(trimmed);
	const operation = extractOperation(cleaned);

	// Handle CTE (WITH) statements based on their actual operation
	// This must come early because CTEs don't start with the operation keyword
	if (SQL_PATTERNS.with_cte.test(cleaned)) {
		// Classify based on the actual operation extracted from the CTE
		switch (operation) {
			case "DELETE":
				// Check if DELETE in CTE has WHERE clause
				// For CTEs, we check if DELETE...WHERE exists anywhere after the CTE defs
				if (!/\bDELETE\b[^;]*\bWHERE\b/i.test(cleaned)) {
					return { sql: trimmed, risk: "destructive", operation: "DELETE" };
				}
				return { sql: trimmed, risk: "write", operation: "DELETE" };
			case "INSERT":
				return { sql: trimmed, risk: "write", operation: "INSERT" };
			case "UPDATE":
				return { sql: trimmed, risk: "write", operation: "UPDATE" };
			case "SELECT":
				return { sql: trimmed, risk: "read", operation: "SELECT" };
			default:
				// Unknown CTE operation - let SQLite handle it
				return { sql: trimmed, risk: "read", operation };
		}
	}

	// Check destructive operations first (highest risk)
	if (SQL_PATTERNS.drop.test(cleaned)) {
		return { sql: trimmed, risk: "destructive", operation: "DROP" };
	}

	if (SQL_PATTERNS.truncate.test(cleaned)) {
		return { sql: trimmed, risk: "destructive", operation: "TRUNCATE" };
	}

	if (SQL_PATTERNS.alter.test(cleaned)) {
		return { sql: trimmed, risk: "destructive", operation: "ALTER" };
	}

	// DELETE without WHERE is destructive
	if (isDeleteWithoutWhere(cleaned)) {
		return { sql: trimmed, risk: "destructive", operation: "DELETE" };
	}

	// Check write operations
	if (SQL_PATTERNS.insert.test(cleaned)) {
		return { sql: trimmed, risk: "write", operation: "INSERT" };
	}

	if (SQL_PATTERNS.update.test(cleaned)) {
		return { sql: trimmed, risk: "write", operation: "UPDATE" };
	}

	if (SQL_PATTERNS.delete.test(cleaned)) {
		// Has WHERE clause (checked above)
		return { sql: trimmed, risk: "write", operation: "DELETE" };
	}

	if (SQL_PATTERNS.replace.test(cleaned)) {
		return { sql: trimmed, risk: "write", operation: "REPLACE" };
	}

	if (SQL_PATTERNS.create.test(cleaned)) {
		return { sql: trimmed, risk: "write", operation: "CREATE" };
	}

	if (SQL_PATTERNS.pragma_write.test(cleaned)) {
		return { sql: trimmed, risk: "write", operation: "PRAGMA" };
	}

	// Check read operations
	if (SQL_PATTERNS.select.test(cleaned)) {
		return { sql: trimmed, risk: "read", operation: "SELECT" };
	}

	if (SQL_PATTERNS.explain.test(cleaned)) {
		return { sql: trimmed, risk: "read", operation: "EXPLAIN" };
	}

	if (SQL_PATTERNS.pragma_read.test(cleaned)) {
		return { sql: trimmed, risk: "read", operation: "PRAGMA" };
	}

	// Unknown operations default to read - let SQLite handle syntax errors
	// Invalid SQL can't modify data, so no point requiring --write for gibberish
	return { sql: trimmed, risk: "read", operation };
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
 * Classify multiple SQL statements and return the highest risk level.
 */
export function classifyStatements(sql: string): {
	statements: ClassifiedStatement[];
	highestRisk: RiskLevel;
} {
	const statements = splitStatements(sql).map(classifyStatement);

	// Find highest risk level
	let highestRisk: RiskLevel = "read";
	for (const stmt of statements) {
		if (stmt.risk === "destructive") {
			highestRisk = "destructive";
			break;
		}
		if (stmt.risk === "write" && highestRisk === "read") {
			highestRisk = "write";
		}
	}

	return { statements, highestRisk };
}

/**
 * Get a human-readable description of the risk level.
 */
export function getRiskDescription(risk: RiskLevel): string {
	switch (risk) {
		case "read":
			return "Read-only query";
		case "write":
			return "Write operation (modifies data)";
		case "destructive":
			return "Destructive operation (may cause data loss)";
	}
}

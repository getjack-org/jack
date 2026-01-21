/**
 * Unit tests for sql-classifier.ts
 *
 * Tests SQL risk classification for security guardrails.
 */

import { describe, expect, it } from "bun:test";

import {
	type RiskLevel,
	classifyStatement,
	classifyStatements,
	getRiskDescription,
	splitStatements,
} from "./sql-classifier.ts";

describe("sql-classifier", () => {
	describe("classifyStatement", () => {
		describe("read operations", () => {
			it("classifies SELECT as read", () => {
				const result = classifyStatement("SELECT * FROM users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("classifies SELECT with WHERE as read", () => {
				const result = classifyStatement("SELECT id, name FROM users WHERE id = 1");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("classifies SELECT with JOIN as read", () => {
				const result = classifyStatement(
					"SELECT u.name, o.id FROM users u JOIN orders o ON u.id = o.user_id",
				);
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("classifies EXPLAIN as read", () => {
				const result = classifyStatement("EXPLAIN SELECT * FROM users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("EXPLAIN");
			});

			it("classifies PRAGMA (read-only) as read", () => {
				const result = classifyStatement("PRAGMA table_info(users)");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("PRAGMA");
			});

			it("classifies PRAGMA without value as read", () => {
				const result = classifyStatement("PRAGMA journal_mode");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("PRAGMA");
			});

			it("classifies WITH...SELECT (CTE) as read", () => {
				const result = classifyStatement(`
					WITH recent_users AS (
						SELECT * FROM users WHERE created_at > date('now', '-7 days')
					)
					SELECT * FROM recent_users
				`);
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("classifies WITH...DELETE (CTE with DELETE) as destructive when no WHERE", () => {
				// This was a security bypass - CTEs with DELETE were misclassified as read
				const result = classifyStatement(`
					WITH dummy AS (SELECT 1)
					DELETE FROM users
				`);
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DELETE");
			});

			it("classifies WITH...DELETE (CTE with DELETE WHERE) as write", () => {
				const result = classifyStatement(`
					WITH old_users AS (SELECT id FROM users WHERE created_at < '2020-01-01')
					DELETE FROM users WHERE id IN (SELECT id FROM old_users)
				`);
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("DELETE");
			});

			it("classifies WITH...INSERT (CTE with INSERT) as write", () => {
				const result = classifyStatement(`
					WITH new_data AS (SELECT 'test' as name)
					INSERT INTO users (name) SELECT name FROM new_data
				`);
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("INSERT");
			});

			it("classifies WITH...UPDATE (CTE with UPDATE) as write", () => {
				const result = classifyStatement(`
					WITH inactive AS (SELECT id FROM users WHERE last_login < '2020-01-01')
					UPDATE users SET status = 'inactive' WHERE id IN (SELECT id FROM inactive)
				`);
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("UPDATE");
			});
		});

		describe("write operations", () => {
			it("classifies INSERT as write", () => {
				const result = classifyStatement("INSERT INTO users (name) VALUES ('test')");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("INSERT");
			});

			it("classifies UPDATE with WHERE as write", () => {
				const result = classifyStatement("UPDATE users SET name = 'new' WHERE id = 1");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("UPDATE");
			});

			it("classifies DELETE with WHERE as write", () => {
				const result = classifyStatement("DELETE FROM users WHERE id = 1");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("DELETE");
			});

			it("classifies REPLACE as write", () => {
				const result = classifyStatement("REPLACE INTO users (id, name) VALUES (1, 'test')");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("REPLACE");
			});

			it("classifies CREATE TABLE as write", () => {
				const result = classifyStatement("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("CREATE");
			});

			it("classifies CREATE INDEX as write", () => {
				const result = classifyStatement("CREATE INDEX idx_users_name ON users(name)");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("CREATE");
			});

			it("classifies PRAGMA with assignment as write", () => {
				const result = classifyStatement("PRAGMA journal_mode = WAL");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("PRAGMA");
			});
		});

		describe("destructive operations", () => {
			it("classifies DROP TABLE as destructive", () => {
				const result = classifyStatement("DROP TABLE users");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DROP");
			});

			it("classifies DROP TABLE IF EXISTS as destructive", () => {
				const result = classifyStatement("DROP TABLE IF EXISTS users");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DROP");
			});

			it("classifies DROP INDEX as destructive", () => {
				const result = classifyStatement("DROP INDEX idx_users_name");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DROP");
			});

			it("classifies TRUNCATE as destructive", () => {
				const result = classifyStatement("TRUNCATE TABLE users");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("TRUNCATE");
			});

			it("classifies DELETE without WHERE as destructive", () => {
				const result = classifyStatement("DELETE FROM users");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DELETE");
			});

			it("classifies DELETE with only table name as destructive", () => {
				const result = classifyStatement("DELETE FROM users;");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("DELETE");
			});

			it("classifies ALTER TABLE as destructive", () => {
				const result = classifyStatement("ALTER TABLE users ADD COLUMN email TEXT");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("ALTER");
			});

			it("classifies ALTER TABLE RENAME as destructive", () => {
				const result = classifyStatement("ALTER TABLE users RENAME TO customers");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("ALTER");
			});

			it("classifies ALTER TABLE DROP COLUMN as destructive", () => {
				const result = classifyStatement("ALTER TABLE users DROP COLUMN email");
				expect(result.risk).toBe("destructive");
				expect(result.operation).toBe("ALTER");
			});
		});

		describe("edge cases", () => {
			it("handles lowercase SQL", () => {
				const result = classifyStatement("select * from users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("handles mixed case SQL", () => {
				const result = classifyStatement("Select * From Users Where Id = 1");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("handles leading whitespace", () => {
				const result = classifyStatement("   SELECT * FROM users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("handles leading newlines", () => {
				const result = classifyStatement("\n\n  SELECT * FROM users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});

			it("treats unknown operations as read (let SQLite handle errors)", () => {
				const result = classifyStatement("VACUUM");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("VACUUM");
			});

			it("handles DELETE with complex WHERE as write", () => {
				const result = classifyStatement(
					"DELETE FROM users WHERE id IN (SELECT id FROM old_users)",
				);
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("DELETE");
			});

			it("handles DELETE with WHERE in lowercase", () => {
				const result = classifyStatement("delete from users where id = 1");
				expect(result.risk).toBe("write");
				expect(result.operation).toBe("DELETE");
			});

			it("handles SQL with comments", () => {
				const result = classifyStatement("-- Get all users\nSELECT * FROM users");
				expect(result.risk).toBe("read");
				expect(result.operation).toBe("SELECT");
			});
		});
	});

	describe("splitStatements", () => {
		it("splits simple statements", () => {
			const statements = splitStatements("SELECT 1; SELECT 2;");
			expect(statements).toHaveLength(2);
			expect(statements[0]).toBe("SELECT 1");
			expect(statements[1]).toBe("SELECT 2");
		});

		it("handles statement without trailing semicolon", () => {
			const statements = splitStatements("SELECT 1");
			expect(statements).toHaveLength(1);
			expect(statements[0]).toBe("SELECT 1");
		});

		it("handles mixed statements", () => {
			const statements = splitStatements("SELECT 1; INSERT INTO t VALUES (1); SELECT 2");
			expect(statements).toHaveLength(3);
		});

		it("handles semicolons inside strings", () => {
			const statements = splitStatements("SELECT 'hello;world' FROM t; SELECT 2");
			expect(statements).toHaveLength(2);
			expect(statements[0]).toBe("SELECT 'hello;world' FROM t");
		});

		it("handles single quotes with escapes", () => {
			const statements = splitStatements("SELECT 'it''s a test'; SELECT 2");
			expect(statements).toHaveLength(2);
			expect(statements[0]).toBe("SELECT 'it''s a test'");
		});

		it("handles double quotes", () => {
			const statements = splitStatements('SELECT "col;name" FROM t; SELECT 2');
			expect(statements).toHaveLength(2);
		});

		it("handles single-line comments", () => {
			const statements = splitStatements("SELECT 1; -- comment; with semicolon\nSELECT 2");
			expect(statements).toHaveLength(2);
		});

		it("handles multi-line comments", () => {
			const statements = splitStatements("SELECT 1; /* comment; with; semicolons */ SELECT 2");
			expect(statements).toHaveLength(2);
		});

		it("filters empty statements", () => {
			const statements = splitStatements("SELECT 1;; ; SELECT 2;");
			expect(statements).toHaveLength(2);
		});

		it("handles whitespace-only content", () => {
			const statements = splitStatements("   \n\t  ");
			expect(statements).toHaveLength(0);
		});
	});

	describe("classifyStatements", () => {
		it("returns highest risk level", () => {
			const { highestRisk } = classifyStatements("SELECT 1; INSERT INTO t VALUES (1)");
			expect(highestRisk).toBe("write");
		});

		it("returns destructive as highest when present", () => {
			const { highestRisk } = classifyStatements(
				"SELECT 1; DROP TABLE t; INSERT INTO t VALUES (1)",
			);
			expect(highestRisk).toBe("destructive");
		});

		it("returns read when all statements are read", () => {
			const { highestRisk } = classifyStatements("SELECT 1; SELECT 2; EXPLAIN SELECT 3");
			expect(highestRisk).toBe("read");
		});

		it("returns all classified statements", () => {
			const { statements } = classifyStatements("SELECT 1; INSERT INTO t VALUES (1)");
			expect(statements).toHaveLength(2);
			expect(statements[0]?.risk).toBe("read");
			expect(statements[1]?.risk).toBe("write");
		});

		it("handles empty input", () => {
			const { statements, highestRisk } = classifyStatements("");
			expect(statements).toHaveLength(0);
			expect(highestRisk).toBe("read");
		});
	});

	describe("getRiskDescription", () => {
		it("describes read risk", () => {
			expect(getRiskDescription("read")).toBe("Read-only query");
		});

		it("describes write risk", () => {
			expect(getRiskDescription("write")).toBe("Write operation (modifies data)");
		});

		it("describes destructive risk", () => {
			expect(getRiskDescription("destructive")).toBe("Destructive operation (may cause data loss)");
		});
	});

	describe("real-world SQL patterns", () => {
		it("classifies migration-like CREATE TABLE", () => {
			const result = classifyStatement(`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					email TEXT UNIQUE,
					created_at TEXT DEFAULT CURRENT_TIMESTAMP
				)
			`);
			expect(result.risk).toBe("write");
			expect(result.operation).toBe("CREATE");
		});

		it("classifies pagination query as read", () => {
			const result = classifyStatement("SELECT * FROM users ORDER BY id LIMIT 10 OFFSET 20");
			expect(result.risk).toBe("read");
		});

		it("classifies aggregation query as read", () => {
			const result = classifyStatement(
				"SELECT COUNT(*), AVG(age) FROM users GROUP BY country HAVING COUNT(*) > 10",
			);
			expect(result.risk).toBe("read");
		});

		it("classifies INSERT with SELECT as write", () => {
			const result = classifyStatement(
				"INSERT INTO archive SELECT * FROM users WHERE created_at < '2023-01-01'",
			);
			expect(result.risk).toBe("write");
			expect(result.operation).toBe("INSERT");
		});

		it("classifies UPDATE with subquery as write", () => {
			const result = classifyStatement(
				"UPDATE users SET status = 'inactive' WHERE id IN (SELECT user_id FROM inactive_list)",
			);
			expect(result.risk).toBe("write");
		});
	});
});

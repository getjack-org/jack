/**
 * Unit tests for sql-utils.ts
 *
 * Tests SQL read-only validation for the control plane query endpoint.
 */

import { describe, expect, it } from "bun:test";

import { getNonReadOperation, splitStatements, validateReadOnly } from "./sql-utils";

describe("sql-utils", () => {
	describe("getNonReadOperation", () => {
		describe("read operations (should return null)", () => {
			it("allows SELECT", () => {
				expect(getNonReadOperation("SELECT * FROM users")).toBeNull();
			});

			it("allows SELECT with WHERE", () => {
				expect(getNonReadOperation("SELECT id, name FROM users WHERE id = 1")).toBeNull();
			});

			it("allows SELECT with JOIN", () => {
				expect(
					getNonReadOperation(
						"SELECT u.name, o.id FROM users u JOIN orders o ON u.id = o.user_id",
					),
				).toBeNull();
			});

			it("allows EXPLAIN", () => {
				expect(getNonReadOperation("EXPLAIN SELECT * FROM users")).toBeNull();
			});

			it("allows PRAGMA (read-only)", () => {
				expect(getNonReadOperation("PRAGMA table_info(users)")).toBeNull();
			});

			it("allows PRAGMA without value", () => {
				expect(getNonReadOperation("PRAGMA journal_mode")).toBeNull();
			});

			it("allows WITH...SELECT (CTE)", () => {
				expect(
					getNonReadOperation(`
          WITH recent_users AS (
            SELECT * FROM users WHERE created_at > date('now', '-7 days')
          )
          SELECT * FROM recent_users
        `),
				).toBeNull();
			});
		});

		describe("write operations (should return operation name)", () => {
			it("rejects INSERT", () => {
				expect(getNonReadOperation("INSERT INTO users (name) VALUES ('test')")).toBe("INSERT");
			});

			it("rejects UPDATE", () => {
				expect(getNonReadOperation("UPDATE users SET name = 'new' WHERE id = 1")).toBe("UPDATE");
			});

			it("rejects DELETE with WHERE", () => {
				expect(getNonReadOperation("DELETE FROM users WHERE id = 1")).toBe("DELETE");
			});

			it("rejects DELETE without WHERE", () => {
				expect(getNonReadOperation("DELETE FROM users")).toBe("DELETE");
			});

			it("rejects REPLACE", () => {
				expect(getNonReadOperation("REPLACE INTO users (id, name) VALUES (1, 'test')")).toBe(
					"REPLACE",
				);
			});

			it("rejects CREATE TABLE", () => {
				expect(getNonReadOperation("CREATE TABLE users (id INTEGER)")).toBe("CREATE");
			});

			it("rejects ALTER TABLE", () => {
				expect(getNonReadOperation("ALTER TABLE users ADD COLUMN email TEXT")).toBe("ALTER");
			});

			it("rejects PRAGMA with assignment", () => {
				expect(getNonReadOperation("PRAGMA journal_mode = WAL")).toBe("PRAGMA");
			});
		});

		describe("destructive operations (should return operation name)", () => {
			it("rejects DROP TABLE", () => {
				expect(getNonReadOperation("DROP TABLE users")).toBe("DROP");
			});

			it("rejects DROP TABLE IF EXISTS", () => {
				expect(getNonReadOperation("DROP TABLE IF EXISTS users")).toBe("DROP");
			});

			it("rejects TRUNCATE", () => {
				expect(getNonReadOperation("TRUNCATE TABLE users")).toBe("TRUNCATE");
			});
		});

		describe("CTE edge cases", () => {
			it("rejects WITH...INSERT", () => {
				expect(
					getNonReadOperation(`
          WITH new_data AS (SELECT 'test' as name)
          INSERT INTO users (name) SELECT name FROM new_data
        `),
				).toBe("INSERT");
			});

			it("rejects WITH...UPDATE", () => {
				expect(
					getNonReadOperation(`
          WITH inactive AS (SELECT id FROM users WHERE last_login < '2020-01-01')
          UPDATE users SET status = 'inactive' WHERE id IN (SELECT id FROM inactive)
        `),
				).toBe("UPDATE");
			});

			it("rejects WITH...DELETE", () => {
				expect(
					getNonReadOperation(`
          WITH old_users AS (SELECT id FROM users WHERE created_at < '2020-01-01')
          DELETE FROM users WHERE id IN (SELECT id FROM old_users)
        `),
				).toBe("DELETE");
			});
		});

		describe("case insensitivity", () => {
			it("handles lowercase SQL", () => {
				expect(getNonReadOperation("select * from users")).toBeNull();
			});

			it("handles mixed case SQL", () => {
				expect(getNonReadOperation("Select * From Users")).toBeNull();
			});

			it("handles lowercase write operations", () => {
				expect(getNonReadOperation("insert into users values (1)")).toBe("INSERT");
			});
		});

		describe("comments", () => {
			it("ignores operations in single-line comments", () => {
				expect(getNonReadOperation("SELECT 1 -- DROP TABLE users")).toBeNull();
			});

			it("ignores operations in multi-line comments", () => {
				expect(getNonReadOperation("SELECT 1 /* INSERT INTO users VALUES (1) */")).toBeNull();
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
		});

		it("handles semicolons inside strings", () => {
			const statements = splitStatements("SELECT 'hello;world' FROM t; SELECT 2");
			expect(statements).toHaveLength(2);
			expect(statements[0]).toBe("SELECT 'hello;world' FROM t");
		});

		it("handles single quotes with escapes", () => {
			const statements = splitStatements("SELECT 'it''s a test'; SELECT 2");
			expect(statements).toHaveLength(2);
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
	});

	describe("validateReadOnly", () => {
		it("returns null for read-only queries", () => {
			expect(validateReadOnly("SELECT * FROM users")).toBeNull();
		});

		it("returns null for multiple read-only statements", () => {
			expect(validateReadOnly("SELECT 1; SELECT 2; PRAGMA table_info(users)")).toBeNull();
		});

		it("returns error for INSERT", () => {
			const error = validateReadOnly("INSERT INTO users VALUES (1)");
			expect(error).toContain("INSERT");
			expect(error).toContain("not allowed");
		});

		it("returns error for mixed read/write", () => {
			const error = validateReadOnly("SELECT * FROM users; INSERT INTO users VALUES (1)");
			expect(error).toContain("INSERT");
		});

		it("returns error for DROP", () => {
			const error = validateReadOnly("DROP TABLE users");
			expect(error).toContain("DROP");
		});

		it("returns error for UPDATE", () => {
			const error = validateReadOnly("UPDATE users SET name = 'test' WHERE id = 1");
			expect(error).toContain("UPDATE");
		});

		it("returns error for DELETE", () => {
			const error = validateReadOnly("DELETE FROM users WHERE id = 1");
			expect(error).toContain("DELETE");
		});

		it("handles empty input", () => {
			expect(validateReadOnly("")).toBeNull();
		});

		it("handles whitespace-only input", () => {
			expect(validateReadOnly("   \n\t  ")).toBeNull();
		});

		it("validates CTE with SELECT as read-only", () => {
			expect(
				validateReadOnly(`
        WITH cte AS (SELECT 1)
        SELECT * FROM cte
      `),
			).toBeNull();
		});

		it("rejects CTE with DELETE", () => {
			const error = validateReadOnly(`
        WITH cte AS (SELECT 1)
        DELETE FROM users
      `);
			expect(error).toContain("DELETE");
		});
	});
});

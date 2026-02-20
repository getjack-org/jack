import { describe, expect, test } from "bun:test";
import { redactSensitiveData } from "../src/lib/redact.ts";

describe("redactSensitiveData", () => {
	describe("prefixed tokens", () => {
		test("redacts Stripe secret keys", () => {
			expect(redactSensitiveData("key is sk_live_abc123def456")).toBe("key is [REDACTED]");
		});

		test("redacts Stripe publishable keys", () => {
			expect(redactSensitiveData("pk_test_51Hx3RtAbCdEfGh")).toBe("[REDACTED]");
		});

		test("redacts jack tokens", () => {
			expect(redactSensitiveData("token: jkt_abcdefghijklmnop")).toBe("token: [REDACTED]");
		});

		test("redacts GitHub PATs", () => {
			expect(redactSensitiveData("ghp_ABCDEFGHIJKLMNOPqrstuvwx")).toBe("[REDACTED]");
		});

		test("redacts GitHub OAuth tokens", () => {
			expect(redactSensitiveData("gho_abcdefghijklmnop")).toBe("[REDACTED]");
		});

		test("redacts GitLab PATs", () => {
			expect(redactSensitiveData("glpat-abcdefghijklmnop")).toBe("[REDACTED]");
		});

		test("redacts Slack bot tokens", () => {
			expect(redactSensitiveData("xoxb-123456789-abcdefgh")).toBe("[REDACTED]");
		});

		test("redacts Slack user tokens", () => {
			expect(redactSensitiveData("xoxp-123456789-abcdefgh")).toBe("[REDACTED]");
		});

		test("redacts Slack app tokens", () => {
			expect(redactSensitiveData("xapp-1-ABCDEFGHIJKLMNOP")).toBe("[REDACTED]");
		});

		test("redacts webhook secrets", () => {
			expect(redactSensitiveData("whsec_abcdefghijklmnop")).toBe("[REDACTED]");
		});

		test("ignores short tokens (< 8 chars after prefix)", () => {
			expect(redactSensitiveData("sk_short")).toBe("sk_short");
		});
	});

	describe("AWS key IDs", () => {
		test("redacts AWS access key IDs", () => {
			expect(redactSensitiveData("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
		});

		test("ignores strings that start with AKIA but are too short", () => {
			expect(redactSensitiveData("AKIA1234")).toBe("AKIA1234");
		});
	});

	describe("JWTs", () => {
		test("redacts JWT tokens", () => {
			const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
			expect(redactSensitiveData(jwt)).toBe("[REDACTED]");
		});

		test("redacts JWT in context", () => {
			const input = `curl -H "Authorization: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIn0.signature123456"`;
			expect(redactSensitiveData(input)).not.toContain("eyJhbG");
		});
	});

	describe("bearer tokens", () => {
		test("redacts Bearer tokens", () => {
			const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
			expect(redactSensitiveData(input)).toBe("Authorization: Bearer [REDACTED]");
		});

		test("ignores short bearer values", () => {
			expect(redactSensitiveData("Bearer short")).toBe("Bearer short");
		});
	});

	describe("env-style assignments", () => {
		test("redacts OPENAI_API_KEY=value", () => {
			expect(redactSensitiveData("OPENAI_API_KEY=sk-abc123def456ghi")).toContain(
				"OPENAI_API_KEY=[REDACTED]",
			);
		});

		test("redacts quoted assignments", () => {
			expect(redactSensitiveData('ANTHROPIC_API_KEY="sk-ant-abc123def456"')).toContain(
				"ANTHROPIC_API_KEY=[REDACTED]",
			);
		});

		test("redacts colon-separated assignments", () => {
			expect(redactSensitiveData("JWT_SECRET: mysecretvalue1234")).toContain(
				"JWT_SECRET=[REDACTED]",
			);
		});

		test("redacts pattern-matched keys (suffix _API_KEY)", () => {
			expect(redactSensitiveData("CUSTOM_API_KEY=verylongsecretvalue")).toContain(
				"CUSTOM_API_KEY=[REDACTED]",
			);
		});

		test("redacts pattern-matched keys (suffix _SECRET)", () => {
			expect(redactSensitiveData("MY_SECRET=supersecretvalue123")).toContain(
				"MY_SECRET=[REDACTED]",
			);
		});

		test("redacts pattern-matched keys (suffix _TOKEN)", () => {
			expect(redactSensitiveData("REFRESH_TOKEN=abcdefghijklmnop")).toContain(
				"REFRESH_TOKEN=[REDACTED]",
			);
		});

		test("redacts pattern-matched keys (suffix _PASSWORD)", () => {
			expect(redactSensitiveData("DB_PASSWORD=hunter2hunter2")).toContain(
				"DB_PASSWORD=[REDACTED]",
			);
		});
	});

	describe("connection strings", () => {
		test("redacts postgres URLs", () => {
			expect(redactSensitiveData("postgres://user:pass@host:5432/db")).toBe("[REDACTED-URL]");
		});

		test("redacts mysql URLs", () => {
			expect(redactSensitiveData("mysql://root:secret@localhost/mydb")).toBe("[REDACTED-URL]");
		});

		test("redacts redis URLs", () => {
			expect(redactSensitiveData("redis://default:pass@redis.example.com:6379")).toBe(
				"[REDACTED-URL]",
			);
		});

		test("redacts mongodb URLs", () => {
			expect(redactSensitiveData("mongodb://user:pass@host/db")).toBe("[REDACTED-URL]");
		});

		test("redacts mongodb+srv URLs", () => {
			expect(redactSensitiveData("mongodb+srv://user:pass@cluster.mongodb.net/db")).toBe(
				"[REDACTED-URL]",
			);
		});
	});

	describe("credential URLs", () => {
		test("redacts HTTPS URLs with embedded credentials", () => {
			expect(redactSensitiveData("https://user:password@registry.npmjs.org/pkg")).toBe(
				"[REDACTED-URL]",
			);
		});

		test("redacts HTTP URLs with credentials", () => {
			expect(redactSensitiveData("http://admin:secret@localhost:8080/api")).toBe(
				"[REDACTED-URL]",
			);
		});

		test("preserves HTTPS URLs without credentials", () => {
			const input = "https://example.com/api/v1/users";
			expect(redactSensitiveData(input)).toBe(input);
		});
	});

	describe("private keys", () => {
		test("redacts PEM private keys", () => {
			const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aBDHFjKBJvBmNmOj1bOzp1BUVBQacePG3gtK9R+U/m8U
-----END RSA PRIVATE KEY-----`;
			expect(redactSensitiveData(pem)).toBe("[REDACTED-PRIVATE-KEY]");
		});

		test("redacts EC private keys", () => {
			const pem = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIBkg4LVWM9nuwNSk3yByxZpYRTBnVjOEkpNjrFKWKBDHFjK
-----END EC PRIVATE KEY-----`;
			expect(redactSensitiveData(pem)).toBe("[REDACTED-PRIVATE-KEY]");
		});
	});

	describe("JSON secret values", () => {
		test('redacts "API_KEY": "value"', () => {
			const input = '{"OPENAI_API_KEY": "sk-longvaluehere123456"}';
			expect(redactSensitiveData(input)).toContain('"OPENAI_API_KEY": "[REDACTED]"');
		});

		test('redacts "JWT_SECRET": "value"', () => {
			const input = '"JWT_SECRET": "mysupersecretjwtkey123"';
			expect(redactSensitiveData(input)).toContain('"JWT_SECRET": "[REDACTED]"');
		});
	});

	describe("mixed content", () => {
		test("redacts multiple patterns in one string", () => {
			const input = 'Set OPENAI_API_KEY=sk-abc123def456 and use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig then connect to postgres://user:pass@host/db';
			const result = redactSensitiveData(input);
			expect(result).toContain("[REDACTED]");
			expect(result).toContain("Bearer [REDACTED]");
			expect(result).toContain("[REDACTED-URL]");
			expect(result).not.toContain("sk-abc123");
			expect(result).not.toContain("eyJhbG");
			expect(result).not.toContain("user:pass");
		});

		test("preserves non-sensitive content", () => {
			const input = "Deployed to https://my-app.runjack.xyz with status 200";
			expect(redactSensitiveData(input)).toBe(input);
		});

		test("handles empty input", () => {
			expect(redactSensitiveData("")).toBe("");
		});

		test("handles input with no secrets", () => {
			const input = '{"type":"user","message":"hello world"}';
			expect(redactSensitiveData(input)).toBe(input);
		});

		test("preserves valid JSON structure after redaction", () => {
			const line = JSON.stringify({
				type: "user",
				message: { content: "Set OPENAI_API_KEY=sk-proj-abc123def456ghi789 and deploy" },
			});
			const redacted = redactSensitiveData(line);
			expect(() => JSON.parse(redacted)).not.toThrow();
			expect(redacted).not.toContain("sk-proj-abc123");
		});
	});
});

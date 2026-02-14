import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUILTIN_TEMPLATES } from "../src/templates/index.ts";
import { parseJsonc } from "../src/lib/jsonc.ts";

/**
 * Template consistency tests.
 *
 * Ensures declarative metadata in .jack.json stays in sync with template source.
 * Catches cases where a template declares (or omits) capabilities that its code
 * doesn't (or does) implement.
 */

const TEMPLATES_DIR = join(dirname(import.meta.dir), "templates");

const SKIP_DIRS = new Set(["node_modules", ".wrangler", "dist", ".git", ".jack"]);

async function readAllSourceFiles(dir: string, base = ""): Promise<Record<string, string>> {
	if (!existsSync(dir)) return {};
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const relativePath = base ? `${base}/${entry.name}` : entry.name;
		const fullPath = join(dir, entry.name);
		if (SKIP_DIRS.has(entry.name)) continue;
		if (entry.isDirectory()) {
			Object.assign(files, await readAllSourceFiles(fullPath, relativePath));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js")) {
			files[relativePath] = await readFile(fullPath, "utf-8");
		}
	}
	return files;
}

describe("template consistency", () => {
	for (const templateName of BUILTIN_TEMPLATES) {
		const templateDir = join(TEMPLATES_DIR, templateName);

		test(`${templateName}: cron metadata matches source`, async () => {
			// Read .jack.json
			let metadata: Record<string, unknown> = {};
			try {
				const raw = await readFile(join(templateDir, ".jack.json"), "utf-8");
				metadata = parseJsonc(raw);
			} catch {
				// No .jack.json — both checks should pass (no crons declared, no handler expected)
			}

			const declaredCrons = Array.isArray(metadata.crons) ? metadata.crons : [];

			// Read all source files in the template directory (not just src/)
			const sourceFiles = await readAllSourceFiles(templateDir);
			const hasScheduledHandler = Object.values(sourceFiles).some(
				(content) => content.includes("/__scheduled"),
			);

			// Bidirectional check
			if (declaredCrons.length > 0) {
				expect(hasScheduledHandler).toBe(true);
			}
			if (hasScheduledHandler) {
				expect(declaredCrons.length).toBeGreaterThan(0);
			}
		});
	}
});

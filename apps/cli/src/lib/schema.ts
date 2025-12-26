import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { debug } from "./debug.ts";
import { parseJsonc } from "./jsonc.ts";
import { output } from "./output.ts";

/**
 * Execute schema.sql on a D1 database after deploy
 * Uses the binding name with --remote flag for remote execution
 */
export async function applySchema(bindingOrDbName: string, projectDir: string): Promise<boolean> {
	const schemaPath = join(projectDir, "schema.sql");

	if (!existsSync(schemaPath)) {
		debug("No schema.sql found, skipping", { projectDir });
		return false;
	}

	debug("Applying D1 schema", { bindingOrDbName, schemaPath });
	output.start("Applying database schema...");

	const result = await $`wrangler d1 execute ${bindingOrDbName} --file ${schemaPath} --remote`
		.nothrow()
		.quiet()
		.cwd(projectDir);

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();

		// Ignore "table already exists" errors (idempotent)
		if (stderr.includes("already exists")) {
			debug("Schema already applied, continuing");
			output.success("Database schema already applied");
			return true;
		}

		output.stop();
		throw new Error(`Failed to apply schema: ${stderr}`);
	}

	output.success("Database schema applied");
	return true;
}

/**
 * Check if project has D1 database configured (has d1_databases in wrangler config)
 */
export async function hasD1Config(projectDir: string): Promise<boolean> {
	const wranglerPath = join(projectDir, "wrangler.jsonc");

	if (!existsSync(wranglerPath)) {
		return false;
	}

	try {
		const content = await Bun.file(wranglerPath).text();
		return content.includes("d1_databases");
	} catch {
		return false;
	}
}

export interface D1Binding {
	binding?: string;
	database_id?: string;
	database_name?: string;
}

/**
 * Read D1 bindings from wrangler.jsonc
 */
export async function getD1Bindings(projectDir: string): Promise<D1Binding[]> {
	const wranglerPath = join(projectDir, "wrangler.jsonc");

	if (!existsSync(wranglerPath)) {
		return [];
	}

	try {
		const content = await Bun.file(wranglerPath).text();
		const config = parseJsonc(content) as { d1_databases?: D1Binding[] };
		return Array.isArray(config.d1_databases) ? config.d1_databases : [];
	} catch {
		return [];
	}
}

/**
 * Get the D1 database name from wrangler config
 * Returns the database_name field which is needed for wrangler d1 execute
 */
export async function getD1DatabaseName(projectDir: string): Promise<string | null> {
	const wranglerPath = join(projectDir, "wrangler.jsonc");

	if (!existsSync(wranglerPath)) {
		return null;
	}

	try {
		const content = await Bun.file(wranglerPath).text();
		// Strip comments for parsing
		// Note: Only remove line comments at the start of a line to avoid breaking URLs
		const cleaned = content
			.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
			.replace(/^\s*\/\/.*$/gm, ""); // line comments at start of line only
		const config = JSON.parse(cleaned);

		return config.d1_databases?.[0]?.database_name || null;
	} catch {
		return null;
	}
}

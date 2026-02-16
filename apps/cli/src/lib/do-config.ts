/**
 * Durable Objects prerequisite auto-fix.
 *
 * Ensures wrangler.jsonc has nodejs_compat and migrations for all
 * declared DO classes, modifying the file in place when needed.
 */

import type { WranglerConfig } from "./build-helper.ts";
import { addSectionBeforeClosingBrace, findMatchingBracket } from "./jsonc-edit.ts";

/**
 * Ensure `compatibility_flags` includes `"nodejs_compat"`.
 * Adds the flag (or the entire section) if missing.
 *
 * @returns true if the file was modified
 */
export async function ensureNodejsCompat(
	configPath: string,
	config: WranglerConfig,
): Promise<boolean> {
	const flags = config.compatibility_flags ?? [];
	if (flags.includes("nodejs_compat")) return false;

	let content = await Bun.file(configPath).text();

	if (config.compatibility_flags) {
		// Array exists but missing nodejs_compat — append to it
		const match = content.match(/"compatibility_flags"\s*:\s*\[/);
		if (!match || match.index === undefined) {
			throw new Error("compatibility_flags exists in parsed config but not found in raw JSONC");
		}

		const arrayOpen = match.index + match[0].length;
		const closingBracket = findMatchingBracket(content, arrayOpen - 1, "[", "]");
		if (closingBracket === -1) {
			throw new Error("Could not find closing bracket for compatibility_flags array");
		}

		const inner = content.slice(arrayOpen, closingBracket).trim();
		const insertion = inner.length > 0 ? `, "nodejs_compat"` : `"nodejs_compat"`;

		content = content.slice(0, closingBracket) + insertion + content.slice(closingBracket);
	} else {
		// No compatibility_flags at all — add the section
		content = addSectionBeforeClosingBrace(content, `"compatibility_flags": ["nodejs_compat"]`);
	}

	await Bun.write(configPath, content);
	return true;
}

/**
 * Ensure every declared DO class has a corresponding migration entry
 * with `new_sqlite_classes`. Only adds — never modifies existing migrations.
 *
 * @returns names of classes that were auto-migrated (empty = nothing done)
 */
export async function ensureMigrations(
	configPath: string,
	config: WranglerConfig,
): Promise<string[]> {
	const bindings = config.durable_objects?.bindings;
	if (!bindings?.length) return [];

	const declaredClasses = bindings.map((b) => b.class_name);

	// Collect classes already covered by existing migrations
	const coveredClasses = new Set<string>();
	if (config.migrations) {
		for (const m of config.migrations) {
			for (const c of m.new_sqlite_classes ?? []) coveredClasses.add(c);
		}
	}

	const uncovered = declaredClasses.filter((c) => !coveredClasses.has(c));
	if (uncovered.length === 0) return [];

	let content = await Bun.file(configPath).text();

	if (!config.migrations?.length) {
		// No migrations section — create one
		const migrationJson = JSON.stringify(
			[{ tag: "v1", new_sqlite_classes: uncovered }],
			null,
			"\t\t",
		).replace(/\n/g, "\n\t");

		content = addSectionBeforeClosingBrace(content, `"migrations": ${migrationJson}`);
	} else {
		// Migrations exist — append a new step
		const match = content.match(/"migrations"\s*:\s*\[/);
		if (!match || match.index === undefined) {
			throw new Error("migrations exists in parsed config but not found in raw JSONC");
		}

		const arrayOpen = match.index + match[0].length;
		const closingBracket = findMatchingBracket(content, arrayOpen - 1, "[", "]");
		if (closingBracket === -1) {
			throw new Error("Could not find closing bracket for migrations array");
		}

		const nextTag = `v${config.migrations.length + 1}`;
		const stepJson = JSON.stringify({ tag: nextTag, new_sqlite_classes: uncovered });

		content = `${content.slice(0, closingBracket)},\n\t\t${stepJson}${content.slice(closingBracket)}`;
	}

	await Bun.write(configPath, content);
	return uncovered;
}

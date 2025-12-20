import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseJsonc } from "../lib/jsonc.ts";
import type { Template } from "./types";

// Resolve templates directory relative to this file (src/templates -> templates)
const TEMPLATES_DIR = join(dirname(dirname(import.meta.dir)), "templates");

const BUILTIN_TEMPLATES = ["miniapp", "api"];

/**
 * Read all files in a directory recursively
 */
async function readTemplateFiles(dir: string, base = ""): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { withFileTypes: true });

	// Skip these directories/files (but keep bun.lock for faster installs)
	const SKIP = [
		".jack.json",
		"node_modules",
		".git",
		"package-lock.json",
		"CLAUDE.md",
		".wrangler",
		"dist",
	];

	for (const entry of entries) {
		const relativePath = base ? `${base}/${entry.name}` : entry.name;
		const fullPath = join(dir, entry.name);

		if (SKIP.includes(entry.name)) continue;

		if (entry.isDirectory()) {
			Object.assign(files, await readTemplateFiles(fullPath, relativePath));
		} else {
			const content = await readFile(fullPath, "utf-8");
			files[relativePath] = content;
		}
	}

	return files;
}

/**
 * Load a template from the templates directory
 */
async function loadTemplate(name: string): Promise<Template> {
	const templateDir = join(TEMPLATES_DIR, name);
	const metadataPath = join(templateDir, ".jack.json");

	if (!existsSync(templateDir)) {
		throw new Error(`Template directory not found: ${name}`);
	}

	// Read metadata
	let metadata: {
		name: string;
		description: string;
		secrets: string[];
		capabilities?: Template["capabilities"];
		requires?: Template["requires"];
		hooks?: Template["hooks"];
	} = { name, description: "", secrets: [] };
	if (existsSync(metadataPath)) {
		metadata = parseJsonc(await readFile(metadataPath, "utf-8"));
	}

	// Read all template files
	const files = await readTemplateFiles(templateDir);

	return {
		description: metadata.description,
		secrets: metadata.secrets,
		capabilities: metadata.capabilities,
		requires: metadata.requires,
		hooks: metadata.hooks,
		files,
	};
}

/**
 * Resolve template by name or GitHub URL
 */
export async function resolveTemplate(template?: string): Promise<Template> {
	// No template → miniapp (omakase default)
	if (!template) {
		return loadTemplate("miniapp");
	}

	// Built-in template
	if (BUILTIN_TEMPLATES.includes(template)) {
		return loadTemplate(template);
	}

	// GitHub: user/repo or full URL → fetch from network
	if (template.includes("/")) {
		const { fetchFromGitHub } = await import("../lib/github");
		return fetchFromGitHub(template);
	}

	// Unknown template
	throw new Error(`Unknown template: ${template}\n\nAvailable: ${BUILTIN_TEMPLATES.join(", ")}`);
}

/**
 * Replace template placeholders with project name
 * All templates use "jack-template" as universal placeholder
 */
export function renderTemplate(template: Template, vars: { name: string }): Template {
	const rendered: Record<string, string> = {};
	for (const [path, content] of Object.entries(template.files)) {
		// Replace -db variant first to avoid partial matches
		rendered[path] = content
			.replace(/jack-template-db/g, `${vars.name}-db`)
			.replace(/jack-template/g, vars.name);
	}
	return { ...template, files: rendered };
}

/**
 * List available built-in templates
 */
export async function listTemplates(): Promise<Array<{ name: string; description: string }>> {
	const templates = [];
	for (const name of BUILTIN_TEMPLATES) {
		const t = await loadTemplate(name);
		templates.push({ name, description: t.description ?? "" });
	}
	return templates;
}

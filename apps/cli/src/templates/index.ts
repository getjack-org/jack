import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { getControlApiUrl } from "../lib/control-plane.ts";
import { parseJsonc } from "../lib/jsonc.ts";
import type { TemplateMetadata as TemplateOrigin } from "../lib/project-link.ts";
import type { Template } from "./types";

// Resolve templates directory relative to this file (src/templates -> templates)
const TEMPLATES_DIR = join(dirname(dirname(import.meta.dir)), "templates");

export const BUILTIN_TEMPLATES = ["hello", "miniapp", "api", "nextjs"];

/**
 * Resolved template with origin tracking for lineage
 */
export interface ResolvedTemplate {
	template: Template;
	origin: TemplateOrigin;
}

/**
 * Read all files in a directory recursively
 */
async function readTemplateFiles(dir: string, base = ""): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { withFileTypes: true });

	// Skip these directories/files (but keep bun.lock for faster installs)
	const SKIP = [
		".jack.json",
		".jack", // Skip .jack directory (template.json is for origin tracking, not project files)
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
		optionalSecrets?: Template["optionalSecrets"];
		capabilities?: Template["capabilities"];
		requires?: Template["requires"];
		hooks?: Template["hooks"];
		agentContext?: Template["agentContext"];
		intent?: Template["intent"];
	} = { name, description: "", secrets: [] };
	if (existsSync(metadataPath)) {
		metadata = parseJsonc(await readFile(metadataPath, "utf-8"));
	}

	// Read all template files
	const files = await readTemplateFiles(templateDir);

	return {
		description: metadata.description,
		secrets: metadata.secrets,
		optionalSecrets: metadata.optionalSecrets,
		capabilities: metadata.capabilities,
		requires: metadata.requires,
		hooks: metadata.hooks,
		agentContext: metadata.agentContext,
		intent: metadata.intent,
		files,
	};
}

// Internal files that should be excluded from templates
const INTERNAL_FILES = [".jack.json", ".jack/template.json"];

/**
 * Extract zip buffer to file map, excluding internal files
 */
function extractZipToFiles(zipData: ArrayBuffer): Record<string, string> {
	const files: Record<string, string> = {};
	const unzipped = unzipSync(new Uint8Array(zipData));

	for (const [path, content] of Object.entries(unzipped)) {
		// Skip directories (they have zero-length content or end with /)
		if (content.length === 0 || path.endsWith("/")) continue;

		// Skip internal files
		if (path && !INTERNAL_FILES.includes(path)) {
			files[path] = new TextDecoder().decode(content);
		}
	}

	return files;
}

/**
 * Read metadata from extracted files (before they're filtered)
 */
function extractMetadataFromZip(zipData: ArrayBuffer): Record<string, unknown> {
	const unzipped = unzipSync(new Uint8Array(zipData));

	for (const [path, content] of Object.entries(unzipped)) {
		// Skip directories
		if (content.length === 0 || path.endsWith("/")) continue;

		if (path === ".jack.json") {
			return parseJsonc(new TextDecoder().decode(content));
		}
	}

	return {};
}

/**
 * Fetch a published template from jack cloud (public endpoint, no auth)
 */
async function fetchPublishedTemplate(username: string, slug: string): Promise<Template> {
	const response = await fetch(
		`${getControlApiUrl()}/v1/projects/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/source`,
	);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				`Template not found: ${username}/${slug}\n\nMake sure the project exists and is published with: jack publish`,
			);
		}
		throw new Error(`Failed to fetch template: ${response.status}`);
	}

	const zipData = await response.arrayBuffer();
	const metadata = extractMetadataFromZip(zipData);
	const files = extractZipToFiles(zipData);

	return {
		description: (metadata.description as string) || `Fork of ${username}/${slug}`,
		secrets: (metadata.secrets as string[]) || [],
		optionalSecrets: metadata.optionalSecrets as Template["optionalSecrets"],
		capabilities: metadata.capabilities as Template["capabilities"],
		requires: metadata.requires as Template["requires"],
		hooks: metadata.hooks as Template["hooks"],
		agentContext: metadata.agentContext as Template["agentContext"],
		intent: metadata.intent as Template["intent"],
		files,
	};
}

/**
 * Fetch user's own project as a template (authenticated)
 */
async function fetchUserTemplate(slug: string): Promise<Template | null> {
	const { authFetch } = await import("../lib/auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/me/projects/${encodeURIComponent(slug)}/source`,
	);

	if (response.status === 404) {
		return null; // Not found, will try other sources
	}

	if (!response.ok) {
		throw new Error(`Failed to fetch your project: ${response.status}`);
	}

	const zipData = await response.arrayBuffer();
	const metadata = extractMetadataFromZip(zipData);
	const files = extractZipToFiles(zipData);

	return {
		description: (metadata.description as string) || `Your project: ${slug}`,
		secrets: (metadata.secrets as string[]) || [],
		optionalSecrets: metadata.optionalSecrets as Template["optionalSecrets"],
		capabilities: metadata.capabilities as Template["capabilities"],
		requires: metadata.requires as Template["requires"],
		hooks: metadata.hooks as Template["hooks"],
		agentContext: metadata.agentContext as Template["agentContext"],
		intent: metadata.intent as Template["intent"],
		files,
	};
}

/**
 * Resolve template by name
 */
export async function resolveTemplate(template?: string): Promise<Template> {
	// No template → hello (omakase default)
	if (!template) {
		return loadTemplate("hello");
	}

	// Built-in template
	if (BUILTIN_TEMPLATES.includes(template)) {
		return loadTemplate(template);
	}

	// username/slug format - fetch from jack cloud
	if (template.includes("/")) {
		const [username, slug] = template.split("/", 2) as [string, string];
		return fetchPublishedTemplate(username, slug);
	}

	// Try as user's own project first
	try {
		const userTemplate = await fetchUserTemplate(template);
		if (userTemplate) {
			return userTemplate;
		}
	} catch (_err) {
		// If auth fails or project not found, fall through to error
	}

	// Unknown template
	throw new Error(
		`Unknown template: ${template}\n\nAvailable built-in templates: ${BUILTIN_TEMPLATES.join(", ")}\nOr use username/slug format for published projects`,
	);
}

/**
 * Resolve template with origin tracking for lineage
 * Used during project creation to record which template was used
 */
export async function resolveTemplateWithOrigin(
	templateOption?: string,
): Promise<ResolvedTemplate> {
	const templateName = templateOption || "hello";

	// Determine origin type
	let originType: "builtin" | "user" | "published" = "builtin";
	if (templateOption?.includes("/")) {
		originType = "published";
	} else if (templateOption && !BUILTIN_TEMPLATES.includes(templateOption)) {
		originType = "user";
	}

	const origin: TemplateOrigin = {
		type: originType,
		name: templateName,
	};

	// Resolve the template
	const template = await resolveTemplate(templateOption);

	return { template, origin };
}

/**
 * Replace template placeholders with project name
 * All templates use "jack-template" as universal placeholder
 */
export function renderTemplate(template: Template, vars: { name: string }): Template {
	const rendered: Record<string, string> = {};
	for (const [path, content] of Object.entries(template.files)) {
		// Replace suffixed variants first to avoid partial matches
		rendered[path] = content
			.replace(/jack-template-db/g, `${vars.name}-db`)
			.replace(/jack-template-cache/g, `${vars.name}-cache`)
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

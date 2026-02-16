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

export const BUILTIN_TEMPLATES = [
	"hello",
	"miniapp",
	"api",
	"cron",
	"resend",
	"nextjs",
	"saas",
	"ai-chat",
	"chat",
	"semantic-search",
	"nextjs-shadcn",
	"nextjs-clerk",
	"nextjs-auth",
];

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
		envVars?: Template["envVars"];
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
		envVars: metadata.envVars,
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

// Wrangler config files that need sanitization when forking (JSONC only, no TOML support)
const WRANGLER_CONFIG_FILES = ["wrangler.jsonc", "wrangler.json"];

/**
 * Strip provider-specific IDs from wrangler config bindings.
 * When forking a template, the original author's resource IDs won't work
 * for the new user - wrangler 4.45.0+ will auto-provision new resources.
 *
 * Stripped fields:
 * - D1: database_id (author's database)
 * - KV: id (author's namespace)
 * - R2: nothing (bucket_name is just a name, not a provider ID)
 */
function sanitizeWranglerConfig(content: string, filename: string): string {
	// Only handle JSON/JSONC files
	if (!filename.endsWith(".json") && !filename.endsWith(".jsonc")) {
		return content;
	}

	try {
		const config = parseJsonc(content);

		// D1: strip database_id
		if (Array.isArray(config.d1_databases)) {
			for (const db of config.d1_databases) {
				if (db && typeof db === "object" && "database_id" in db) {
					delete db.database_id;
				}
			}
		}

		// KV: strip id
		if (Array.isArray(config.kv_namespaces)) {
			for (const kv of config.kv_namespaces) {
				if (kv && typeof kv === "object" && "id" in kv) {
					delete kv.id;
				}
			}
		}

		// Re-serialize with formatting
		return JSON.stringify(config, null, "\t");
	} catch {
		// If parsing fails, return original content
		return content;
	}
}

/**
 * Extract zip buffer to file map, excluding internal files.
 * Sanitizes wrangler config to remove provider IDs (D1 database_id, KV id).
 */
function extractZipToFiles(zipData: ArrayBuffer): Record<string, string> {
	const files: Record<string, string> = {};
	const unzipped = unzipSync(new Uint8Array(zipData));

	for (const [path, content] of Object.entries(unzipped)) {
		// Skip directories (they have zero-length content or end with /)
		if (content.length === 0 || path.endsWith("/")) continue;

		// Skip internal files
		if (path && !INTERNAL_FILES.includes(path)) {
			let fileContent = new TextDecoder().decode(content);

			// Sanitize wrangler config files to strip provider IDs
			// This ensures forked projects create new resources instead of
			// trying to use the original author's resources
			const filename = path.split("/").pop() || path;
			if (filename === "wrangler.jsonc" || filename === "wrangler.json") {
				fileContent = sanitizeWranglerConfig(fileContent, filename);
			}

			files[path] = fileContent;
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
 * Fetch a remote template (own project or published).
 * Both paths require auth.
 */
async function fetchRemoteTemplate(identifier: string): Promise<Template | null> {
	const { authFetch } = await import("../lib/auth/index.ts");

	// Route to the correct endpoint based on format
	let url: string;
	if (identifier.includes("/")) {
		const [owner, slug] = identifier.split("/", 2) as [string, string];
		url = `${getControlApiUrl()}/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/source`;
	} else {
		url = `${getControlApiUrl()}/v1/me/projects/${encodeURIComponent(identifier)}/source`;
	}

	const response = await authFetch(url);

	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Failed to fetch template: ${response.status}`);

	const zipData = await response.arrayBuffer();
	const metadata = extractMetadataFromZip(zipData);
	const files = extractZipToFiles(zipData);

	return {
		description: (metadata.description as string) || `Fork of ${identifier}`,
		secrets: (metadata.secrets as string[]) || [],
		optionalSecrets: metadata.optionalSecrets as Template["optionalSecrets"],
		envVars: metadata.envVars as Template["envVars"],
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
	if (!template) return loadTemplate("hello");
	if (BUILTIN_TEMPLATES.includes(template)) return loadTemplate(template);

	// Remote: "username/slug" or "my-own-project"
	const result = await fetchRemoteTemplate(template);
	if (result) return result;

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
			.replace(/jack-template-vectors/g, `${vars.name}-vectors`)
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

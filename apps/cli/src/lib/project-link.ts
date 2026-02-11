/**
 * Project Linking
 *
 * Connects local directories to control plane projects or creates local-only BYO links.
 * This module manages the .jack/project.json file that serves as a local pointer.
 *
 * Design:
 * - .jack/project.json is a minimal pointer (project_id + deploy_mode), not a cache
 * - Control plane is the source of truth for managed projects
 * - BYO projects get a locally-generated UUIDv7 for tracking
 * - .jack/ is automatically added to .gitignore
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Deploy mode for a project
 */
export type DeployMode = "managed" | "byo";

/**
 * Local project link stored in .jack/project.json
 */
export interface LocalProjectLink {
	version: 1;
	project_id: string;
	deploy_mode: DeployMode;
	linked_at: string;
	tags?: string[];
	owner_username?: string;
}

/**
 * Template metadata stored in .jack/template.json
 */
export interface TemplateMetadata {
	type: "builtin" | "user" | "published";
	name: string; // "miniapp", "api", or "username/slug" for published
}

const JACK_DIR = ".jack";
const PROJECT_LINK_FILE = "project.json";
const TEMPLATE_FILE = "template.json";
const GITIGNORE_ENTRY = ".jack/";
const GITIGNORE_COMMENT = "# Jack project link (local-only)";

/**
 * Get the .jack directory path for a project
 */
export function getJackDir(projectDir: string): string {
	return join(resolve(projectDir), JACK_DIR);
}

/**
 * Get the .jack/project.json path for a project
 */
export function getProjectLinkPath(projectDir: string): string {
	return join(getJackDir(projectDir), PROJECT_LINK_FILE);
}

/**
 * Get the .jack/template.json path for a project
 */
export function getTemplatePath(projectDir: string): string {
	return join(getJackDir(projectDir), TEMPLATE_FILE);
}

/**
 * Generate a new BYO project ID using UUIDv7
 * Format: byo_<uuidv7> for easy identification
 */
export function generateByoProjectId(): string {
	// UUIDv7: timestamp-based with random suffix for uniqueness
	const timestamp = Date.now();
	const random = crypto.getRandomValues(new Uint8Array(10));
	const hex = Array.from(random)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// UUIDv7-like format: timestamp + random
	const timestampHex = timestamp.toString(16).padStart(12, "0");
	const uuid = `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-7${hex.slice(0, 3)}-${hex.slice(3, 7)}-${hex.slice(7, 19)}`;

	return `byo_${uuid}`;
}

/**
 * Link a local directory to a control plane project (managed)
 * or create a local-only link (BYO with provided/generated ID)
 */
export async function linkProject(
	projectDir: string,
	projectId: string,
	deployMode: DeployMode,
	ownerUsername?: string,
): Promise<void> {
	const jackDir = getJackDir(projectDir);
	const linkPath = getProjectLinkPath(projectDir);

	// Create .jack directory if it doesn't exist
	if (!existsSync(jackDir)) {
		await mkdir(jackDir, { recursive: true });
	}

	const link: LocalProjectLink = {
		version: 1,
		project_id: projectId,
		deploy_mode: deployMode,
		linked_at: new Date().toISOString(),
		owner_username: ownerUsername,
	};

	await writeFile(linkPath, JSON.stringify(link, null, 2));

	// Auto-add .jack/ to .gitignore
	await ensureGitignored(projectDir);

	// Install Claude Code SessionStart hook to project-level .claude/settings.json
	// Non-blocking, fire-and-forget — never delays project linking
	import("./claude-hooks-installer.ts")
		.then(({ installClaudeCodeHooks }) => installClaudeCodeHooks(projectDir))
		.catch(() => {});
}

/**
 * Unlink a local directory. Removes .jack/ directory entirely.
 */
export async function unlinkProject(projectDir: string): Promise<void> {
	const jackDir = getJackDir(projectDir);

	if (existsSync(jackDir)) {
		await rm(jackDir, { recursive: true, force: true });
	}
}

/**
 * Read the project link from a directory.
 * Returns null if no .jack/project.json exists or if it's invalid.
 */
export async function readProjectLink(projectDir: string): Promise<LocalProjectLink | null> {
	const linkPath = getProjectLinkPath(projectDir);

	if (!existsSync(linkPath)) {
		return null;
	}

	try {
		const content = await readFile(linkPath, "utf-8");
		const link = JSON.parse(content) as LocalProjectLink;

		// Validate required fields
		if (!link.version || !link.project_id || !link.deploy_mode) {
			return null;
		}

		return link;
	} catch {
		return null;
	}
}

/**
 * Check if a directory is linked (has valid .jack/project.json)
 */
export async function isLinked(projectDir: string): Promise<boolean> {
	const link = await readProjectLink(projectDir);
	return link !== null;
}

/**
 * Get the project ID for a directory, or null if not linked.
 */
export async function getProjectId(projectDir: string): Promise<string | null> {
	const link = await readProjectLink(projectDir);
	return link?.project_id ?? null;
}

/**
 * Get the deploy mode for a directory.
 * Returns "byo" if not linked (default assumption per PRD).
 */
export async function getDeployMode(projectDir: string): Promise<DeployMode> {
	const link = await readProjectLink(projectDir);
	return link?.deploy_mode ?? "byo";
}

/**
 * Ensure .jack/ is in .gitignore
 */
export async function ensureGitignored(projectDir: string): Promise<void> {
	const gitignorePath = join(resolve(projectDir), ".gitignore");

	// Check if .gitignore exists
	if (!existsSync(gitignorePath)) {
		// Create new .gitignore with .jack/ entry
		const content = `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`;
		await writeFile(gitignorePath, content);
		return;
	}

	// Read existing .gitignore
	const content = await readFile(gitignorePath, "utf-8");

	// Check if .jack/ is already present (with or without trailing slash)
	const lines = content.split("\n");
	const hasJackEntry = lines.some((line) => {
		const trimmed = line.trim();
		return trimmed === ".jack" || trimmed === ".jack/";
	});

	if (hasJackEntry) {
		return; // Already gitignored
	}

	// Append .jack/ entry
	const needsNewline = content.length > 0 && !content.endsWith("\n");
	const toAppend = `${needsNewline ? "\n" : ""}\n${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`;
	await appendFile(gitignorePath, toAppend);
}

/**
 * Write template metadata to .jack/template.json
 */
export async function writeTemplateMetadata(
	projectDir: string,
	template: TemplateMetadata,
): Promise<void> {
	const jackDir = getJackDir(projectDir);
	const templatePath = getTemplatePath(projectDir);

	// Create .jack directory if it doesn't exist
	if (!existsSync(jackDir)) {
		await mkdir(jackDir, { recursive: true });
	}

	await writeFile(templatePath, JSON.stringify(template, null, 2));
}

/**
 * Read template metadata from .jack/template.json
 * Returns null if no template.json exists or if it's invalid.
 */
export async function readTemplateMetadata(projectDir: string): Promise<TemplateMetadata | null> {
	const templatePath = getTemplatePath(projectDir);

	if (!existsSync(templatePath)) {
		return null;
	}

	try {
		const content = await readFile(templatePath, "utf-8");
		const template = JSON.parse(content) as TemplateMetadata;

		// Validate required fields
		if (!template.type || !template.name) {
			return null;
		}

		return template;
	} catch {
		return null;
	}
}

/**
 * Update the project link with partial data (e.g., after deploy)
 */
export async function updateProjectLink(
	projectDir: string,
	updates: Partial<Omit<LocalProjectLink, "version">>,
): Promise<void> {
	const existing = await readProjectLink(projectDir);

	if (!existing) {
		throw new Error("Project is not linked. Use linkProject() first.");
	}

	const updated: LocalProjectLink = {
		...existing,
		...updates,
	};

	const linkPath = getProjectLinkPath(projectDir);
	await writeFile(linkPath, JSON.stringify(updated, null, 2));
}

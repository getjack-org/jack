/**
 * Database creation logic for jack services db create
 *
 * Handles both managed (control plane) and BYO (wrangler d1 create) modes.
 */

import { join } from "node:path";
import { $ } from "bun";
import { createProjectResource } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { getProjectNameFromDir } from "../storage/index.ts";
import { addD1Binding, getExistingD1Bindings } from "../wrangler-config.ts";

export interface CreateDatabaseOptions {
	name?: string;
	interactive?: boolean; // Whether to prompt for deploy
}

export interface CreateDatabaseResult {
	databaseName: string;
	databaseId: string;
	bindingName: string;
	created: boolean; // false if reused existing
}

/**
 * Convert a database name to SCREAMING_SNAKE_CASE for the binding name.
 * Special case: first database in a project gets "DB" as the binding.
 */
function toBindingName(dbName: string, isFirst: boolean): string {
	if (isFirst) {
		return "DB";
	}
	// Convert kebab-case/snake_case to SCREAMING_SNAKE_CASE
	return dbName
		.replace(/-/g, "_")
		.replace(/[^a-zA-Z0-9_]/g, "")
		.toUpperCase();
}

/**
 * Generate a unique database name for a project.
 * First DB: {project}-db
 * Subsequent DBs: {project}-db-{n}
 */
function generateDatabaseName(projectName: string, existingCount: number): string {
	if (existingCount === 0) {
		return `${projectName}-db`;
	}
	return `${projectName}-db-${existingCount + 1}`;
}

interface ExistingDatabase {
	uuid: string;
	name: string;
}

/**
 * List all D1 databases in the Cloudflare account via wrangler
 */
async function listDatabasesViaWrangler(): Promise<ExistingDatabase[]> {
	const result = await $`wrangler d1 list --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		// If wrangler fails, return empty list (might not be logged in)
		return [];
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);
		// wrangler d1 list --json returns array: [{ "uuid": "...", "name": "...", ... }]
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/**
 * Find an existing D1 database by name
 */
async function findExistingDatabase(dbName: string): Promise<ExistingDatabase | null> {
	const databases = await listDatabasesViaWrangler();
	return databases.find((db) => db.name === dbName) ?? null;
}

/**
 * Create a D1 database via wrangler (for BYO mode)
 */
async function createDatabaseViaWrangler(
	dbName: string,
): Promise<{ id: string; created: boolean }> {
	// Check if database already exists
	const existing = await findExistingDatabase(dbName);
	if (existing) {
		return { id: existing.uuid, created: false };
	}

	const result = await $`wrangler d1 create ${dbName} --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to create database ${dbName}`);
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);
		// wrangler d1 create --json returns: { "uuid": "...", "name": "..." }
		return { id: data.uuid || "", created: true };
	} catch {
		throw new Error("Failed to parse wrangler d1 create output");
	}
}

/**
 * Create a D1 database for the current project.
 *
 * For managed projects: calls control plane POST /v1/projects/:id/resources/d1
 * For BYO projects: uses wrangler d1 create
 *
 * In both cases, updates wrangler.jsonc with the new binding.
 */
export async function createDatabase(
	projectDir: string,
	options: CreateDatabaseOptions = {},
): Promise<CreateDatabaseResult> {
	// Read project link to determine deploy mode
	const link = await readProjectLink(projectDir);
	if (!link) {
		throw new Error("Not in a jack project. Run 'jack new' to create a project.");
	}

	// Get project name from wrangler config
	const projectName = await getProjectNameFromDir(projectDir);

	// Get existing D1 bindings to determine naming
	const wranglerPath = join(projectDir, "wrangler.jsonc");
	const existingBindings = await getExistingD1Bindings(wranglerPath);
	const existingCount = existingBindings.length;

	// Determine database name
	const databaseName = options.name ?? generateDatabaseName(projectName, existingCount);

	// Determine binding name
	const isFirst = existingCount === 0;
	const bindingName = toBindingName(databaseName, isFirst);

	// Check if binding name already exists
	const bindingExists = existingBindings.some((b) => b.binding === bindingName);
	if (bindingExists) {
		throw new Error(`Binding "${bindingName}" already exists. Choose a different database name.`);
	}

	let databaseId: string;
	let created = true;

	if (link.deploy_mode === "managed") {
		// Managed mode: call control plane
		// Note: Control plane will reuse existing DB if name matches
		const resource = await createProjectResource(link.project_id, "d1", {
			name: databaseName,
			bindingName,
		});
		databaseId = resource.provider_id;
		// Control plane always creates for now; could add reuse logic there too
	} else {
		// BYO mode: use wrangler d1 create (checks for existing first)
		const result = await createDatabaseViaWrangler(databaseName);
		databaseId = result.id;
		created = result.created;
	}

	// Update wrangler.jsonc with the new binding
	await addD1Binding(wranglerPath, {
		binding: bindingName,
		database_name: databaseName,
		database_id: databaseId,
	});

	return {
		databaseName,
		databaseId,
		bindingName,
		created,
	};
}

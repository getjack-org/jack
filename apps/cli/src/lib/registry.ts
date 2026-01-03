import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Deploy mode for a project
 */
export type DeployMode = "managed" | "byo";

/**
 * Template origin tracking for agent file regeneration
 */
export interface TemplateOrigin {
	type: "builtin" | "github";
	name: string; // "miniapp", "api", or "user/repo"
}

/**
 * Remote metadata for managed projects
 */
export interface ManagedRemote {
	project_id: string;
	project_slug: string;
	org_id: string;
	runjack_url: string;
}

/**
 * Project data stored in registry
 */
export interface Project {
	workerUrl: string | null;
	createdAt: string;
	lastDeployed: string | null;
	status?: "created" | "build_failed" | "live";
	cloudflare?: {
		accountId: string;
		workerId: string;
	};
	template?: TemplateOrigin;
	deploy_mode?: DeployMode;
	remote?: ManagedRemote;
}

/**
 * Project registry structure
 */
export interface Registry {
	version: 2;
	projects: Record<string, Project>;
}

export const REGISTRY_PATH = join(CONFIG_DIR, "projects.json");

/**
 * Migrate registry from v1 to v2
 * - Removes localPath field (no longer tracked)
 * - Removes resources.services.db field (fetch from control plane instead)
 */
async function migrateV1ToV2(v1Registry: {
	version: 1;
	projects: Record<string, unknown>;
}): Promise<Registry> {
	const migrated: Registry = {
		version: 2,
		projects: {},
	};

	for (const [name, project] of Object.entries(v1Registry.projects)) {
		const p = project as Record<string, unknown>;
		// Remove localPath and resources, keep everything else
		const { localPath, resources, ...rest } = p;
		migrated.projects[name] = rest as unknown as Project;
	}

	return migrated;
}

/**
 * Read project registry from disk
 */
export async function readRegistry(): Promise<Registry> {
	if (!existsSync(REGISTRY_PATH)) {
		return { version: 2, projects: {} };
	}

	try {
		const raw = await Bun.file(REGISTRY_PATH).json();

		// Auto-migrate v1 to v2
		if (raw.version === 1) {
			const migrated = await migrateV1ToV2(raw);
			await writeRegistry(migrated);
			return migrated;
		}

		// Handle unversioned (legacy) registries
		if (!raw.version) {
			const migrated = await migrateV1ToV2({
				version: 1,
				projects: raw.projects || {},
			});
			await writeRegistry(migrated);
			return migrated;
		}

		return raw as Registry;
	} catch {
		return { version: 2, projects: {} };
	}
}

/**
 * Write project registry to disk
 */
export async function writeRegistry(registry: Registry): Promise<void> {
	await Bun.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Register or update a project in the registry
 */
export async function registerProject(name: string, data: Partial<Project>): Promise<void> {
	const registry = await readRegistry();
	const existing = registry.projects[name];

	if (existing) {
		registry.projects[name] = {
			...existing,
			...data,
		};
	} else {
		registry.projects[name] = data as Project;
	}

	await writeRegistry(registry);
}

/**
 * Update project with partial data
 */
export async function updateProject(name: string, data: Partial<Project>): Promise<void> {
	const registry = await readRegistry();
	const existing = registry.projects[name];

	if (!existing) {
		throw new Error(`Project "${name}" not found in registry`);
	}

	registry.projects[name] = {
		...existing,
		...data,
	};

	await writeRegistry(registry);
}

/**
 * Remove project from registry
 */
export async function removeProject(name: string): Promise<void> {
	const registry = await readRegistry();
	delete registry.projects[name];
	await writeRegistry(registry);
}

/**
 * Get single project from registry
 */
export async function getProject(name: string): Promise<Project | null> {
	const registry = await readRegistry();
	return registry.projects[name] ?? null;
}

/**
 * Get all projects from registry
 */
export async function getAllProjects(): Promise<Record<string, Project>> {
	const registry = await readRegistry();
	return registry.projects;
}

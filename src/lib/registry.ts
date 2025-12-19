import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Project data stored in registry
 */
export interface Project {
	localPath: string | null;
	workerUrl: string | null;
	createdAt: string;
	lastDeployed: string | null;
	cloudflare: {
		accountId: string;
		workerId: string;
	};
	resources: {
		// Legacy field - kept for backwards compatibility
		d1Databases?: string[];
		// New normalized services structure
		services?: {
			db: string | null;
		};
	};
}

/**
 * Project registry structure
 */
export interface Registry {
	version: 1;
	projects: Record<string, Project>;
}

export const REGISTRY_PATH = join(CONFIG_DIR, "projects.json");

/**
 * Read project registry from disk
 */
export async function readRegistry(): Promise<Registry> {
	if (!existsSync(REGISTRY_PATH)) {
		return { version: 1, projects: {} };
	}
	try {
		return await Bun.file(REGISTRY_PATH).json();
	} catch {
		return { version: 1, projects: {} };
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

/**
 * Get database name for a project, handling backwards compatibility
 * @returns Database name or null if no database is configured
 */
export function getProjectDatabaseName(project: Project): string | null {
	// Prefer new structure
	if (project.resources.services?.db !== undefined) {
		return project.resources.services.db;
	}
	// Fall back to old d1Databases array (first item)
	return project.resources.d1Databases?.[0] ?? null;
}

/**
 * Update the database for a project using the new services structure
 */
export async function updateProjectDatabase(name: string, dbName: string | null): Promise<void> {
	const project = await getProject(name);
	if (!project) return;

	await updateProject(name, {
		resources: {
			...project.resources,
			services: {
				...project.resources.services,
				db: dbName,
			},
		},
	});
}

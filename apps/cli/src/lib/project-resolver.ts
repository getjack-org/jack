/**
 * Project Resolver - unified project discovery
 *
 * Users see "projects". We handle the plumbing.
 *
 * Resolution strategy:
 * 1. Check local registry (fast cache)
 * 2. Check control plane (if logged in)
 * 3. Update registry cache with remote data
 *
 * Control plane is authoritative for managed projects.
 * Registry is a cache that can be rebuilt.
 */

import { isLoggedIn } from "./auth/index.ts";
import { type ManagedProject, findProjectBySlug, listManagedProjects } from "./control-plane.ts";
import {
	type Project as RegistryProject,
	getAllProjects,
	getProject,
	registerProject,
	removeProject as removeFromRegistry,
} from "./registry.ts";

/**
 * User-facing project status
 */
export type ProjectStatus = "live" | "local-only" | "error" | "syncing";

/**
 * Unified project representation
 */
export interface ResolvedProject {
	name: string;
	slug: string;

	// User-facing status
	status: ProjectStatus;
	url?: string;
	errorMessage?: string;

	// Where we found it (internal, not shown to user)
	sources: {
		registry: boolean;
		controlPlane: boolean;
		filesystem: boolean;
	};

	// Location details
	localPath?: string;
	remote?: {
		projectId: string;
		orgId: string;
	};

	// Metadata
	createdAt: string;
	updatedAt?: string;
}

/**
 * Convert registry project to resolved project
 */
function fromRegistryProject(name: string, project: RegistryProject): ResolvedProject {
	// Determine status from registry data
	let status: ProjectStatus = "local-only";
	if (project.status === "live") {
		status = "live";
	} else if (project.status === "build_failed") {
		status = "error";
	} else if (project.lastDeployed || project.remote) {
		// If we have a deployment or remote metadata, assume it's live
		status = "live";
	}

	return {
		name,
		slug: project.remote?.project_slug || name,
		status,
		url: project.workerUrl || project.remote?.runjack_url || undefined,
		sources: {
			registry: true,
			controlPlane: false,
			filesystem: !!project.localPath,
		},
		localPath: project.localPath || undefined,
		remote: project.remote
			? {
					projectId: project.remote.project_id,
					orgId: project.remote.org_id,
				}
			: undefined,
		createdAt: project.createdAt,
		updatedAt: project.lastDeployed || undefined,
	};
}

/**
 * Convert managed project to resolved project
 */
function fromManagedProject(managed: ManagedProject): ResolvedProject {
	const status: ProjectStatus = managed.status === "active" ? "live" : "error";

	return {
		name: managed.name,
		slug: managed.slug,
		status,
		url: `https://${managed.slug}.runjack.org`,
		errorMessage: managed.status === "error" ? "deployment failed" : undefined,
		sources: {
			registry: false,
			controlPlane: true,
			filesystem: false,
		},
		remote: {
			projectId: managed.id,
			orgId: managed.org_id,
		},
		createdAt: managed.created_at,
		updatedAt: managed.updated_at,
	};
}

/**
 * Merge registry and managed project data
 */
function mergeProjects(registry: ResolvedProject, managed: ResolvedProject): ResolvedProject {
	return {
		...registry,
		status: managed.status, // Control plane is authoritative for status
		url: managed.url || registry.url,
		errorMessage: managed.errorMessage,
		sources: {
			registry: true,
			controlPlane: true,
			filesystem: registry.sources.filesystem,
		},
		remote: managed.remote,
		updatedAt: managed.updatedAt || registry.updatedAt,
	};
}

/**
 * Resolve a project by name/slug
 * Checks: registry → control plane → filesystem
 * Caches result in registry
 */
export async function resolveProject(name: string): Promise<ResolvedProject | null> {
	// Check registry first (fast)
	const registryProject = await getProject(name);
	if (registryProject) {
		const resolved = fromRegistryProject(name, registryProject);

		// If it's a BYOC project, don't check control plane
		if (registryProject.deploy_mode === "byo") {
			return resolved;
		}

		// If it's managed, try to get latest status from control plane
		if (registryProject.deploy_mode === "managed" && (await isLoggedIn())) {
			try {
				const managed = await findProjectBySlug(resolved.slug);
				if (managed) {
					const merged = mergeProjects(resolved, fromManagedProject(managed));

					// Update registry cache with latest status
					await registerProject(name, {
						...registryProject,
						status: managed.status === "active" ? "live" : "build_failed",
					});

					return merged;
				}
			} catch {
				// Control plane unavailable, use cached data
			}
		}

		return resolved;
	}

	// Not in registry, check control plane if logged in
	if (await isLoggedIn()) {
		try {
			const managed = await findProjectBySlug(name);
			if (managed) {
				const resolved = fromManagedProject(managed);

				// Cache in registry for future lookups
				await registerProject(name, {
					localPath: null,
					workerUrl: resolved.url || null,
					createdAt: managed.created_at,
					lastDeployed: managed.updated_at,
					status: managed.status === "active" ? "live" : "build_failed",
					resources: { services: { db: null } },
					deploy_mode: "managed",
					remote: {
						project_id: managed.id,
						project_slug: managed.slug,
						org_id: managed.org_id,
						runjack_url: `https://${managed.slug}.runjack.org`,
					},
				});

				return resolved;
			}
		} catch {
			// Control plane unavailable or not found
		}
	}

	return null;
}

/**
 * List ALL projects from all sources
 * Merges and dedupes automatically
 */
export async function listAllProjects(): Promise<ResolvedProject[]> {
	const projectMap = new Map<string, ResolvedProject>();

	// Get all registry projects
	const registryProjects = await getAllProjects();
	for (const [name, project] of Object.entries(registryProjects)) {
		projectMap.set(name, fromRegistryProject(name, project));
	}

	// Get all managed projects if logged in
	if (await isLoggedIn()) {
		try {
			const managedProjects = await listManagedProjects();

			for (const managed of managedProjects) {
				const existing = projectMap.get(managed.slug);

				if (existing) {
					// Merge with registry data
					projectMap.set(managed.slug, mergeProjects(existing, fromManagedProject(managed)));
				} else {
					// New project not in registry
					const resolved = fromManagedProject(managed);
					projectMap.set(managed.slug, resolved);

					// Cache in registry
					await registerProject(managed.slug, {
						localPath: null,
						workerUrl: resolved.url || null,
						createdAt: managed.created_at,
						lastDeployed: managed.updated_at,
						status: managed.status === "active" ? "live" : "build_failed",
						resources: { services: { db: null } },
						deploy_mode: "managed",
						remote: {
							project_id: managed.id,
							project_slug: managed.slug,
							org_id: managed.org_id,
							runjack_url: `https://${managed.slug}.runjack.org`,
						},
					});
				}
			}
		} catch {
			// Control plane unavailable, use registry-only data
		}
	}

	return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if a name is available for new project
 */
export async function checkAvailability(name: string): Promise<{
	available: boolean;
	existingProject?: ResolvedProject;
}> {
	const existing = await resolveProject(name);

	return {
		available: !existing,
		existingProject: existing || undefined,
	};
}

/**
 * Remove a project from everywhere
 * Handles: registry cleanup, control plane deletion, worker teardown
 */
export async function removeProject(name: string): Promise<{
	removed: string[];
	errors: string[];
}> {
	const removed: string[] = [];
	const errors: string[] = [];

	// Resolve project to find all locations
	const project = await resolveProject(name);
	if (!project) {
		return { removed, errors: [`Project "${name}" not found`] };
	}

	// Remove from control plane if managed
	if (project.remote?.projectId) {
		try {
			const { deleteManagedProject } = await import("./control-plane.ts");
			await deleteManagedProject(project.remote.projectId);
			removed.push("jack cloud");
		} catch (error) {
			errors.push(`Failed to delete from jack cloud: ${error}`);
		}
	}

	// Remove from registry
	if (project.sources.registry) {
		try {
			await removeFromRegistry(name);
			removed.push("local registry");
		} catch (error) {
			errors.push(`Failed to remove from registry: ${error}`);
		}
	}

	return { removed, errors };
}

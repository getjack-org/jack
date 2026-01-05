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
import {
	type ManagedProject,
	fetchProjectResources,
	findProjectBySlug,
	listManagedProjects,
} from "./control-plane.ts";
import { getAllLocalPaths } from "./local-paths.ts";
import {
	type Project as RegistryProject,
	getAllProjects,
	getProject,
	registerProject,
	removeProject as removeFromRegistry,
} from "./registry.ts";
import {
	type ResolvedResources,
	convertControlPlaneResources,
	parseWranglerResources,
} from "./resources.ts";

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

	// Resources (fetched on-demand)
	resources?: ResolvedResources;
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
			filesystem: false, // localPath removed from registry - filesystem detection done elsewhere
		},
		localPath: undefined, // localPath removed from registry
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
		url: `https://${managed.slug}.runjack.xyz`,
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
 * Options for resolving a project
 */
export interface ResolveProjectOptions {
	/** Include resources in the resolved project (fetched on-demand) */
	includeResources?: boolean;
	/** Project path for BYO projects (defaults to cwd) */
	projectPath?: string;
	/** Allow fallback lookup by managed project name when slug lookup fails */
	matchByName?: boolean;
}

interface RegistryIndex {
	byRemoteId: Map<string, string>;
	byRemoteSlug: Map<string, string>;
}

function buildRegistryIndexes(registryProjects: Record<string, RegistryProject>): RegistryIndex {
	const byRemoteId = new Map<string, string>();
	const byRemoteSlug = new Map<string, string>();

	for (const [name, project] of Object.entries(registryProjects)) {
		const remote = project.remote;
		if (!remote) continue;
		if (remote.project_id) {
			byRemoteId.set(remote.project_id, name);
		}
		if (remote.project_slug) {
			byRemoteSlug.set(remote.project_slug, name);
		}
	}

	return { byRemoteId, byRemoteSlug };
}

/**
 * Resolve project resources based on deploy mode.
 * For managed: fetch from control plane
 * For BYO: parse from wrangler.jsonc
 */
export async function resolveProjectResources(
	project: ResolvedProject,
	projectPath?: string,
): Promise<ResolvedResources | null> {
	// Managed: fetch from control plane
	if (project.remote?.projectId) {
		try {
			const resources = await fetchProjectResources(project.remote.projectId);
			// Cast ProjectResource[] to ControlPlaneResource[] (compatible shapes)
			return convertControlPlaneResources(
				resources as Parameters<typeof convertControlPlaneResources>[0],
			);
		} catch {
			// Network error, return null
			return null;
		}
	}

	// BYO: parse from wrangler config
	const path = projectPath || process.cwd();
	try {
		return await parseWranglerResources(path);
	} catch {
		return null;
	}
}

/**
 * Resolve a project by name/slug
 * Checks: registry → control plane → filesystem
 * Caches result in registry
 */
export async function resolveProject(
	name: string,
	options?: ResolveProjectOptions,
): Promise<ResolvedProject | null> {
	let resolved: ResolvedProject | null = null;
	const matchByName = options?.matchByName !== false;
	let registryName = name;
	let registryProjects: Record<string, RegistryProject> | null = null;
	let registryIndex: RegistryIndex | null = null;

	// Check registry first (fast)
	let registryProject = await getProject(name);
	if (!registryProject) {
		registryProjects = await getAllProjects();
		registryIndex = buildRegistryIndexes(registryProjects);
		const slugMatchName = registryIndex.byRemoteSlug.get(name);
		if (slugMatchName) {
			registryProject = registryProjects[slugMatchName] ?? null;
			registryName = slugMatchName;
		}
	}
	if (registryProject) {
		resolved = fromRegistryProject(registryName, registryProject);

		// If it's a BYOC project, don't check control plane
		if (registryProject.deploy_mode === "byo") {
			// resolved stays as-is
		} else if (registryProject.deploy_mode === "managed" && (await isLoggedIn())) {
			// If it's managed, try to get latest status from control plane
			try {
				const managed = await findProjectBySlug(resolved.slug);
				if (managed) {
					resolved = mergeProjects(resolved, fromManagedProject(managed));

					// Update registry cache with latest status
					await registerProject(registryName, {
						...registryProject,
						status: managed.status === "active" ? "live" : "build_failed",
					});
				}
			} catch {
				// Control plane unavailable, use cached data
			}
		}
	} else if (await isLoggedIn()) {
		// Not in registry, check control plane if logged in
		try {
			let managed = await findProjectBySlug(name);
			if (!managed && matchByName) {
				const managedProjects = await listManagedProjects();
				managed = managedProjects.find((project) => project.name === name) ?? null;
			}
			if (managed) {
				if (!registryProjects || !registryIndex) {
					registryProjects = await getAllProjects();
					registryIndex = buildRegistryIndexes(registryProjects);
				}

				const existingRegistryName =
					registryIndex.byRemoteId.get(managed.id) ?? registryIndex.byRemoteSlug.get(managed.slug);

				if (existingRegistryName && registryProjects[existingRegistryName]) {
					const existingProject = registryProjects[existingRegistryName];
					resolved = mergeProjects(
						fromRegistryProject(existingRegistryName, existingProject),
						fromManagedProject(managed),
					);

					// Update registry cache with latest status
					await registerProject(existingRegistryName, {
						...existingProject,
						status: managed.status === "active" ? "live" : "build_failed",
					});
				} else {
					resolved = fromManagedProject(managed);

					// Cache in registry for future lookups
					await registerProject(managed.slug, {
						workerUrl: resolved.url || null,
						createdAt: managed.created_at,
						lastDeployed: managed.updated_at,
						status: managed.status === "active" ? "live" : "build_failed",
						deploy_mode: "managed",
						remote: {
							project_id: managed.id,
							project_slug: managed.slug,
							org_id: managed.org_id,
							runjack_url: `https://${managed.slug}.runjack.xyz`,
						},
					});
				}
			}
		} catch {
			// Control plane unavailable or not found
		}
	}

	// Optionally fetch resources
	if (resolved && options?.includeResources) {
		const resources = await resolveProjectResources(resolved, options.projectPath || process.cwd());
		if (resources) {
			resolved.resources = resources;
		}
	}

	return resolved;
}

/**
 * List ALL projects from all sources
 * Merges and dedupes automatically
 */
export async function listAllProjects(): Promise<ResolvedProject[]> {
	const projectMap = new Map<string, ResolvedProject>();

	// Get all registry projects
	const registryProjects = await getAllProjects();
	const registryIndex = buildRegistryIndexes(registryProjects);
	for (const [name, project] of Object.entries(registryProjects)) {
		const key = project.remote?.project_slug ?? name;
		projectMap.set(key, fromRegistryProject(name, project));
	}

	// Get all managed projects if logged in
	if (await isLoggedIn()) {
		try {
			const managedProjects = await listManagedProjects();

			// Filter out deleted projects - they're orphaned control plane records
			const activeProjects = managedProjects.filter((p) => p.status !== "deleted");

			for (const managed of activeProjects) {
				const existing = projectMap.get(managed.slug);

				if (existing) {
					// Merge with registry data
					projectMap.set(managed.slug, mergeProjects(existing, fromManagedProject(managed)));
				} else {
					// New project not in registry
					const resolved = fromManagedProject(managed);
					projectMap.set(managed.slug, resolved);

					// Cache in registry
					const registryName =
						registryIndex.byRemoteId.get(managed.id) ??
						registryIndex.byRemoteSlug.get(managed.slug) ??
						managed.slug;
					await registerProject(registryName, {
						workerUrl: resolved.url || null,
						createdAt: managed.created_at,
						lastDeployed: managed.updated_at,
						status: managed.status === "active" ? "live" : "build_failed",
						deploy_mode: "managed",
						remote: {
							project_id: managed.id,
							project_slug: managed.slug,
							org_id: managed.org_id,
							runjack_url: `https://${managed.slug}.runjack.xyz`,
						},
					});
				}
			}
		} catch {
			// Control plane unavailable, use registry-only data
		}
	}

	// Enrich with local paths
	const localPaths = await getAllLocalPaths();

	for (const [name, paths] of Object.entries(localPaths)) {
		const existing = projectMap.get(name);

		if (existing) {
			// Update existing project with local info
			existing.localPath = paths[0]; // Primary path
			existing.sources.filesystem = true;
		} else {
			// Project exists locally but not in registry/cloud
			projectMap.set(name, {
				name,
				slug: name,
				status: "local-only",
				sources: { registry: false, controlPlane: false, filesystem: true },
				localPath: paths[0],
				createdAt: new Date().toISOString(),
			});
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
	const existing = await resolveProject(name, { matchByName: false });

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
			await removeFromRegistry(project.name);
			removed.push("local registry");
		} catch (error) {
			errors.push(`Failed to remove from registry: ${error}`);
		}
	}

	return { removed, errors };
}

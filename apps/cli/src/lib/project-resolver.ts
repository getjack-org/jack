/**
 * Project Resolver - unified project discovery
 *
 * Users see "projects". We handle the plumbing.
 *
 * Resolution strategy:
 * 1. Check .jack/project.json (local link)
 * 2. If managed: fetch from control plane (authoritative)
 * 3. If BYO: use local link info only
 *
 * Control plane is authoritative for managed projects.
 * .jack/project.json is the local link (not a cache).
 */

import { isLoggedIn } from "./auth/index.ts";
import {
	type ManagedProject,
	fetchProjectResources,
	findProjectBySlug,
	listManagedProjects,
} from "./control-plane.ts";
import { getAllPaths, unregisterPath } from "./paths-index.ts";
import {
	type DeployMode,
	type LocalProjectLink,
	getDeployMode,
	getProjectId,
	readProjectLink,
	unlinkProject,
} from "./project-link.ts";
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
		controlPlane: boolean;
		filesystem: boolean;
	};

	// Location details
	localPath?: string;
	remote?: {
		projectId: string;
		orgId: string;
	};

	// Deploy mode
	deployMode?: DeployMode;

	// Metadata
	createdAt: string;
	updatedAt?: string;

	// Resources (fetched on-demand)
	resources?: ResolvedResources;

	// Tags (from local project link)
	tags?: string[];
}

/**
 * Convert a local project link to a resolved project
 */
function fromLocalLink(link: LocalProjectLink, localPath: string): ResolvedProject {
	const isByo = link.deploy_mode === "byo";

	return {
		name: localPath.split("/").pop() || "unknown",
		slug: localPath.split("/").pop() || "unknown",
		status: isByo ? "local-only" : "syncing", // BYO is local-only, managed needs control plane check
		sources: {
			controlPlane: false,
			filesystem: true,
		},
		localPath,
		remote: isByo
			? undefined
			: {
					projectId: link.project_id,
					orgId: "", // Will be filled from control plane
				},
		deployMode: link.deploy_mode,
		createdAt: link.linked_at,
		tags: link.tags,
	};
}

/**
 * Convert managed project to resolved project
 */
function fromManagedProject(managed: ManagedProject): ResolvedProject {
	const status: ProjectStatus = managed.status === "active" ? "live" : "error";

	// Parse tags from JSON string (e.g., '["backend", "api"]')
	let tags: string[] | undefined;
	if (managed.tags) {
		try {
			tags = JSON.parse(managed.tags);
		} catch {
			// Invalid JSON, ignore
		}
	}

	return {
		name: managed.name,
		slug: managed.slug,
		status,
		url: `https://${managed.slug}.runjack.xyz`,
		errorMessage: managed.status === "error" ? "deployment failed" : undefined,
		sources: {
			controlPlane: true,
			filesystem: false,
		},
		remote: {
			projectId: managed.id,
			orgId: managed.org_id,
		},
		deployMode: "managed",
		createdAt: managed.created_at,
		updatedAt: managed.updated_at,
		tags,
	};
}

/**
 * Merge local and managed project data
 */
function mergeProjects(local: ResolvedProject, managed: ResolvedProject): ResolvedProject {
	return {
		...local,
		name: managed.name, // Control plane name is authoritative
		slug: managed.slug,
		status: managed.status, // Control plane is authoritative for status
		url: managed.url || local.url,
		errorMessage: managed.errorMessage,
		sources: {
			controlPlane: true,
			filesystem: local.sources.filesystem,
		},
		remote: managed.remote,
		deployMode: "managed",
		updatedAt: managed.updatedAt || local.updatedAt,
		// Local tags take priority; fall back to remote if local has none
		tags: local.tags?.length ? local.tags : managed.tags,
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
 * Resolve a project by name/slug or from current directory
 * Checks: .jack/project.json -> control plane
 * No caching - fresh reads only
 */
export async function resolveProject(
	name: string,
	options?: ResolveProjectOptions,
): Promise<ResolvedProject | null> {
	let resolved: ResolvedProject | null = null;
	const matchByName = options?.matchByName !== false;
	const projectPath = options?.projectPath || process.cwd();

	// First, check if we're resolving from a local path with .jack/project.json
	const link = await readProjectLink(projectPath);

	if (link) {
		// We have a local link - start with that
		resolved = fromLocalLink(link, projectPath);

		if (link.deploy_mode === "byo") {
			// BYO project - use local link info only, no control plane
			// resolved stays as-is
		} else if (link.deploy_mode === "managed" && (await isLoggedIn())) {
			// Managed project - fetch fresh data from control plane
			try {
				// Try to find by project ID first via listing
				const managedProjects = await listManagedProjects();
				const managed = managedProjects.find((p) => p.id === link.project_id);

				if (managed) {
					resolved = mergeProjects(resolved, fromManagedProject(managed));
				} else {
					// Project ID not found in control plane - might be deleted
					resolved.status = "error";
					resolved.errorMessage = "Project not found in jack cloud";
				}
			} catch {
				// Control plane unavailable, use local data with syncing status
				resolved.status = "syncing";
			}
		}
	} else if (await isLoggedIn()) {
		// No local link - check control plane by slug/name if logged in
		try {
			let managed = await findProjectBySlug(name);
			if (!managed && matchByName) {
				const managedProjects = await listManagedProjects();
				managed = managedProjects.find((project) => project.name === name) ?? null;
			}
			if (managed) {
				resolved = fromManagedProject(managed);

				// Check if we have a local path for this project
				const allPaths = await getAllPaths();
				const localPaths = allPaths[managed.id];
				if (localPaths && localPaths.length > 0) {
					resolved.localPath = localPaths[0];
					resolved.sources.filesystem = true;
				}
			}
		} catch {
			// Control plane unavailable or not found
		}
	}

	// If still not found, check paths index for local projects
	if (!resolved) {
		const allPaths = await getAllPaths();
		for (const [projectId, paths] of Object.entries(allPaths)) {
			for (const localPath of paths) {
				const localLink = await readProjectLink(localPath);
				if (localLink) {
					const dirName = localPath.split("/").pop() || "";
					// Match by directory name or project_id
					if (dirName === name || projectId === name) {
						resolved = fromLocalLink(localLink, localPath);
						break;
					}
				}
			}
			if (resolved) break;
		}
	}

	// Optionally fetch resources
	if (resolved && options?.includeResources) {
		const resources = await resolveProjectResources(resolved, resolved.localPath || projectPath);
		if (resources) {
			resolved.resources = resources;
		}
	}

	return resolved;
}

/**
 * List ALL projects from all sources
 * Merges and dedupes by project_id
 */
export async function listAllProjects(): Promise<ResolvedProject[]> {
	const projectMap = new Map<string, ResolvedProject>();

	// Get all local projects from paths index
	const allPaths = await getAllPaths();

	for (const [projectId, paths] of Object.entries(allPaths)) {
		// Read the first valid path's link
		for (const localPath of paths) {
			const link = await readProjectLink(localPath);
			if (link) {
				const resolved = fromLocalLink(link, localPath);
				projectMap.set(projectId, resolved);
				break; // Use first valid path
			}
		}
	}

	// Get all managed projects if logged in
	if (await isLoggedIn()) {
		try {
			const managedProjects = await listManagedProjects();

			// Filter out deleted projects - they're orphaned control plane records
			const activeProjects = managedProjects.filter((p) => p.status !== "deleted");

			for (const managed of activeProjects) {
				const existing = projectMap.get(managed.id);

				if (existing) {
					// Merge with local data - control plane is authoritative
					projectMap.set(managed.id, mergeProjects(existing, fromManagedProject(managed)));
				} else {
					// New project not in local index
					const resolved = fromManagedProject(managed);

					// Check if we have a local path for this project
					const localPaths = allPaths[managed.id];
					if (localPaths && localPaths.length > 0) {
						resolved.localPath = localPaths[0];
						resolved.sources.filesystem = true;
					}

					projectMap.set(managed.id, resolved);
				}
			}
		} catch {
			// Control plane unavailable, use local-only data
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
 * Handles: .jack/ cleanup, paths index, control plane deletion
 */
export async function removeProject(
	name: string,
	projectPath?: string,
): Promise<{
	removed: string[];
	errors: string[];
}> {
	const removed: string[] = [];
	const errors: string[] = [];
	const localPath = projectPath || process.cwd();

	// Resolve project to find all locations
	const project = await resolveProject(name, { projectPath: localPath });
	if (!project) {
		return { removed, errors: [`Project "${name}" not found`] };
	}

	// Get project ID for paths index cleanup
	const projectId = await getProjectId(localPath);

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

	// Remove local .jack/ directory
	if (project.sources.filesystem && project.localPath) {
		try {
			await unlinkProject(project.localPath);
			removed.push("local link (.jack/)");
		} catch (error) {
			errors.push(`Failed to remove local link: ${error}`);
		}
	}

	// Remove from paths index
	if (projectId) {
		try {
			await unregisterPath(projectId, localPath);
			removed.push("paths index");
		} catch (error) {
			errors.push(`Failed to remove from paths index: ${error}`);
		}
	}

	return { removed, errors };
}

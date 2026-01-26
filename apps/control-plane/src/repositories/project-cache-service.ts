import type { ProjectConfig } from "../types";

export const CACHE_KEYS = {
	project: (projectId: string) => `project:${projectId}`,
	configBySlug: (slug: string) => `config:${slug}`,
	configByUsernameSlug: (username: string, slug: string) => `config:${username}:${slug}`,
	slugLookup: (orgId: string, slug: string) => `slug:${orgId}:${slug}`,
	notFound: (subdomain: string) => `notfound:${subdomain}`,
	customDomain: (hostname: string) => `custom:${hostname}`,
} as const;

const NOT_FOUND_TTL_SECONDS = 60;

export class ProjectCacheService {
	constructor(private cache: KVNamespace) {}

	async getProjectConfig(projectId: string): Promise<ProjectConfig | null> {
		try {
			const data = await this.cache.get(CACHE_KEYS.project(projectId));
			return data ? JSON.parse(data) : null;
		} catch {
			return null;
		}
	}

	async getConfigBySlug(slug: string): Promise<ProjectConfig | null> {
		try {
			const data = await this.cache.get(CACHE_KEYS.configBySlug(slug));
			return data ? JSON.parse(data) : null;
		} catch {
			return null;
		}
	}

	async getConfigByUsernameSlug(username: string, slug: string): Promise<ProjectConfig | null> {
		try {
			const data = await this.cache.get(CACHE_KEYS.configByUsernameSlug(username, slug));
			return data ? JSON.parse(data) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Set project config in cache.
	 * Optionally pass customDomainHostnames to also update custom domain cache entries.
	 * This keeps custom domain caches in sync when project config changes (e.g., after deployment).
	 */
	async setProjectConfig(config: ProjectConfig, customDomainHostnames?: string[]): Promise<void> {
		const serialized = JSON.stringify(config);

		const writes: Promise<void>[] = [
			this.cache.put(CACHE_KEYS.project(config.project_id), serialized),
		];

		if (config.owner_username) {
			// Published projects: only username-prefixed URL works
			writes.push(
				this.cache.put(
					CACHE_KEYS.configByUsernameSlug(config.owner_username, config.slug),
					serialized,
				),
			);
			// Delete legacy slug-only key to prevent old URL from working
			writes.push(this.cache.delete(CACHE_KEYS.configBySlug(config.slug)));
		} else {
			// Unpublished projects: slug-only URL works
			writes.push(this.cache.put(CACHE_KEYS.configBySlug(config.slug), serialized));
		}

		// Update custom domain cache entries if provided
		if (customDomainHostnames) {
			for (const hostname of customDomainHostnames) {
				writes.push(this.cache.put(CACHE_KEYS.customDomain(hostname), serialized));
			}
		}

		await Promise.all(writes);
	}

	async setSlugLookup(orgId: string, slug: string, projectId: string): Promise<void> {
		await this.cache.put(CACHE_KEYS.slugLookup(orgId, slug), projectId);
	}

	/**
	 * Update an existing project config with partial updates.
	 * Reads the current config, merges the updates, and writes back to all cache keys.
	 * Optionally pass customDomainHostnames to also update custom domain cache entries.
	 * Returns null if the config doesn't exist.
	 */
	async updateProjectConfig(
		projectId: string,
		updates: Partial<ProjectConfig>,
		customDomainHostnames?: string[],
	): Promise<ProjectConfig | null> {
		const existing = await this.getProjectConfig(projectId);
		if (!existing) {
			return null;
		}

		const updated: ProjectConfig = {
			...existing,
			...updates,
			updated_at: new Date().toISOString(),
		};

		await this.setProjectConfig(updated, customDomainHostnames);
		return updated;
	}

	async invalidateProject(
		projectId: string,
		slug: string,
		orgId: string,
		ownerUsername: string | null,
		customDomainHostnames?: string[],
	): Promise<void> {
		const deletes: Promise<void>[] = [
			this.cache.delete(CACHE_KEYS.project(projectId)),
			this.cache.delete(CACHE_KEYS.configBySlug(slug)),
			this.cache.delete(CACHE_KEYS.slugLookup(orgId, slug)),
		];

		if (ownerUsername) {
			deletes.push(this.cache.delete(CACHE_KEYS.configByUsernameSlug(ownerUsername, slug)));
		}

		// Invalidate custom domain cache entries if provided
		if (customDomainHostnames) {
			for (const hostname of customDomainHostnames) {
				deletes.push(this.cache.delete(CACHE_KEYS.customDomain(hostname)));
			}
		}

		await Promise.allSettled(deletes);
	}

	async setNotFound(subdomain: string, ttlSeconds: number = NOT_FOUND_TTL_SECONDS): Promise<void> {
		await this.cache.put(CACHE_KEYS.notFound(subdomain), "1", { expirationTtl: ttlSeconds });
	}

	async isNotFound(subdomain: string): Promise<boolean> {
		const data = await this.cache.get(CACHE_KEYS.notFound(subdomain));
		return data !== null;
	}

	async clearNotFound(slug: string, ownerUsername: string | null): Promise<void> {
		const deletes: Promise<void>[] = [this.cache.delete(CACHE_KEYS.notFound(slug))];

		if (ownerUsername) {
			// dispatch-worker uses hyphen separator: `${username}-${slug}`
			deletes.push(this.cache.delete(CACHE_KEYS.notFound(`${ownerUsername}-${slug}`)));
		}

		await Promise.allSettled(deletes);
	}

	async setCustomDomainConfig(hostname: string, config: ProjectConfig): Promise<void> {
		await this.cache.put(CACHE_KEYS.customDomain(hostname), JSON.stringify(config));
	}

	async deleteCustomDomainConfig(hostname: string): Promise<void> {
		await this.cache.delete(CACHE_KEYS.customDomain(hostname));
	}
}

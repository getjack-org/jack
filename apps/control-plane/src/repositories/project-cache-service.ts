import type { ProjectConfig } from "../types";

export const CACHE_KEYS = {
	project: (projectId: string) => `project:${projectId}`,
	configBySlug: (slug: string) => `config:${slug}`,
	configByUsernameSlug: (username: string, slug: string) => `config:${username}:${slug}`,
	slugLookup: (orgId: string, slug: string) => `slug:${orgId}:${slug}`,
	notFound: (subdomain: string) => `notfound:${subdomain}`,
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

	async setProjectConfig(config: ProjectConfig): Promise<void> {
		const serialized = JSON.stringify(config);

		const writes: Promise<void>[] = [
			this.cache.put(CACHE_KEYS.project(config.project_id), serialized),
			this.cache.put(CACHE_KEYS.configBySlug(config.slug), serialized),
		];

		if (config.owner_username) {
			writes.push(
				this.cache.put(
					CACHE_KEYS.configByUsernameSlug(config.owner_username, config.slug),
					serialized,
				),
			);
		}

		await Promise.all(writes);
	}

	async setSlugLookup(orgId: string, slug: string, projectId: string): Promise<void> {
		await this.cache.put(CACHE_KEYS.slugLookup(orgId, slug), projectId);
	}

	/**
	 * Update an existing project config with partial updates.
	 * Reads the current config, merges the updates, and writes back to all cache keys.
	 * Returns null if the config doesn't exist.
	 */
	async updateProjectConfig(
		projectId: string,
		updates: Partial<ProjectConfig>,
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

		await this.setProjectConfig(updated);
		return updated;
	}

	async invalidateProject(
		projectId: string,
		slug: string,
		orgId: string,
		ownerUsername: string | null,
	): Promise<void> {
		const deletes: Promise<void>[] = [
			this.cache.delete(CACHE_KEYS.project(projectId)),
			this.cache.delete(CACHE_KEYS.configBySlug(slug)),
			this.cache.delete(CACHE_KEYS.slugLookup(orgId, slug)),
		];

		if (ownerUsername) {
			deletes.push(this.cache.delete(CACHE_KEYS.configByUsernameSlug(ownerUsername, slug)));
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
}

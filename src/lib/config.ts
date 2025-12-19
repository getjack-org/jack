import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Agent configuration stored in jack config
 */
export type AgentLaunchConfig =
	| {
			type: "cli";
			command: string;
			args?: string[];
	  }
	| {
			type: "app";
			appName?: string;
			appPath?: string;
	  };

export interface AgentConfig {
	active: boolean;
	path: string;
	detectedAt: string;
	launch?: AgentLaunchConfig;
}

/**
 * Sync configuration for template synchronization
 */
export interface SyncConfig {
	enabled: boolean; // Default true
	autoSync: boolean; // Auto-sync after ship, default true
}

/**
 * Jack configuration structure
 * Single source of truth - used by all modules
 */
export interface JackConfig {
	version: number;
	initialized: boolean;
	initializedAt: string;
	agents?: Record<string, AgentConfig>;
	preferredAgent?: string;
	sync?: SyncConfig;
}

export const CONFIG_DIR = join(homedir(), ".config", "jack");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
	if (!existsSync(CONFIG_DIR)) {
		await mkdir(CONFIG_DIR, { recursive: true });
	}
}

/**
 * Read jack config from disk
 */
export async function readConfig(): Promise<JackConfig | null> {
	if (!existsSync(CONFIG_PATH)) {
		return null;
	}
	try {
		return await Bun.file(CONFIG_PATH).json();
	} catch {
		return null;
	}
}

/**
 * Write jack config to disk
 */
export async function writeConfig(config: JackConfig): Promise<void> {
	await ensureConfigDir();
	await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Default sync configuration
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
	enabled: true,
	autoSync: true,
};

/**
 * Get sync configuration, returning defaults if not set
 */
export async function getSyncConfig(): Promise<SyncConfig> {
	const config = await readConfig();
	return config?.sync ?? DEFAULT_SYNC_CONFIG;
}

/**
 * Update sync configuration with partial updates
 */
export async function updateSyncConfig(updates: Partial<SyncConfig>): Promise<void> {
	const config = await readConfig();
	if (!config) {
		throw new Error("Jack config not initialized");
	}

	config.sync = {
		...(config.sync ?? DEFAULT_SYNC_CONFIG),
		...updates,
	};

	await writeConfig(config);
}

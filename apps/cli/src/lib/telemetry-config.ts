import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Telemetry configuration structure (v2)
 */
export interface TelemetryConfig {
	anonymousId: string; // UUID v4, generated once
	enabled: boolean; // false if user opted out
	version: number; // config schema version (2 for new configs)
	// AARRR tracking fields
	firstSeenAt: string; // ISO date when config was created
	firstDeployAt?: string; // ISO date when first deploy succeeded
	lastIdentifyDate?: string; // "YYYY-MM-DD" for dedupe
}

export const TELEMETRY_CONFIG_DIR = CONFIG_DIR;
export const TELEMETRY_CONFIG_PATH = join(CONFIG_DIR, "telemetry.json");

/**
 * Cached telemetry config for memoization
 */
let cachedTelemetryConfig: TelemetryConfig | null = null;

/**
 * Get the path to the telemetry configuration file
 */
export function getTelemetryConfigPath(): string {
	return TELEMETRY_CONFIG_PATH;
}

/**
 * Ensure telemetry config directory exists
 */
async function ensureTelemetryConfigDir(): Promise<void> {
	if (!existsSync(TELEMETRY_CONFIG_DIR)) {
		await mkdir(TELEMETRY_CONFIG_DIR, { recursive: true });
	}
}

/**
 * Create a new telemetry config with generated anonymous ID (v2)
 */
function createNewTelemetryConfig(): TelemetryConfig {
	return {
		anonymousId: crypto.randomUUID(),
		enabled: true,
		version: 2,
		firstSeenAt: new Date().toISOString(),
	};
}

/**
 * Migrate v1 config to v2 by adding AARRR tracking fields
 */
function migrateV1ToV2(config: TelemetryConfig): TelemetryConfig {
	return {
		...config,
		version: 2,
		firstSeenAt: new Date().toISOString(), // Best approximation for existing users
	};
}

/**
 * Load telemetry config from disk or create new one
 */
export async function loadOrCreateTelemetryConfig(): Promise<TelemetryConfig> {
	if (!existsSync(TELEMETRY_CONFIG_PATH)) {
		const newConfig = createNewTelemetryConfig();
		await ensureTelemetryConfigDir();
		await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

		// Track install event for new users (fire-and-forget)
		queueMicrotask(async () => {
			try {
				const { track, Events } = await import("./telemetry.ts");
				track(Events.USER_INSTALLED, {
					install_date: newConfig.firstSeenAt,
				});
			} catch {
				// Ignore - telemetry should not break CLI
			}
		});

		return newConfig;
	}

	try {
		const config = await Bun.file(TELEMETRY_CONFIG_PATH).json();
		// Validate config structure
		if (
			typeof config === "object" &&
			config !== null &&
			typeof config.anonymousId === "string" &&
			typeof config.enabled === "boolean" &&
			typeof config.version === "number"
		) {
			// Migrate v1 configs to v2
			if (config.version === 1) {
				const migratedConfig = migrateV1ToV2(config as TelemetryConfig);
				await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(migratedConfig, null, 2));
				return migratedConfig;
			}
			return config as TelemetryConfig;
		}
		// Invalid config, regenerate
		const newConfig = createNewTelemetryConfig();
		await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(newConfig, null, 2));
		return newConfig;
	} catch {
		// Corrupt JSON, regenerate
		const newConfig = createNewTelemetryConfig();
		await ensureTelemetryConfigDir();
		await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(newConfig, null, 2));
		return newConfig;
	}
}

/**
 * Get telemetry config (memoized)
 */
export async function getTelemetryConfig(): Promise<TelemetryConfig> {
	if (cachedTelemetryConfig) {
		return cachedTelemetryConfig;
	}

	cachedTelemetryConfig = await loadOrCreateTelemetryConfig();
	return cachedTelemetryConfig;
}

/**
 * Update telemetry enabled state and save to disk
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
	const config = await getTelemetryConfig();
	config.enabled = enabled;

	await ensureTelemetryConfigDir();
	await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(config, null, 2));

	// Update cache
	cachedTelemetryConfig = config;
}

/**
 * Save telemetry config to disk
 */
export async function saveTelemetryConfig(config: TelemetryConfig): Promise<void> {
	await ensureTelemetryConfigDir();
	await Bun.write(TELEMETRY_CONFIG_PATH, JSON.stringify(config, null, 2));

	// Update cache
	cachedTelemetryConfig = config;
}

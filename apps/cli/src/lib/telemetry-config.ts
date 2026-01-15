import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Telemetry configuration structure
 */
export interface TelemetryConfig {
	anonymousId: string; // UUID v4, generated once
	enabled: boolean; // false if user opted out
	version: number; // config schema version (start at 1)
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
 * Create a new telemetry config with generated anonymous ID
 */
function createNewTelemetryConfig(): TelemetryConfig {
	return {
		anonymousId: crypto.randomUUID(),
		enabled: true,
		version: 1,
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

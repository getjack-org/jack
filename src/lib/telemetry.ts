import { PostHog } from "posthog-node";
import type { TelemetryConfig } from "./telemetry-config.ts";
import { getTelemetryConfig, setTelemetryEnabled } from "./telemetry-config.ts";

// ============================================
// EVENT REGISTRY - Single source of truth
// Add new events here, they become type-safe
// ============================================
export const Events = {
	// Automatic (via wrapper)
	COMMAND_INVOKED: "command_invoked",
	COMMAND_COMPLETED: "command_completed",
	COMMAND_FAILED: "command_failed",

	// Business events (for future use)
	PROJECT_CREATED: "project_created",
	DEPLOY_STARTED: "deploy_started",
	CONFIG_CHANGED: "config_changed",

	// Intent-driven creation events
	INTENT_MATCHED: "intent_matched",
	INTENT_NO_MATCH: "intent_no_match",
	INTENT_CUSTOMIZATION_STARTED: "intent_customization_started",
	INTENT_CUSTOMIZATION_COMPLETED: "intent_customization_completed",
	INTENT_CUSTOMIZATION_FAILED: "intent_customization_failed",
} as const;

type EventName = (typeof Events)[keyof typeof Events];

// Re-export config functions for convenience
export { getTelemetryConfig, setTelemetryEnabled };

// ============================================
// CLIENT SETUP
// ============================================
let client: PostHog | null = null;
let telemetryConfig: TelemetryConfig | null = null;

/**
 * Check if telemetry is enabled based on environment and config
 * Priority order:
 * 1. DO_NOT_TRACK=1 -> disabled
 * 2. CI=true -> disabled
 * 3. JACK_TELEMETRY_DISABLED=1 -> disabled
 * 4. Config file enabled: false -> disabled
 * 5. Default -> enabled
 */
async function isEnabled(): Promise<boolean> {
	// Environment variable checks (highest priority)
	if (process.env.DO_NOT_TRACK === "1") return false;
	if (process.env.CI === "true") return false;
	if (process.env.JACK_TELEMETRY_DISABLED === "1") return false;

	// Check config file
	try {
		const config = await getTelemetryConfig();
		telemetryConfig = config;
		return config.enabled;
	} catch {
		// If config loading fails, default to enabled
		return true;
	}
}

/**
 * Get or initialize PostHog client
 * Returns null if telemetry is disabled or API key is missing
 */
async function getClient(): Promise<PostHog | null> {
	const enabled = await isEnabled();
	if (!enabled) return null;

	// Lazy initialization
	if (!client) {
		const apiKey = process.env.POSTHOG_API_KEY;
		if (!apiKey) return null;

		try {
			client = new PostHog(apiKey, {
				host: "https://us.i.posthog.com",
				flushAt: 1, // Flush immediately (CLI is short-lived)
				flushInterval: 0, // No delay
			});
		} catch {
			// Silent failure - never block execution
			return null;
		}
	}

	return client;
}

/**
 * Get anonymous ID from config
 */
async function getAnonymousId(): Promise<string> {
	if (!telemetryConfig) {
		telemetryConfig = await getTelemetryConfig();
	}
	return telemetryConfig.anonymousId;
}

// ============================================
// USER PROPERTIES - Set once, sent with all events
// ============================================
export interface UserProperties {
	jack_version: string;
	os: string;
	arch: string;
	node_version: string;
	is_ci: boolean;
	config_style?: "byoc" | "jack-cloud";
}

let userProps: Partial<UserProperties> = {};

/**
 * Set user properties (sent with all events)
 * Safe to call multiple times - properties are merged
 */
export async function identify(properties: Partial<UserProperties>): Promise<void> {
	userProps = { ...userProps, ...properties };

	const ph = await getClient();
	if (!ph) return;

	try {
		const distinctId = await getAnonymousId();
		ph.identify({
			distinctId,
			properties: userProps,
		});
	} catch {
		// Silent failure - never block execution
	}
}

// ============================================
// TRACK - Fire-and-forget event tracking
// ============================================
/**
 * Track an event with optional properties
 * This is fire-and-forget and will never throw or block
 */
export async function track(event: EventName, properties?: Record<string, unknown>): Promise<void> {
	const ph = await getClient();
	if (!ph) return;

	try {
		const distinctId = await getAnonymousId();
		ph.capture({
			distinctId,
			event,
			properties: {
				...properties,
				...userProps,
				timestamp: Date.now(),
			},
		});
	} catch {
		// Silent failure - never block execution
	}
}

// ============================================
// THE MAGIC: withTelemetry() wrapper
// Commands wrapped with this get automatic tracking
// ============================================
export interface TelemetryOptions {
	platform?: "cli" | "mcp";
}

/**
 * Wrap a command function with automatic telemetry tracking
 * Tracks command_invoked, command_completed, and command_failed events
 */
// biome-ignore lint/suspicious/noExplicitAny: Required for flexible command wrapping
export function withTelemetry<T extends (...args: any[]) => Promise<any>>(
	commandName: string,
	fn: T,
	options?: TelemetryOptions,
): T {
	const platform = options?.platform ?? "cli";

	return (async (...args: Parameters<T>) => {
		// Fire-and-forget: don't await track() to avoid blocking command execution
		track(Events.COMMAND_INVOKED, { command: commandName, platform });
		const start = Date.now();

		try {
			const result = await fn(...args);
			track(Events.COMMAND_COMPLETED, {
				command: commandName,
				platform,
				duration_ms: Date.now() - start,
			});
			return result;
		} catch (error) {
			track(Events.COMMAND_FAILED, {
				command: commandName,
				platform,
				error_type: classifyError(error),
				duration_ms: Date.now() - start,
			});
			throw error;
		}
	}) as T;
}

// ============================================
// SHUTDOWN - Call before process exit
// ============================================
/**
 * Gracefully shutdown telemetry client
 * Times out after 500ms to never block CLI exit
 */
export async function shutdown(): Promise<void> {
	if (!client) return;

	try {
		await Promise.race([
			client.shutdown(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Telemetry shutdown timeout")), 500),
			),
		]);
	} catch {
		// Silent failure - never block exit
	}
}

// ============================================
// ERROR CLASSIFICATION
// ============================================
/**
 * Classify error into broad categories for analytics
 * Returns: 'validation' | 'network' | 'build' | 'deploy' | 'config' | 'unknown'
 */
function classifyError(error: unknown): string {
	const msg = (error as Error)?.message || "";
	const errorStr = String(error).toLowerCase();
	const combined = `${msg} ${errorStr}`.toLowerCase();

	// Check for validation errors
	if (
		combined.includes("validation") ||
		combined.includes("invalid") ||
		combined.includes("required") ||
		combined.includes("missing")
	) {
		return "validation";
	}

	// Check for network errors
	if (
		combined.includes("enotfound") ||
		combined.includes("etimedout") ||
		combined.includes("econnrefused") ||
		combined.includes("network") ||
		combined.includes("fetch")
	) {
		return "network";
	}

	// Check for build errors
	if (
		combined.includes("vite") ||
		combined.includes("build") ||
		combined.includes("compile") ||
		combined.includes("bundle")
	) {
		return "build";
	}

	// Check for deploy errors
	if (combined.includes("deploy") || combined.includes("publish") || combined.includes("upload")) {
		return "deploy";
	}

	// Check for config errors
	if (
		combined.includes("wrangler") ||
		combined.includes("config") ||
		combined.includes("toml") ||
		combined.includes("json")
	) {
		return "config";
	}

	return "unknown";
}

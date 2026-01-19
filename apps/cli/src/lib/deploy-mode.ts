/**
 * Deploy mode selection and validation
 */

import { $ } from "bun";
import { isLoggedIn } from "./auth/index.ts";
import type { DeployMode } from "./project-link.ts";
import { Events, track } from "./telemetry.ts";

export interface ModeFlags {
	managed?: boolean;
	byo?: boolean;
}

/**
 * Check if wrangler CLI is available.
 */
export async function isWranglerAvailable(): Promise<boolean> {
	try {
		const result = await $`which wrangler`.nothrow().quiet();
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Ensure wrangler is installed, auto-installing if needed.
 *
 * @param onInstalling - Optional callback when installation starts (for UI feedback)
 * @returns true if wrangler is available, false if installation failed
 */
export async function ensureWranglerInstalled(onInstalling?: () => void): Promise<boolean> {
	if (await isWranglerAvailable()) {
		return true;
	}

	// Auto-install wrangler
	onInstalling?.();
	try {
		await $`bun add -g wrangler`.quiet();
		return await isWranglerAvailable();
	} catch {
		return false;
	}
}

/**
 * Determine deploy mode based on login status and flags.
 *
 * Omakase behavior:
 * - Logged in => managed
 * - Logged out => BYO
 *
 * Explicit flags always override.
 */
export async function resolveDeployMode(flags: ModeFlags = {}): Promise<DeployMode> {
	// Validate mutual exclusion
	if (flags.managed && flags.byo) {
		throw new Error("Cannot use both --managed and --byo flags. Choose one.");
	}

	// Explicit flag takes precedence
	if (flags.managed) {
		track(Events.DEPLOY_MODE_SELECTED, { mode: "managed", explicit: true });
		return "managed";
	}
	if (flags.byo) {
		track(Events.DEPLOY_MODE_SELECTED, { mode: "byo", explicit: true });
		return "byo";
	}

	// Omakase default based on login status
	const loggedIn = await isLoggedIn();
	const mode = loggedIn ? "managed" : "byo";

	track(Events.DEPLOY_MODE_SELECTED, { mode, explicit: false });

	return mode;
}

/**
 * Validate that the chosen mode is available.
 *
 * @returns Error message if unavailable, null if OK
 */
export async function validateModeAvailability(mode: DeployMode): Promise<string | null> {
	if (mode === "managed") {
		const loggedIn = await isLoggedIn();
		if (!loggedIn) {
			return "Not logged in. Run: jack login or use --byo";
		}
		const hasWrangler = await isWranglerAvailable();
		if (!hasWrangler) {
			return "wrangler installation failed. Please install manually: bun add -g wrangler";
		}
	}

	if (mode === "byo") {
		const hasWrangler = await isWranglerAvailable();
		if (!hasWrangler) {
			return "wrangler installation failed. Please install manually: bun add -g wrangler";
		}
	}

	return null;
}

/**
 * Get a human-readable label for the deploy mode.
 */
export function getDeployModeLabel(mode: DeployMode): string {
	return mode === "managed" ? "jack cloud" : "wrangler (BYO)";
}

/**
 * Version checking utilities for self-update functionality
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import pkg from "../../package.json";
import { CONFIG_DIR } from "./config.ts";

const VERSION_CACHE_PATH = join(CONFIG_DIR, "version-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = "@getjack/jack";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface VersionCache {
	latestVersion: string;
	checkedAt: number;
}

/**
 * Get the current installed version
 */
export function getCurrentVersion(): string {
	return pkg.version;
}

/**
 * Fetch the latest version from npm registry
 */
async function fetchLatestVersion(): Promise<string | null> {
	try {
		const response = await fetch(NPM_REGISTRY_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5000), // 5 second timeout
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { version: string };
		return data.version;
	} catch {
		return null;
	}
}

/**
 * Read cached version info
 */
async function readVersionCache(): Promise<VersionCache | null> {
	if (!existsSync(VERSION_CACHE_PATH)) return null;
	try {
		return await Bun.file(VERSION_CACHE_PATH).json();
	} catch {
		return null;
	}
}

/**
 * Write version info to cache
 */
async function writeVersionCache(cache: VersionCache): Promise<void> {
	try {
		await Bun.write(VERSION_CACHE_PATH, JSON.stringify(cache));
	} catch {
		// Ignore cache write errors
	}
}

/**
 * Compare semver versions (simple comparison, assumes valid semver)
 */
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const l = latestParts[i] ?? 0;
		const c = currentParts[i] ?? 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

/**
 * Check if an update is available (uses cache, non-blocking)
 * Returns the latest version if newer, null otherwise
 */
export async function checkForUpdate(): Promise<string | null> {
	const currentVersion = getCurrentVersion();

	// Check cache first
	const cache = await readVersionCache();
	const now = Date.now();

	if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
		// Use cached value
		if (isNewerVersion(cache.latestVersion, currentVersion)) {
			return cache.latestVersion;
		}
		return null;
	}

	// Fetch fresh version (don't await in caller for non-blocking)
	const latestVersion = await fetchLatestVersion();
	if (!latestVersion) return null;

	// Update cache
	await writeVersionCache({ latestVersion, checkedAt: now });

	if (isNewerVersion(latestVersion, currentVersion)) {
		return latestVersion;
	}
	return null;
}

/**
 * Perform the actual update
 */
export async function performUpdate(): Promise<{
	success: boolean;
	version?: string;
	error?: string;
}> {
	try {
		// Run bun add -g to update
		const result = await $`bun add -g ${PACKAGE_NAME}@latest`.nothrow().quiet();

		if (result.exitCode !== 0) {
			return {
				success: false,
				error: result.stderr.toString() || "Update failed",
			};
		}

		// Verify the new version
		const newVersionResult = await $`bun pm ls -g`.nothrow().quiet();
		const output = newVersionResult.stdout.toString();

		// Try to extract version from output
		const versionMatch = output.match(/@getjack\/jack@(\d+\.\d+\.\d+)/);
		const newVersion = versionMatch?.[1];

		// Clear version cache so next check gets fresh data
		try {
			await Bun.write(VERSION_CACHE_PATH, "");
		} catch {
			// Ignore
		}

		return {
			success: true,
			version: newVersion,
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Check if running via bunx (vs global install)
 * bunx runs from a temp cache directory
 */
export function isRunningViaBunx(): boolean {
	// bunx runs from ~/.bun/install/cache or similar temp location
	const execPath = process.argv[1] ?? "";
	return execPath.includes(".bun/install/cache") || execPath.includes("/.cache/");
}

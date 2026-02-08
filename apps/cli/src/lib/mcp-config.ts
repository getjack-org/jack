import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * MCP server configuration structure
 */
export interface McpServerConfig {
	type: "stdio";
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * App-specific MCP configuration paths and settings
 */
interface AppMcpConfig {
	path: string;
	key: string;
}

/**
 * App MCP configuration paths
 * Maps app ID to its config file path and MCP servers key
 */
export const APP_MCP_CONFIGS: Record<string, AppMcpConfig> = {
	"claude-code": {
		path: join(homedir(), ".claude.json"),
		key: "mcpServers",
	},
	"claude-desktop": {
		path:
			platform() === "darwin"
				? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
				: platform() === "win32"
					? join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
					: join(homedir(), ".config", "Claude", "claude_desktop_config.json"),
		key: "mcpServers",
	},
};

/**
 * Jack MCP configuration storage path
 */
const JACK_MCP_CONFIG_DIR = join(CONFIG_DIR, "mcp");
const JACK_MCP_CONFIG_PATH = join(JACK_MCP_CONFIG_DIR, "config.json");

/**
 * Find the jack binary path
 * Checks common install locations
 */
function findJackBinary(): string {
	const bunBin = join(homedir(), ".bun", "bin", "jack");
	const npmBin = join(homedir(), ".npm-global", "bin", "jack");
	const homebrewBin = "/opt/homebrew/bin/jack";
	const usrLocalBin = "/usr/local/bin/jack";

	// Check in order of priority
	for (const path of [bunBin, npmBin, homebrewBin, usrLocalBin]) {
		if (existsSync(path)) {
			return path;
		}
	}

	// Fallback to just "jack" and hope PATH works
	return "jack";
}

/**
 * Returns the jack MCP server configuration
 * Uses full path to jack binary for reliability
 */
export function getJackMcpConfig(): McpServerConfig {
	// Build PATH with common locations (still needed for child processes)
	const bunBin = join(homedir(), ".bun", "bin");
	const npmBin = join(homedir(), ".npm-global", "bin");
	const defaultPaths = [bunBin, npmBin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

	return {
		type: "stdio",
		command: findJackBinary(),
		args: ["mcp", "serve"],
		env: {
			PATH: defaultPaths.join(":"),
		},
	};
}

/**
 * Get display name for app
 */
export function getAppDisplayName(appId: string): string {
	const displayNames: Record<string, string> = {
		"claude-code": "Claude Code",
		"claude-desktop": "Claude Desktop",
	};
	return displayNames[appId] || appId;
}

/**
 * Check if an app is installed
 *
 * Detection strategies per app:
 * - claude-code: Check for ~/.claude/ directory (created when Claude Code is installed/run)
 * - claude-desktop: Check if config directory exists (created when app is first run)
 */
export function isAppInstalled(appId: string): boolean {
	const appConfig = APP_MCP_CONFIGS[appId];
	if (!appConfig) return false;

	if (appId === "claude-code") {
		// Claude Code creates ~/.claude/ directory when installed
		// Don't use parent of ~/.claude.json (that's ~, which always exists)
		const claudeCodeDataDir = join(homedir(), ".claude");
		return existsSync(claudeCodeDataDir);
	}

	// For other apps (claude-desktop), check if config directory exists
	const configDir = dirname(appConfig.path);
	return existsSync(configDir);
}

/**
 * Install MCP config to a single app
 * Reads existing config, merges jack server, writes back
 * Returns true on success
 */
export async function installMcpConfigToApp(appId: string): Promise<boolean> {
	const appConfig = APP_MCP_CONFIGS[appId];
	if (!appConfig) {
		throw new Error(`Unknown app: ${appId}`);
	}

	// Ensure parent directory exists
	const configDir = dirname(appConfig.path);
	if (!existsSync(configDir)) {
		try {
			await mkdir(configDir, { recursive: true });
		} catch (error) {
			// Directory doesn't exist and can't be created - app not installed
			return false;
		}
	}

	// Read existing config or start with empty object
	let existingConfig: Record<string, unknown> = {};
	if (existsSync(appConfig.path)) {
		try {
			existingConfig = await Bun.file(appConfig.path).json();
		} catch {
			// Invalid JSON - treat as empty config
			existingConfig = {};
		}
	}

	// Get or create mcpServers object
	const mcpServers = (existingConfig[appConfig.key] as Record<string, unknown>) || {};

	// Add/update jack MCP server
	mcpServers.jack = getJackMcpConfig();

	// Merge back into config
	existingConfig[appConfig.key] = mcpServers;

	// Write updated config
	try {
		await Bun.write(appConfig.path, JSON.stringify(existingConfig, null, 2));
		return true;
	} catch {
		// Write failed (permissions, etc.)
		return false;
	}
}

/**
 * Install to ALL detected/installed apps
 * Returns array of app IDs that were configured
 */
export async function installMcpConfigsToAllApps(): Promise<string[]> {
	const configured: string[] = [];

	for (const appId of Object.keys(APP_MCP_CONFIGS)) {
		// Check if app is installed
		if (!isAppInstalled(appId)) {
			continue;
		}

		// Try to install config
		const success = await installMcpConfigToApp(appId);
		if (success) {
			configured.push(appId);
		}
	}

	return configured;
}

/**
 * Save jack's MCP config for future reference
 */
export async function saveMcpConfig(): Promise<void> {
	// Ensure directory exists
	if (!existsSync(JACK_MCP_CONFIG_DIR)) {
		await mkdir(JACK_MCP_CONFIG_DIR, { recursive: true });
	}

	// Save the jack MCP config
	const config = {
		version: 1,
		mcpServer: getJackMcpConfig(),
		installedAt: new Date().toISOString(),
	};

	await Bun.write(JACK_MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

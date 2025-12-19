import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * MCP server configuration structure
 */
export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * IDE-specific MCP configuration paths and settings
 */
interface IdeMcpConfig {
	path: string;
	key: string;
}

/**
 * IDE MCP configuration paths
 * Maps IDE ID to its config file path and MCP servers key
 */
export const IDE_MCP_CONFIGS: Record<string, IdeMcpConfig> = {
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
const JACK_MCP_CONFIG_DIR = join(homedir(), ".config", "jack", "mcp");
const JACK_MCP_CONFIG_PATH = join(JACK_MCP_CONFIG_DIR, "config.json");

/**
 * Returns the jack MCP server configuration
 */
export function getJackMcpConfig(): McpServerConfig {
	return {
		command: "jack",
		args: ["mcp", "serve"],
	};
}

/**
 * Get display name for IDE
 */
export function getIdeDisplayName(ideId: string): string {
	const displayNames: Record<string, string> = {
		"claude-code": "Claude Code",
		"claude-desktop": "Claude Desktop",
	};
	return displayNames[ideId] || ideId;
}

/**
 * Check if an IDE's config directory exists (indicating it's installed)
 */
export function isIdeInstalled(ideId: string): boolean {
	const ideConfig = IDE_MCP_CONFIGS[ideId];
	if (!ideConfig) return false;

	// Check if the parent directory exists (config file itself may not exist yet)
	const configDir = dirname(ideConfig.path);
	return existsSync(configDir);
}

/**
 * Install MCP config to a single IDE
 * Reads existing config, merges jack server, writes back
 * Returns true on success
 */
export async function installMcpConfigToIde(ideId: string): Promise<boolean> {
	const ideConfig = IDE_MCP_CONFIGS[ideId];
	if (!ideConfig) {
		throw new Error(`Unknown IDE: ${ideId}`);
	}

	// Ensure parent directory exists
	const configDir = dirname(ideConfig.path);
	if (!existsSync(configDir)) {
		try {
			await mkdir(configDir, { recursive: true });
		} catch (error) {
			// Directory doesn't exist and can't be created - IDE not installed
			return false;
		}
	}

	// Read existing config or start with empty object
	let existingConfig: Record<string, unknown> = {};
	if (existsSync(ideConfig.path)) {
		try {
			existingConfig = await Bun.file(ideConfig.path).json();
		} catch {
			// Invalid JSON - treat as empty config
			existingConfig = {};
		}
	}

	// Get or create mcpServers object
	const mcpServers = (existingConfig[ideConfig.key] as Record<string, unknown>) || {};

	// Add/update jack MCP server
	mcpServers.jack = getJackMcpConfig();

	// Merge back into config
	existingConfig[ideConfig.key] = mcpServers;

	// Write updated config
	try {
		await Bun.write(ideConfig.path, JSON.stringify(existingConfig, null, 2));
		return true;
	} catch {
		// Write failed (permissions, etc.)
		return false;
	}
}

/**
 * Install to ALL detected/installed IDEs
 * Returns array of IDE IDs that were configured
 */
export async function installMcpConfigsToAllIdes(): Promise<string[]> {
	const configured: string[] = [];

	for (const ideId of Object.keys(IDE_MCP_CONFIGS)) {
		// Check if IDE is installed
		if (!isIdeInstalled(ideId)) {
			continue;
		}

		// Try to install config
		const success = await installMcpConfigToIde(ideId);
		if (success) {
			configured.push(ideId);
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

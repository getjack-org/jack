import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type AgentConfig, readConfig, writeConfig } from "./config.ts";

// Re-export AgentConfig for consumers
export type { AgentConfig } from "./config.ts";

/**
 * Project file to generate for an agent
 */
export interface ProjectFile {
	path: string;
	template: string;
	shared?: boolean;
}

/**
 * Agent definition in the registry
 */
export interface AgentDefinition {
	id: string;
	name: string;
	searchPaths: string[];
	projectFiles: ProjectFile[];
	priority: number; // Lower = higher priority for default selection (claude-code=1, codex=2, etc.)
}

/**
 * Result of scanning for agents
 */
export interface DetectionResult {
	detected: Array<{ id: string; path: string }>;
	total: number;
}

/**
 * Result of validating agent paths
 */
export interface ValidationResult {
	valid: Array<{ id: string; path: string }>;
	invalid: Array<{ id: string; path: string }>;
}

/**
 * Built-in agent registry
 * Priority: lower = higher priority for default selection
 * Claude Code is default (priority 1), Codex is fallback (priority 2)
 */
export const AGENT_REGISTRY: AgentDefinition[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		priority: 1,
		searchPaths: [
			"~/.claude",
			"~/.config/claude",
			"%APPDATA%/Claude", // Windows
		],
		projectFiles: [
			{ path: "CLAUDE.md", template: "claude-md" },
			{ path: "AGENTS.md", template: "agents-md", shared: true },
		],
	},
	{
		id: "codex",
		name: "Codex",
		priority: 2,
		searchPaths: [
			"~/.codex",
			"%APPDATA%/codex", // Windows
		],
		projectFiles: [{ path: "AGENTS.md", template: "agents-md", shared: true }],
	},
	{
		id: "cursor",
		name: "Cursor",
		priority: 10,
		searchPaths: [
			"/Applications/Cursor.app",
			"~/.cursor",
			"%PROGRAMFILES%/Cursor", // Windows
			"/usr/share/cursor", // Linux
		],
		projectFiles: [
			{ path: ".cursorrules", template: "cursorrules" },
			{ path: "AGENTS.md", template: "agents-md", shared: true },
		],
	},
	{
		id: "windsurf",
		name: "Windsurf",
		priority: 10,
		searchPaths: [
			"/Applications/Windsurf.app",
			"~/.windsurf",
			"%PROGRAMFILES%/Windsurf", // Windows
		],
		projectFiles: [
			{ path: ".windsurfrules", template: "windsurfrules" },
			{ path: "AGENTS.md", template: "agents-md", shared: true },
		],
	},
];

/**
 * Expand ~ to home directory and handle Windows environment variables
 */
export function expandPath(path: string): string {
	if (path.startsWith("~")) {
		return path.replace("~", homedir());
	}
	// Handle Windows environment variables like %APPDATA%
	if (process.platform === "win32" && path.includes("%")) {
		return path.replace(/%([^%]+)%/g, (_, key) => process.env[key] || "");
	}
	return path;
}

/**
 * Check if a path exists (used for agent detection)
 */
export function pathExists(path: string): boolean {
	try {
		return existsSync(expandPath(path));
	} catch {
		return false;
	}
}

/**
 * Get agent definition by ID
 */
export function getAgentDefinition(id: string): AgentDefinition | undefined {
	return AGENT_REGISTRY.find((agent) => agent.id === id);
}

/**
 * Scan for installed agents by checking known paths
 */
export async function scanAgents(): Promise<DetectionResult> {
	const detected: Array<{ id: string; path: string }> = [];

	for (const agent of AGENT_REGISTRY) {
		for (const searchPath of agent.searchPaths) {
			if (pathExists(searchPath)) {
				detected.push({ id: agent.id, path: expandPath(searchPath) });
				break; // Use first found path
			}
		}
	}

	return { detected, total: AGENT_REGISTRY.length };
}

/**
 * Get active agents from config
 */
export async function getActiveAgents(): Promise<
	Array<{ id: string; config: AgentConfig; definition: AgentDefinition }>
> {
	const config = await readConfig();
	if (!config?.agents) return [];

	const active = [];
	for (const [id, agentConfig] of Object.entries(config.agents)) {
		if (agentConfig.active) {
			const definition = getAgentDefinition(id);
			if (definition) {
				active.push({ id, config: agentConfig, definition });
			}
		}
	}

	return active;
}

/**
 * Update agent in config
 */
export async function updateAgent(id: string, config: AgentConfig): Promise<void> {
	const jackConfig = await readConfig();
	if (!jackConfig) {
		throw new Error("jack not initialized - run: jack init");
	}

	if (!jackConfig.agents) {
		jackConfig.agents = {};
	}

	jackConfig.agents[id] = config;
	await writeConfig(jackConfig);
}

/**
 * Add agent to config (auto-detect or use custom path)
 */
export async function addAgent(id: string, path?: string): Promise<void> {
	const definition = getAgentDefinition(id);
	if (!definition) {
		throw new Error(`Unknown agent: ${id}`);
	}

	// If no custom path, try to detect
	let detectedPath = path;
	if (!detectedPath) {
		for (const searchPath of definition.searchPaths) {
			if (pathExists(searchPath)) {
				detectedPath = expandPath(searchPath);
				break;
			}
		}
	}

	if (!detectedPath) {
		throw new Error(`Could not detect ${definition.name}`);
	}

	if (!pathExists(detectedPath)) {
		throw new Error(`Path does not exist: ${detectedPath}`);
	}

	await updateAgent(id, {
		active: true,
		path: detectedPath,
		detectedAt: new Date().toISOString(),
	});
}

/**
 * Remove agent from config
 */
export async function removeAgent(id: string): Promise<void> {
	const config = await readConfig();
	if (!config?.agents?.[id]) {
		throw new Error(`Agent not configured: ${id}`);
	}

	delete config.agents[id];
	await writeConfig(config);
}

/**
 * Enable an agent
 */
export async function enableAgent(id: string): Promise<void> {
	const config = await readConfig();
	if (!config) {
		throw new Error("jack not initialized - run: jack init");
	}

	const agentConfig = config.agents?.[id];
	if (!agentConfig) {
		throw new Error(`Agent not configured: ${id}`);
	}

	agentConfig.active = true;
	await writeConfig(config);
}

/**
 * Disable an agent
 */
export async function disableAgent(id: string): Promise<void> {
	const config = await readConfig();
	if (!config) {
		throw new Error("jack not initialized - run: jack init");
	}

	const agentConfig = config.agents?.[id];
	if (!agentConfig) {
		throw new Error(`Agent not configured: ${id}`);
	}

	agentConfig.active = false;
	await writeConfig(config);
}

/**
 * Validate that all configured agent paths still exist
 */
export async function validateAgentPaths(): Promise<ValidationResult> {
	const config = await readConfig();
	const agents = config?.agents || {};

	const valid: Array<{ id: string; path: string }> = [];
	const invalid: Array<{ id: string; path: string }> = [];

	for (const [id, agentConfig] of Object.entries(agents)) {
		if (agentConfig.active) {
			if (pathExists(agentConfig.path)) {
				valid.push({ id, path: agentConfig.path });
			} else {
				invalid.push({ id, path: agentConfig.path });
			}
		}
	}

	return { valid, invalid };
}

/**
 * Get the user's preferred agent ID
 * Falls back to highest priority detected agent if not set
 */
export async function getPreferredAgent(): Promise<string | null> {
	const config = await readConfig();

	// If user has explicitly set a preference, use it
	if (config?.preferredAgent) {
		// Verify the preferred agent is still active
		const agentConfig = config.agents?.[config.preferredAgent];
		if (agentConfig?.active && pathExists(agentConfig.path)) {
			return config.preferredAgent;
		}
	}

	// Fall back to highest priority active agent
	const activeAgents = await getActiveAgents();
	if (activeAgents.length === 0) return null;

	// Sort by priority (lower = higher priority)
	activeAgents.sort((a, b) => a.definition.priority - b.definition.priority);
	return activeAgents[0]?.id ?? null;
}

/**
 * Set the user's preferred agent
 */
export async function setPreferredAgent(id: string): Promise<void> {
	const definition = getAgentDefinition(id);
	if (!definition) {
		throw new Error(`Unknown agent: ${id}`);
	}

	const config = await readConfig();
	if (!config) {
		throw new Error("jack not initialized - run: jack init");
	}

	// Verify the agent is configured and active
	const agentConfig = config.agents?.[id];
	if (!agentConfig) {
		throw new Error(`Agent not configured: ${id}. Run: jack agents add ${id}`);
	}
	if (!agentConfig.active) {
		throw new Error(`Agent not active: ${id}. Run: jack agents enable ${id}`);
	}

	config.preferredAgent = id;
	await writeConfig(config);
}

/**
 * Determine the default preferred agent from detected agents
 * Used during jack init to set initial preference
 */
export function getDefaultPreferredAgent(
	detected: Array<{ id: string; path: string }>,
): string | null {
	if (detected.length === 0) return null;

	// Get definitions and sort by priority
	const withPriority = detected
		.map(({ id, path }) => {
			const def = getAgentDefinition(id);
			return { id, path, priority: def?.priority ?? 999 };
		})
		.sort((a, b) => a.priority - b.priority);

	return withPriority[0]?.id ?? null;
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { type AgentConfig, type AgentLaunchConfig, readConfig, writeConfig } from "./config.ts";
import { debug, isDebug } from "./debug.ts";
import { restoreTty } from "./tty";

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
	projectFiles: ProjectFile[];
	priority: number; // Lower = higher priority for default selection (claude-code=1, codex=2, etc.)
	launch?: AgentLaunchDefinition;
}

export interface AgentLaunchDefinition {
	cliCommands?: Array<{ command: string; args?: string[] }>;
}

/**
 * Result of scanning for agents
 */
export interface DetectionResult {
	detected: Array<{ id: string; path: string; launch?: AgentLaunchConfig }>;
	total: number;
}

export interface OneShotReporter {
	info(message: string): void;
	warn(message: string): void;
	status?(message: string): void;
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
		launch: {
			cliCommands: [{ command: "claude" }],
		},
		projectFiles: [
			{ path: "CLAUDE.md", template: "claude-md" },
			{ path: "AGENTS.md", template: "agents-md", shared: true },
		],
	},
	{
		id: "codex",
		name: "Codex",
		priority: 2,
		launch: {
			cliCommands: [{ command: "codex" }],
		},
		projectFiles: [{ path: "AGENTS.md", template: "agents-md", shared: true }],
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

function findExecutable(command: string): string | null {
	const expanded = expandPath(command);
	if (expanded.includes("/") || expanded.includes("\\")) {
		return existsSync(expanded) ? expanded : null;
	}

	const pathEnv = process.env.PATH ?? "";
	const paths = pathEnv.split(delimiter).filter(Boolean);

	if (process.platform === "win32") {
		const extension = extname(command);
		const extensions =
			extension.length > 0 ? [""] : (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");

		for (const basePath of paths) {
			for (const ext of extensions) {
				const candidate = join(basePath, `${command}${ext}`);
				if (existsSync(candidate)) {
					return candidate;
				}
			}
		}
		return null;
	}

	for (const basePath of paths) {
		const candidate = join(basePath, command);
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

function resolveCliLaunch(definition: AgentDefinition): AgentLaunchConfig | null {
	const candidates = definition.launch?.cliCommands ?? [];
	for (const candidate of candidates) {
		const resolved = findExecutable(candidate.command);
		if (resolved) {
			return { type: "cli", command: resolved, args: candidate.args };
		}
	}
	return null;
}

function resolveAgentLaunch(definition: AgentDefinition): AgentLaunchConfig | null {
	return resolveCliLaunch(definition);
}

function normalizeLaunchConfig(launch: AgentLaunchConfig): AgentLaunchConfig | null {
	if (launch.type === "cli") {
		const resolved = findExecutable(launch.command);
		if (!resolved) return null;
		return { type: "cli", command: resolved, args: launch.args };
	}
	return null;
}

function getLaunchPath(launch: AgentLaunchConfig): string | null {
	if (launch.type === "cli") return launch.command;
	return null;
}

/**
 * Get agent definition by ID
 */
export function getAgentDefinition(id: string): AgentDefinition | undefined {
	return AGENT_REGISTRY.find((agent) => agent.id === id);
}

/**
 * Scan for installed agents by checking launch commands
 */
export async function scanAgents(): Promise<DetectionResult> {
	const detected: Array<{ id: string; path: string; launch?: AgentLaunchConfig }> = [];

	for (const agent of AGENT_REGISTRY) {
		const launch = resolveAgentLaunch(agent);
		const installPath = launch ? getLaunchPath(launch) : null;
		if (launch && installPath && pathExists(installPath)) {
			detected.push({ id: agent.id, path: installPath, launch });
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
export async function addAgent(
	id: string,
	options: { launch?: AgentLaunchConfig } = {},
): Promise<void> {
	const definition = getAgentDefinition(id);
	if (!definition) {
		throw new Error(`Unknown agent: ${id}`);
	}

	const launchOverride = options.launch ? normalizeLaunchConfig(options.launch) : null;
	const detectedLaunch = launchOverride ?? resolveAgentLaunch(definition);
	const detectedPath = detectedLaunch ? getLaunchPath(detectedLaunch) : null;

	if (!detectedLaunch) {
		throw new Error(`Could not detect ${definition.name}`);
	}

	if (!detectedPath) {
		throw new Error(`Could not determine install path for ${definition.name}`);
	}

	if (!pathExists(detectedPath)) {
		throw new Error(`Path does not exist: ${detectedPath}`);
	}

	await updateAgent(id, {
		active: true,
		path: expandPath(detectedPath),
		detectedAt: new Date().toISOString(),
		launch: detectedLaunch,
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
			const launch = agentConfig.launch ? normalizeLaunchConfig(agentConfig.launch) : null;
			const path = launch ? getLaunchPath(launch) : agentConfig.path;
			if (launch && path && pathExists(path)) {
				valid.push({ id, path });
			} else {
				invalid.push({ id, path: path ?? agentConfig.path });
			}
		}
	}

	return { valid, invalid };
}

function launchConfigsEqual(
	left?: AgentLaunchConfig | null,
	right?: AgentLaunchConfig | null,
): boolean {
	if (!left || !right) return left === right;
	return JSON.stringify(left) === JSON.stringify(right);
}

export async function getAgentLaunch(id: string): Promise<AgentLaunchConfig | null> {
	const definition = getAgentDefinition(id);
	if (!definition) return null;

	const config = await readConfig();
	const agentConfig = config?.agents?.[id];

	const normalized = agentConfig?.launch ? normalizeLaunchConfig(agentConfig.launch) : null;
	if (normalized) {
		if (agentConfig && config && !launchConfigsEqual(normalized, agentConfig.launch)) {
			agentConfig.launch = normalized;
			await writeConfig(config);
		}
		return normalized;
	}

	const resolved = resolveAgentLaunch(definition);
	if (resolved && agentConfig && config) {
		if (!launchConfigsEqual(resolved, agentConfig.launch)) {
			agentConfig.launch = resolved;
			await writeConfig(config);
		}
	}
	return resolved ?? null;
}

export async function getPreferredLaunchAgent(): Promise<{
	id: string;
	definition: AgentDefinition;
	launch: AgentLaunchConfig;
} | null> {
	const config = await readConfig();
	if (!config?.agents) return null;

	const activeAgents: Array<{ id: string; config: AgentConfig; definition: AgentDefinition }> = [];
	for (const [id, agentConfig] of Object.entries(config.agents)) {
		if (!agentConfig.active) continue;
		const definition = getAgentDefinition(id);
		if (definition) {
			activeAgents.push({ id, config: agentConfig, definition });
		}
	}

	if (activeAgents.length === 0) return null;

	if (config.preferredAgent) {
		const preferred = activeAgents.find((agent) => agent.id === config.preferredAgent);
		if (preferred) {
			const launch = await getAgentLaunch(preferred.id);
			if (launch) {
				return { id: preferred.id, definition: preferred.definition, launch };
			}
		}
	}

	activeAgents.sort((a, b) => a.definition.priority - b.definition.priority);
	for (const agent of activeAgents) {
		const launch = await getAgentLaunch(agent.id);
		if (launch) {
			return { id: agent.id, definition: agent.definition, launch };
		}
	}

	return null;
}

function buildLaunchCommand(
	launch: AgentLaunchConfig,
	projectDir: string,
): {
	command: string;
	args: string[];
	options: { cwd?: string; stdio: "inherit" | "ignore"; detached?: boolean };
	waitForExit: boolean;
} | null {
	if (launch.type !== "cli") return null;

	return {
		command: launch.command,
		args: launch.args ?? [],
		options: { cwd: projectDir, stdio: "inherit" },
		waitForExit: true,
	};
}

export async function launchAgent(
	launch: AgentLaunchConfig,
	projectDir: string,
): Promise<{ success: boolean; error?: string; command?: string[]; exitCode?: number | null }> {
	const launchCommand = buildLaunchCommand(launch, projectDir);
	if (!launchCommand) {
		return { success: false, error: "No supported launch command found" };
	}

	const { command, args, options, waitForExit } = launchCommand;
	const displayCommand = [command, ...args];
	restoreTty();

	return await new Promise((resolve) => {
		const child = spawn(command, args, options);

		child.once("error", (err) => {
			resolve({ success: false, error: err.message, command: displayCommand });
		});

		child.once("spawn", () => {
			if (!waitForExit) {
				child.unref();
				resolve({ success: true, command: displayCommand });
			}
		});

		if (waitForExit) {
			child.once("exit", (code) => {
				resolve({ success: true, command: displayCommand, exitCode: code });
			});
		}
	});
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
	detected: Array<{ id: string; path: string; launch?: AgentLaunchConfig }>,
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

/**
 * Agents that support one-shot mode (non-interactive execution)
 */
export const ONE_SHOT_CAPABLE_AGENTS = ["claude-code", "codex"] as const;
type OneShotAgent = (typeof ONE_SHOT_CAPABLE_AGENTS)[number];

/**
 * Check if an agent supports one-shot mode
 */
export function isOneShotCapable(agentId: string): agentId is OneShotAgent {
	return ONE_SHOT_CAPABLE_AGENTS.includes(agentId as OneShotAgent);
}

/**
 * Get preferred agent for one-shot execution
 * Returns null if no capable agent is available
 */
export async function getOneShotAgent(): Promise<OneShotAgent | null> {
	const preferred = await getPreferredAgent();

	if (preferred && isOneShotCapable(preferred)) {
		return preferred;
	}

	// Try to find any capable agent that's installed
	for (const agentId of ONE_SHOT_CAPABLE_AGENTS) {
		const launch = await getAgentLaunch(agentId);
		if (launch) {
			return agentId;
		}
	}

	return null;
}

/**
 * Build customization prompt for project personalization
 */
function buildCustomizationPrompt(projectDir: string, intent: string): string {
	return `You are customizing a new project based on this intent: "${intent}"

This is the first customization from a template. The project has been scaffolded but not yet personalized.

Instructions:
1. Read AGENTS.md and CLAUDE.md for project context
2. Modify code and configuration to match the intent
3. Focus on code/config changes, not documentation
4. Keep changes minimal and focused
5. End with a short report:
   - SUMMARY: 2-4 bullet points
   - BLOCKER: none | <short reason>

Project directory: ${projectDir}

Please customize the project to match the intent.`;
}

/**
 * Run agent in one-shot mode for project customization
 */
export async function runAgentOneShot(
	agentId: OneShotAgent,
	projectDir: string,
	intent: string,
	reporter?: OneShotReporter,
): Promise<{ success: boolean; error?: string }> {
	const launch = await getAgentLaunch(agentId);
	if (!launch || launch.type !== "cli") {
		return { success: false, error: `Agent ${agentId} not available` };
	}

	const prompt = buildCustomizationPrompt(projectDir, intent);
	const debugEnabled = isDebug();
	const agentLabel = getAgentDefinition(agentId)?.name ?? agentId;

	// Build command based on agent type
	let args: string[];
	let streamJson = false;
	let jsonMode: "claude" | "codex" | null = null;
	if (agentId === "claude-code") {
		streamJson = true;
		jsonMode = "claude";
		args = [
			"-p",
			prompt,
			"--permission-mode",
			"acceptEdits",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
		];
		if (debugEnabled) {
			args.push("--debug");
		}
	} else if (agentId === "codex") {
		streamJson = true;
		jsonMode = "codex";
		args = ["exec", prompt, "--json", "--skip-git-repo-check"];
	} else {
		return { success: false, error: `Unsupported agent: ${agentId}` };
	}

	if (debugEnabled) {
		debug("One-shot agent command", { command: launch.command, args, cwd: projectDir });
		debug("One-shot prompt", prompt);
	}

	restoreTty();

	return new Promise((resolve) => {
		const child = spawn(launch.command, args, {
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let fullOutput = "";
		let summaryLines: string[] = [];
		let blockerMessage: string | null = null;
		let statusMessage: string | null = null;

		const reportSummary = () => {
			if (!reporter) return;
			if (summaryLines.length > 0) {
				reporter.info(`Summary: ${summaryLines.join(" | ")}`);
			}
			if (blockerMessage && blockerMessage.toLowerCase() !== "none") {
				reporter.warn(`Blocker: ${blockerMessage}`);
			}
		};

		const updateStatus = (message: string) => {
			if (!reporter?.status) return;
			const next = `${agentLabel}: ${message}`;
			if (next === statusMessage) return;
			statusMessage = next;
			reporter.status(next);
		};

		const extractSummary = (text: string) => {
			const lines = text.split(/\r?\n/).map((line) => line.trim());
			let inSummary = false;

			for (const line of lines) {
				if (!line) {
					if (inSummary) {
						inSummary = false;
					}
					continue;
				}

				if (line.toUpperCase().startsWith("SUMMARY:")) {
					inSummary = true;
					const after = line.slice("SUMMARY:".length).trim();
					if (after) {
						summaryLines.push(after.replace(/^[-•]\s*/, ""));
					}
					continue;
				}

				if (line.toUpperCase().startsWith("BLOCKER:")) {
					blockerMessage = line.slice("BLOCKER:".length).trim();
					inSummary = false;
					continue;
				}

				if (inSummary) {
					summaryLines.push(line.replace(/^[-•]\s*/, ""));
				}
			}
		};

		const handleClaudeLine = (line: string) => {
			if (!line.trim()) return;
			if (debugEnabled) {
				process.stderr.write(`${line}\n`);
			}
			try {
				const parsed = JSON.parse(line) as {
					type?: string;
					event?: {
						type?: string;
						content_block?: { type?: string; name?: string };
						delta?: { type?: string; text_delta?: string };
					};
					result?: string;
					is_error?: boolean;
					permission_denials?: Array<{ reason?: string }>;
				};

				if (parsed.type === "result") {
					if (typeof parsed.result === "string" && parsed.result.trim().length > 0) {
						fullOutput = parsed.result;
					}
					if (parsed.permission_denials?.length && reporter) {
						const details = parsed.permission_denials
							.map((denial) => denial.reason)
							.filter(Boolean)
							.join(" | ");
						reporter.warn(details ? `Permission denied: ${details}` : "Permission denied");
						updateStatus("permission denied");
					}
					if (parsed.is_error) {
						stderrBuffer = stderrBuffer || "Claude returned an error";
					}
					return;
				}

				if (parsed.type === "stream_event") {
					const eventType = parsed.event?.type;
					const blockType = parsed.event?.content_block?.type;
					if (eventType === "message_start") {
						updateStatus("thinking");
					} else if (eventType === "content_block_start") {
						if (blockType === "tool_use") {
							const toolName = parsed.event?.content_block?.name;
							updateStatus(toolName ? `running ${toolName}` : "running tool");
						} else if (blockType === "text") {
							updateStatus("responding");
						}
					} else if (eventType === "message_stop") {
						updateStatus("finalizing");
					}
					const delta = parsed.event?.delta;
					if (delta?.type === "text_delta" && delta.text_delta) {
						fullOutput += delta.text_delta;
					}
				}
			} catch {
				// Ignore malformed lines in non-debug mode
			}
		};

		const handleCodexLine = (line: string) => {
			if (!line.trim()) return;
			if (debugEnabled) {
				process.stderr.write(`${line}\n`);
			}
			try {
				const parsed = JSON.parse(line) as {
					type?: string;
					item?: { type?: string; text?: string };
					error?: { message?: string };
				};

				if (parsed.type === "thread.started") {
					updateStatus("starting");
				}
				if (parsed.type === "turn.started") {
					updateStatus("thinking");
				}

				if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
					if (parsed.item.text) {
						fullOutput += parsed.item.text;
					}
					updateStatus("responding");
				}
				if (parsed.type === "item.completed" && parsed.item?.type === "reasoning") {
					updateStatus("reasoning");
				}

				if (parsed.type === "error") {
					if (parsed.error?.message) {
						stderrBuffer = parsed.error.message;
					} else {
						stderrBuffer = stderrBuffer || "Codex returned an error";
					}
					updateStatus("error");
				}
				if (parsed.type === "turn.completed") {
					updateStatus("finalizing");
				}
			} catch {
				// Ignore malformed lines in non-debug mode
			}
		};

		const handleJsonLine =
			jsonMode === "claude" ? handleClaudeLine : jsonMode === "codex" ? handleCodexLine : null;

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			if (!streamJson) {
				fullOutput += text;
				if (debugEnabled) {
					process.stderr.write(text);
				}
				return;
			}

			stdoutBuffer += text;
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				handleJsonLine?.(line);
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderrBuffer += text;
			if (debugEnabled) {
				process.stderr.write(text);
			}
		});

		child.once("error", (err) => {
			resolve({ success: false, error: err.message });
		});

		child.once("exit", (code) => {
			if (streamJson && stdoutBuffer.trim().length > 0) {
				handleJsonLine?.(stdoutBuffer);
				stdoutBuffer = "";
			}

			const exitOk = code === 0;
			if (!debugEnabled && fullOutput.trim().length > 0) {
				extractSummary(fullOutput);
				reportSummary();
			}

			if (!exitOk && stderrBuffer.trim().length > 0) {
				resolve({ success: false, error: stderrBuffer.trim() });
				return;
			}

			resolve(exitOk ? { success: true } : { success: false, error: `Exit code ${code}` });
		});
	});
}

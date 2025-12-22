import { existsSync } from "node:fs";
import { join } from "node:path";
import { regenerateAgentFiles } from "../lib/agent-files.ts";
import {
	AGENT_REGISTRY,
	addAgent,
	disableAgent,
	enableAgent,
	getActiveAgents,
	getAgentDefinition,
	getPreferredAgent,
	pathExists,
	removeAgent,
	scanAgents,
	setPreferredAgent,
	updateAgent,
} from "../lib/agents.ts";
import { readConfig } from "../lib/config.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import { getProject } from "../lib/registry.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";
import { resolveTemplate } from "../templates/index.ts";
import type { Template } from "../templates/types.ts";

/**
 * Main agents command - handles all agent management
 */
interface AgentsOptions {
	project?: string;
}

export default async function agents(
	subcommand?: string,
	args: string[] = [],
	options: AgentsOptions = {},
): Promise<void> {
	if (!subcommand) {
		return await listAgents();
	}

	switch (subcommand) {
		case "scan":
			return await scanAndPrompt();
		case "add":
			return await addAgentCommand(args);
		case "remove":
			return await removeAgentCommand(args);
		case "enable":
			return await enableAgentCommand(args);
		case "disable":
			return await disableAgentCommand(args);
		case "prefer":
			return await preferAgentCommand(args);
		case "refresh":
			return await refreshAgentFilesCommand(options);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: scan, add, remove, enable, disable, prefer, refresh");
			process.exit(1);
	}
}

/**
 * List all agents with their status
 */
async function listAgents(): Promise<void> {
	const config = await readConfig();
	const configuredAgents = config?.agents || {};
	const preferredAgentId = await getPreferredAgent();

	console.error("");
	info("AI Coding Agents");
	console.error("");

	for (const definition of AGENT_REGISTRY) {
		const agentConfig = configuredAgents[definition.id];
		const isPreferred = definition.id === preferredAgentId;

		if (agentConfig) {
			const statusMark = agentConfig.active ? "✓" : "○";
			const status = agentConfig.active ? "active" : "inactive";
			const preferredLabel = isPreferred ? " ★ preferred" : "";
			console.error(`${statusMark} ${definition.name} (${status})${preferredLabel}`);
			item(`Path: ${agentConfig.path}`);

			// Validate path still exists
			if (!pathExists(agentConfig.path)) {
				console.error("");
				item("⚠ Path no longer exists - run: jack agents scan");
			}
		} else {
			console.error(`○ ${definition.name} (not detected)`);
		}
		console.error("");
	}

	info("Commands: jack agents scan | add | remove | enable | disable | prefer | refresh");
}

/**
 * Scan for agents and prompt to enable new ones
 */
async function scanAndPrompt(): Promise<void> {
	outputSpinner.start("Scanning for agents...");
	const detectionResult = await scanAgents();
	outputSpinner.stop();

	if (detectionResult.detected.length === 0) {
		info("No agents detected");
		await listAgents();
		return;
	}

	const config = await readConfig();
	const existingAgents = config?.agents || {};
	const newAgents = detectionResult.detected.filter(({ id }) => !existingAgents[id]);

	if (newAgents.length === 0) {
		success("No new agents found");
		await listAgents();
		return;
	}

	console.error("");
	success(`Found ${newAgents.length} new agent(s):`);
	for (const { id, path, launch } of newAgents) {
		const definition = getAgentDefinition(id);
		item(`${definition?.name}: ${path}`);

		// Auto-enable (following omakase principle)
		await updateAgent(id, {
			active: true,
			path,
			detectedAt: new Date().toISOString(),
			launch,
		});
	}

	console.error("");
	success("New agents enabled");
	info("Future projects will include context files for these agents");
	await listAgents();
}

function getFlagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1]) {
			values.push(args[i + 1]);
			i++;
		}
	}
	return values;
}

/**
 * Manually add an agent
 */
async function addAgentCommand(args: string[]): Promise<void> {
	const [agentId, ...rest] = args;

	if (!agentId) {
		error("Agent ID required");
		info("Usage: jack agents add <id> [--command cmd] [--arg value]");
		info(`Available IDs: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`);
		process.exit(1);
	}

	const definition = getAgentDefinition(agentId);
	if (!definition) {
		error(`Unknown agent: ${agentId}`);
		info(`Available: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`);
		process.exit(1);
	}

	// Parse flags
	let customCommand: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--command" && rest[i + 1]) {
			customCommand = rest[i + 1];
			break;
		}
	}
	const customArgs = getFlagValues(rest, "--arg");

	if (customArgs.length > 0 && !customCommand) {
		error("Use --command with --arg");
		info("Usage: jack agents add <id> [--command cmd] [--arg value]");
		process.exit(1);
	}

	try {
		const launchOverride = customCommand
			? {
					type: "cli" as const,
					command: customCommand,
					args: customArgs.length ? customArgs : undefined,
				}
			: undefined;

		await addAgent(agentId, { launch: launchOverride });

		success(`Added ${definition.name}`);
		const config = await readConfig();
		const agentConfig = config?.agents?.[agentId];
		if (agentConfig) {
			item(`Path: ${agentConfig.path}`);
		}
		info("Future projects will include context files for this agent");
	} catch (err) {
		if (err instanceof Error) {
			error(err.message);
			if (err.message.includes("Could not detect")) {
				info(`Specify launch manually: jack agents add ${agentId} --command /path/to/command`);
			}
		}
		process.exit(1);
	}
}

/**
 * Remove an agent from config
 */
async function removeAgentCommand(args: string[]): Promise<void> {
	const [agentId] = args;

	if (!agentId) {
		error("Agent ID required");
		info("Usage: jack agents remove <id>");
		process.exit(1);
	}

	try {
		await removeAgent(agentId);
		success(`Removed ${agentId}`);
	} catch (err) {
		if (err instanceof Error) {
			error(err.message);
		}
		process.exit(1);
	}
}

/**
 * Enable an agent
 */
async function enableAgentCommand(args: string[]): Promise<void> {
	const [agentId] = args;

	if (!agentId) {
		error("Agent ID required");
		info("Usage: jack agents enable <id>");
		process.exit(1);
	}

	try {
		await enableAgent(agentId);
		success(`Enabled ${agentId}`);
	} catch (err) {
		if (err instanceof Error) {
			error(err.message);
			if (err.message.includes("not configured")) {
				info(`Run: jack agents add ${agentId}`);
			}
		}
		process.exit(1);
	}
}

/**
 * Disable an agent
 */
async function disableAgentCommand(args: string[]): Promise<void> {
	const [agentId] = args;

	if (!agentId) {
		error("Agent ID required");
		info("Usage: jack agents disable <id>");
		process.exit(1);
	}

	try {
		await disableAgent(agentId);
		success(`Disabled ${agentId}`);
		info("Future projects will not include context files for this agent");
	} catch (err) {
		if (err instanceof Error) {
			error(err.message);
		}
		process.exit(1);
	}
}

/**
 * Set preferred agent
 */
async function preferAgentCommand(args: string[]): Promise<void> {
	const [agentId] = args;

	if (!agentId) {
		// Show current preferred agent
		const preferred = await getPreferredAgent();
		if (preferred) {
			const definition = getAgentDefinition(preferred);
			success(`Preferred agent: ${definition?.name || preferred}`);
		} else {
			info("No preferred agent set");
		}
		info("Usage: jack agents prefer <id>");
		info(`Available: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`);
		return;
	}

	try {
		await setPreferredAgent(agentId);
		const definition = getAgentDefinition(agentId);
		success(`Set ${definition?.name || agentId} as preferred agent`);
	} catch (err) {
		if (err instanceof Error) {
			error(err.message);
		}
		process.exit(1);
	}
}

/**
 * Refresh agent context files from template
 */
async function refreshAgentFilesCommand(options: AgentsOptions = {}): Promise<void> {
	let projectDir = process.cwd();
	let projectName: string;
	let project = null;

	if (options.project) {
		projectName = options.project;
		project = await getProject(projectName);

		if (!project) {
			error(`Project "${projectName}" not found in registry`);
			info("List projects with: jack projects list");
			process.exit(1);
		}

		if (!project.localPath) {
			error(`Project "${projectName}" has no workspace path`);
			info("Run this command from a project directory instead");
			process.exit(1);
		}

		projectDir = project.localPath;
		if (!existsSync(projectDir)) {
			error(`Workspace not found at ${projectDir}`);
			info("Run this command from a project directory instead");
			process.exit(1);
		}
	} else {
		// 1. Detect project name from wrangler config
		outputSpinner.start("Detecting project...");
		try {
			projectName = await getProjectNameFromDir(projectDir);
		} catch {
			outputSpinner.stop();
			error("Could not determine project");
			info("Run this command from a project directory, or use --project <name>");
			process.exit(1);
		}
		outputSpinner.stop();

		// 2. Get project from registry to find template origin
		project = await getProject(projectName);
		if (!project) {
			error(`Project "${projectName}" not found in registry`);
			info("List projects with: jack projects list");
			process.exit(1);
		}
	}

	if (!project?.template) {
		error("No template lineage found for this project");
		info("This project was created before lineage tracking was added.");
		info("Re-create the project with `jack new` to enable refresh.");
		process.exit(1);
	}

	// 3. Resolve template (fetch if GitHub, load if builtin)
	outputSpinner.start("Loading template...");
	let template: Template;
	try {
		template = await resolveTemplate(project.template.name);
	} catch (err) {
		outputSpinner.stop();
		error(`Failed to load template: ${project.template.name}`);
		if (err instanceof Error) {
			info(err.message);
		}
		process.exit(1);
	}
	outputSpinner.stop();

	// 4. Backup existing files
	const agentsMdPath = join(projectDir, "AGENTS.md");
	if (existsSync(agentsMdPath)) {
		const backupPath = `${agentsMdPath}.backup`;
		const content = await Bun.file(agentsMdPath).text();
		await Bun.write(backupPath, content);
		success("Backed up AGENTS.md → AGENTS.md.backup");
	}

	const claudeMdPath = join(projectDir, "CLAUDE.md");
	if (existsSync(claudeMdPath)) {
		const backupPath = `${claudeMdPath}.backup`;
		const content = await Bun.file(claudeMdPath).text();
		await Bun.write(backupPath, content);
		success("Backed up CLAUDE.md → CLAUDE.md.backup");
	}

	// 5. Get active agents
	const activeAgents = await getActiveAgents();
	if (activeAgents.length === 0) {
		warn("No active agents configured");
		info("Run: jack agents scan");
		process.exit(1);
	}

	// 6. Regenerate agent files
	const updatedFiles = await regenerateAgentFiles(projectDir, projectName, template, activeAgents);

	console.error("");
	success("Refreshed agent context files:");
	for (const file of updatedFiles) {
		item(file);
	}
	console.error("");
	info("Review changes: git diff AGENTS.md");
}

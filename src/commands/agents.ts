import {
	AGENT_REGISTRY,
	addAgent,
	disableAgent,
	enableAgent,
	getAgentDefinition,
	getPreferredAgent,
	pathExists,
	removeAgent,
	scanAgents,
	setPreferredAgent,
	updateAgent,
} from "../lib/agents.ts";
import { readConfig } from "../lib/config.ts";
import { error, info, item, output as outputSpinner, success } from "../lib/output.ts";

/**
 * Main agents command - handles all agent management
 */
export default async function agents(subcommand?: string, args: string[] = []): Promise<void> {
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
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: scan, add, remove, enable, disable, prefer");
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

	info("Commands: jack agents scan | add | remove | enable | disable | prefer");
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
		return;
	}

	const config = await readConfig();
	const existingAgents = config?.agents || {};
	const newAgents = detectionResult.detected.filter(({ id }) => !existingAgents[id]);

	if (newAgents.length === 0) {
		success("No new agents found");
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
				info(
					`Specify launch manually: jack agents add ${agentId} --command /path/to/command`,
				);
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

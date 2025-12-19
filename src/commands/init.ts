import {
	getAgentDefinition,
	getDefaultPreferredAgent,
	scanAgents,
	updateAgent,
} from "../lib/agents.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { info, item, spinner, success } from "../lib/output.ts";
import { ensureAuth, ensureWrangler, isAuthenticated } from "../lib/wrangler.ts";

export async function isInitialized(): Promise<boolean> {
	const config = await readConfig();
	if (!config?.initialized) return false;
	return await isAuthenticated();
}

export default async function init(): Promise<void> {
	// Immediate feedback
	const spin = spinner("Checking setup...");

	const config = await readConfig();
	const alreadySetUp = config?.initialized;

	// Step 1: Ensure wrangler is installed
	spin.text = "Checking wrangler...";
	await ensureWrangler();
	spin.success("Wrangler installed");

	// Step 2: Ensure Cloudflare authentication
	const spin2 = spinner("Checking authentication...");
	const wasAuthenticated = await isAuthenticated();

	if (!wasAuthenticated) {
		spin2.stop();
		info("Opening Cloudflare login...");
		await ensureAuth();
		success("Authenticated with Cloudflare");
	} else {
		spin2.success("Authenticated with Cloudflare");
	}

	// Step 3: Detect agents
	const agentSpin = spinner("Detecting AI coding agents...");
	const detectionResult = await scanAgents();
	agentSpin.stop();

	let preferredAgent: string | undefined;
	if (detectionResult.detected.length > 0) {
		success(`Found ${detectionResult.detected.length} agent(s)`);
		for (const { id, path } of detectionResult.detected) {
			const definition = getAgentDefinition(id);
			item(`${definition?.name}: ${path}`);

			// Auto-enable detected agents
			await updateAgent(id, {
				active: true,
				path: path,
				detectedAt: new Date().toISOString(),
			});
		}

		// Set preferred agent based on priority (claude-code > codex > others)
		preferredAgent = getDefaultPreferredAgent(detectionResult.detected) ?? undefined;
		if (preferredAgent) {
			const preferredDef = getAgentDefinition(preferredAgent);
			item(`Preferred: ${preferredDef?.name || preferredAgent}`);
		}
	} else {
		info("No agents detected (you can add them later with: jack agents add)");
	}

	// Step 4: Save config (preserve existing agents, just update init status)
	const existingConfig = await readConfig();
	await writeConfig({
		version: 1,
		initialized: true,
		initializedAt: existingConfig?.initializedAt || new Date().toISOString(),
		agents: existingConfig?.agents,
		preferredAgent: preferredAgent || existingConfig?.preferredAgent,
	});

	console.error("");
	success("jack is ready!");
	if (!alreadySetUp) {
		info("Create your first project: jack new my-app");
	}
}

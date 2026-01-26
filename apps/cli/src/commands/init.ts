import {
	getAgentDefinition,
	getDefaultPreferredAgent,
	scanAgents,
	updateAgent,
} from "../lib/agents.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { promptSelect } from "../lib/hooks.ts";
import { getAppDisplayName, installMcpConfigsToAllApps, saveMcpConfig } from "../lib/mcp-config.ts";
import { info, item, spinner, success } from "../lib/output.ts";
import {
	detectShell,
	getRcFileName,
	getRcFilePath,
	getShellFileDisplayPath,
	getShellName,
	hasLegacyInstall,
	install as installShellIntegration,
	isInstalled as isShellIntegrationInstalled,
} from "../lib/shell-integration.ts";
import { ensureAuth, ensureWrangler, isAuthenticated } from "../lib/wrangler.ts";

export async function isInitialized(): Promise<boolean> {
	const config = await readConfig();
	const { isLoggedIn } = await import("../lib/auth/store.ts");

	if (config?.initialized) {
		if ((await isLoggedIn()) || (await isAuthenticated())) return true;
	}

	// Auto-initialize if authenticated
	const loggedIn = await isLoggedIn();
	const wranglerAuth = !loggedIn && (await isAuthenticated());

	if (loggedIn || wranglerAuth) {
		await writeConfig({
			version: 1,
			initialized: true,
			initializedAt: new Date().toISOString(),
			...config,
		});
		return true;
	}

	return false;
}

interface InitOptions {
	skipMcp?: boolean;
}

export default async function init(options: InitOptions = {}): Promise<void> {
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
		for (const { id, path, launch } of detectionResult.detected) {
			const definition = getAgentDefinition(id);
			item(`${definition?.name}: ${path}`);

			// Auto-enable detected agents
			await updateAgent(id, {
				active: true,
				path: path,
				detectedAt: new Date().toISOString(),
				launch,
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

	// Step 4: Install MCP configs to detected apps (unless --skip-mcp)
	if (!options.skipMcp) {
		const mcpSpinner = spinner("Installing MCP server configs...");
		try {
			const installedApps = await installMcpConfigsToAllApps();
			mcpSpinner.stop();

			if (installedApps.length > 0) {
				success(`MCP server installed to ${installedApps.length} app(s)`);
				for (const appId of installedApps) {
					item(`  ${getAppDisplayName(appId)}`);
				}
			} else {
				info("No supported apps detected for MCP installation");
			}
		} catch (err) {
			mcpSpinner.stop();
			// Don't fail init if MCP install fails - just warn
			info("Could not install MCP configs (non-critical)");
		}

		try {
			await saveMcpConfig();
		} catch {
			// Non-critical; config persistence shouldn't block init
		}
	}

	// Step 5: Shell integration
	const shell = detectShell();
	const rcFile = getRcFilePath(shell);

	if (rcFile && shell !== "unknown") {
		const alreadyInstalled = isShellIntegrationInstalled(rcFile);
		const hasLegacy = hasLegacyInstall(rcFile);

		if (alreadyInstalled && !hasLegacy) {
			// Already installed
		} else if (hasLegacy) {
			console.error("");
			info("Upgrading shell integration...");
			try {
				const result = installShellIntegration(rcFile);
				if (result.migrated) {
					success(`Upgraded to ${getShellFileDisplayPath()}`);
					info(`Restart your terminal or run: source ~/${getRcFileName(rcFile)}`);
				}
			} catch {
				info("Could not upgrade shell integration (non-critical)");
			}
		} else {
			console.error("");
			info("Enable 'jack cd' and 'jack new' to auto-change directories?");
			const choice = await promptSelect(["Yes", "No"]);

			if (choice === 0) {
				try {
					installShellIntegration(rcFile);
					success(`Added to ~/${getRcFileName(rcFile)}`);
					info(`Restart your terminal or run: source ~/${getRcFileName(rcFile)}`);
				} catch {
					info("Could not update shell config (non-critical)");
					info('Add manually: eval "$(jack shell-init)"');
				}
			}
		}
	}

	// Step 6: Save config (preserve existing agents, just update init status)
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

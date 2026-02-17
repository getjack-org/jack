/**
 * jack update - Self-update to the latest version
 */

import { debug } from "../lib/debug.ts";
import { installMcpConfigsToAllApps } from "../lib/mcp-config.ts";
import { error, info, success, warn } from "../lib/output.ts";
import {
	detectShell,
	getRcFilePath,
	isInstalled as isShellIntegrationInstalled,
	update as updateShellIntegration,
} from "../lib/shell-integration.ts";
import {
	checkForUpdate,
	getCurrentVersion,
	isRunningViaBunx,
	performUpdate,
} from "../lib/version-check.ts";

export default async function update(): Promise<void> {
	const currentVersion = getCurrentVersion();

	debug("Update check started");
	debug(`Current version: ${currentVersion}`);
	debug(`Exec path: ${process.argv[1]}`);

	// Check if running via bunx
	if (isRunningViaBunx()) {
		debug("Detected bunx execution");
		info(`Running via bunx (current: v${currentVersion})`);
		info("bunx automatically uses cached packages.");
		info("To get the latest version, run:");
		info("  bunx @getjack/jack@latest <command>");
		info("");
		info("Or install globally:");
		info("  bun add -g @getjack/jack");
		return;
	}

	info(`Current version: v${currentVersion}`);

	// Check for updates - skip cache since user explicitly requested update
	debug("Fetching latest version from npm...");
	const latestVersion = await checkForUpdate(true);
	debug(`Latest version from npm: ${latestVersion ?? "none (you're up to date)"}`);

	if (!latestVersion) {
		success("You're on the latest version!");
		return;
	}

	info(`New version available: v${latestVersion}`);
	info("Updating...");

	debug("Running: bun add -g @getjack/jack@latest");
	const result = await performUpdate();
	debug(`Update result: ${JSON.stringify(result)}`);

	if (result.success) {
		success(`Updated to v${result.version ?? latestVersion}`);

		// Repair MCP config on successful update (ensures new features work)
		try {
			const installedApps = await installMcpConfigsToAllApps();
			if (installedApps.length > 0) {
				info(`MCP config updated for: ${installedApps.join(", ")}`);
				info("Restart your Claude Code / Codex session to use the new version");
			}
		} catch {
			// Non-critical - don't fail update if MCP repair fails
			debug("MCP config repair failed (non-critical)");
		}

		try {
			const shell = detectShell();
			const rcFile = getRcFilePath(shell);
			if (rcFile && isShellIntegrationInstalled(rcFile)) {
				updateShellIntegration();
				info("Shell integration updated");
			} else if (rcFile && shell !== "unknown") {
				info("Tip: 'jack init' enables auto-cd for jack new/cd");
			}
		} catch {
			debug("Shell integration update failed");
		}
	} else {
		error("Update failed");
		if (result.error) {
			warn(result.error);
		}
		info("Try manually: bun add -g @getjack/jack@latest");
	}
}

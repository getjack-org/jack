/**
 * jack update - Self-update to the latest version
 */

import { error, info, success, warn } from "../lib/output.ts";
import {
	checkForUpdate,
	getCurrentVersion,
	isRunningViaBunx,
	performUpdate,
} from "../lib/version-check.ts";

export default async function update(): Promise<void> {
	const currentVersion = getCurrentVersion();

	// Check if running via bunx
	if (isRunningViaBunx()) {
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

	// Check for updates
	const latestVersion = await checkForUpdate();

	if (!latestVersion) {
		success("You're on the latest version!");
		return;
	}

	info(`New version available: v${latestVersion}`);
	info("Updating...");

	const result = await performUpdate();

	if (result.success) {
		success(`Updated to v${result.version ?? latestVersion}`);
		info("Restart your terminal to use the new version.");
	} else {
		error("Update failed");
		if (result.error) {
			warn(result.error);
		}
		info("Try manually: bun add -g @getjack/jack@latest");
	}
}

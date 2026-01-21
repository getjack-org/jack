/**
 * jack update - Self-update to the latest version
 */

import { debug } from "../lib/debug.ts";
import { error, info, success, warn } from "../lib/output.ts";
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
	} else {
		error("Update failed");
		if (result.error) {
			warn(result.error);
		}
		info("Try manually: bun add -g @getjack/jack@latest");
	}
}

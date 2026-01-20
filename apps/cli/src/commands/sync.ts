import { existsSync } from "node:fs";
import { getSyncConfig } from "../lib/config.ts";
import { error, info, spinner, success, warn } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { syncToCloud } from "../lib/storage/index.ts";

export interface SyncFlags {
	verbose?: boolean;
	dryRun?: boolean;
	force?: boolean;
}

function hasWranglerConfig(): boolean {
	return (
		existsSync("./wrangler.toml") || existsSync("./wrangler.jsonc") || existsSync("./wrangler.json")
	);
}

export default async function sync(flags: SyncFlags = {}): Promise<void> {
	const { verbose = false, dryRun = false, force = false } = flags;

	// Check for wrangler config
	if (!hasWranglerConfig()) {
		error("Not in a project directory");
		info("Run jack new <name> to create a project");
		process.exit(1);
	}

	// Check if this is a managed project
	const link = await readProjectLink(process.cwd());
	if (link?.deploy_mode === "managed") {
		info("Managed projects are automatically backed up to jack cloud during deploy.");
		info("Use 'jack clone <project>' on another machine to restore.");
		return;
	}

	// Check if sync is enabled
	const syncConfig = await getSyncConfig();
	if (!syncConfig.enabled) {
		warn("Sync is disabled in config");
		info("Enable with: jack config sync.enabled true");
	}

	// Sync to cloud
	const syncSpin = spinner("Syncing to cloud...");
	const projectDir = process.cwd();

	const result = await syncToCloud(projectDir, { force, dryRun, verbose });

	if (!result.success) {
		syncSpin.stop();
		error("Sync failed");
		if (result.error) {
			info(result.error);
		}
		info("Check your network connection and try again");
		process.exit(1);
	}

	syncSpin.stop();

	// Show results
	console.error("");
	const totalChanges = result.filesUploaded + result.filesDeleted;

	if (dryRun) {
		if (totalChanges === 0) {
			info("No changes to sync");
		} else {
			if (result.filesUploaded > 0) {
				info(`${result.filesUploaded} file(s) would be uploaded`);
			}
			if (result.filesDeleted > 0) {
				info(`${result.filesDeleted} file(s) would be deleted`);
			}
		}
		console.error("");
		info("Dry run - no changes made");
		return;
	}

	if (totalChanges === 0) {
		success("Already in sync");
	} else {
		if (result.filesUploaded > 0) {
			info(`${result.filesUploaded} file(s) uploaded`);
		}
		if (result.filesDeleted > 0) {
			info(`${result.filesDeleted} file(s) deleted`);
		}
		console.error("");
		success(`Synced to jack-storage/${result.projectName}/`);
	}
	console.error("");
}

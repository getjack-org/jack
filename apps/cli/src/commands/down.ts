import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAuthState } from "../lib/auth/index.ts";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../lib/cloudflare-api.ts";
import { getJackHome } from "../lib/config.ts";
import { fetchProjectResources } from "../lib/control-plane.ts";
import { promptSelect } from "../lib/hooks.ts";
import { managedDown } from "../lib/managed-down.ts";
import { error, info, item, output, success, warn } from "../lib/output.ts";
import { unregisterPath } from "../lib/paths-index.ts";
import { type LocalProjectLink, readProjectLink, unlinkProject } from "../lib/project-link.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import { parseWranglerResources } from "../lib/resources.ts";
import { deleteProject } from "../lib/services/project-delete.ts";
import { deleteCloudProject, getProjectNameFromDir } from "../lib/storage/index.ts";

/**
 * Resolve database name for a project.
 * For managed projects: fetch from control plane.
 * For BYO projects: parse from wrangler.jsonc in cwd.
 */
async function resolveDatabaseName(
	link: LocalProjectLink | null,
	projectName: string,
): Promise<string | null> {
	// For managed projects, fetch from control plane
	if (link?.deploy_mode === "managed") {
		try {
			const resources = await fetchProjectResources(link.project_id);
			const d1 = resources.find((r) => r.resource_type === "d1");
			return d1?.resource_name || null;
		} catch {
			return null;
		}
	}

	// For BYO, parse from wrangler config in cwd
	try {
		let cwdProjectName: string | null = null;
		try {
			cwdProjectName = await getProjectNameFromDir(process.cwd());
		} catch {
			cwdProjectName = null;
		}

		if (!cwdProjectName || cwdProjectName !== projectName) {
			warn(`Run this command from the ${projectName} project directory to manage its database.`);
			return null;
		}

		const resources = await parseWranglerResources(process.cwd());
		return resources.d1?.name || null;
	} catch {
		return null;
	}
}

export interface DownFlags {
	force?: boolean;
	includeBackup?: boolean;
}

export default async function down(projectName?: string, flags: DownFlags = {}): Promise<void> {
	try {
		// Get project name
		const hasExplicitName = Boolean(projectName);
		let name = projectName;
		if (!name) {
			try {
				name = await getProjectNameFromDir(process.cwd());
			} catch (err) {
				error("Could not determine project name");
				info("Usage: jack down [project-name]");
				process.exit(1);
			}
		}

		// Resolve project from all sources (local link + control plane)
		const resolved = await resolveProject(name, {
			preferLocalLink: !hasExplicitName,
		});

		// Read local project link (only when no explicit name provided)
		const link = hasExplicitName ? null : await readProjectLink(process.cwd());

		// Check if found only on control plane (orphaned managed project)
		if (resolved?.sources.controlPlane && !resolved.sources.filesystem) {
			console.error("");
			info(`Found "${name}" on jack cloud`);
		}

		// Guard against mismatched resolutions when an explicit name is provided
		if (hasExplicitName && resolved) {
			const matches =
				name === resolved.slug || name === resolved.name || name === resolved.remote?.projectId;
			if (!matches) {
				error(`Refusing to undeploy '${name}' because it resolves to '${resolved.slug}'.`);
				info("Use the exact slug/name shown by 'jack info' and try again.");
				process.exit(1);
			}
		}

		// Track auth state for final messaging
		let authState: Awaited<ReturnType<typeof getAuthState>> | null = null;
		if (!resolved && !link) {
			authState = await getAuthState();
		}

		// Check if this is a managed project (from link or resolved data)
		const isManaged = link?.deploy_mode === "managed" || resolved?.remote?.projectId;

		if (isManaged) {
			// Get the project ID from link or resolved data
			const projectId = link?.project_id || resolved?.remote?.projectId;
			const runjackUrl = resolved?.url || null;
			const localPath = resolved?.localPath || null;

			if (!projectId) {
				error("Cannot determine project ID for managed deletion");
				process.exit(1);
			}

			if (flags.force) {
				// Force mode: full teardown via shared service
				const projectDir = resolved?.localPath ?? process.cwd();
				console.error("");
				info(`Undeploying '${name}'`);
				console.error("");

				output.start("Undeploying from jack cloud...");
				const result = await deleteProject(projectDir, { exportDatabase: false });
				output.stop();

				for (const w of result.warnings) {
					warn(w);
				}

				console.error("");
				success(`'${name}' undeployed`);
				if (result.databaseDeleted) {
					info("Database and all resources were deleted");
				}
				console.error("");
			} else {
				// Interactive mode: use managedDown with prompts
				const deleteSuccess = await managedDown({ projectId, runjackUrl, localPath }, name, flags);
				if (!deleteSuccess) {
					process.exit(0); // User cancelled
				}
			}

			// Clean up local tracking state (only if project has local path)
			if (resolved?.localPath) {
				try {
					await unlinkProject(resolved.localPath);
					await unregisterPath(projectId, resolved.localPath);
				} catch {
					// Non-fatal: local cleanup failed but cloud deletion succeeded
				}
			}
			return;
		}

		// Continue with existing BYO flow...

		// Check if worker exists
		output.start("Checking deployment...");
		const workerExists = await checkWorkerExists(name);
		output.stop();

		if (!workerExists) {
			console.error("");
			error(`Project '${name}' not found`);
			if (authState === "session-expired") {
				info("Session expired. Run: jack login");
			} else if (authState === "not-logged-in") {
				info("Not logged in. Run: jack login");
			} else {
				info("Run jack projects to see your projects");
			}
			return;
		}

		// Force mode - full teardown (worker + database) without prompts
		if (flags.force) {
			console.error("");
			info(`Undeploying '${name}'`);
			console.error("");

			output.start("Undeploying...");
			const forceResult = await deleteProject(resolved?.localPath ?? process.cwd(), {
				exportDatabase: false,
			});
			output.stop();

			for (const w of forceResult.warnings) {
				warn(w);
			}

			console.error("");
			success(`'${name}' undeployed`);
			if (forceResult.databaseDeleted && forceResult.databaseName) {
				info(`Database '${forceResult.databaseName}' was also deleted`);
			}
			console.error("");
			return;
		}

		// Interactive mode - show what will be affected
		console.error("");
		info(`Project: ${name}`);
		if (resolved?.url) {
			item(`URL: ${resolved.url}`);
		}
		const dbName = await resolveDatabaseName(link, name);
		if (dbName) {
			item(`Database: ${dbName}`);
		}
		console.error("");

		// Single confirmation with clear description
		console.error("");
		const confirmMsg = dbName
			? "Undeploy this project? Worker and database will be deleted."
			: "Undeploy this project?";
		info(confirmMsg);
		const action = await promptSelect(["Yes", "No"]);

		if (action !== 0) {
			info("Cancelled");
			return;
		}

		// Auto-export database if it exists (no prompt)
		let exportPath: string | null = null;
		if (dbName) {
			const backupDir = resolved?.localPath ?? join(getJackHome(), name);
			mkdirSync(backupDir, { recursive: true });
			exportPath = join(backupDir, `${dbName}-backup.sql`);
			output.start("Exporting database...");
			try {
				await exportDatabase(dbName, exportPath);
				output.stop();
			} catch (err) {
				output.stop();
				warn(`Could not export database: ${err instanceof Error ? err.message : String(err)}`);
				exportPath = null;
			}
		}

		// Undeploy worker
		output.start("Undeploying...");
		try {
			await deleteWorker(name);
			output.stop();
		} catch (err) {
			output.stop();
			error(`Failed to undeploy: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}

		// Delete database if it exists
		if (dbName) {
			output.start(`Deleting database '${dbName}'...`);
			try {
				await deleteDatabase(dbName);
				output.stop();
			} catch (err) {
				output.stop();
				warn(
					`Failed to delete database '${dbName}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Only prompt for backup deletion if --include-backup flag is passed
		if (flags.includeBackup) {
			console.error("");
			info("Also delete cloud backup?");
			const deleteR2Action = await promptSelect(["Yes", "No"]);

			if (deleteR2Action === 0) {
				output.start("Deleting backup...");
				try {
					const deleted = await deleteCloudProject(name);
					output.stop();
					if (deleted) {
						success("Backup deleted");
					} else {
						warn("No backup found or already deleted");
					}
				} catch (err) {
					output.stop();
					warn(`Failed to delete backup: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// Final success message
		console.error("");
		success(`Undeployed '${name}'`);
		if (exportPath) {
			info(`Database backup: ${exportPath}`);
		}
		console.error("");
	} catch (err) {
		console.error("");
		error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

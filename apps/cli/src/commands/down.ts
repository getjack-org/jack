import { join } from "node:path";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../lib/cloudflare-api.ts";
import { fetchProjectResources } from "../lib/control-plane.ts";
import { promptSelect } from "../lib/hooks.ts";
import { managedDown } from "../lib/managed-down.ts";
import { error, info, item, output, success, warn } from "../lib/output.ts";
import { type LocalProjectLink, readProjectLink } from "../lib/project-link.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import { parseWranglerResources } from "../lib/resources.ts";
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
			info(`Found "${name}" on jack cloud, linking locally...`);
		}


		// Guard against mismatched resolutions when an explicit name is provided
		if (hasExplicitName && resolved) {
			const matches =
				name === resolved.slug ||
				name === resolved.name ||
				name === resolved.remote?.projectId;
			if (!matches) {
				error(`Refusing to undeploy '${name}' because it resolves to '${resolved.slug}'.`);
				info("Use the exact slug/name shown by 'jack info' and try again.");
				process.exit(1);
			}
		}

		if (!resolved && !link) {
			// Not found anywhere
			warn(`Project '${name}' not found`);
			info("Will attempt to undeploy if deployed");
		}

		// Check if this is a managed project (from link or resolved data)
		const isManaged = link?.deploy_mode === "managed" || resolved?.remote?.projectId;

		if (isManaged) {
			// Get the project ID from link or resolved data
			const projectId = link?.project_id || resolved?.remote?.projectId;
			const runjackUrl = resolved?.url || null;

			if (!projectId) {
				error("Cannot determine project ID for managed deletion");
				process.exit(1);
			}

			// Route to managed deletion flow
			const deleteSuccess = await managedDown({ projectId, runjackUrl }, name, flags);
			if (!deleteSuccess) {
				process.exit(0); // User cancelled
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
			warn(`'${name}' is not deployed`);
			info("Nothing to undeploy");
			return;
		}

		// Force mode - quick deletion without prompts
		if (flags.force) {
			console.error("");
			info(`Undeploying '${name}'`);
			console.error("");

			output.start("Undeploying...");
			await deleteWorker(name);
			output.stop();

			console.error("");
			success(`'${name}' undeployed`);
			info("Databases and backups were not affected");
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

		// Confirm undeploy
		console.error("");
		info("Undeploy this project?");
		const action = await promptSelect(["Yes", "No"]);

		if (action !== 0) {
			info("Cancelled");
			return;
		}

		// Handle database if it exists
		let shouldDeleteDb = false;

		if (dbName) {
			console.error("");
			info(`Found database: ${dbName}`);

			// Ask if they want to export first
			console.error("");
			info(`Export database '${dbName}' before deleting?`);
			const exportAction = await promptSelect(["Yes", "No"]);

			if (exportAction === 0) {
				const exportPath = join(process.cwd(), `${dbName}-backup.sql`);
				output.start(`Exporting database to ${exportPath}...`);
				try {
					await exportDatabase(dbName, exportPath);
					output.stop();
					success(`Database exported to ${exportPath}`);
				} catch (err) {
					output.stop();
					error(`Failed to export database: ${err instanceof Error ? err.message : String(err)}`);
					console.error("");
					info("Continue without exporting?");
					const continueAction = await promptSelect(["Yes", "No"]);
					if (continueAction !== 0) {
						info("Cancelled");
						return;
					}
				}
			}

			// Ask if they want to delete the database
			console.error("");
			info(`Delete database '${dbName}'?`);
			const deleteAction = await promptSelect(["Yes", "No"]);

			shouldDeleteDb = deleteAction === 0;
		}

		// Handle backup deletion
		let shouldDeleteR2 = false;
		console.error("");
		info("Delete backup for this project?");
		const deleteR2Action = await promptSelect(["Yes", "No"]);
		shouldDeleteR2 = deleteR2Action === 0;

		// Execute deletions
		console.error("");
		info("Executing cleanup...");
		console.error("");

		// Undeploy service
		output.start("Undeploying...");
		try {
			await deleteWorker(name);
			output.stop();
			success(`'${name}' undeployed`);
		} catch (err) {
			output.stop();
			error(`Failed to undeploy: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}

		// Delete database if requested
		if (shouldDeleteDb && dbName) {
			output.start(`Deleting database '${dbName}'...`);
			try {
				await deleteDatabase(dbName);
				output.stop();
				success(`Database '${dbName}' deleted`);
			} catch (err) {
				output.stop();
				warn(
					`Failed to delete database '${dbName}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Delete backup if requested
		if (shouldDeleteR2) {
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

		console.error("");
		success(`Project '${name}' undeployed`);
		console.error("");
	} catch (err) {
		console.error("");
		error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

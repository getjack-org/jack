import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../lib/cloudflare-api.ts";
import { promptSelect } from "../lib/hooks.ts";
import { managedDown } from "../lib/managed-down.ts";
import { error, info, item, output, success, warn } from "../lib/output.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import {
	type Project,
	getProject,
	getProjectDatabaseName,
	updateProject,
	updateProjectDatabase,
} from "../lib/registry.ts";
import { deleteCloudProject, getProjectNameFromDir } from "../lib/storage/index.ts";

/**
 * Get database name for a project, with fallback to wrangler config
 */
async function resolveDbName(project: Project): Promise<string | null> {
	// First check registry
	const dbFromRegistry = getProjectDatabaseName(project);
	if (dbFromRegistry) {
		return dbFromRegistry;
	}

	// Fallback: read from wrangler config file
	if (project.localPath && existsSync(project.localPath)) {
		const jsoncPath = join(project.localPath, "wrangler.jsonc");
		if (existsSync(jsoncPath)) {
			try {
				const content = await Bun.file(jsoncPath).text();
				// Remove comments for JSON parsing
				// Note: Only remove line comments at the start of a line to avoid breaking URLs
				const jsonContent = content
					.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
					.replace(/^\s*\/\/.*$/gm, ""); // line comments at start of line only
				const config = JSON.parse(jsonContent);
				if (config.d1_databases?.[0]?.database_name) {
					return config.d1_databases[0].database_name;
				}
			} catch {
				// Ignore parse errors
			}
		}

		const tomlPath = join(project.localPath, "wrangler.toml");
		if (existsSync(tomlPath)) {
			try {
				const content = await Bun.file(tomlPath).text();
				const match = content.match(/database_name\s*=\s*"([^"]+)"/);
				if (match?.[1]) {
					return match[1];
				}
			} catch {
				// Ignore read errors
			}
		}
	}

	return null;
}

export interface DownFlags {
	force?: boolean;
}

export default async function down(projectName?: string, flags: DownFlags = {}): Promise<void> {
	try {
		// Get project name
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

		// Resolve project from all sources (registry + control plane)
		const resolved = await resolveProject(name);

		// Check if found only on control plane (orphaned managed project)
		if (resolved?.sources.controlPlane && !resolved.sources.registry) {
			console.error("");
			info(`Found "${name}" on jack cloud, linking locally...`);
		}

		// Get the registry project (may have been created by resolver cache)
		const project = await getProject(name);

		if (!resolved && !project) {
			// Not found anywhere
			warn(`Project '${name}' not found`);
			info("Will attempt to undeploy if deployed");
		}

		// Check if this is a managed project (either from resolved or registry)
		const isManaged =
			resolved?.remote?.projectId ||
			(project?.deploy_mode === "managed" && project.remote?.project_id);

		if (isManaged) {
			// Build project object for managedDown if we only have resolved data
			const managedProject: Project = project || {
				localPath: resolved?.localPath || null,
				workerUrl: resolved?.url || null,
				createdAt: resolved?.createdAt || new Date().toISOString(),
				lastDeployed: resolved?.updatedAt || null,
				status: resolved?.status === "live" ? "live" : "build_failed",
				resources: { services: { db: null } },
				deploy_mode: "managed",
				remote:
					resolved?.remote && resolved.url
						? {
								project_id: resolved.remote.projectId,
								project_slug: resolved.slug,
								org_id: resolved.remote.orgId,
								runjack_url: resolved.url,
							}
						: undefined,
			};

			// Route to managed deletion flow
			const deleteSuccess = await managedDown(managedProject, name, flags);
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

			// Update registry - keep entry but clear worker URL
			if (project) {
				await updateProject(name, {
					workerUrl: null,
					lastDeployed: null,
				});
			}

			console.error("");
			success(`'${name}' undeployed`);
			info("Databases and backups were not affected");
			console.error("");
			return;
		}

		// Interactive mode - show what will be affected
		console.error("");
		info(`Project: ${name}`);
		if (project?.workerUrl) {
			item(`URL: ${project.workerUrl}`);
		}
		const dbName = project ? await resolveDbName(project) : null;
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
		if (project) {
			console.error("");
			info("Delete backup for this project?");
			const deleteR2Action = await promptSelect(["Yes", "No"]);
			shouldDeleteR2 = deleteR2Action === 0;
		}

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

				// Update registry
				await updateProjectDatabase(name, null);
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

		// Update registry - keep entry but clear worker URL
		if (project) {
			await updateProject(name, {
				workerUrl: null,
				lastDeployed: null,
			});
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

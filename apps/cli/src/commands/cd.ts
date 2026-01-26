/**
 * cd command - print project path for shell integration
 *
 * Usage: jack cd <name>
 *
 * Outputs ONLY the absolute path to stdout (no other output).
 * Error messages go to stderr.
 *
 * Exit codes:
 * - 0: Success (path printed)
 * - 1: No match, error, or project cannot be resolved
 */

import { join } from "node:path";
import { CloneCollisionError, ProjectNotFoundError, cloneProject } from "../lib/clone-core.ts";
import { getJackHome } from "../lib/config.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { error } from "../lib/output.ts";
import { type ResolvedProject, listAllProjects } from "../lib/project-resolver.ts";
import {
	detectShell,
	getRcFilePath,
	isInstalled as isShellIntegrationInstalled,
} from "../lib/shell-integration.ts";

function maybeShowShellHint(path: string): void {
	const shell = detectShell();
	const rcFile = getRcFilePath(shell);

	if (!rcFile || shell === "unknown") return;
	if (isShellIntegrationInstalled(rcFile)) return;
	console.error(`cd ${path}`);
}

/**
 * Find the best matching project by name using fuzzy matching.
 * Tiebreaker: most recently deployed wins (updatedAt descending).
 *
 * @param query - The search query
 * @param projects - All resolved projects
 * @returns The best matching project or null
 */
function findBestMatch(query: string, projects: ResolvedProject[]): ResolvedProject | null {
	// Sort by updatedAt descending before fuzzy filter so tiebreaker favors recent
	const sorted = [...projects].sort((a, b) => {
		const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
		const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
		return bTime - aTime;
	});

	// Fuzzy filter preserves sort order for items with equal scores
	const matches = fuzzyFilter(query, sorted, (p) => p.name);

	return matches[0] ?? null;
}

export default async function cd(projectName?: string): Promise<void> {
	// Validate project name
	if (!projectName) {
		// No match: exit 1, no message (shell wrapper handles it)
		process.exit(1);
	}

	let projects: ResolvedProject[];

	// Fetch all projects (local + cloud)
	try {
		projects = await listAllProjects();
	} catch (err) {
		// Network timeout
		error("Could not reach cloud. Check your connection.");
		if (process.env.DEBUG || process.argv.includes("--debug")) {
			console.error("Debug:", err);
		}
		process.exit(1);
	}

	// Find best match using fuzzy matching
	const match = findBestMatch(projectName, projects);

	if (!match) {
		// No match: exit 1, no message
		process.exit(1);
	}

	// Check if project has local path
	if (match.localPath) {
		// Local copy exists - print path and exit
		console.log(match.localPath);
		maybeShowShellHint(match.localPath);
		process.exit(0);
	}

	// Cloud-only project: check deploy mode
	if (match.deployMode === "managed") {
		// Managed cloud-only: auto-clone to JACK_HOME
		const jackHome = getJackHome();
		const targetDir = join(jackHome, match.slug || match.name);

		try {
			const result = await cloneProject(match.slug || match.name, targetDir, {
				silent: true,
				skipPrompts: true,
			});

			// Print the cloned path
			console.log(result.path);
			maybeShowShellHint(result.path);
			process.exit(0);
		} catch (err) {
			if (err instanceof ProjectNotFoundError) {
				// Project deleted from cloud
				error(`Project '${match.name}' no longer exists in cloud.`);
				process.exit(1);
			}

			if (err instanceof CloneCollisionError) {
				// Directory already exists - use it (silent recovery)
				console.log(err.targetDir);
				maybeShowShellHint(err.targetDir);
				process.exit(0);
			}

			// Check for "no source backup" error (orphan project)
			const errMsg = err instanceof Error ? err.message : "";
			if (errMsg.includes("source not found")) {
				error(`'${match.name}' has no cloud backup.`);
				console.error("  This project was created before source backup was enabled.");
				console.error(`  Remove it with: jack down ${match.name}`);
				process.exit(1);
			}

			// Other clone errors (network, etc.)
			error("Could not reach cloud. Check your connection.");
			if (process.env.DEBUG || process.argv.includes("--debug")) {
				console.error("Debug:", err);
			}
			process.exit(1);
		}
	}

	// BYO cloud-only: error with guidance
	if (match.deployMode === "byo") {
		error(`'${match.name}' is a BYO project with no local copy.`);
		console.error("  Clone it manually or check your backup.");
		process.exit(1);
	}

	// Unknown state (should not happen)
	process.exit(1);
}

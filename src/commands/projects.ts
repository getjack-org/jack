import { dirname } from "node:path";
import { select } from "@inquirer/prompts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import {
	cleanupStaleProjects,
	getProjectStatus,
	listAllProjects,
	scanStaleProjects,
	type ProjectStatus,
} from "../lib/project-operations.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

/**
 * Main projects command - handles all project management
 */
export default async function projects(subcommand?: string, args: string[] = []): Promise<void> {
	if (!subcommand || subcommand === "list") {
		return await listProjects(args);
	}

	switch (subcommand) {
		case "info":
			return await infoProject(args);
		case "cleanup":
			return await cleanupProjects();
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: list, info, cleanup");
			process.exit(1);
	}
}

/**
 * List all projects with status indicators
 */
async function listProjects(args: string[]): Promise<void> {
	// Parse flags
	const flags = {
		local: args.includes("--local"),
		deployed: args.includes("--deployed"),
		cloud: args.includes("--cloud"),
	};

	// Determine status for each project (with spinner for API calls)
	outputSpinner.start("Checking project status...");
	const statuses: ProjectStatus[] = await listAllProjects();
	outputSpinner.stop();

	if (statuses.length === 0) {
		info("No projects found");
		info("Create a project with: jack new <name>");
		return;
	}

	// Filter based on flags
	let filteredStatuses = statuses;
	if (flags.local) {
		filteredStatuses = filteredStatuses.filter((s) => s.local);
	}
	if (flags.deployed) {
		filteredStatuses = filteredStatuses.filter((s) => s.deployed);
	}
	if (flags.cloud) {
		filteredStatuses = filteredStatuses.filter((s) => s.backedUp);
	}

	if (filteredStatuses.length === 0) {
		info("No projects match the specified filters");
		return;
	}

	// Group projects by parent directory
	interface DirectoryGroup {
		path: string;
		projects: ProjectStatus[];
	}

	const groups = new Map<string, DirectoryGroup>();
	const ungrouped: ProjectStatus[] = [];
	const stale: ProjectStatus[] = [];

	for (const status of filteredStatuses) {
		// Stale projects go to their own section
		if (status.missing) {
			stale.push(status);
		} else if (status.localPath && status.local) {
			const parent = dirname(status.localPath);
			if (!groups.has(parent)) {
				groups.set(parent, { path: parent, projects: [] });
			}
			groups.get(parent)?.projects.push(status);
		} else {
			ungrouped.push(status);
		}
	}

	// Display grouped projects
	console.error("");
	info("Projects");
	console.error("");

	// Display directory groups (active local projects)
	for (const [_parentPath, group] of groups) {
		console.error(`${colors.dim}${group.path}/${colors.reset}`);
		const sortedProjects = group.projects.sort((a, b) => a.name.localeCompare(b.name));

		for (let i = 0; i < sortedProjects.length; i++) {
			const proj = sortedProjects[i];
			if (!proj) continue;
			const isLast = i === sortedProjects.length - 1;
			const prefix = isLast ? "└──" : "├──";

			const badges = buildStatusBadges(proj);
			console.error(`  ${colors.dim}${prefix}${colors.reset} ${proj.name}  ${badges}`);
		}
		console.error("");
	}

	// Display ungrouped projects (cloud-only, no local path)
	if (ungrouped.length > 0) {
		console.error(`${colors.dim}Cloud only:${colors.reset}`);
		for (const proj of ungrouped) {
			const badges = buildStatusBadges(proj);
			console.error(`  ${proj.name}  ${badges}`);
		}
		console.error("");
	}

	// Display stale projects (local folder deleted)
	if (stale.length > 0) {
		console.error(`${colors.yellow}Stale (local folder deleted):${colors.reset}`);
		for (const proj of stale) {
			// Only show non-missing badges since the section header explains the issue
			const badges = buildStatusBadges({ ...proj, missing: false });
			console.error(`  ${colors.dim}${proj.name}${colors.reset}  ${badges}`);
		}
		console.error("");
	}

	// Summary
	const deployedCount = statuses.filter((s) => s.deployed).length;
	const notDeployedCount = statuses.filter((s) => s.local && !s.deployed).length;
	const staleCount = statuses.filter((s) => s.missing).length;

	const parts = [`${deployedCount} deployed`];
	if (notDeployedCount > 0) {
		parts.push(`${notDeployedCount} not deployed`);
	}
	if (staleCount > 0) {
		parts.push(`${staleCount} stale`);
	}
	info(`${statuses.length} projects (${parts.join(", ")})`);
	if (staleCount > 0) {
		console.error(
			`  ${colors.dim}Run 'jack projects cleanup' to remove stale entries${colors.reset}`,
		);
	}
	console.error("");
}

// Color codes
const colors = {
	reset: "\x1b[0m",
	dim: "\x1b[90m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

/**
 * Build status badge string for a project
 */
function buildStatusBadges(status: ProjectStatus): string {
	const badges: string[] = [];

	if (status.local) {
		badges.push(`${colors.green}[local]${colors.reset}`);
	}
	if (status.deployed) {
		badges.push(`${colors.green}[deployed]${colors.reset}`);
	}
	if (status.backedUp) {
		badges.push(`${colors.dim}[cloud]${colors.reset}`);
	}
	if (status.missing) {
		badges.push(`${colors.yellow}[local deleted]${colors.reset}`);
	}

	return badges.join(" ");
}

/**
 * Show detailed project info
 */
async function infoProject(args: string[]): Promise<void> {
	let name = args[0];

	// If no name provided, try to get from cwd
	if (!name) {
		try {
			name = await getProjectNameFromDir(process.cwd());
		} catch {
			error("Project name required");
			info("Usage: jack projects info <name>");
			info("Or run from a project directory");
			process.exit(1);
		}
	}

	// Check actual status (with spinner for API calls)
	outputSpinner.start("Fetching project info...");
	const status = await getProjectStatus(name);
	outputSpinner.stop();

	if (!status) {
		error(`Project "${name}" not found in registry`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	console.error("");
	info(`Project: ${status.name}`);
	console.error("");

	// Status section
	const statuses: string[] = [];
	if (status.local) {
		statuses.push("local");
	}
	if (status.deployed) {
		statuses.push("deployed");
	}
	if (status.backedUp) {
		statuses.push("backed-up");
	}
	if (status.missing) {
		statuses.push("missing");
	}

	item(`Status: ${statuses.join(", ") || "none"}`);
	console.error("");

	// Local info
	if (status.localPath) {
		item(`Local path: ${status.localPath}`);
		if (status.missing) {
			warn("  Path no longer exists");
		}
		console.error("");
	}

	// Deployment info
	if (status.workerUrl) {
		item(`Worker URL: ${status.workerUrl}`);
	}
	if (status.lastDeployed) {
		item(`Last deployed: ${new Date(status.lastDeployed).toLocaleString()}`);
	}
	if (status.deployed) {
		console.error("");
	}

	// Cloud info
	if (status.backedUp && status.backupFiles !== null) {
		item(`Cloud backup: ${status.backupFiles} files`);
		if (status.backupLastSync) {
			item(`Last synced: ${new Date(status.backupLastSync).toLocaleString()}`);
		}
		console.error("");
	}

	// Account info
	if (status.accountId) {
		item(`Account ID: ${status.accountId}`);
	}
	if (status.workerId) {
		item(`Worker ID: ${status.workerId}`);
	}
	console.error("");

	// Resources
	if (status.dbName) {
		item(`Database: ${status.dbName}`);
		console.error("");
	}

	// Timestamps
	if (status.createdAt) {
		item(`Created: ${new Date(status.createdAt).toLocaleString()}`);
	}
	console.error("");
}

/**
 * Remove stale registry entries
 */
async function cleanupProjects(): Promise<void> {
	outputSpinner.start("Scanning for stale projects...");

	const scan = await scanStaleProjects();
	if (scan.total === 0) {
		outputSpinner.stop();
		info("No projects to clean up");
		return;
	}

	outputSpinner.stop();

	if (scan.stale.length === 0) {
		success("No stale projects found");
		return;
	}

	// Explain what cleanup does
	console.error("");
	info("What cleanup does:");
	item("Removes entries from jack's local tracking registry");
	item("Does NOT undeploy live services");
	item("Does NOT delete cloud backups or databases");
	console.error("");

	// Show found issues
	warn(`Found ${scan.stale.length} stale project(s):`);
	console.error("");

	// Check which have deployed workers
	const deployedStale = scan.stale.filter((stale) => stale.workerUrl);

	for (const stale of scan.stale) {
		const hasWorker = stale.workerUrl
			? ` ${colors.yellow}(still deployed)${colors.reset}`
			: "";
		item(`${stale.name}: ${stale.reason}${hasWorker}`);
	}
	console.error("");

	if (deployedStale.length > 0) {
		warn(`${deployedStale.length} project(s) are still deployed`);
		info("To fully remove, run 'jack down <name>' first");
		console.error("");
	}

	// Prompt to remove
	console.error("  Esc to skip\n");
	const action = await select({
		message: "Remove these from jack's tracking? (deployed services stay live)",
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (action === "no") {
		info("Cleanup cancelled");
		return;
	}

	// Remove stale entries
	await cleanupStaleProjects(scan.stale.map((stale) => stale.name));

	console.error("");
	success(`Removed ${scan.stale.length} entry/entries from jack's registry`);
	if (deployedStale.length > 0) {
		info("Note: Deployed services are still live");
	}
}

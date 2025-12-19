import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { select } from "@inquirer/prompts";
import { checkWorkerExists } from "../lib/cloudflare-api.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import { getAllProjects, getProject, removeProject } from "../lib/registry.ts";
import { getProjectNameFromDir, getRemoteManifest } from "../lib/storage/index.ts";

interface ProjectStatus {
	name: string;
	localPath: string | null;
	local: boolean;
	deployed: boolean;
	backedUp: boolean;
	missing: boolean;
}

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

	const projects = await getAllProjects();
	const projectNames = Object.keys(projects);

	if (projectNames.length === 0) {
		info("No projects found");
		info("Create a project with: jack new <name>");
		return;
	}

	// Determine status for each project (with spinner for API calls)
	outputSpinner.start("Checking project status...");

	const statuses: ProjectStatus[] = await Promise.all(
		projectNames.map(async (name) => {
			const project = projects[name];
			if (!project) {
				return null;
			}

			const local = project.localPath ? existsSync(project.localPath) : false;
			const missing = project.localPath ? !local : false;

			// Check if deployed (use cached URL or check API)
			let deployed = false;
			if (project.workerUrl) {
				deployed = true;
			} else {
				deployed = await checkWorkerExists(name);
			}

			// Check if backed up
			const manifest = await getRemoteManifest(name);
			const backedUp = manifest !== null;

			return {
				name,
				localPath: project.localPath,
				local,
				deployed,
				backedUp,
				missing,
			};
		}),
	).then((results) => results.filter((s): s is ProjectStatus => s !== null));

	outputSpinner.stop();

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

	const project = await getProject(name);

	if (!project) {
		error(`Project "${name}" not found in registry`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	// Check actual status (with spinner for API calls)
	outputSpinner.start("Fetching project info...");
	const localExists = project.localPath ? existsSync(project.localPath) : false;
	const [workerExists, manifest] = await Promise.all([
		checkWorkerExists(name),
		getRemoteManifest(name),
	]);
	const backedUp = manifest !== null;
	outputSpinner.stop();

	console.error("");
	info(`Project: ${name}`);
	console.error("");

	// Status section
	const statuses: string[] = [];
	if (localExists) {
		statuses.push("local");
	}
	if (workerExists || project.workerUrl) {
		statuses.push("deployed");
	}
	if (backedUp) {
		statuses.push("backed-up");
	}
	if (project.localPath && !localExists) {
		statuses.push("missing");
	}

	item(`Status: ${statuses.join(", ") || "none"}`);
	console.error("");

	// Local info
	if (project.localPath) {
		item(`Local path: ${project.localPath}`);
		if (!localExists) {
			warn("  Path no longer exists");
		}
		console.error("");
	}

	// Deployment info
	if (project.workerUrl) {
		item(`Worker URL: ${project.workerUrl}`);
	}
	if (project.lastDeployed) {
		item(`Last deployed: ${new Date(project.lastDeployed).toLocaleString()}`);
	}
	if (workerExists || project.workerUrl) {
		console.error("");
	}

	// Cloud info
	if (backedUp && manifest) {
		item(`Cloud backup: ${manifest.files.length} files`);
		item(`Last synced: ${new Date(manifest.lastSync).toLocaleString()}`);
		console.error("");
	}

	// Account info
	item(`Account ID: ${project.cloudflare.accountId}`);
	item(`Worker ID: ${project.cloudflare.workerId}`);
	console.error("");

	// Resources
	if (project.resources.d1Databases.length > 0) {
		item("Databases:");
		for (const db of project.resources.d1Databases) {
			item(`  - ${db}`);
		}
		console.error("");
	}

	// Timestamps
	item(`Created: ${new Date(project.createdAt).toLocaleString()}`);
	console.error("");
}

/**
 * Remove stale registry entries
 */
async function cleanupProjects(): Promise<void> {
	outputSpinner.start("Scanning for stale projects...");

	const projects = await getAllProjects();
	const projectNames = Object.keys(projects);

	if (projectNames.length === 0) {
		outputSpinner.stop();
		info("No projects to clean up");
		return;
	}

	interface StaleProject {
		name: string;
		reason: string;
	}

	const staleProjects: StaleProject[] = [];

	// Check each project for issues
	for (const name of projectNames) {
		const project = projects[name];
		if (!project) continue;

		// Check if local folder was deleted
		if (project.localPath && !existsSync(project.localPath)) {
			staleProjects.push({
				name,
				reason: "local folder deleted",
			});
			continue;
		}

		// Check if service was undeployed externally
		const workerExists = await checkWorkerExists(name);
		if (project.workerUrl && !workerExists) {
			staleProjects.push({
				name,
				reason: "undeployed from cloud",
			});
		}
	}

	outputSpinner.stop();

	if (staleProjects.length === 0) {
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
	warn(`Found ${staleProjects.length} stale project(s):`);
	console.error("");

	// Check which have deployed workers
	const deployedStale = staleProjects.filter((s) => {
		const proj = projects[s.name];
		return proj?.workerUrl;
	});

	for (const stale of staleProjects) {
		const proj = projects[stale.name];
		const hasWorker = proj?.workerUrl ? ` ${colors.yellow}(still deployed)${colors.reset}` : "";
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
	for (const stale of staleProjects) {
		await removeProject(stale.name);
	}

	console.error("");
	success(`Removed ${staleProjects.length} entry/entries from jack's registry`);
	if (deployedStale.length > 0) {
		info("Note: Deployed services are still live");
	}
}

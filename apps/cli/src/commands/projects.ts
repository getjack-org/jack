import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promptSelect } from "../lib/hooks.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import {
	cleanupStaleProjects,
	getProjectStatus,
	scanStaleProjects,
} from "../lib/project-operations.ts";
import {
	type ResolvedProject,
	listAllProjects,
	removeProject as removeProjectEverywhere,
	resolveProject,
} from "../lib/project-resolver.ts";
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
		case "remove":
			return await removeProjectEntry(args);
		case "cleanup":
			return await cleanupProjects();
		case "scan":
			return await scanProjects(args);
		case "down":
			return await handleDown(args);
		default: {
			// Commands that are valid top-level commands users might try under projects
			const topLevelCommands = ["open", "logs", "clone", "sync"];
			const isTopLevel = topLevelCommands.includes(subcommand);

			error(`Unknown subcommand: ${subcommand}`);
			if (isTopLevel) {
				const projectArg = args[0] ? ` ${args[0]}` : "";
				info(`Did you mean: jack ${subcommand}${projectArg}`);
			}
			info("Available: list, info, remove, cleanup, scan, down");
			process.exit(1);
		}
	}
}

/**
 * List all projects with status indicators
 */
async function listProjects(_args: string[]): Promise<void> {
	// Fetch all projects from registry and control plane
	outputSpinner.start("Checking project status...");
	const projects: ResolvedProject[] = await listAllProjects();
	outputSpinner.stop();

	if (projects.length === 0) {
		info("No projects found");
		info("Create a project with: jack new <name>");
		return;
	}

	// Separate local projects from cloud-only projects
	const localProjects: ResolvedProject[] = [];
	const cloudOnlyProjects: ResolvedProject[] = [];

	for (const proj of projects) {
		if (proj.localPath && proj.sources.filesystem) {
			localProjects.push(proj);
		} else {
			cloudOnlyProjects.push(proj);
		}
	}

	// Group local projects by parent directory
	interface DirectoryGroup {
		displayPath: string;
		projects: ResolvedProject[];
	}

	const groups = new Map<string, DirectoryGroup>();
	const home = homedir();

	for (const proj of localProjects) {
		if (!proj.localPath) continue;
		const parent = dirname(proj.localPath);
		if (!groups.has(parent)) {
			// Replace home directory with ~ for display
			const displayPath = parent.startsWith(home) ? `~${parent.slice(home.length)}` : parent;
			groups.set(parent, { displayPath, projects: [] });
		}
		groups.get(parent)?.projects.push(proj);
	}

	// Display header
	console.error("");
	info("Your projects");
	console.error("");

	// Display local project groups
	for (const [_parentPath, group] of groups) {
		console.error(`  ${colors.dim}${group.displayPath}/${colors.reset}`);
		const sortedProjects = group.projects.sort((a, b) => a.name.localeCompare(b.name));

		for (let i = 0; i < sortedProjects.length; i++) {
			const proj = sortedProjects[i];
			if (!proj) continue;
			const isLast = i === sortedProjects.length - 1;
			const prefix = isLast ? "└──" : "├──";

			const statusBadge = buildStatusBadge(proj);
			console.error(`  ${colors.dim}${prefix}${colors.reset} ${proj.name}  ${statusBadge}`);
		}
		console.error("");
	}

	// Display cloud-only projects
	if (cloudOnlyProjects.length > 0) {
		console.error(`  ${colors.dim}On jack cloud (no local files)${colors.reset}`);
		const sortedCloudProjects = cloudOnlyProjects.sort((a, b) => a.name.localeCompare(b.name));

		for (let i = 0; i < sortedCloudProjects.length; i++) {
			const proj = sortedCloudProjects[i];
			if (!proj) continue;
			const isLast = i === sortedCloudProjects.length - 1;
			const prefix = isLast ? "└──" : "├──";

			const statusBadge = buildStatusBadge(proj);
			console.error(`  ${colors.dim}${prefix}${colors.reset} ${proj.name}  ${statusBadge}`);
		}
		console.error("");
	}

	// Summary
	const liveCount = projects.filter((p) => p.status === "live").length;
	const localOnlyCount = projects.filter((p) => p.status === "local-only").length;
	const errorCount = projects.filter((p) => p.status === "error").length;

	const parts: string[] = [];
	if (liveCount > 0) parts.push(`${liveCount} live`);
	if (localOnlyCount > 0) parts.push(`${localOnlyCount} local-only`);
	if (errorCount > 0) parts.push(`${errorCount} error`);

	const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	info(`${projects.length} projects${summary}`);
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
 * Build a user-friendly status badge for a project
 */
function buildStatusBadge(project: ResolvedProject): string {
	switch (project.status) {
		case "live":
			return `${colors.green}[live]${colors.reset} ${colors.cyan}${project.url || ""}${colors.reset}`;
		case "local-only":
			return `${colors.dim}[local only]${colors.reset}`;
		case "error":
			return `${colors.red}[error]${colors.reset} ${project.errorMessage || "deployment failed"}`;
		case "syncing":
			return `${colors.yellow}[syncing]${colors.reset}`;
		default:
			return "";
	}
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
		statuses.push("backup");
	}

	item(`Status: ${statuses.join(", ") || "none"}`);
	console.error("");

	// Workspace info (only shown if running from project directory)
	if (status.localPath) {
		item(`Workspace path: ${status.localPath}`);
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

	// Backup info
	if (status.backedUp && status.backupFiles !== null) {
		item(`Backup: ${status.backupFiles} files`);
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
 * Find and remove stale registry entries (projects with URLs but no deployed worker)
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
	item("Does NOT delete backups or databases");
	info("Remove a single entry with: jack projects remove <name>");
	console.error("");

	// Show found issues
	warn(`Found ${scan.stale.length} stale project(s):`);
	console.error("");

	for (const stale of scan.stale) {
		item(`${stale.name}: ${stale.reason} (URL: ${stale.workerUrl})`);
	}
	console.error("");

	// Prompt to remove
	info("Remove these from jack's tracking?");
	const choice = await promptSelect(["Yes", "No"]);

	if (choice !== 0) {
		info("Cleanup cancelled");
		return;
	}

	// Remove stale entries
	await cleanupStaleProjects(scan.stale.map((stale) => stale.name));

	console.error("");
	success(`Removed ${scan.stale.length} entry/entries from jack's registry`);
}

/**
 * Remove a project from registry and jack cloud
 */
async function removeProjectEntry(args: string[]): Promise<void> {
	const name = args.find((arg) => !arg.startsWith("--"));
	const yes = args.includes("--yes");

	if (!name) {
		error("Project name required");
		info("Usage: jack projects remove <name>");
		process.exit(1);
	}

	// Use resolver to find project anywhere (registry OR control plane)
	outputSpinner.start("Checking project status...");
	const project = await resolveProject(name);
	outputSpinner.stop();

	if (!project) {
		error(`Project "${name}" not found`);
		info("Check available projects with: jack projects");
		process.exit(1);
	}

	// Show what we found and where
	console.error("");
	info(`Removing "${name}"...`);
	console.error("");

	// Show project details
	if (project.localPath) {
		item(`Workspace: ${project.localPath}`);
	}
	if (project.url) {
		item(`URL: ${project.url}`);
	}

	// Show where we'll remove from
	const locations: string[] = [];
	if (project.sources.filesystem) {
		locations.push("local project");
	}
	if (project.sources.controlPlane) {
		locations.push("jack cloud");
	}
	if (locations.length > 0) {
		item(`Will remove from: ${locations.join(", ")}`);
	}

	// Warn if still deployed
	if (project.status === "live") {
		console.error("");
		warn("Project is still deployed; removal does not undeploy the worker");
	}

	console.error("");

	if (!yes) {
		info("Remove this project?");
		const choice = await promptSelect(["Yes", "No"]);

		if (choice !== 0) {
			info("Removal cancelled");
			return;
		}
	}

	// Use resolver's removeProject to clean up everywhere
	outputSpinner.start("Removing project...");
	const result = await removeProjectEverywhere(name);
	outputSpinner.stop();

	console.error("");

	// Show what was removed
	if (result.removed.length > 0) {
		for (const location of result.removed) {
			success(`Removed from ${location}`);
		}
	}

	// Show any errors
	if (result.errors.length > 0) {
		for (const err of result.errors) {
			warn(err);
		}
	}

	// Final status
	if (result.removed.length > 0 && result.errors.length === 0) {
		console.error("");
		success(`Project "${name}" removed`);
	} else if (result.removed.length === 0) {
		console.error("");
		error(`Failed to remove "${name}"`);
	}

	// Hint about undeploying
	if (project.status === "live") {
		console.error("");
		info(`To undeploy the worker, run: jack down ${name}`);
	}
}

/**
 * Scan a directory for jack projects and register them
 */
async function scanProjects(args: string[]): Promise<void> {
	const targetDir = args[0] || process.cwd();
	const absoluteDir = resolve(targetDir);

	if (!existsSync(absoluteDir)) {
		error(`Directory not found: ${targetDir}`);
		process.exit(1);
	}

	outputSpinner.start(`Scanning ${targetDir} for jack projects...`);

	const { scanDirectoryForProjects, registerDiscoveredProjects } = await import(
		"../lib/local-paths.ts"
	);

	const discovered = await scanDirectoryForProjects(absoluteDir);
	outputSpinner.stop();

	if (discovered.length === 0) {
		info("No jack projects found");
		info("Projects must have a wrangler.toml or wrangler.jsonc file");
		return;
	}

	console.error("");
	info(`Found ${discovered.length} project(s):`);

	const home = homedir();
	for (let i = 0; i < discovered.length; i++) {
		const proj = discovered[i];
		if (!proj) continue;
		const displayPath = proj.path.startsWith(home) ? `~${proj.path.slice(home.length)}` : proj.path;
		const isLast = i === discovered.length - 1;
		const prefix = isLast ? "└──" : "├──";
		console.error(
			`  ${colors.dim}${prefix}${colors.reset} ${proj.name}  ${colors.dim}${displayPath}${colors.reset}`,
		);
	}

	// Register all discovered projects
	await registerDiscoveredProjects(discovered);

	console.error("");
	success(`Registered ${discovered.length} local path(s)`);
}

/**
 * Handle down subcommand - routes to top-level down command
 */
async function handleDown(args: string[]): Promise<void> {
	const { default: down } = await import("./down.ts");
	const projectName = args.find((arg) => !arg.startsWith("--"));
	const force = args.includes("--force");
	return await down(projectName, { force });
}

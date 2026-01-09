import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promptSelect } from "../lib/hooks.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import {
	type ProjectListItem,
	STATUS_ICONS,
	colors,
	filterByStatus,
	formatCloudSection,
	formatErrorSection,
	formatLocalSection,
	groupProjects,
	sortByUpdated,
	toListItems,
} from "../lib/project-list.ts";
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
 * Extract a flag value from args (e.g., --status live -> "live")
 */
function extractFlagValue(args: string[], flag: string): string | null {
	const idx = args.indexOf(flag);
	if (idx !== -1 && idx + 1 < args.length) {
		return args[idx + 1] ?? null;
	}
	return null;
}

/**
 * List all projects with status indicators
 */
async function listProjects(args: string[]): Promise<void> {
	// Parse flags
	const showAll = args.includes("--all") || args.includes("-a");
	const statusFilter = extractFlagValue(args, "--status");
	const jsonOutput = args.includes("--json");
	const localOnly = args.includes("--local");
	const cloudOnly = args.includes("--cloud");

	// Fetch all projects from registry and control plane
	outputSpinner.start("Checking project status...");
	const projects: ResolvedProject[] = await listAllProjects();
	outputSpinner.stop();

	// Convert to list items
	let items = toListItems(projects);

	// Apply filters
	if (statusFilter) items = filterByStatus(items, statusFilter);
	if (localOnly) items = items.filter((i) => i.isLocal);
	if (cloudOnly) items = items.filter((i) => i.isCloudOnly);

	// Handle empty state
	if (items.length === 0) {
		if (jsonOutput) {
			console.log("[]");
			return;
		}
		info("No projects found");
		if (statusFilter || localOnly || cloudOnly) {
			info("Try removing filters to see all projects");
		} else {
			info("Create a project with: jack new <name>");
		}
		return;
	}

	// JSON output to stdout (pipeable)
	if (jsonOutput) {
		console.log(JSON.stringify(items, null, 2));
		return;
	}

	// Flat table for --all mode
	if (showAll) {
		renderFlatTable(items);
		return;
	}

	// Default: grouped view
	renderGroupedView(items);
}

/**
 * Render the grouped view (default)
 */
function renderGroupedView(items: ProjectListItem[]): void {
	const groups = groupProjects(items);
	const total = items.length;

	console.error("");
	info(`${total} projects`);

	// Section 1: Errors (always show all)
	if (groups.errors.length > 0) {
		console.error("");
		console.error(formatErrorSection(groups.errors));
	}

	// Section 2: Local projects (grouped by parent dir)
	if (groups.local.length > 0) {
		console.error("");
		console.error(
			`  ${colors.dim}${STATUS_ICONS["local-only"]} Local (${groups.local.length})${colors.reset}`,
		);
		console.error(formatLocalSection(groups.local));
	}

	// Section 3: Cloud-only (show last N by updatedAt)
	if (groups.cloudOnly.length > 0) {
		const CLOUD_LIMIT = 5;
		const sorted = sortByUpdated(groups.cloudOnly);

		console.error("");
		console.error(
			formatCloudSection(sorted, { limit: CLOUD_LIMIT, total: groups.cloudOnly.length }),
		);
	}

	// Footer hint
	console.error("");
	info("jack ls --all for full list, --status error to filter");
	console.error("");
}

/**
 * Render flat table (for --all mode)
 */
function renderFlatTable(items: ProjectListItem[]): void {
	// Sort: errors first, then by name
	const sorted = [...items].sort((a, b) => {
		if (a.status === "error" && b.status !== "error") return -1;
		if (a.status !== "error" && b.status === "error") return 1;
		return a.name.localeCompare(b.name);
	});

	console.error("");
	info(`${items.length} projects`);
	console.error("");

	// Header
	console.error(`  ${colors.dim}${"NAME".padEnd(22)} ${"STATUS".padEnd(12)} URL${colors.reset}`);

	// Rows
	for (const item of sorted) {
		const icon = STATUS_ICONS[item.status] || "?";
		const statusColor =
			item.status === "error"
				? colors.red
				: item.status === "live"
					? colors.green
					: item.status === "syncing"
						? colors.yellow
						: colors.dim;

		const name = item.name.slice(0, 20).padEnd(22);
		const status = item.status.padEnd(12);
		const url = item.url ? item.url.replace("https://", "") : "\u2014"; // em-dash

		console.error(
			`  ${statusColor}${icon}${colors.reset} ${name} ${statusColor}${status}${colors.reset} ${url}`,
		);
	}

	console.error("");
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

	const { scanAndRegisterProjects } = await import("../lib/paths-index.ts");

	// scanAndRegisterProjects both discovers and registers projects
	const discovered = await scanAndRegisterProjects(absoluteDir);
	outputSpinner.stop();

	if (discovered.length === 0) {
		info("No linked jack projects found");
		info("Projects must have a .jack/project.json file");
		return;
	}

	console.error("");
	info(`Found ${discovered.length} project(s):`);

	const home = homedir();
	for (let i = 0; i < discovered.length; i++) {
		const proj = discovered[i];
		if (!proj) continue;
		// Extract project name from path
		const projectName = proj.path.split("/").pop() || proj.projectId;
		const displayPath = proj.path.startsWith(home) ? `~${proj.path.slice(home.length)}` : proj.path;
		const isLast = i === discovered.length - 1;
		const prefix = isLast ? "└──" : "├──";
		console.error(
			`  ${colors.dim}${prefix}${colors.reset} ${projectName}  ${colors.dim}${displayPath}${colors.reset}`,
		);
	}

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

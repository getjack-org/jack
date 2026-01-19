import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promptSelect } from "../lib/hooks.ts";
import { error, info, item, output as outputSpinner, success, warn } from "../lib/output.ts";
import {
	type ProjectListItem,
	STATUS_ICONS,
	buildTagColorMap,
	colors,
	filterByStatus,
	filterByTag,
	formatCloudSection,
	formatErrorSection,
	formatLocalSection,
	formatTagsInline,
	groupProjects,
	sortByUpdated,
	toListItems,
} from "../lib/project-list.ts";
import { cleanupStaleProjects, scanStaleProjects } from "../lib/project-operations.ts";
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
 * Extract multiple flag values from args (e.g., --tag api --tag prod -> ["api", "prod"])
 */
function extractFlagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) {
			const value = args[i + 1];
			if (value) values.push(value);
		}
	}
	return values;
}

/**
 * List all projects with status indicators
 */
async function listProjects(args: string[]): Promise<void> {
	// Parse flags
	const showAll = args.includes("--all") || args.includes("-a");
	const statusFilter = extractFlagValue(args, "--status");
	const tagFilters = extractFlagValues(args, "--tag");
	const jsonOutput = args.includes("--json");
	const localOnly = args.includes("--local");
	const cloudOnly = args.includes("--cloud");

	// Fetch all projects from registry and control plane
	outputSpinner.start("Loading projects...");
	const projects: ResolvedProject[] = await listAllProjects();
	outputSpinner.stop();

	// Convert to list items
	let items = toListItems(projects);

	// Apply filters
	if (statusFilter) items = filterByStatus(items, statusFilter);
	if (localOnly) items = items.filter((i) => i.isLocal);
	if (cloudOnly) items = items.filter((i) => i.isCloudOnly);
	if (tagFilters.length > 0) items = filterByTag(items, tagFilters);

	// Handle empty state
	if (items.length === 0) {
		if (jsonOutput) {
			console.log("[]");
			return;
		}
		info("No projects found");
		if (statusFilter || localOnly || cloudOnly || tagFilters.length > 0) {
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
	const CLOUD_LIMIT = 5;

	// Build consistent tag color map across all projects
	const tagColorMap = buildTagColorMap(items);

	console.error("");
	info(`${total} projects`);

	// Section 1: Errors (always show all)
	if (groups.errors.length > 0) {
		console.error("");
		console.error(formatErrorSection(groups.errors, { tagColorMap }));
	}

	// Section 2: Local projects (grouped by parent dir)
	if (groups.local.length > 0) {
		console.error("");
		console.error(
			`  ${colors.dim}${STATUS_ICONS["local-only"]} Local (${groups.local.length})${colors.reset}`,
		);
		console.error(formatLocalSection(groups.local, { tagColorMap }));
	}

	// Section 3: Cloud-only (show last N by updatedAt)
	if (groups.cloudOnly.length > 0) {
		const sorted = sortByUpdated(groups.cloudOnly);

		console.error("");
		console.error(
			formatCloudSection(sorted, {
				limit: CLOUD_LIMIT,
				total: groups.cloudOnly.length,
				tagColorMap,
			}),
		);
	}

	// Footer hint - only show --all hint if there are hidden cloud projects
	console.error("");
	const hasHiddenCloudProjects = groups.cloudOnly.length > CLOUD_LIMIT;
	if (hasHiddenCloudProjects) {
		info(`jack ls --all to see all ${groups.cloudOnly.length} cloud projects`);
	} else {
		info("jack ls --status error to filter, --json for machine output");
	}
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

	// Build consistent tag color map
	const tagColorMap = buildTagColorMap(items);

	console.error("");
	info(`${items.length} projects`);
	console.error("");

	// Header
	console.error(`  ${colors.dim}${"NAME".padEnd(22)} ${"STATUS".padEnd(12)} URL${colors.reset}`);

	// Rows
	for (const item of sorted) {
		const icon = STATUS_ICONS[item.status] || "?";
		const statusColor =
			item.status === "error" || item.status === "auth-expired"
				? colors.red
				: item.status === "live"
					? colors.green
					: item.status === "syncing"
						? colors.yellow
						: colors.dim;

		const name = item.name.slice(0, 20).padEnd(22);
		const tags = formatTagsInline(item.tags, tagColorMap);
		const status = item.status.padEnd(12);
		const url = item.url ? item.url.replace("https://", "") : "\u2014"; // em-dash

		console.error(
			`  ${statusColor}${icon}${colors.reset} ${name}${tags ? ` ${tags}` : ""} ${statusColor}${status}${colors.reset} ${url}`,
		);
	}

	console.error("");
}

/**
 * Show detailed project info
 */
async function infoProject(args: string[]): Promise<void> {
	const hasExplicitName = Boolean(args[0]);
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

	// Resolve project using the same pattern as down.ts
	outputSpinner.start("Fetching project info...");
	const resolved = await resolveProject(name, {
		preferLocalLink: !hasExplicitName,
		includeResources: true,
	});
	outputSpinner.stop();

	// Guard against mismatched resolutions when an explicit name is provided
	if (hasExplicitName && resolved) {
		const matches =
			name === resolved.slug || name === resolved.name || name === resolved.remote?.projectId;
		if (!matches) {
			error(`Project '${name}' resolves to '${resolved.slug}'.`);
			info("Use the exact slug/name and try again.");
			process.exit(1);
		}
	}

	if (!resolved) {
		error(`Project "${name}" not found`);
		info("List projects with: jack projects list");
		process.exit(1);
	}

	console.error("");
	info(`Project: ${resolved.name}`);
	console.error("");

	// Status section
	const statuses: string[] = [];
	if (resolved.sources.filesystem) {
		statuses.push("local");
	}
	if (resolved.status === "live") {
		statuses.push("deployed");
	}

	item(`Status: ${statuses.join(", ") || "none"}`);
	console.error("");

	// Workspace info (only shown if running from project directory)
	if (resolved.localPath) {
		item(`Workspace path: ${resolved.localPath}`);
		console.error("");
	}

	// Deployment info
	if (resolved.url) {
		item(`Worker URL: ${resolved.url}`);
	}
	if (resolved.updatedAt) {
		item(`Last deployed: ${new Date(resolved.updatedAt).toLocaleString()}`);
	}
	if (resolved.status === "live") {
		console.error("");
	}

	// Account info
	if (resolved.remote?.orgId) {
		item(`Account ID: ${resolved.remote.orgId}`);
	}
	if (resolved.slug) {
		item(`Worker ID: ${resolved.slug}`);
	}
	console.error("");

	// Resources
	if (resolved.resources?.d1?.name) {
		item(`Database: ${resolved.resources.d1.name}`);
		console.error("");
	}

	// Timestamps
	if (resolved.createdAt) {
		item(`Created: ${new Date(resolved.createdAt).toLocaleString()}`);
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
	outputSpinner.start("Finding project...");
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
		warn("Project is still live; this only removes it from jack, not from Cloudflare");
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
		info(`To take it offline: jack down ${name}`);
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

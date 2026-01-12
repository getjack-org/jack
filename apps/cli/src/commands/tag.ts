/**
 * jack tag - Manage project tags
 *
 * Usage:
 *   jack tag add <tags...>              Add tags to current project
 *   jack tag add <project> <tags...>    Add tags to named project
 *   jack tag remove <tags...>           Remove tags from current project
 *   jack tag remove <project> <tags...> Remove tags from named project
 *   jack tag list                       List all tags across projects
 *   jack tag list [project]             List tags for a specific project
 */

import { error, info, item, success } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import {
	addTags,
	findProjectPathByName,
	getAllTagsWithCounts,
	getProjectTags,
	removeTags,
	validateTags,
} from "../lib/tags.ts";

export default async function tag(subcommand?: string, args: string[] = []): Promise<void> {
	if (!subcommand) {
		showHelp();
		return;
	}

	switch (subcommand) {
		case "add":
			return await addTagsCommand(args);
		case "remove":
			return await removeTagsCommand(args);
		case "list":
			return await listTagsCommand(args);
		case "--help":
		case "-h":
		case "help":
			showHelp();
			return;
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: add, remove, list");
			process.exit(1);
	}
}

/**
 * Show help for the tag command
 */
function showHelp(): void {
	console.error(`
  jack tag - Manage project tags

  Usage
    $ jack tag add <tags...>              Add tags to current project
    $ jack tag add <project> <tags...>    Add tags to named project
    $ jack tag remove <tags...>           Remove tags from current project
    $ jack tag remove <project> <tags...> Remove tags from named project
    $ jack tag list                       List all tags across projects
    $ jack tag list [project]             List tags for a specific project

  Tag Format
    Tags must be lowercase alphanumeric with optional colons and hyphens.
    Examples: backend, api:v2, my-service, prod

  Examples
    $ jack tag add backend api          Add tags in project directory
    $ jack tag add my-app backend       Add tag to my-app project
    $ jack tag remove deprecated        Remove tag from current project
    $ jack tag list                     Show all tags with counts
    $ jack tag list my-app              Show tags for my-app
`);
}

/**
 * Resolve project path from arguments
 * Returns [projectPath, remainingArgs]
 *
 * Logic:
 * 1. If in a linked project directory, use cwd and all args are tags
 * 2. If not in project directory, first arg might be project name
 */
async function resolveProjectAndTags(args: string[]): Promise<[string | null, string[]]> {
	const cwd = process.cwd();

	// Check if we're in a linked project directory
	const link = await readProjectLink(cwd);

	if (link) {
		// In a project directory - all args are tags
		return [cwd, args];
	}

	// Not in a project directory - first arg might be project name
	if (args.length === 0) {
		return [null, []];
	}

	const firstArg = args[0] as string; // Safe: we checked args.length > 0 above
	const rest = args.slice(1);

	// Try to find project by name
	const projectPath = await findProjectPathByName(firstArg);

	if (projectPath) {
		// First arg was a project name
		return [projectPath, rest];
	}

	// First arg wasn't a project name - we're not in a project directory
	// and couldn't find a matching project
	return [null, args];
}

/**
 * Add tags to a project
 */
async function addTagsCommand(args: string[]): Promise<void> {
	const [projectPath, tagArgs] = await resolveProjectAndTags(args);

	if (!projectPath) {
		error("Not in a project directory and no valid project name provided");
		info("Run from a project directory or specify project name: jack tag add <project> <tags...>");
		process.exit(1);
	}

	if (tagArgs.length === 0) {
		error("No tags specified");
		info("Usage: jack tag add <tags...>");
		process.exit(1);
	}

	// Validate tags first
	const validation = validateTags(tagArgs);
	if (!validation.valid) {
		error("Invalid tags:");
		for (const { tag, reason } of validation.invalidTags) {
			item(`"${tag}": ${reason}`);
		}
		process.exit(1);
	}

	const result = await addTags(projectPath, tagArgs);

	if (!result.success) {
		error(result.error || "Failed to add tags");
		process.exit(1);
	}

	if (result.added && result.added.length > 0) {
		success(`Added tags: ${result.added.join(", ")}`);
	}

	if (result.skipped && result.skipped.length > 0) {
		info(`Already present: ${result.skipped.join(", ")}`);
	}

	if (result.tags.length > 0) {
		info(`Current tags: ${result.tags.join(", ")}`);
	}
}

/**
 * Remove tags from a project
 */
async function removeTagsCommand(args: string[]): Promise<void> {
	const [projectPath, tagArgs] = await resolveProjectAndTags(args);

	if (!projectPath) {
		error("Not in a project directory and no valid project name provided");
		info(
			"Run from a project directory or specify project name: jack tag remove <project> <tags...>",
		);
		process.exit(1);
	}

	if (tagArgs.length === 0) {
		error("No tags specified");
		info("Usage: jack tag remove <tags...>");
		process.exit(1);
	}

	const result = await removeTags(projectPath, tagArgs);

	if (!result.success) {
		error(result.error || "Failed to remove tags");
		process.exit(1);
	}

	if (result.removed && result.removed.length > 0) {
		success(`Removed tags: ${result.removed.join(", ")}`);
	}

	if (result.skipped && result.skipped.length > 0) {
		info(`Not found: ${result.skipped.join(", ")}`);
	}

	if (result.tags.length > 0) {
		info(`Remaining tags: ${result.tags.join(", ")}`);
	} else {
		info("No tags remaining");
	}
}

/**
 * List tags for a project or all tags across projects
 */
async function listTagsCommand(args: string[]): Promise<void> {
	const [projectArg] = args;

	if (projectArg) {
		// List tags for a specific project
		await listProjectTags(projectArg);
	} else {
		// Check if we're in a project directory
		const cwd = process.cwd();
		const link = await readProjectLink(cwd);

		if (link) {
			// In a project directory - show tags for this project
			await listProjectTagsForPath(cwd);
		} else {
			// Not in project directory - show all tags
			await listAllTags();
		}
	}
}

/**
 * List tags for a specific project by name
 */
async function listProjectTags(projectName: string): Promise<void> {
	const projectPath = await findProjectPathByName(projectName);

	if (!projectPath) {
		error(`Project not found: ${projectName}`);
		process.exit(1);
	}

	await listProjectTagsForPath(projectPath);
}

/**
 * List tags for a project at a specific path
 */
async function listProjectTagsForPath(projectPath: string): Promise<void> {
	const tags = await getProjectTags(projectPath);

	console.error("");
	if (tags.length === 0) {
		info("No tags for this project");
		info("Add tags with: jack tag add <tags...>");
	} else {
		info(`Tags (${tags.length}):`);
		for (const tag of tags) {
			item(tag);
		}
	}
	console.error("");
}

/**
 * List all tags across all projects with counts
 */
async function listAllTags(): Promise<void> {
	const tagCounts = await getAllTagsWithCounts();

	console.error("");
	if (tagCounts.length === 0) {
		info("No tags found across any projects");
		info("Add tags with: jack tag add <tags...>");
	} else {
		info(`All tags (${tagCounts.length}):`);
		for (const { tag, count } of tagCounts) {
			const projectLabel = count === 1 ? "project" : "projects";
			item(`${tag} (${count} ${projectLabel})`);
		}
	}
	console.error("");
}

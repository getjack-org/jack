/**
 * jack link - Link current directory to a jack cloud project or create BYO link
 *
 * Usage:
 *   jack link my-api       Link to existing managed project
 *   jack link --byo        Create BYO link (generates local ID)
 *   jack link              Interactive: prompts for project selection if logged in
 */

import { existsSync } from "node:fs";
import { select } from "@inquirer/prompts";
import { isLoggedIn } from "../lib/auth/index.ts";
import {
	type ManagedProject,
	findProjectBySlug,
	listManagedProjects,
} from "../lib/control-plane.ts";
import { error, info, output, success } from "../lib/output.ts";
import { registerPath } from "../lib/paths-index.ts";
import { generateByoProjectId, linkProject, readProjectLink } from "../lib/project-link.ts";

export interface LinkFlags {
	byo?: boolean;
}

export default async function link(projectName?: string, flags: LinkFlags = {}): Promise<void> {
	// Check if already linked
	const existingLink = await readProjectLink(process.cwd());
	if (existingLink) {
		error("This directory is already linked");
		info(`Project ID: ${existingLink.project_id}`);
		info("To re-link, first run: jack unlink");
		process.exit(1);
	}

	// Check for wrangler config
	const hasWranglerConfig =
		existsSync("wrangler.jsonc") || existsSync("wrangler.json") || existsSync("wrangler.toml");

	if (!hasWranglerConfig) {
		error("No wrangler config found");
		info("Run this from a jack project directory");
		process.exit(1);
	}

	// BYO mode - generate local ID
	if (flags.byo) {
		const projectId = generateByoProjectId();
		output.start("Creating BYO link...");
		await linkProject(process.cwd(), projectId, "byo");
		await registerPath(projectId, process.cwd());
		output.stop();
		success("Linked as BYO project");
		info(`Project ID: ${projectId}`);
		return;
	}

	// Check if logged in for managed mode
	const loggedIn = await isLoggedIn();

	if (!loggedIn && !projectName) {
		// Not logged in and no project name - suggest options
		error("Not logged in to jack cloud");
		info("Login with: jack login");
		info("Or create a BYO link: jack link --byo");
		process.exit(1);
	}

	// If project name provided, find it on control plane
	if (projectName) {
		if (!loggedIn) {
			error("Login required to link managed projects");
			info("Run: jack login");
			process.exit(1);
		}

		output.start(`Finding project: ${projectName}...`);
		let project: ManagedProject | null = null;
		try {
			project = await findProjectBySlug(projectName);
		} catch (err) {
			output.stop();
			error("Failed to find project");
			if (err instanceof Error) {
				info(err.message);
			}
			process.exit(1);
		}
		output.stop();

		if (!project) {
			error(`Project not found: ${projectName}`);
			info("List your projects with: jack projects list");
			process.exit(1);
		}

		output.start("Linking project...");
		await linkProject(process.cwd(), project.id, "managed");
		await registerPath(project.id, process.cwd());
		output.stop();
		success(`Linked to: ${projectName}`);
		return;
	}

	// Interactive mode - list and select project
	output.start("Loading projects...");
	let projects: ManagedProject[] = [];
	try {
		projects = await listManagedProjects();
	} catch (err) {
		output.stop();
		error("Failed to load projects");
		if (err instanceof Error) {
			info(err.message);
		}
		process.exit(1);
	}
	output.stop();

	if (projects.length === 0) {
		error("No managed projects found");
		info("Create one with: jack new");
		info("Or link as BYO: jack link --byo");
		process.exit(1);
	}

	console.error("");
	const choice = await select({
		message: "Select a project to link:",
		choices: projects.map((p) => ({
			value: p.id,
			name: `${p.slug} (${p.status})`,
		})),
	});

	const selected = projects.find((p) => p.id === choice);
	if (!selected) {
		error("No project selected");
		process.exit(1);
	}

	output.start("Linking project...");
	await linkProject(process.cwd(), selected.id, "managed");
	await registerPath(selected.id, process.cwd());
	output.stop();
	success(`Linked to: ${selected.slug}`);
}

/**
 * jack link - Link current directory to a jack cloud project or create BYO link
 *
 * Usage:
 *   jack link my-api       Link to existing managed project
 *   jack link --byo        Create BYO link (generates local ID)
 *   jack link              Interactive: prompts for project selection if logged in
 */

import { existsSync } from "node:fs";
import { isLoggedIn } from "../lib/auth/index.ts";
import { findProjectById, findProjectBySlug } from "../lib/control-plane.ts";
import { error, info, output, success } from "../lib/output.ts";
import { registerPath } from "../lib/paths-index.ts";
import { pickProject, requireTTY } from "../lib/picker.ts";
import { generateByoProjectId, linkProject, readProjectLink } from "../lib/project-link.ts";

export interface LinkFlags {
	byo?: boolean;
}

export default async function link(projectName?: string, flags: LinkFlags = {}): Promise<void> {
	// Check if already linked
	const existingLink = await readProjectLink(process.cwd());
	if (existingLink) {
		// Try to look up project name for better UX
		let projectDisplay = existingLink.project_id;
		if (existingLink.deploy_mode === "managed") {
			const project = await findProjectById(existingLink.project_id);
			if (project) {
				projectDisplay = project.slug;
			}
		}

		// Ensure hooks are installed for existing projects (idempotent)
		try {
			const { installClaudeCodeHooks } = await import("../lib/claude-hooks-installer.ts");
			await installClaudeCodeHooks(process.cwd());
		} catch {
			// Non-critical
		}

		error("This directory is already linked");
		info(`Linked to: ${projectDisplay}`);
		info("To re-link, first run: jack unlink");
		process.exit(1);
	}

	// Check for wrangler config
	const { hasWranglerConfig } = await import("../lib/wrangler-config.ts");
	if (!hasWranglerConfig(process.cwd())) {
		error("No wrangler config found");
		console.error("");
		info("Jack needs a wrangler.toml or wrangler.jsonc to deploy.");
		info("  → For a new project: jack new my-project");
		info("  → For existing code: jack init");
		process.exit(1);
	}

	// BYO mode - generate local ID
	if (flags.byo) {
		const projectId = generateByoProjectId();
		output.start("Linking to your Cloudflare account...");
		await linkProject(process.cwd(), projectId, "byo");
		await registerPath(projectId, process.cwd());
		output.stop();
		success("Linked to your Cloudflare account");
		info(`Project ID: ${projectId}`);
		return;
	}

	// Check if logged in for managed mode
	const loggedIn = await isLoggedIn();

	if (!loggedIn && !projectName) {
		// Not logged in and no project name - suggest options
		error("Not logged in to jack cloud");
		info("Login with: jack login");
		info("Or link to your Cloudflare account: jack link --byo");
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

	// Interactive mode - use fuzzy picker with cloud-only projects
	requireTTY();

	const result = await pickProject({ cloudOnly: true });

	if (result.action === "cancel") {
		info("Cancelled");
		process.exit(0);
	}

	const selected = result.project;

	// Need project ID - fetch from control plane by slug
	const project = await findProjectBySlug(selected.name);
	if (!project) {
		error(`Could not find project: ${selected.name}`);
		process.exit(1);
	}

	output.start("Linking project...");
	await linkProject(process.cwd(), project.id, "managed");
	await registerPath(project.id, process.cwd());
	output.stop();
	success(`Linked to: ${selected.name}`);
}

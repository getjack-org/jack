/**
 * Core project operations library for jack CLI
 *
 * This module extracts reusable business logic from CLI commands
 * to enable integration with MCP tools and other programmatic interfaces.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { renderTemplate, resolveTemplate } from "../templates/index.ts";
import type { Template } from "../templates/types.ts";
import { generateAgentFiles } from "./agent-files.ts";
import { getActiveAgents, validateAgentPaths } from "./agents.ts";
import { getAccountId } from "./cloudflare-api.ts";
import { checkWorkerExists } from "./cloudflare-api.ts";
import { generateEnvFile, generateSecretsJson } from "./env-parser.ts";
import { runHook } from "./hooks.ts";
import { generateProjectName } from "./names.ts";
import { output } from "./output.ts";
import {
	type Project,
	getAllProjects,
	getProject,
	getProjectDatabaseName,
	registerProject,
} from "./registry.ts";
import { applySchema, getD1DatabaseName, hasD1Config } from "./schema.ts";
import { getSavedSecrets } from "./secrets.ts";
import { getProjectNameFromDir, getRemoteManifest } from "./storage/index.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreateProjectOptions {
	template?: string;
	silent?: boolean; // Suppress console output for MCP
}

export interface CreateProjectResult {
	projectName: string;
	targetDir: string;
	workerUrl: string | null;
}

export interface DeployOptions {
	projectPath?: string;
	silent?: boolean;
}

export interface DeployResult {
	workerUrl: string | null;
	projectName: string;
}

export interface ProjectStatus {
	name: string;
	localPath: string | null;
	workerUrl: string | null;
	lastDeployed: string | null;
	deployed: boolean;
	local: boolean;
	backedUp: boolean;
}

// ============================================================================
// Create Project Operation
// ============================================================================

/**
 * Create a new project from a template
 *
 * Extracted from commands/new.ts to enable programmatic project creation.
 *
 * @param name - Project name (auto-generated if not provided)
 * @param options - Creation options
 * @returns Project creation result with name, path, and deployment URL
 * @throws Error if initialization check fails, directory exists, or template issues occur
 */
export async function createProject(
	name?: string,
	options: CreateProjectOptions = {},
): Promise<CreateProjectResult> {
	const { template: templateOption, silent = false } = options;

	// Check if jack init was run (throws if not)
	const { isInitialized } = await import("../commands/init.ts");
	const initialized = await isInitialized();
	if (!initialized) {
		throw new Error("jack is not set up yet. Run: jack init");
	}

	// Generate or use provided name
	const projectName = name ?? generateProjectName();
	const targetDir = resolve(projectName);

	// Check directory doesn't exist
	if (existsSync(targetDir)) {
		throw new Error(`Directory ${projectName} already exists`);
	}

	if (!silent) {
		output.start("Creating project...");
	}

	// Load template
	let template: Template;
	try {
		template = await resolveTemplate(templateOption);
	} catch (err) {
		if (!silent) output.stop();
		throw new Error(err instanceof Error ? err.message : String(err));
	}

	const rendered = renderTemplate(template, { name: projectName });

	// Handle template-specific secrets
	const secretsToUse: Record<string, string> = {};
	if (template.secrets?.length) {
		const saved = await getSavedSecrets();

		for (const key of template.secrets) {
			if (saved[key]) {
				secretsToUse[key] = saved[key];
			}
		}

		const missing = template.secrets.filter((key) => !saved[key]);
		if (missing.length > 0) {
			if (!silent) output.stop();
			throw new Error(
				`Missing required secrets: ${missing.join(", ")}. Run: jack secrets add <key>`,
			);
		}

		if (!silent) {
			output.stop();
			for (const key of Object.keys(secretsToUse)) {
				output.success(`Using saved secret: ${key}`);
			}
			output.start("Creating project...");
		}
	}

	// Write all template files
	for (const [filePath, content] of Object.entries(rendered.files)) {
		await Bun.write(join(targetDir, filePath), content);
	}

	// Write secrets files (.env for Vite, .dev.vars for wrangler local, .secrets.json for wrangler bulk)
	if (Object.keys(secretsToUse).length > 0) {
		const envContent = generateEnvFile(secretsToUse);
		const jsonContent = generateSecretsJson(secretsToUse);
		await Bun.write(join(targetDir, ".env"), envContent);
		await Bun.write(join(targetDir, ".dev.vars"), envContent);
		await Bun.write(join(targetDir, ".secrets.json"), jsonContent);

		const gitignorePath = join(targetDir, ".gitignore");
		const gitignoreExists = existsSync(gitignorePath);

		if (!gitignoreExists) {
			await Bun.write(gitignorePath, ".env\n.env.*\n.dev.vars\n.secrets.json\nnode_modules/\n");
		} else {
			const existingContent = await Bun.file(gitignorePath).text();
			if (!existingContent.includes(".env")) {
				await Bun.write(
					gitignorePath,
					`${existingContent}\n.env\n.env.*\n.dev.vars\n.secrets.json\n`,
				);
			}
		}
	}

	// Generate agent context files
	let activeAgents = await getActiveAgents();
	if (activeAgents.length > 0) {
		const validation = await validateAgentPaths();

		if (validation.invalid.length > 0) {
			if (!silent) {
				output.stop();
				output.warn("Some agent paths no longer exist:");
				for (const { id, path } of validation.invalid) {
					output.info(`  ${id}: ${path}`);
				}
				output.info("Run: jack agents scan");
				output.start("Creating project...");
			}

			// Filter out invalid agents
			activeAgents = activeAgents.filter(
				({ id }) => !validation.invalid.some((inv) => inv.id === id),
			);
		}

		if (activeAgents.length > 0) {
			await generateAgentFiles(targetDir, projectName, template, activeAgents);
			if (!silent) {
				const agentNames = activeAgents.map(({ definition }) => definition.name).join(", ");
				output.stop();
				output.success(`Generated context for: ${agentNames}`);
				output.start("Creating project...");
			}
		}
	}

	if (!silent) {
		output.stop();
		output.success(`Created ${projectName}/`);
	}

	// Auto-install dependencies
	if (!silent) {
		output.start("Installing dependencies...");
	}

	const install = Bun.spawn(["bun", "install"], {
		cwd: targetDir,
		stdout: "ignore",
		stderr: "ignore",
	});
	await install.exited;

	if (install.exitCode !== 0) {
		if (!silent) {
			output.stop();
			output.warn("Failed to install dependencies, run: bun install");
		}
		throw new Error("Dependency installation failed");
	}

	if (!silent) {
		output.stop();
		output.success("Dependencies installed");
	}

	// Run pre-deploy hooks
	if (template.hooks?.preDeploy?.length) {
		const hookContext = { projectName, projectDir: targetDir };
		const passed = await runHook(template.hooks.preDeploy, hookContext, {
			interactive: !silent,
		});
		if (!passed) {
			throw new Error("Pre-deploy checks failed");
		}
	}

	// For Vite projects, build first
	const hasVite = existsSync(join(targetDir, "vite.config.ts"));
	if (hasVite) {
		if (!silent) {
			output.start("Building...");
		}

		const buildResult = await $`npx vite build`.cwd(targetDir).nothrow().quiet();
		if (buildResult.exitCode !== 0) {
			if (!silent) {
				output.stop();
				output.error("Build failed");
			}
			throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
		}

		if (!silent) {
			output.stop();
			output.success("Built");
		}
	}

	// Deploy
	if (!silent) {
		output.start("Deploying...");
	}

	const deployResult = await $`wrangler deploy`.cwd(targetDir).nothrow().quiet();

	if (deployResult.exitCode !== 0) {
		if (!silent) {
			output.stop();
			output.error("Deploy failed");
		}
		throw new Error(`Deploy failed: ${deployResult.stderr.toString()}`);
	}

	// Apply schema.sql after deploy
	if (await hasD1Config(targetDir)) {
		const dbName = await getD1DatabaseName(targetDir);
		if (dbName) {
			try {
				await applySchema(dbName, targetDir);
			} catch (err) {
				if (!silent) {
					output.warn(`Schema application failed: ${err}`);
					output.info("Run manually: bun run db:migrate");
				}
			}
		}
	}

	// Push secrets to Cloudflare
	const secretsJsonPath = join(targetDir, ".secrets.json");
	if (existsSync(secretsJsonPath)) {
		if (!silent) {
			output.start("Configuring secrets...");
		}

		const secretsResult = await $`wrangler secret bulk .secrets.json`
			.cwd(targetDir)
			.nothrow()
			.quiet();

		if (secretsResult.exitCode !== 0) {
			if (!silent) {
				output.stop();
				output.warn("Failed to push secrets to Cloudflare");
				output.info("Run manually: wrangler secret bulk .secrets.json");
			}
		} else if (!silent) {
			output.stop();
			output.success("Secrets configured");
		}
	}

	// Parse URL from output
	const deployOutput = deployResult.stdout.toString();
	const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
	const workerUrl = urlMatch ? urlMatch[0] : null;

	if (!silent) {
		output.stop();
		if (workerUrl) {
			output.success(`Live: ${workerUrl}`);
		} else {
			output.success("Deployed");
		}
	}

	// Register project in registry
	try {
		const accountId = await getAccountId();
		const dbName = await getD1DatabaseName(targetDir);

		await registerProject(projectName, {
			localPath: targetDir,
			workerUrl,
			createdAt: new Date().toISOString(),
			lastDeployed: workerUrl ? new Date().toISOString() : null,
			cloudflare: {
				accountId,
				workerId: projectName,
			},
			resources: {
				services: {
					db: dbName,
				},
			},
		});
	} catch {
		// Don't fail the creation if registry update fails
	}

	// Run post-deploy hooks
	if (template.hooks?.postDeploy?.length && workerUrl) {
		const domain = workerUrl.replace(/^https?:\/\//, "");
		await runHook(
			template.hooks.postDeploy,
			{
				domain,
				url: workerUrl,
				projectName,
				projectDir: targetDir,
			},
			{ interactive: !silent },
		);
	}

	return {
		projectName,
		targetDir,
		workerUrl,
	};
}

// ============================================================================
// Deploy Project Operation
// ============================================================================

/**
 * Deploy an existing project
 *
 * Extracted from commands/ship.ts to enable programmatic deployment.
 *
 * @param options - Deployment options
 * @returns Deployment result with URL and project name
 * @throws Error if no wrangler config found, build fails, or deploy fails
 */
export async function deployProject(options: DeployOptions = {}): Promise<DeployResult> {
	const { projectPath = process.cwd(), silent = false } = options;

	// Check for wrangler config
	const hasWranglerConfig =
		existsSync(join(projectPath, "wrangler.toml")) ||
		existsSync(join(projectPath, "wrangler.jsonc")) ||
		existsSync(join(projectPath, "wrangler.json"));

	if (!hasWranglerConfig) {
		throw new Error("No wrangler config found in project directory. Run: jack new <project-name>");
	}

	// For Vite projects, build first
	const isViteProject =
		existsSync(join(projectPath, "vite.config.ts")) ||
		existsSync(join(projectPath, "vite.config.js")) ||
		existsSync(join(projectPath, "vite.config.mjs"));

	if (isViteProject) {
		if (!silent) {
			const { spinner } = await import("./output.ts");
			const buildSpin = spinner("Building...");
			const buildResult = await $`npx vite build`.cwd(projectPath).nothrow().quiet();

			if (buildResult.exitCode !== 0) {
				buildSpin.error("Build failed");
				throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
			}
			buildSpin.success("Built");
		} else {
			const buildResult = await $`npx vite build`.cwd(projectPath).nothrow().quiet();
			if (buildResult.exitCode !== 0) {
				throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
			}
		}
	}

	// Deploy
	if (!silent) {
		const { spinner } = await import("./output.ts");
		const spin = spinner("Deploying...");
		const result = await $`wrangler deploy`.cwd(projectPath).nothrow().quiet();

		if (result.exitCode !== 0) {
			spin.error("Deploy failed");
			throw new Error(`Deploy failed: ${result.stderr.toString()}`);
		}

		// Parse URL from output
		const deployOutput = result.stdout.toString();
		const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
		const workerUrl = urlMatch ? urlMatch[0] : null;

		if (workerUrl) {
			spin.success(`Live: ${workerUrl}`);
		} else {
			spin.success("Deployed");
		}

		// Apply schema if needed
		let dbName: string | null = null;
		if (await hasD1Config(projectPath)) {
			dbName = await getD1DatabaseName(projectPath);
			if (dbName) {
				try {
					await applySchema(dbName, projectPath);
				} catch (err) {
					const { warn, info } = await import("./output.ts");
					warn(`Schema application failed: ${err}`);
					info("Run manually: bun run db:migrate");
				}
			}
		}

		// Update registry
		try {
			const projectName = await getProjectNameFromDir(projectPath);
			await registerProject(projectName, {
				localPath: projectPath,
				workerUrl,
				lastDeployed: new Date().toISOString(),
				resources: {
					services: {
						db: dbName,
					},
				},
			});
		} catch {
			// Don't fail the deploy if registry update fails
		}

		return {
			workerUrl,
			projectName: await getProjectNameFromDir(projectPath),
		};
	}

	// Silent mode
	const result = await $`wrangler deploy`.cwd(projectPath).nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Deploy failed: ${result.stderr.toString()}`);
	}

	// Parse URL from output
	const deployOutput = result.stdout.toString();
	const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
	const workerUrl = urlMatch ? urlMatch[0] : null;

	// Apply schema if needed
	let dbName: string | null = null;
	if (await hasD1Config(projectPath)) {
		dbName = await getD1DatabaseName(projectPath);
		if (dbName) {
			try {
				await applySchema(dbName, projectPath);
			} catch {
				// Silent mode - ignore schema errors
			}
		}
	}

	// Update registry
	try {
		const projectName = await getProjectNameFromDir(projectPath);
		await registerProject(projectName, {
			localPath: projectPath,
			workerUrl,
			lastDeployed: new Date().toISOString(),
			resources: {
				services: {
					db: dbName,
				},
			},
		});
	} catch {
		// Don't fail the deploy if registry update fails
	}

	return {
		workerUrl,
		projectName: await getProjectNameFromDir(projectPath),
	};
}

// ============================================================================
// Get Project Status Operation
// ============================================================================

/**
 * Get detailed status for a specific project
 *
 * Extracted from commands/projects.ts infoProject to enable programmatic status checks.
 *
 * @param name - Project name (auto-detected from cwd if not provided)
 * @param projectPath - Project path (defaults to cwd)
 * @returns Project status or null if not found
 */
export async function getProjectStatus(
	name?: string,
	projectPath?: string,
): Promise<ProjectStatus | null> {
	let projectName = name;

	// If no name provided, try to get from project path or cwd
	if (!projectName) {
		try {
			projectName = await getProjectNameFromDir(projectPath ?? process.cwd());
		} catch {
			// Could not determine project name
			return null;
		}
	}

	const project = await getProject(projectName);

	if (!project) {
		return null;
	}

	// Check actual status
	const localExists = project.localPath ? existsSync(project.localPath) : false;
	const [workerExists, manifest] = await Promise.all([
		checkWorkerExists(projectName),
		getRemoteManifest(projectName),
	]);
	const backedUp = manifest !== null;

	return {
		name: projectName,
		localPath: project.localPath,
		workerUrl: project.workerUrl,
		lastDeployed: project.lastDeployed,
		deployed: workerExists || !!project.workerUrl,
		local: localExists,
		backedUp,
	};
}

// ============================================================================
// List All Projects Operation
// ============================================================================

/**
 * List all projects with status information
 *
 * Extracted from commands/projects.ts listProjects to enable programmatic project listing.
 *
 * @param filter - Filter projects by status
 * @returns Array of project statuses
 */
export async function listAllProjects(
	filter?: "all" | "local" | "deployed" | "cloud",
): Promise<ProjectStatus[]> {
	const projects = await getAllProjects();
	const projectNames = Object.keys(projects);

	if (projectNames.length === 0) {
		return [];
	}

	// Determine status for each project
	const statuses: ProjectStatus[] = await Promise.all(
		projectNames.map(async (name) => {
			const project = projects[name];
			if (!project) {
				return null;
			}

			const local = project.localPath ? existsSync(project.localPath) : false;

			// Check if deployed
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
				workerUrl: project.workerUrl,
				lastDeployed: project.lastDeployed,
				local,
				deployed,
				backedUp,
			};
		}),
	).then((results) => results.filter((s): s is ProjectStatus => s !== null));

	// Apply filter
	if (!filter || filter === "all") {
		return statuses;
	}

	switch (filter) {
		case "local":
			return statuses.filter((s) => s.local);
		case "deployed":
			return statuses.filter((s) => s.deployed);
		case "cloud":
			return statuses.filter((s) => s.backedUp);
		default:
			return statuses;
	}
}

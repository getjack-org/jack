/**
 * Core project operations library for jack CLI
 *
 * This module extracts reusable business logic from CLI commands
 * to enable integration with MCP tools and other programmatic interfaces.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import {
	BUILTIN_TEMPLATES,
	type ResolvedTemplate,
	renderTemplate,
	resolveTemplateWithOrigin,
} from "../templates/index.ts";
import type { Template } from "../templates/types.ts";
import { generateAgentFiles } from "./agent-files.ts";
import {
	getActiveAgents,
	getAgentDefinition,
	getOneShotAgent,
	runAgentOneShot,
	validateAgentPaths,
} from "./agents.ts";
import { checkWorkerExists, getAccountId, listD1Databases } from "./cloudflare-api.ts";
import { getSyncConfig } from "./config.ts";
import { debug, isDebug } from "./debug.ts";
import { resolveDeployMode, validateModeAvailability } from "./deploy-mode.ts";
import { detectSecrets, generateEnvFile, generateSecretsJson } from "./env-parser.ts";
import { JackError, JackErrorCode } from "./errors.ts";
import { type HookOutput, runHook } from "./hooks.ts";
import { loadTemplateKeywords, matchTemplateByIntent } from "./intent.ts";
import { createManagedProjectRemote, deployToManagedProject } from "./managed-deploy.ts";
import { generateProjectName } from "./names.ts";
import { filterNewSecrets, promptSaveSecrets } from "./prompts.ts";
import type { DeployMode, TemplateOrigin } from "./registry.ts";
import {
	getAllProjects,
	getProject,
	getProjectDatabaseName,
	registerProject,
	removeProject,
} from "./registry.ts";
import { applySchema, getD1Bindings, getD1DatabaseName, hasD1Config } from "./schema.ts";
import { getSavedSecrets, saveSecrets } from "./secrets.ts";
import { getProjectNameFromDir, getRemoteManifest, syncToCloud } from "./storage/index.ts";
import { Events, track } from "./telemetry.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreateProjectOptions {
	template?: string;
	intent?: string;
	reporter?: OperationReporter;
	interactive?: boolean;
	managed?: boolean; // Force managed deploy mode
	byo?: boolean; // Force BYO deploy mode
}

export interface CreateProjectResult {
	projectName: string;
	targetDir: string;
	workerUrl: string | null;
	deployMode: DeployMode; // The deploy mode used
}

export interface DeployOptions {
	projectPath?: string;
	reporter?: OperationReporter;
	interactive?: boolean;
	includeSecrets?: boolean;
	includeSync?: boolean;
	managed?: boolean; // Force managed deploy mode
	byo?: boolean; // Force BYO deploy mode
}

export interface DeployResult {
	workerUrl: string | null;
	projectName: string;
	deployOutput?: string;
	deployMode: DeployMode; // The deploy mode used
}

export interface ProjectStatus {
	name: string;
	localPath: string | null;
	workerUrl: string | null;
	lastDeployed: string | null;
	createdAt: string | null;
	accountId: string | null;
	workerId: string | null;
	dbName: string | null;
	deployed: boolean;
	local: boolean;
	backedUp: boolean;
	missing: boolean;
	backupFiles: number | null;
	backupLastSync: string | null;
}

export interface StaleProject {
	name: string;
	reason: "workspace path not set" | "workspace folder missing" | "worker not deployed";
	workerUrl: string | null;
}

export interface StaleProjectScan {
	total: number;
	stale: StaleProject[];
}

export interface OperationSpinner {
	success(message: string): void;
	error(message: string): void;
	stop(): void;
}

export interface OperationReporter extends HookOutput {
	start(message: string): void;
	stop(): void;
	spinner(message: string): OperationSpinner;
}

const noopSpinner: OperationSpinner = {
	success() {},
	error() {},
	stop() {},
};

const noopReporter: OperationReporter = {
	start() {},
	stop() {},
	spinner() {
		return noopSpinner;
	},
	info() {},
	warn() {},
	error() {},
	success() {},
	box() {},
};

const DEFAULT_D1_LIMIT = 10;

async function preflightD1Capacity(
	projectDir: string,
	reporter: OperationReporter,
	interactive: boolean,
): Promise<void> {
	const bindings = await getD1Bindings(projectDir);
	const needsCreate = bindings.some((binding) => !binding.database_id && binding.database_name);
	if (!needsCreate) {
		return;
	}

	let databases: Array<{ name?: string; uuid?: string }>;
	try {
		databases = await listD1Databases();
	} catch (err) {
		reporter.warn("Could not check D1 limits before deploy");
		if (err instanceof Error) {
			reporter.info(err.message);
		}
		return;
	}

	const count = databases.length;
	if (count < DEFAULT_D1_LIMIT) {
		return;
	}

	reporter.warn(`D1 limit likely reached: ${count} databases`);
	reporter.info("Delete old D1 databases with: wrangler d1 list / wrangler d1 delete <name>");
	reporter.info("Or reuse an existing database by setting database_id in wrangler.jsonc");

	if (!interactive) {
		return;
	}

	const { select } = await import("@inquirer/prompts");
	console.error("");
	console.error(
		`  You have ${count} D1 databases. If your limit is ${DEFAULT_D1_LIMIT}, deploy may fail.`,
	);
	console.error("");
	console.error("  Esc to cancel\n");

	const choice = await select({
		message: "Continue anyway?",
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (choice === "no") {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"D1 limit likely reached",
			"Delete old D1 databases or reuse an existing database_id",
			{ exitCode: 0, reported: true },
		);
	}
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
	const {
		template: templateOption,
		intent: intentPhrase,
		reporter: providedReporter,
		interactive: interactiveOption,
	} = options;
	const reporter = providedReporter ?? noopReporter;
	const hasReporter = Boolean(providedReporter);
	const isCi = process.env.CI === "true" || process.env.CI === "1";
	const interactive = interactiveOption ?? !isCi;

	// Check if jack init was run (throws if not)
	const { isInitialized } = await import("../commands/init.ts");
	const initialized = await isInitialized();
	if (!initialized) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, "jack is not set up yet", "Run: jack init");
	}

	// Resolve deploy mode (omakase: logged in => managed, logged out => BYO)
	const deployMode = await resolveDeployMode({
		managed: options.managed,
		byo: options.byo,
	});
	const modeError = await validateModeAvailability(deployMode);
	if (modeError) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, modeError);
	}

	// Generate or use provided name
	const projectName = name ?? generateProjectName();
	const targetDir = resolve(projectName);

	// Check directory doesn't exist
	if (existsSync(targetDir)) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, `Directory ${projectName} already exists`);
	}

	reporter.start("Creating project...");

	// Intent-based template matching
	let resolvedTemplate = templateOption;

	if (intentPhrase && !templateOption) {
		reporter.start("Matching intent to template...");

		const templates = await loadTemplateKeywords();
		const matches = matchTemplateByIntent(intentPhrase, templates);

		reporter.stop();

		if (matches.length === 0) {
			// Track no match
			track(Events.INTENT_NO_MATCH, {});

			// No match - prompt user to choose
			if (interactive) {
				const { select } = await import("@clack/prompts");
				console.error("");
				console.error(`  No template matched for: "${intentPhrase}"`);
				console.error("");

				const choice = await select({
					message: "Select a template:",
					options: BUILTIN_TEMPLATES.map((t, i) => ({ value: t, label: `${i + 1}. ${t}` })),
				});

				if (typeof choice !== "string") {
					throw new JackError(JackErrorCode.VALIDATION_ERROR, "No template selected", undefined, {
						exitCode: 0,
						reported: true,
					});
				}
				resolvedTemplate = choice;
			} else {
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					`No template matched intent: "${intentPhrase}"`,
					`Available templates: ${BUILTIN_TEMPLATES.join(", ")}`,
				);
			}
		} else if (matches.length === 1) {
			resolvedTemplate = matches[0]?.template;
			reporter.success(`Matched template: ${resolvedTemplate}`);

			// Track single match
			track(Events.INTENT_MATCHED, {
				template: resolvedTemplate,
				match_count: 1,
			});
		} else {
			// Track multiple matches
			track(Events.INTENT_MATCHED, {
				template: matches[0]?.template,
				match_count: matches.length,
			});

			// Multiple matches
			if (interactive) {
				const { select } = await import("@clack/prompts");
				console.error("");
				console.error(`  Multiple templates matched: "${intentPhrase}"`);
				console.error("");

				const matchedNames = matches.map((m) => m.template);
				const choice = await select({
					message: "Select a template:",
					options: matchedNames.map((t, i) => ({ value: t, label: `${i + 1}. ${t}` })),
				});

				if (typeof choice !== "string") {
					throw new JackError(JackErrorCode.VALIDATION_ERROR, "No template selected", undefined, {
						exitCode: 0,
						reported: true,
					});
				}
				resolvedTemplate = choice;
			} else {
				resolvedTemplate = matches[0]?.template;
				reporter.info(`Multiple matches, using: ${resolvedTemplate}`);
			}
		}

		reporter.start("Creating project...");
	}

	// Load template with origin tracking for lineage
	let template: Template;
	let templateOrigin: TemplateOrigin;
	try {
		const resolved = await resolveTemplateWithOrigin(resolvedTemplate);
		template = resolved.template;
		templateOrigin = resolved.origin;
	} catch (err) {
		reporter.stop();
		const message = err instanceof Error ? err.message : String(err);
		throw new JackError(JackErrorCode.TEMPLATE_NOT_FOUND, message);
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
			reporter.stop();
			const missingList = missing.join(", ");
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				`Missing required secrets: ${missingList}`,
				"Run: jack secrets add <key>",
				{ missingSecrets: missing },
			);
		}

		reporter.stop();
		for (const key of Object.keys(secretsToUse)) {
			reporter.success(`Using saved secret: ${key}`);
		}
		reporter.start("Creating project...");
	}

	// Handle optional secrets (only in interactive mode)
	if (template.optionalSecrets?.length && interactive) {
		const saved = await getSavedSecrets();

		for (const optionalSecret of template.optionalSecrets) {
			// Skip if already saved
			const savedValue = saved[optionalSecret.name];
			if (savedValue) {
				secretsToUse[optionalSecret.name] = savedValue;
				reporter.stop();
				reporter.success(`Using saved secret: ${optionalSecret.name}`);
				reporter.start("Creating project...");
				continue;
			}

			// Prompt user
			reporter.stop();
			const { input, select } = await import("@inquirer/prompts");
			console.error("");
			console.error(`  ${optionalSecret.description}`);
			if (optionalSecret.setupUrl) {
				console.error(`  Setup: ${optionalSecret.setupUrl}`);
			}
			console.error("");
			console.error("  Esc to skip\n");

			const choice = await select({
				message: `Add ${optionalSecret.name}?`,
				choices: [
					{ name: "1. Yes", value: "yes" },
					{ name: "2. Skip", value: "skip" },
				],
			});

			if (choice === "yes") {
				const value = await input({
					message: `Enter ${optionalSecret.name}:`,
				});

				if (value.trim()) {
					secretsToUse[optionalSecret.name] = value.trim();
					// Save to global secrets for reuse
					await saveSecrets([
						{
							key: optionalSecret.name,
							value: value.trim(),
							source: "optional-template",
						},
					]);
					reporter.success(`Saved ${optionalSecret.name}`);
				}
			}

			reporter.start("Creating project...");
		}
	}

	// Write all template files
	for (const [filePath, content] of Object.entries(rendered.files)) {
		await Bun.write(join(targetDir, filePath), content);
	}

	// Preflight: check D1 capacity before spending time on installs
	reporter.stop();
	await preflightD1Capacity(targetDir, reporter, interactive);
	reporter.start("Creating project...");

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
			reporter.stop();
			reporter.warn("Some agent paths no longer exist:");
			for (const { id, path } of validation.invalid) {
				reporter.info(`  ${id}: ${path}`);
			}
			reporter.info("Run: jack agents scan");
			reporter.start("Creating project...");

			// Filter out invalid agents
			activeAgents = activeAgents.filter(
				({ id }) => !validation.invalid.some((inv) => inv.id === id),
			);
		}

		if (activeAgents.length > 0) {
			await generateAgentFiles(targetDir, projectName, template, activeAgents);
			const agentNames = activeAgents.map(({ definition }) => definition.name).join(", ");
			reporter.stop();
			reporter.success(`Generated context for: ${agentNames}`);
			reporter.start("Creating project...");
		}
	}

	reporter.stop();
	reporter.success(`Created ${projectName}/`);

	// Auto-install dependencies
	reporter.start("Installing dependencies...");

	const install = Bun.spawn(["bun", "install"], {
		cwd: targetDir,
		stdout: "ignore",
		stderr: "ignore",
	});
	await install.exited;

	if (install.exitCode !== 0) {
		reporter.stop();
		reporter.warn("Failed to install dependencies, run: bun install");
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Dependency installation failed",
			"Run: bun install",
			{ exitCode: 0, reported: hasReporter },
		);
	}

	reporter.stop();
	reporter.success("Dependencies installed");

	// Run pre-deploy hooks
	if (template.hooks?.preDeploy?.length) {
		const hookContext = { projectName, projectDir: targetDir };
		const passed = await runHook(template.hooks.preDeploy, hookContext, {
			interactive,
			output: reporter,
		});
		if (!passed) {
			reporter.error("Pre-deploy checks failed");
			throw new JackError(JackErrorCode.VALIDATION_ERROR, "Pre-deploy checks failed", undefined, {
				exitCode: 0,
				reported: hasReporter,
			});
		}
	}

	// One-shot agent customization if intent was provided
	if (intentPhrase) {
		const oneShotAgent = await getOneShotAgent();

		if (oneShotAgent) {
			const agentDefinition = getAgentDefinition(oneShotAgent);
			const agentLabel = agentDefinition?.name ?? oneShotAgent;
			reporter.info(`Customizing with ${agentLabel}`);
			reporter.info(`Intent: ${intentPhrase}`);
			const debugEnabled = isDebug();
			const customizationSpinner = debugEnabled ? null : reporter.spinner("Customizing...");

			// Track customization start
			track(Events.INTENT_CUSTOMIZATION_STARTED, { agent: oneShotAgent });

			const result = await runAgentOneShot(oneShotAgent, targetDir, intentPhrase, {
				info: reporter.info,
				warn: reporter.warn,
				status: customizationSpinner
					? (message) => {
							customizationSpinner.text = message;
						}
					: undefined,
			});

			if (customizationSpinner) {
				customizationSpinner.stop();
			}
			if (result.success) {
				reporter.success("Project customized");
				// Track successful customization
				track(Events.INTENT_CUSTOMIZATION_COMPLETED, { agent: oneShotAgent });
			} else {
				reporter.warn(`Customization skipped: ${result.error ?? "unknown error"}`);
				// Track failed customization
				track(Events.INTENT_CUSTOMIZATION_FAILED, {
					agent: oneShotAgent,
					error_type: "agent_error",
				});
			}
		} else {
			reporter.info?.("No compatible agent for customization (Claude Code or Codex required)");
		}
	}

	// For Vite projects, build first (needed for both modes)
	const hasVite = existsSync(join(targetDir, "vite.config.ts"));
	if (hasVite) {
		reporter.start("Building...");

		const buildResult = await $`npx vite build`.cwd(targetDir).nothrow().quiet();
		if (buildResult.exitCode !== 0) {
			reporter.stop();
			reporter.error("Build failed");
			throw new JackError(JackErrorCode.BUILD_FAILED, "Build failed", undefined, {
				exitCode: 0,
				stderr: buildResult.stderr.toString(),
				reported: hasReporter,
			});
		}

		reporter.stop();
		reporter.success("Built");
	}

	let workerUrl: string | null = null;

	// Deploy based on mode
	if (deployMode === "managed") {
		// Managed mode: create project and deploy via jack cloud
		const remoteResult = await createManagedProjectRemote(projectName, reporter);
		await deployToManagedProject(remoteResult.projectId, targetDir, reporter);
		workerUrl = remoteResult.runjackUrl;

		// Register project with managed mode metadata
		try {
			const dbName = await getD1DatabaseName(targetDir);

			await registerProject(projectName, {
				localPath: targetDir,
				workerUrl,
				createdAt: new Date().toISOString(),
				lastDeployed: new Date().toISOString(),
				resources: {
					services: {
						db: dbName,
					},
				},
				template: templateOrigin,
				deploy_mode: "managed",
				remote: {
					project_id: remoteResult.projectId,
					project_slug: remoteResult.projectSlug,
					org_id: remoteResult.orgId,
					runjack_url: remoteResult.runjackUrl,
				},
			});
		} catch (err) {
			// Log but don't fail - registry is convenience, not critical path
			debug("Failed to register managed project:", err);
		}
	} else {
		// BYO mode: deploy via wrangler
		reporter.start("Deploying...");

		const deployResult = await $`wrangler deploy`.cwd(targetDir).nothrow().quiet();

		if (deployResult.exitCode !== 0) {
			reporter.stop();
			reporter.error("Deploy failed");
			throw new JackError(JackErrorCode.DEPLOY_FAILED, "Deploy failed", undefined, {
				exitCode: 0,
				stderr: deployResult.stderr.toString(),
				reported: hasReporter,
			});
		}

		// Apply schema.sql after deploy
		if (await hasD1Config(targetDir)) {
			const dbName = await getD1DatabaseName(targetDir);
			if (dbName) {
				try {
					await applySchema(dbName, targetDir);
				} catch (err) {
					reporter.warn(`Schema application failed: ${err}`);
					reporter.info("Run manually: bun run db:migrate");
				}
			}
		}

		// Push secrets to Cloudflare
		const secretsJsonPath = join(targetDir, ".secrets.json");
		if (existsSync(secretsJsonPath)) {
			reporter.start("Configuring secrets...");

			const secretsResult = await $`wrangler secret bulk .secrets.json`
				.cwd(targetDir)
				.nothrow()
				.quiet();

			if (secretsResult.exitCode !== 0) {
				reporter.stop();
				reporter.warn("Failed to push secrets to Cloudflare");
				reporter.info("Run manually: wrangler secret bulk .secrets.json");
			} else {
				reporter.stop();
				reporter.success("Secrets configured");
			}
		}

		// Parse URL from output
		const deployOutput = deployResult.stdout.toString();
		const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
		workerUrl = urlMatch ? urlMatch[0] : null;

		reporter.stop();
		if (workerUrl) {
			reporter.success(`Live: ${workerUrl}`);
		} else {
			reporter.success("Deployed");
		}

		// Register project with BYO mode
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
				template: templateOrigin,
				deploy_mode: "byo",
			});
		} catch {
			// Don't fail the creation if registry update fails
		}
	}

	// Run post-deploy hooks (for both modes)
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
			{ interactive, output: reporter },
		);
	}

	return {
		projectName,
		targetDir,
		workerUrl,
		deployMode,
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
	const {
		projectPath = process.cwd(),
		reporter: providedReporter,
		interactive: interactiveOption,
		includeSecrets = false,
		includeSync = false,
	} = options;
	const reporter = providedReporter ?? noopReporter;
	const hasReporter = Boolean(providedReporter);
	const isCi = process.env.CI === "true" || process.env.CI === "1";
	const interactive = interactiveOption ?? !isCi;

	// Check for wrangler config
	const hasWranglerConfig =
		existsSync(join(projectPath, "wrangler.toml")) ||
		existsSync(join(projectPath, "wrangler.jsonc")) ||
		existsSync(join(projectPath, "wrangler.json"));

	if (!hasWranglerConfig) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			"No wrangler config found in current directory",
			"Run: jack new <project-name>",
		);
	}

	// Get project name from directory
	const projectName = await getProjectNameFromDir(projectPath);

	// Get project from registry to check stored mode
	const project = await getProject(projectName);

	// Determine effective mode: explicit flag > stored mode > default BYO
	let deployMode: DeployMode;
	if (options.managed) {
		deployMode = "managed";
	} else if (options.byo) {
		deployMode = "byo";
	} else {
		deployMode = project?.deploy_mode ?? "byo";
	}

	// Validate mode availability
	const modeError = await validateModeAvailability(deployMode);
	if (modeError) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, modeError);
	}

	// For Vite projects, build first
	const isViteProject =
		existsSync(join(projectPath, "vite.config.ts")) ||
		existsSync(join(projectPath, "vite.config.js")) ||
		existsSync(join(projectPath, "vite.config.mjs"));

	if (isViteProject) {
		const buildSpin = reporter.spinner("Building...");
		const buildResult = await $`npx vite build`.cwd(projectPath).nothrow().quiet();

		if (buildResult.exitCode !== 0) {
			buildSpin.error("Build failed");
			throw new JackError(JackErrorCode.BUILD_FAILED, "Build failed", undefined, {
				exitCode: buildResult.exitCode ?? 1,
				stderr: buildResult.stderr.toString(),
				reported: hasReporter,
			});
		}
		buildSpin.success("Built");
	}

	let workerUrl: string | null = null;
	let deployOutput: string | undefined;

	// Deploy based on mode
	if (deployMode === "managed") {
		// Managed mode: deploy via jack cloud
		if (!project?.remote?.project_id) {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				"Project not linked to jack cloud",
				"Create a new managed project or use --byo",
			);
		}

		// deployToManagedProject now handles both template and code deploy
		const result = await deployToManagedProject(project.remote.project_id, projectPath, reporter);

		workerUrl = project.remote.runjack_url;

		// Update lastDeployed in registry (will be persisted below)
		if (project) {
			project.lastDeployed = new Date().toISOString();
		}
	} else {
		// BYO mode: deploy via wrangler
		const spin = reporter.spinner("Deploying...");
		const result = await $`wrangler deploy`.cwd(projectPath).nothrow().quiet();

		if (result.exitCode !== 0) {
			spin.error("Deploy failed");
			throw new JackError(JackErrorCode.DEPLOY_FAILED, "Deploy failed", undefined, {
				exitCode: result.exitCode ?? 1,
				stderr: result.stderr.toString(),
				reported: hasReporter,
			});
		}

		// Parse URL from output
		deployOutput = result.stdout.toString();
		const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
		workerUrl = urlMatch ? urlMatch[0] : null;

		if (workerUrl) {
			spin.success(`Live: ${workerUrl}`);
		} else {
			spin.success("Deployed");
		}
	}

	// Apply schema if needed (BYO only - managed projects have their own DB)
	let dbName: string | null = null;
	if (deployMode === "byo" && (await hasD1Config(projectPath))) {
		dbName = await getD1DatabaseName(projectPath);
		if (dbName) {
			try {
				await applySchema(dbName, projectPath);
			} catch (err) {
				reporter.warn(`Schema application failed: ${err}`);
				reporter.info("Run manually: bun run db:migrate");
			}
		}
	}

	// Update registry
	try {
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

	if (includeSecrets && interactive) {
		const detected = await detectSecrets(projectPath);
		const newSecrets = await filterNewSecrets(detected);

		if (newSecrets.length > 0) {
			await promptSaveSecrets(newSecrets);
		}
	}

	if (includeSync) {
		const syncConfig = await getSyncConfig();
		if (syncConfig.enabled && syncConfig.autoSync) {
			const syncSpin = reporter.spinner("Syncing source to cloud...");
			try {
				const syncResult = await syncToCloud(projectPath);
				if (syncResult.success) {
					if (syncResult.filesUploaded > 0 || syncResult.filesDeleted > 0) {
						syncSpin.success(
							`Backed up ${syncResult.filesUploaded} files to jack-storage/${projectName}/`,
						);
					} else {
						syncSpin.success("Source already synced");
					}
				}
			} catch {
				syncSpin.stop();
				reporter.warn("Cloud sync failed (deploy succeeded)");
				reporter.info("Run: jack sync");
			}
		}
	}

	return {
		workerUrl,
		projectName,
		deployOutput: workerUrl ? undefined : deployOutput,
		deployMode,
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
	const backupFiles = manifest ? manifest.files.length : null;
	const backupLastSync = manifest ? manifest.lastSync : null;

	return {
		name: projectName,
		localPath: project.localPath,
		workerUrl: project.workerUrl,
		lastDeployed: project.lastDeployed,
		createdAt: project.createdAt,
		accountId: project.cloudflare?.accountId ?? null,
		workerId: project.cloudflare?.workerId ?? null,
		dbName: getProjectDatabaseName(project),
		deployed: workerExists || !!project.workerUrl,
		local: localExists,
		backedUp,
		missing: project.localPath ? !localExists : false,
		backupFiles,
		backupLastSync,
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
			const missing = project.localPath ? !local : false;

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
			const backupFiles = manifest ? manifest.files.length : null;
			const backupLastSync = manifest ? manifest.lastSync : null;

			return {
				name,
				localPath: project.localPath,
				workerUrl: project.workerUrl,
				lastDeployed: project.lastDeployed,
				createdAt: project.createdAt,
				accountId: project.cloudflare?.accountId ?? null,
				workerId: project.cloudflare?.workerId ?? null,
				dbName: getProjectDatabaseName(project),
				local,
				deployed,
				backedUp,
				missing,
				backupFiles,
				backupLastSync,
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

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Scan registry for stale projects
 * Returns total project count and stale entries with reasons.
 */
export async function scanStaleProjects(): Promise<StaleProjectScan> {
	const projects = await getAllProjects();
	const projectNames = Object.keys(projects);
	const stale: StaleProject[] = [];

	for (const name of projectNames) {
		const project = projects[name];
		if (!project) continue;

		if (!project.localPath) {
			stale.push({
				name,
				reason: "workspace path not set",
				workerUrl: project.workerUrl,
			});
			continue;
		}

		if (project.localPath && !existsSync(project.localPath)) {
			stale.push({
				name,
				reason: "workspace folder missing",
				workerUrl: project.workerUrl,
			});
			continue;
		}

		if (project.workerUrl) {
			const workerExists = await checkWorkerExists(name);
			if (!workerExists) {
				stale.push({
					name,
					reason: "worker not deployed",
					workerUrl: project.workerUrl,
				});
			}
		}
	}

	return { total: projectNames.length, stale };
}

/**
 * Remove stale registry entries by name
 * Returns the number of entries removed.
 */
export async function cleanupStaleProjects(names: string[]): Promise<number> {
	let removed = 0;
	for (const name of names) {
		await removeProject(name);
		removed += 1;
	}
	return removed;
}

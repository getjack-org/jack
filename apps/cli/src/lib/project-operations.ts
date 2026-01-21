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
import type { EnvVar, Template } from "../templates/types.ts";
import { generateAgentFiles } from "./agent-files.ts";
import { ensureAgentIntegration } from "./agent-integration.ts";
import {
	getActiveAgents,
	getAgentDefinition,
	getOneShotAgent,
	runAgentOneShot,
	validateAgentPaths,
} from "./agents.ts";
import {
	checkWranglerVersion,
	getWranglerVersion,
	needsOpenNextBuild,
	needsViteBuild,
	parseWranglerConfig,
	runOpenNextBuild,
	runViteBuild,
} from "./build-helper.ts";
import { checkWorkerExists, getAccountId, listD1Databases } from "./cloudflare-api.ts";
import {
	generateWranglerConfig,
	getDefaultProjectName,
	slugify,
	writeWranglerConfig,
} from "./config-generator.ts";
import { deleteManagedProject, listManagedProjects } from "./control-plane.ts";
import { debug, isDebug, printTimingSummary, timerEnd, timerStart } from "./debug.ts";
import { ensureWranglerInstalled, validateModeAvailability } from "./deploy-mode.ts";
import { detectSecrets, generateEnvFile, generateSecretsJson } from "./env-parser.ts";
import { JackError, JackErrorCode } from "./errors.ts";
import { type HookOutput, runHook } from "./hooks.ts";
import { loadTemplateKeywords, matchTemplateByIntent } from "./intent.ts";
import {
	type ManagedCreateResult,
	createManagedProjectRemote,
	deployToManagedProject,
} from "./managed-deploy.ts";
import { generateProjectName } from "./names.ts";
import { getAllPaths, registerPath, unregisterPath } from "./paths-index.ts";
import { detectProjectType, validateProject } from "./project-detection.ts";
import {
	type DeployMode,
	type TemplateMetadata as TemplateOrigin,
	generateByoProjectId,
	linkProject,
	readProjectLink,
	unlinkProject,
	writeTemplateMetadata,
} from "./project-link.ts";
import { filterNewSecrets, promptSaveSecrets } from "./prompts.ts";
import { applySchema, getD1Bindings, getD1DatabaseName, hasD1Config } from "./schema.ts";
import { getSavedSecrets, saveSecrets } from "./secrets.ts";
import { getProjectNameFromDir, getRemoteManifest } from "./storage/index.ts";
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
	dryRun?: boolean; // Stop before actual deployment
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
	reason: "worker not deployed";
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
	text?: string;
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

/**
 * Check if an environment variable already exists in a .env file
 * Returns the existing value if found, null otherwise
 */
async function checkEnvVarExists(envPath: string, key: string): Promise<string | null> {
	if (!existsSync(envPath)) {
		return null;
	}

	const content = await Bun.file(envPath).text();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) {
			continue;
		}

		const lineKey = trimmed.slice(0, eqIndex).trim();
		if (lineKey === key) {
			let value = trimmed.slice(eqIndex + 1).trim();
			// Remove surrounding quotes
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			return value;
		}
	}

	return null;
}

/**
 * Prompt for environment variables defined in a template
 * Returns a record of env var name -> value for vars that were provided
 */
async function promptEnvVars(
	envVars: EnvVar[],
	targetDir: string,
	reporter: OperationReporter,
	interactive: boolean,
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const envPath = join(targetDir, ".env");

	for (const envVar of envVars) {
		// Check if already exists in .env
		const existingValue = await checkEnvVarExists(envPath, envVar.name);
		if (existingValue) {
			reporter.stop();
			reporter.success(`${envVar.name}: already configured`);
			reporter.start("Creating project...");
			result[envVar.name] = existingValue;
			continue;
		}

		if (!interactive) {
			// Non-interactive mode: use default if available, otherwise warn
			if (envVar.defaultValue !== undefined) {
				result[envVar.name] = envVar.defaultValue;
				reporter.stop();
				reporter.info(`${envVar.name}: using default value`);
				reporter.start("Creating project...");
			} else if (envVar.required !== false) {
				reporter.stop();
				reporter.warn(`${envVar.name}: required but not set (no default available)`);
				reporter.start("Creating project...");
			}
			continue;
		}

		// Interactive mode: prompt user
		reporter.stop();
		const { isCancel, text } = await import("@clack/prompts");

		console.error("");
		console.error(`  ${envVar.description}`);
		if (envVar.setupUrl) {
			console.error(`  Get it at: ${envVar.setupUrl}`);
		}
		if (envVar.example) {
			console.error(`  Example: ${envVar.example}`);
		}
		console.error("");

		const value = await text({
			message: `${envVar.name}:`,
			defaultValue: envVar.defaultValue,
			placeholder: envVar.defaultValue ?? (envVar.example ? `e.g. ${envVar.example}` : undefined),
		});

		if (isCancel(value)) {
			// User cancelled - skip this var
			if (envVar.required !== false) {
				reporter.warn(`Skipped required env var: ${envVar.name}`);
			}
			reporter.start("Creating project...");
			continue;
		}

		const trimmedValue = value.trim();
		if (trimmedValue) {
			result[envVar.name] = trimmedValue;
			reporter.success(`Set ${envVar.name}`);
		} else if (envVar.defaultValue !== undefined) {
			result[envVar.name] = envVar.defaultValue;
			reporter.info(`${envVar.name}: using default value`);
		} else if (envVar.required !== false) {
			reporter.warn(`Skipped required env var: ${envVar.name}`);
		}

		reporter.start("Creating project...");
	}

	return result;
}

/**
 * Get the wrangler config file path for a project
 * Returns the first found: wrangler.jsonc, wrangler.toml, wrangler.json
 */
function getWranglerConfigPath(projectPath: string): string | null {
	const configs = ["wrangler.jsonc", "wrangler.toml", "wrangler.json"];
	for (const config of configs) {
		if (existsSync(join(projectPath, config))) {
			return config;
		}
	}
	return null;
}

/**
 * Run wrangler deploy with explicit config to avoid parent directory conflicts
 */
async function runWranglerDeploy(
	projectPath: string,
	options: { dryRun?: boolean; outDir?: string } = {},
) {
	const configFile = getWranglerConfigPath(projectPath);
	const configArg = configFile ? ["--config", configFile] : [];
	const dryRunArgs = options.dryRun
		? ["--dry-run", ...(options.outDir ? ["--outdir", options.outDir] : [])]
		: [];

	return await $`wrangler deploy ${configArg} ${dryRunArgs}`.cwd(projectPath).nothrow().quiet();
}

/**
 * Ensure Cloudflare authentication is in place before BYO operations.
 * Checks wrangler auth and CLOUDFLARE_API_TOKEN env var.
 */
async function ensureCloudflareAuth(
	interactive: boolean,
	reporter: OperationReporter,
): Promise<void> {
	const { isAuthenticated, ensureAuth } = await import("./wrangler.ts");
	const cfAuthenticated = await isAuthenticated();
	const hasApiToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);

	if (!cfAuthenticated && !hasApiToken) {
		if (interactive) {
			reporter.info("Cloudflare authentication required");
			await ensureAuth();
		} else {
			throw new JackError(
				JackErrorCode.AUTH_FAILED,
				"Not authenticated with Cloudflare",
				"Run: wrangler login\nOr set CLOUDFLARE_API_TOKEN environment variable",
			);
		}
	}
}

/**
 * Run bun install and managed project creation in parallel.
 * Handles partial failures with cleanup.
 * Optionally reports URL early via onRemoteReady callback.
 */
async function runParallelSetup(
	targetDir: string,
	projectName: string,
	options: {
		template?: string;
		usePrebuilt?: boolean;
		onRemoteReady?: (result: ManagedCreateResult) => void;
	},
): Promise<{
	installSuccess: boolean;
	remoteResult: ManagedCreateResult;
}> {
	const setupStart = Date.now();
	debug("Parallel setup started", { template: options.template, usePrebuilt: options.usePrebuilt });

	// Start both operations
	const installStart = Date.now();
	const installPromise = (async () => {
		const install = Bun.spawn(["bun", "install", "--prefer-offline"], {
			cwd: targetDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await install.exited;
		const duration = ((Date.now() - installStart) / 1000).toFixed(1);
		debug(`bun install completed in ${duration}s (exit: ${install.exitCode})`);
		if (install.exitCode !== 0) {
			throw new Error("Dependency installation failed");
		}
		return true;
	})();

	const remoteStart = Date.now();
	const remotePromise = createManagedProjectRemote(projectName, undefined, {
		template: options.template || "hello",
		usePrebuilt: options.usePrebuilt ?? true,
	}).then((result) => {
		const duration = ((Date.now() - remoteStart) / 1000).toFixed(1);
		debug(`Remote project created in ${duration}s (status: ${result.status})`);
		return result;
	});

	// Report URL as soon as remote is ready (don't wait for install)
	remotePromise
		.then((result) => {
			if (result.status === "live" && options.onRemoteReady) {
				options.onRemoteReady(result);
			}
		})
		.catch(() => {}); // Errors handled below in allSettled

	const [installResult, remoteResult] = await Promise.allSettled([installPromise, remotePromise]);

	const installFailed = installResult.status === "rejected";
	const remoteFailed = remoteResult.status === "rejected";

	// Handle partial failures
	if (installFailed && remoteResult.status === "fulfilled") {
		// Install failed but remote succeeded - cleanup orphan cloud project
		const remote = remoteResult.value;
		try {
			await deleteManagedProject(remote.projectId);
			debug("Cleaned up orphan cloud project:", remote.projectId);
		} catch (cleanupErr) {
			debug("Failed to cleanup orphan cloud project:", cleanupErr);
		}
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Dependency installation failed",
			"Run: bun install",
		);
	}

	if (!installFailed && remoteResult.status === "rejected") {
		// Remote failed but install succeeded - throw remote error
		const error = remoteResult.reason;
		throw error instanceof Error ? error : new Error(String(error));
	}

	if (installFailed && remoteFailed) {
		// Both failed - prioritize install error (more actionable)
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Dependency installation failed",
			"Run: bun install",
		);
	}

	// Both succeeded - TypeScript knows remoteResult.status === "fulfilled" here
	if (remoteResult.status !== "fulfilled") {
		// Should never happen, but satisfies TypeScript
		throw new Error("Unexpected state: remote result not fulfilled");
	}

	const totalDuration = ((Date.now() - setupStart) / 1000).toFixed(1);
	debug(`Parallel setup completed in ${totalDuration}s`);

	return {
		installSuccess: true,
		remoteResult: remoteResult.value,
	};
}

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

	const { promptSelect } = await import("./hooks.ts");
	console.error("");
	console.error(
		`  You have ${count} D1 databases. If your limit is ${DEFAULT_D1_LIMIT}, deploy may fail.`,
	);
	console.error("");
	console.error("  Continue anyway?");

	const choice = await promptSelect(["Yes", "No"]);

	if (choice !== 0) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"D1 limit likely reached",
			"Delete old D1 databases or reuse an existing database_id",
			{ exitCode: 0, reported: true },
		);
	}
}

// ============================================================================
// Auto-detect Flow for Ship Command
// ============================================================================

interface AutoDetectResult {
	projectName: string;
	projectId: string | null; // null when dry run (no cloud project created)
	deployMode: DeployMode;
}

/**
 * Run the auto-detect flow when no wrangler config exists.
 * Detects project type, prompts user for confirmation, generates config,
 * and creates managed project on jack cloud.
 *
 * @param dryRun - If true, skip cloud project creation and linking
 */
async function runAutoDetectFlow(
	projectPath: string,
	reporter: OperationReporter,
	interactive: boolean,
	dryRun = false,
): Promise<AutoDetectResult> {
	// Step 1: Validate project (file count, size limits)
	const validation = await validateProject(projectPath);
	if (!validation.valid) {
		track(Events.AUTO_DETECT_REJECTED, { reason: "validation_failed" });
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			validation.error || "Project validation failed",
		);
	}

	// Step 2: Detect project type
	const detection = detectProjectType(projectPath);

	// Step 3: Handle unsupported frameworks
	if (detection.unsupportedFramework) {
		track(Events.AUTO_DETECT_FAILED, {
			reason: "unsupported_framework",
			framework: detection.unsupportedFramework,
		});

		// Use the detailed error message from detection (includes setup instructions)
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			detection.error || `${detection.unsupportedFramework} is not yet supported`,
		);
	}

	// Step 4: Handle unknown project type
	if (detection.type === "unknown") {
		track(Events.AUTO_DETECT_FAILED, { reason: "unknown_type" });

		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"Could not detect project type\n\nSupported types:\n  - Vite (React, Vue, etc.)\n  - Hono API\n  - SvelteKit (with @sveltejs/adapter-cloudflare)\n\nTo deploy manually, create a wrangler.jsonc file.\nDocs: https://docs.getjack.org/guides/manual-setup",
		);
	}

	// Step 5: Handle detection errors (e.g., missing adapter)
	if (detection.error) {
		track(Events.AUTO_DETECT_FAILED, {
			reason: "detection_error",
			type: detection.type,
		});
		throw new JackError(JackErrorCode.VALIDATION_ERROR, detection.error);
	}

	// Step 6: Detection succeeded - show what was detected
	const typeLabels: Record<string, string> = {
		vite: "Vite",
		hono: "Hono API",
		sveltekit: "SvelteKit",
	};
	const typeLabel = typeLabels[detection.type] || detection.type;
	const configInfo = detection.configFile || detection.entryPoint || "";
	reporter.info(`Detected: ${typeLabel} project${configInfo ? ` (${configInfo})` : ""}`);

	// Step 7: Fetch username for URL preview (skip for dry run)
	let ownerUsername: string | null = null;
	if (!dryRun) {
		const { getCurrentUserProfile } = await import("./control-plane.ts");
		const profile = await getCurrentUserProfile();
		ownerUsername = profile?.username ?? null;
	}

	// Step 8: Get default project name and prompt user
	const defaultName = getDefaultProjectName(projectPath);

	if (!interactive) {
		// Non-interactive mode - use defaults
		const projectName = defaultName;
		const runjackUrl = ownerUsername
			? `https://${ownerUsername}-${projectName}.runjack.xyz`
			: `https://${projectName}.runjack.xyz`;

		reporter.info(`Project name: ${projectName}`);
		reporter.info(`Will deploy to: ${runjackUrl}`);

		// Generate and write wrangler config
		const wranglerConfig = generateWranglerConfig(
			detection.type,
			projectName,
			detection.entryPoint,
		);
		writeWranglerConfig(projectPath, wranglerConfig);
		reporter.success("Created wrangler.jsonc");

		// Skip cloud creation and linking for dry run
		if (dryRun) {
			track(Events.AUTO_DETECT_SUCCESS, { type: detection.type });
			return {
				projectName,
				projectId: null,
				deployMode: "managed",
			};
		}

		// Create managed project on jack cloud
		const remoteResult = await createManagedProjectRemote(projectName, reporter, {
			usePrebuilt: false,
		});

		// Link project locally (include username for correct URL display)
		await linkProject(projectPath, remoteResult.projectId, "managed", ownerUsername ?? undefined);
		await registerPath(remoteResult.projectId, projectPath);

		track(Events.AUTO_DETECT_SUCCESS, { type: detection.type });

		return {
			projectName,
			projectId: remoteResult.projectId,
			deployMode: "managed",
		};
	}

	// Interactive mode - prompt for project name
	const { isCancel, text } = await import("@clack/prompts");

	console.error("");
	const projectNameInput = await text({
		message: "Project name:",
		defaultValue: defaultName,
	});

	if (isCancel(projectNameInput)) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, "Deployment cancelled", undefined, {
			exitCode: 0,
			reported: true,
		});
	}

	const projectName = projectNameInput;

	const slugifiedName = slugify(projectName.trim());
	const runjackUrl = ownerUsername
		? `https://${ownerUsername}-${slugifiedName}.runjack.xyz`
		: `https://${slugifiedName}.runjack.xyz`;

	// Confirmation prompt
	console.error("");
	console.error("  This will:");
	console.error("    - Create wrangler.jsonc");
	console.error("    - Create project on jack cloud");
	console.error(`    - Deploy to ${runjackUrl}`);
	console.error("");

	const { promptSelect } = await import("./hooks.ts");
	const choice = await promptSelect(["Continue", "Cancel"]);

	if (choice !== 0) {
		track(Events.AUTO_DETECT_REJECTED, { reason: "user_cancelled" });
		throw new JackError(JackErrorCode.VALIDATION_ERROR, "Deployment cancelled", undefined, {
			exitCode: 0,
			reported: true,
		});
	}

	// Generate and write wrangler config
	const wranglerConfig = generateWranglerConfig(
		detection.type,
		slugifiedName,
		detection.entryPoint,
	);
	writeWranglerConfig(projectPath, wranglerConfig);
	reporter.success("Created wrangler.jsonc");

	// Skip cloud creation and linking for dry run
	if (dryRun) {
		track(Events.AUTO_DETECT_SUCCESS, { type: detection.type });
		return {
			projectName: slugifiedName,
			projectId: null,
			deployMode: "managed",
		};
	}

	// Create managed project on jack cloud
	const remoteResult = await createManagedProjectRemote(slugifiedName, reporter, {
		usePrebuilt: false,
	});

	// Link project locally (include username for correct URL display)
	await linkProject(projectPath, remoteResult.projectId, "managed", ownerUsername ?? undefined);
	await registerPath(remoteResult.projectId, projectPath);

	track(Events.AUTO_DETECT_SUCCESS, { type: detection.type });

	return {
		projectName: slugifiedName,
		projectId: remoteResult.projectId,
		deployMode: "managed",
	};
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
	// CI mode: JACK_CI env or standard CI env
	const isCi =
		process.env.JACK_CI === "1" ||
		process.env.JACK_CI === "true" ||
		process.env.CI === "true" ||
		process.env.CI === "1";
	const interactive = interactiveOption ?? !isCi;

	// Track timings for each step (shown with --debug)
	const timings: Array<{ label: string; duration: number }> = [];

	// Fast local validation first - check directory before any network calls
	const nameWasProvided = name !== undefined;
	if (nameWasProvided) {
		const targetDir = resolve(name);
		if (existsSync(targetDir)) {
			throw new JackError(JackErrorCode.VALIDATION_ERROR, `Directory ${name} already exists`);
		}
	}

	// Check if jack init was run (throws if not)
	const { isInitialized } = await import("../commands/init.ts");
	const initialized = await isInitialized();
	if (!initialized) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, "jack is not set up yet", "Run: jack init");
	}

	// Auth gate - check/prompt for authentication before any work
	timerStart("auth-gate");
	const { ensureAuthForCreate } = await import("./auth/ensure-auth.ts");
	const authResult = await ensureAuthForCreate({
		interactive,
		forceManaged: options.managed,
		forceByo: options.byo,
	});
	timings.push({ label: "Auth gate", duration: timerEnd("auth-gate") });

	// Use authResult.mode (auth gate handles mode resolution)
	const deployMode = authResult.mode;

	// Close the "Starting..." spinner from new.ts
	reporter.stop();
	if (deployMode === "managed") {
		reporter.success("Connected to jack cloud");
	} else {
		reporter.success("Ready");
	}

	// Generate or use provided name
	const projectName = name ?? generateProjectName();
	const targetDir = resolve(projectName);

	// Check directory doesn't exist (only needed for auto-generated names now)
	if (!nameWasProvided && existsSync(targetDir)) {
		throw new JackError(JackErrorCode.VALIDATION_ERROR, `Directory ${projectName} already exists`);
	}

	// Early slug availability check for managed mode (only if user provided explicit name)
	// Skip for auto-generated names - collision is rare, control plane will catch it anyway
	if (deployMode === "managed" && nameWasProvided) {
		timerStart("slug-check");
		reporter.start("Checking name availability...");

		// First check if the slug is available globally (includes system-reserved names)
		const { checkSlugAvailability } = await import("./control-plane.ts");
		const slugCheck = await checkSlugAvailability(projectName);

		if (slugCheck.available) {
			timings.push({ label: "Slug check", duration: timerEnd("slug-check") });
			reporter.stop();
			reporter.success("Name available");
		} else {
			// Slug not available - check if it's the user's own project
			const { checkAvailability } = await import("./project-resolver.ts");
			const { existingProject } = await checkAvailability(projectName);
			timings.push({ label: "Slug check", duration: timerEnd("slug-check") });
			reporter.stop();

			if (existingProject?.sources.controlPlane && !existingProject.sources.filesystem) {
				// User's project exists on jack cloud but not locally - suggest clone
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					`Project "${projectName}" already exists on jack cloud`,
					`To download it: jack clone ${projectName}`,
				);
			} else if (existingProject) {
				// Project exists in registry with local path - it's truly taken by user
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					`Project "${projectName}" already exists`,
					`Try a different name: jack new ${projectName}-2`,
				);
			} else {
				// Slug taken but not by this user (reserved or another user's project)
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					`Name "${projectName}" is not available`,
					`Try a different name: jack new ${projectName}-2`,
				);
			}
		}
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
				const { promptSelectValue, isCancel } = await import("./hooks.ts");
				console.error("");
				console.error(`  No template matched for: "${intentPhrase}"`);
				console.error("");

				const choice = await promptSelectValue(
					"Select a template:",
					BUILTIN_TEMPLATES.map((t) => ({ value: t, label: t })),
				);

				if (isCancel(choice) || typeof choice !== "string") {
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
				const { promptSelectValue, isCancel } = await import("./hooks.ts");
				console.error("");
				console.error(`  Multiple templates matched: "${intentPhrase}"`);
				console.error("");

				const matchedNames = matches.map((m) => m.template);
				const choice = await promptSelectValue(
					"Select a template:",
					matchedNames.map((t) => ({ value: t, label: t })),
				);

				if (isCancel(choice) || typeof choice !== "string") {
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
	timerStart("template-load");
	let template: Template;
	let templateOrigin: TemplateOrigin;
	try {
		const resolved = await resolveTemplateWithOrigin(resolvedTemplate);
		template = resolved.template;
		templateOrigin = resolved.origin;
	} catch (err) {
		timerEnd("template-load");
		reporter.stop();
		const message = err instanceof Error ? err.message : String(err);
		throw new JackError(JackErrorCode.TEMPLATE_NOT_FOUND, message);
	}

	const rendered = renderTemplate(template, { name: projectName });
	timings.push({ label: "Template load", duration: timerEnd("template-load") });

	// Run preCreate hooks (for interactive secret collection, auto-generation, etc.)
	if (template.hooks?.preCreate?.length) {
		timerStart("pre-create-hooks");
		const hookContext = { projectName, projectDir: targetDir };
		const hookResult = await runHook(template.hooks.preCreate, hookContext, {
			interactive,
			output: reporter,
		});
		timings.push({ label: "Pre-create hooks", duration: timerEnd("pre-create-hooks") });

		if (!hookResult.success) {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				"Project setup incomplete",
				"Missing required configuration",
			);
		}
	}

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

			// Prompt user - single text input, empty/Esc to skip
			reporter.stop();
			const { isCancel, text } = await import("@clack/prompts");
			console.error("");
			console.error(`  ${optionalSecret.description}`);
			if (optionalSecret.setupUrl) {
				console.error(`  Get it at: \x1b[36m${optionalSecret.setupUrl}\x1b[0m`);
			}
			console.error("");

			const value = await text({
				message: `${optionalSecret.name}:`,
				placeholder: "paste value or press Esc to skip",
			});

			if (!isCancel(value) && value.trim()) {
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
			} else {
				reporter.info(`Skipped ${optionalSecret.name}`);
			}

			reporter.start("Creating project...");
		}
	}

	// Handle environment variables (non-secret configuration)
	let envVarsToUse: Record<string, string> = {};
	if (template.envVars?.length) {
		envVarsToUse = await promptEnvVars(template.envVars, targetDir, reporter, interactive);
	}

	// Track if we created the directory (for cleanup on failure)
	let directoryCreated = false;

	try {
		// Write all template files
		timerStart("file-write");
		for (const [filePath, content] of Object.entries(rendered.files)) {
			await Bun.write(join(targetDir, filePath), content);
			directoryCreated = true; // Directory now exists
		}

		// Preflight: check D1 capacity before spending time on installs (BYO only)
		reporter.stop();
		if (deployMode === "byo") {
			await preflightD1Capacity(targetDir, reporter, interactive);
		}
		reporter.start("Creating project...");

		// Write secrets and env vars files
		// - Secrets go to: .env, .dev.vars, .secrets.json (for wrangler bulk upload)
		// - Env vars go to: .env, .dev.vars only (not secrets.json - they're not secrets)
		const hasSecrets = Object.keys(secretsToUse).length > 0;
		const hasEnvVars = Object.keys(envVarsToUse).length > 0;

		if (hasSecrets || hasEnvVars) {
			// Combine secrets and env vars for .env and .dev.vars
			const allEnvVars = { ...secretsToUse, ...envVarsToUse };
			const envContent = generateEnvFile(allEnvVars);
			await Bun.write(join(targetDir, ".env"), envContent);
			await Bun.write(join(targetDir, ".dev.vars"), envContent);

			// Only write secrets to .secrets.json (for wrangler secret bulk)
			if (hasSecrets) {
				const jsonContent = generateSecretsJson(secretsToUse);
				await Bun.write(join(targetDir, ".secrets.json"), jsonContent);
			}

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
		timings.push({ label: "File write", duration: timerEnd("file-write") });

		// Generate agent context files
		let activeAgents = await getActiveAgents();
		if (activeAgents.length > 0) {
			const validation = await validateAgentPaths();

			if (validation.invalid.length > 0) {
				// Silently filter out agents with missing paths
				// User can run 'jack agents scan' to see/fix agent config
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

		// Parallel setup for managed mode: install + remote creation
		let remoteResult: ManagedCreateResult | undefined;
		let urlShownEarly = false;

		if (deployMode === "managed") {
			// Run install and remote creation in parallel
			timerStart("parallel-setup");
			reporter.start("Setting up project...");

			try {
				const result = await runParallelSetup(targetDir, projectName, {
					template: resolvedTemplate || "hello",
					usePrebuilt: templateOrigin.type === "builtin", // Only builtin templates have prebuilt bundles
					onRemoteReady: (remote) => {
						// Show URL immediately when prebuilt succeeds
						reporter.stop();
						reporter.success(`Live: ${remote.runjackUrl}`);
						reporter.start("Installing dependencies locally...");
						urlShownEarly = true;
					},
				});
				remoteResult = result.remoteResult;
				timings.push({ label: "Parallel setup", duration: timerEnd("parallel-setup") });
				reporter.stop();
				if (urlShownEarly) {
					reporter.success("Ready for local development");
				} else {
					reporter.success("Project setup complete");
				}
			} catch (err) {
				timerEnd("parallel-setup");
				reporter.stop();
				if (err instanceof JackError) {
					reporter.warn(err.suggestion ?? err.message);
					throw err;
				}
				throw err;
			}
		} else {
			// BYO mode: just install dependencies
			timerStart("bun-install");
			reporter.start("Installing dependencies...");

			const install = Bun.spawn(["bun", "install", "--prefer-offline"], {
				cwd: targetDir,
				stdout: "ignore",
				stderr: "ignore",
			});
			await install.exited;

			if (install.exitCode !== 0) {
				timerEnd("bun-install");
				reporter.stop();
				reporter.warn("Failed to install dependencies, run: bun install");
				throw new JackError(
					JackErrorCode.BUILD_FAILED,
					"Dependency installation failed",
					"Run: bun install",
					{ exitCode: 0, reported: hasReporter },
				);
			}

			timings.push({ label: "Bun install", duration: timerEnd("bun-install") });
			reporter.stop();
			reporter.success("Dependencies installed");
		}

		// Run pre-deploy hooks
		if (template.hooks?.preDeploy?.length) {
			const hookContext = { projectName, projectDir: targetDir };
			const hookResult = await runHook(template.hooks.preDeploy, hookContext, {
				interactive,
				output: reporter,
			});
			if (!hookResult.success) {
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

		let workerUrl: string | null = null;

		// Deploy based on mode
		timerStart("deploy");
		if (deployMode === "managed") {
			// Managed mode: remote was already created in parallel setup
			if (!remoteResult) {
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					"Managed project was not created",
					"This is an internal error - please report it",
				);
			}

			// Fetch username for link storage
			const { getCurrentUserProfile } = await import("./control-plane.ts");
			const profile = await getCurrentUserProfile();
			const ownerUsername = profile?.username ?? undefined;

			// Link project locally and register path
			try {
				await linkProject(targetDir, remoteResult.projectId, "managed", ownerUsername);
				await writeTemplateMetadata(targetDir, templateOrigin);
				await registerPath(remoteResult.projectId, targetDir);
			} catch (err) {
				reporter.warn("Could not save project link (deploy still works)");
				debug("Failed to link managed project:", err);
			}

			// Check if prebuilt deployment succeeded
			if (remoteResult.status === "live") {
				// Prebuilt succeeded - skip the fresh build
				workerUrl = remoteResult.runjackUrl;
				// Only show if not already shown by parallel setup
				if (!urlShownEarly) {
					reporter.success(`Deployed: ${workerUrl}`);
				}

				// Upload source snapshot for forking (prebuilt path needs this too)
				try {
					const { createSourceZip } = await import("./zip-packager.ts");
					const { uploadSourceSnapshot } = await import("./control-plane.ts");
					const { rm } = await import("node:fs/promises");

					const sourceZipPath = await createSourceZip(targetDir);
					await uploadSourceSnapshot(remoteResult.projectId, sourceZipPath);
					await rm(sourceZipPath, { force: true });
					debug("Source snapshot uploaded for prebuilt project");
				} catch (err) {
					debug(
						"Source snapshot upload failed (prebuilt):",
						err instanceof Error ? err.message : String(err),
					);
				}
			} else {
				// Prebuilt not available - fall back to fresh build
				if (remoteResult.prebuiltFailed) {
					// Show debug info about why prebuilt failed
					const errorDetail = remoteResult.prebuiltError ? ` (${remoteResult.prebuiltError})` : "";
					debug(`Prebuilt failed${errorDetail}`);
					reporter.info("Pre-built not available, building fresh...");
				}

				await deployToManagedProject(remoteResult.projectId, targetDir, reporter);
				workerUrl = remoteResult.runjackUrl;
				reporter.success(`Created: ${workerUrl}`);
			}
		} else {
			// BYO mode: deploy via wrangler

			// Build first if needed (wrangler needs built assets)
			if (await needsOpenNextBuild(targetDir)) {
				reporter.start("Building assets...");
				try {
					await runOpenNextBuild(targetDir);
					reporter.stop();
					reporter.success("Built assets");
				} catch (err) {
					reporter.stop();
					reporter.error("Build failed");
					throw err;
				}
			} else if (await needsViteBuild(targetDir)) {
				reporter.start("Building assets...");
				try {
					await runViteBuild(targetDir);
					reporter.stop();
					reporter.success("Built assets");
				} catch (err) {
					reporter.stop();
					reporter.error("Build failed");
					throw err;
				}
			}

			reporter.start("Deploying...");

			const deployResult = await runWranglerDeploy(targetDir);

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

			// Generate BYO project ID and link locally
			const byoProjectId = generateByoProjectId();

			// Link project locally and register path
			try {
				await linkProject(targetDir, byoProjectId, "byo");
				await writeTemplateMetadata(targetDir, templateOrigin);
				await registerPath(byoProjectId, targetDir);
			} catch (err) {
				reporter.warn("Could not save project link (deploy still works)");
				debug("Failed to link BYO project:", err);
			}
		}
		timings.push({ label: "Deploy", duration: timerEnd("deploy") });

		// Run post-deploy hooks (for both modes)
		if (template.hooks?.postDeploy?.length && workerUrl) {
			timerStart("post-deploy-hooks");
			const domain = workerUrl.replace(/^https?:\/\//, "");
			const hookResult = await runHook(
				template.hooks.postDeploy,
				{
					domain,
					url: workerUrl,
					projectName,
					projectDir: targetDir,
				},
				{ interactive, output: reporter },
			);
			timings.push({ label: "Post-deploy hooks", duration: timerEnd("post-deploy-hooks") });

			// Show final celebration if there were interactive prompts (URL might have scrolled away)
			if (hookResult.hadInteractiveActions && reporter.celebrate) {
				reporter.celebrate("You're live!", [workerUrl]);
			}
		}

		// Print timing summary (only shown with --debug)
		printTimingSummary(timings);

		return {
			projectName,
			targetDir,
			workerUrl,
			deployMode,
		};
	} catch (error) {
		// Clean up directory if we created it
		if (directoryCreated && existsSync(targetDir)) {
			try {
				const { rm } = await import("node:fs/promises");
				await rm(targetDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors - user will see directory exists on retry
			}
		}
		throw error;
	}
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
		dryRun = false,
	} = options;
	const reporter = providedReporter ?? noopReporter;
	const hasReporter = Boolean(providedReporter);
	// CI mode: JACK_CI env or standard CI env
	const isCi =
		process.env.JACK_CI === "1" ||
		process.env.JACK_CI === "true" ||
		process.env.CI === "true" ||
		process.env.CI === "1";
	const interactive = interactiveOption ?? !isCi;

	// Check for wrangler config
	const hasWranglerConfig =
		existsSync(join(projectPath, "wrangler.toml")) ||
		existsSync(join(projectPath, "wrangler.jsonc")) ||
		existsSync(join(projectPath, "wrangler.json"));

	// Check for existing project link
	const hasProjectLink = existsSync(join(projectPath, ".jack", "project.json"));

	// Auto-detect flow: no wrangler config and no project link
	let autoDetectResult: AutoDetectResult | null = null;
	if (!hasWranglerConfig && !hasProjectLink) {
		autoDetectResult = await runAutoDetectFlow(projectPath, reporter, interactive, dryRun);
	} else if (!hasWranglerConfig) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			"No wrangler config found in current directory",
			"Run: jack new <project-name>",
		);
	} else if (hasWranglerConfig && !hasProjectLink) {
		// Orphaned state: wrangler config exists but no project link
		// This happens when: linking failed during jack new, user has existing wrangler project,
		// or project was moved/copied without .jack directory
		const { isLoggedIn } = await import("./auth/store.ts");
		const loggedIn = await isLoggedIn();

		if (loggedIn && !options.byo) {
			// User is logged into Jack Cloud - create managed project
			const orphanedProjectName = await getProjectNameFromDir(projectPath);

			reporter.info(`Linking "${orphanedProjectName}" to jack cloud...`);

			// Get username for URL construction
			const { getCurrentUserProfile } = await import("./control-plane.ts");
			const profile = await getCurrentUserProfile();
			const ownerUsername = profile?.username ?? undefined;

			// Create managed project on jack cloud
			const remoteResult = await createManagedProjectRemote(orphanedProjectName, reporter, {
				usePrebuilt: false,
			});

			// Link project locally
			await linkProject(projectPath, remoteResult.projectId, "managed", ownerUsername);
			await registerPath(remoteResult.projectId, projectPath);

			// Set autoDetectResult so the rest of the flow uses managed mode
			autoDetectResult = {
				projectName: orphanedProjectName,
				projectId: remoteResult.projectId,
				deployMode: "managed",
			};

			reporter.success("Linked to jack cloud");
		} else if (!options.managed) {
			// BYO path - ensure wrangler auth before proceeding
			await ensureCloudflareAuth(interactive, reporter);

			// Create BYO link for tracking (non-blocking)
			const orphanedProjectName = await getProjectNameFromDir(projectPath);
			const byoProjectId = generateByoProjectId();

			try {
				await linkProject(projectPath, byoProjectId, "byo");
				await registerPath(byoProjectId, projectPath);
				debug("Created BYO project link for orphaned project");
			} catch (err) {
				debug("Failed to create BYO project link:", err);
			}
		}
	}

	// Get project name from directory (or auto-detect result)
	const projectName = autoDetectResult?.projectName ?? (await getProjectNameFromDir(projectPath));

	// Read local project link for stored mode and project ID
	const link = await readProjectLink(projectPath);

	// Determine effective mode: explicit flag > auto-detect > stored mode > default BYO
	let deployMode: DeployMode;
	if (options.managed) {
		deployMode = "managed";
	} else if (options.byo) {
		deployMode = "byo";
	} else if (autoDetectResult) {
		deployMode = autoDetectResult.deployMode;
	} else {
		deployMode = link?.deploy_mode ?? "byo";
	}

	// Ensure agent integration is set up (JACK.md, MCP config)
	// This is idempotent and runs silently
	try {
		await ensureAgentIntegration(projectPath, {
			projectName,
			silent: true,
		});
	} catch (err) {
		// Don't fail deploy if agent integration fails
		debug("Agent integration setup failed:", err);
	}

	// Ensure wrangler is installed (auto-install if needed)
	if (!dryRun) {
		let installSpinner: OperationSpinner | null = null;
		const wranglerReady = await ensureWranglerInstalled(() => {
			installSpinner = reporter.spinner("Installing dependencies...");
		});
		if (installSpinner) {
			if (wranglerReady) {
				(installSpinner as OperationSpinner).success("Dependencies installed");
			} else {
				(installSpinner as OperationSpinner).error("Failed to install dependencies");
			}
		}

		// Validate mode availability
		const modeError = await validateModeAvailability(deployMode);
		if (modeError) {
			throw new JackError(JackErrorCode.VALIDATION_ERROR, modeError);
		}
	}

	let workerUrl: string | null = null;
	let deployOutput: string | undefined;

	// Deploy based on mode
	if (deployMode === "managed") {
		// Managed mode: deploy via jack cloud
		// Use autoDetectResult.projectId if available, otherwise require existing link
		const managedProjectId = autoDetectResult?.projectId ?? link?.project_id;

		// For dry run, skip the project ID check since we didn't create a cloud project
		if (!dryRun && (!managedProjectId || (!autoDetectResult && link?.deploy_mode !== "managed"))) {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				"Project not linked to jack cloud",
				"Create a new managed project or use --byo",
			);
		}

		// Dry run: build for validation then stop before actual deployment
		// (deployToManagedProject handles its own build, so only build here for dry-run)
		if (dryRun) {
			if (await needsOpenNextBuild(projectPath)) {
				const buildSpin = reporter.spinner("Building assets...");
				try {
					await runOpenNextBuild(projectPath);
					buildSpin.success("Built assets");
				} catch (err) {
					buildSpin.error("Build failed");
					throw err;
				}
			} else if (await needsViteBuild(projectPath)) {
				const buildSpin = reporter.spinner("Building assets...");
				try {
					await runViteBuild(projectPath);
					buildSpin.success("Built assets");
				} catch (err) {
					buildSpin.error("Build failed");
					throw err;
				}
			}
			reporter.success("Dry run complete - config generated, build verified");
			return {
				workerUrl: null,
				projectName,
				deployMode,
			};
		}

		// deployToManagedProject now handles both template and code deploy
		await deployToManagedProject(managedProjectId as string, projectPath, reporter);

		// Construct URL with username if available
		workerUrl = link?.owner_username
			? `https://${link.owner_username}-${projectName}.runjack.xyz`
			: `https://${projectName}.runjack.xyz`;
	} else {
		// BYO mode: deploy via wrangler

		// Build first if needed (wrangler needs built assets)
		if (await needsOpenNextBuild(projectPath)) {
			const buildSpin = reporter.spinner("Building assets...");
			try {
				await runOpenNextBuild(projectPath);
				buildSpin.success("Built assets");
			} catch (err) {
				buildSpin.error("Build failed");
				throw err;
			}
		} else if (await needsViteBuild(projectPath)) {
			const buildSpin = reporter.spinner("Building assets...");
			try {
				await runViteBuild(projectPath);
				buildSpin.success("Built assets");
			} catch (err) {
				buildSpin.error("Build failed");
				throw err;
			}
		}

		// Dry run: stop before actual deployment
		if (dryRun) {
			reporter.success("Dry run complete - build verified");
			return {
				workerUrl: null,
				projectName,
				deployMode,
			};
		}

		// Check wrangler version for auto-provisioning (KV/R2/D1 without IDs)
		const config = await parseWranglerConfig(projectPath);
		const needsAutoProvision =
			config.kv_namespaces?.some((kv) => !kv.id) ||
			config.r2_buckets?.some((r2) => r2.bucket_name?.startsWith("jack-template-")) ||
			config.d1_databases?.some((d1) => !d1.database_id);

		if (needsAutoProvision) {
			try {
				const wranglerVersion = await getWranglerVersion();
				checkWranglerVersion(wranglerVersion);
			} catch (err) {
				if (err instanceof JackError) {
					throw err;
				}
			}
		}

		// Ensure Cloudflare auth before BYO deploy
		await ensureCloudflareAuth(interactive, reporter);

		const spin = reporter.spinner("Deploying...");
		const result = await runWranglerDeploy(projectPath);

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

	if (includeSecrets && interactive) {
		const detected = await detectSecrets(projectPath);
		const newSecrets = await filterNewSecrets(detected);

		if (newSecrets.length > 0) {
			await promptSaveSecrets(newSecrets);
		}
	}

	// Note: Auto-sync to User R2 was removed for managed mode.
	// Managed projects use control-plane source.zip for clone instead.
	// BYO users can run 'jack sync' manually if needed.

	// Ensure project is linked locally for discovery
	try {
		const existingLink = await readProjectLink(projectPath);
		if (!existingLink) {
			// Not linked yet - create link
			if (deployMode === "managed" && link?.project_id) {
				// Fetch username for link storage
				const { getCurrentUserProfile } = await import("./control-plane.ts");
				const profile = await getCurrentUserProfile();
				const ownerUsername = profile?.username ?? undefined;
				await linkProject(projectPath, link.project_id, "managed", ownerUsername);
				await registerPath(link.project_id, projectPath);
			} else {
				// BYO mode - generate new ID
				const byoProjectId = generateByoProjectId();
				await linkProject(projectPath, byoProjectId, "byo");
				await registerPath(byoProjectId, projectPath);
			}
		} else {
			// Already linked - just ensure path is registered
			await registerPath(existingLink.project_id, projectPath);
		}
	} catch {
		// Silent fail - registration is best-effort
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
 * @param projectPath - Project path (defaults to cwd, used for local status checks)
 * @returns Project status or null if not found
 */
export async function getProjectStatus(
	name?: string,
	projectPath?: string,
): Promise<ProjectStatus | null> {
	let projectName = name;
	const resolvedPath = projectPath ?? process.cwd();

	// If no name provided, try to get from project path or cwd
	if (!projectName) {
		try {
			projectName = await getProjectNameFromDir(resolvedPath);
		} catch {
			// Could not determine project name
			return null;
		}
	}

	// Read local project link
	const link = await readProjectLink(resolvedPath);

	// Check if local project exists at the resolved path
	const hasWranglerConfig =
		existsSync(join(resolvedPath, "wrangler.jsonc")) ||
		existsSync(join(resolvedPath, "wrangler.toml")) ||
		existsSync(join(resolvedPath, "wrangler.json"));
	const localExists = hasWranglerConfig;
	const localPath = localExists ? resolvedPath : null;

	// If no link and no local project, return null
	if (!link && !localExists) {
		return null;
	}

	// Check actual deployment status
	const [workerExists, manifest] = await Promise.all([
		checkWorkerExists(projectName),
		getRemoteManifest(projectName),
	]);
	const backedUp = manifest !== null;
	const backupFiles = manifest ? manifest.files.length : null;
	const backupLastSync = manifest ? manifest.lastSync : null;

	// Determine URL based on mode
	let workerUrl: string | null = null;
	if (link?.deploy_mode === "managed") {
		workerUrl = link.owner_username
			? `https://${link.owner_username}-${projectName}.runjack.xyz`
			: `https://${projectName}.runjack.xyz`;
	}

	// Get database name on-demand
	let dbName: string | null = null;
	if (link?.deploy_mode === "managed") {
		// For managed projects, fetch from control plane
		try {
			const { fetchProjectResources } = await import("./control-plane.ts");
			const resources = await fetchProjectResources(link.project_id);
			const d1 = resources.find((r) => r.resource_type === "d1");
			dbName = d1?.resource_name || null;
		} catch {
			// Ignore errors, dbName stays null
		}
	} else if (localExists) {
		// For BYO, parse from wrangler config
		try {
			const { parseWranglerResources } = await import("./resources.ts");
			const resources = await parseWranglerResources(resolvedPath);
			dbName = resources.d1?.name || null;
		} catch {
			// Ignore errors, dbName stays null
		}
	}

	return {
		name: projectName,
		localPath,
		workerUrl,
		lastDeployed: link?.linked_at ?? null,
		createdAt: link?.linked_at ?? null,
		accountId: null, // No longer stored in registry
		workerId: projectName,
		dbName,
		deployed: workerExists || !!workerUrl,
		local: localExists,
		backedUp,
		missing: false,
		backupFiles,
		backupLastSync,
	};
}

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Scan for stale project paths.
 * Checks for:
 * 1. Paths in the index that no longer have wrangler config (dir deleted/moved)
 * 2. Managed projects where the cloud project no longer exists (orphaned links)
 * Returns total project count and stale entries with reasons.
 */
export async function scanStaleProjects(): Promise<StaleProjectScan> {
	const allPaths = await getAllPaths();
	const projectIds = Object.keys(allPaths);
	const stale: StaleProject[] = [];
	let totalPaths = 0;

	// Get list of valid managed project IDs (if logged in)
	let validManagedIds: Set<string> = new Set();
	try {
		const { isLoggedIn } = await import("./auth/store.ts");
		if (await isLoggedIn()) {
			const managedProjects = await listManagedProjects();
			validManagedIds = new Set(managedProjects.map((p) => p.id));
		}
	} catch {
		// Control plane unavailable, skip orphan detection
	}

	for (const projectId of projectIds) {
		const paths = allPaths[projectId] || [];
		totalPaths += paths.length;

		for (const projectPath of paths) {
			// Check if path exists and has valid wrangler config
			const hasWranglerConfig =
				existsSync(join(projectPath, "wrangler.jsonc")) ||
				existsSync(join(projectPath, "wrangler.toml")) ||
				existsSync(join(projectPath, "wrangler.json"));

			if (!hasWranglerConfig) {
				// Type 1: No wrangler config at path (dir deleted/moved)
				const name = projectPath.split("/").pop() || projectId;
				stale.push({
					name,
					reason: "directory missing or no wrangler config",
					workerUrl: null,
				});
				continue;
			}

			// Check for Type 2: Managed project link pointing to deleted cloud project
			try {
				const link = await readProjectLink(projectPath);
				if (link?.deploy_mode === "managed" && validManagedIds.size > 0) {
					if (!validManagedIds.has(link.project_id)) {
						// Orphaned managed link - cloud project doesn't exist
						let name = projectPath.split("/").pop() || projectId;
						try {
							name = await getProjectNameFromDir(projectPath);
						} catch {
							// Use path basename as fallback
						}
						stale.push({
							name,
							reason: "cloud project deleted",
							workerUrl: null,
						});
					}
				}
			} catch {
				// Can't read link, skip
			}
		}
	}

	return { total: totalPaths, stale };
}

/**
 * Remove stale project entries by path
 * Unlinks and unregisters projects.
 * Returns the number of entries removed.
 */
export async function cleanupStaleProjects(names: string[]): Promise<number> {
	let removed = 0;

	// Get all paths to find matching projects
	const allPaths = await getAllPaths();

	for (const name of names) {
		// Find project ID by checking each path
		for (const [projectId, paths] of Object.entries(allPaths)) {
			for (const projectPath of paths || []) {
				const pathName = projectPath.split("/").pop();
				if (pathName === name) {
					// Unlink and unregister
					try {
						await unlinkProject(projectPath);
					} catch {
						// Path may not exist
					}
					await unregisterPath(projectId, projectPath);
					removed += 1;
				}
			}
		}
	}

	return removed;
}

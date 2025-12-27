import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";
import { JackError, JackErrorCode } from "./errors.ts";
import { parseJsonc } from "./jsonc.ts";
import type { OperationReporter } from "./project-operations.ts";

export interface BuildOutput {
	outDir: string;
	entrypoint: string;
	assetsDir: string | null;
	compatibilityDate: string;
	compatibilityFlags: string[];
	moduleFormat: "esm";
}

export interface BuildOptions {
	projectPath: string;
	reporter?: OperationReporter;
}

export interface WranglerConfig {
	main?: string;
	compatibility_date?: string;
	compatibility_flags?: string[];
	// Supported bindings
	d1_databases?: Array<{ binding: string; database_name?: string; database_id?: string }>;
	ai?: { binding?: string };
	assets?: {
		directory?: string;
		binding?: string;
		not_found_handling?: "single-page-application" | "404-page" | "none";
		html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
		run_worker_first?: boolean;
	};
	vars?: Record<string, string>;
	// Unsupported bindings (for validation)
	kv_namespaces?: unknown;
	durable_objects?: unknown;
	queues?: unknown;
	services?: unknown;
	r2_buckets?: unknown;
	hyperdrive?: unknown;
	vectorize?: unknown;
	browser?: unknown;
	mtls_certificates?: unknown;
}

/**
 * Parses wrangler.jsonc configuration from project directory
 * @param projectPath - Absolute path to project directory
 * @returns Parsed wrangler configuration
 */
export async function parseWranglerConfig(projectPath: string): Promise<WranglerConfig> {
	const wranglerPath = join(projectPath, "wrangler.jsonc");

	if (!existsSync(wranglerPath)) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"wrangler.jsonc not found",
			"Ensure your project has a wrangler.jsonc configuration file",
		);
	}

	const content = await readFile(wranglerPath, "utf-8");
	return parseJsonc<WranglerConfig>(content);
}

/**
 * Checks if project requires Vite build by detecting vite config files
 * @param projectPath - Absolute path to project directory
 * @returns true if vite.config.ts or vite.config.js exists
 */
export async function needsViteBuild(projectPath: string): Promise<boolean> {
	return (
		existsSync(join(projectPath, "vite.config.ts")) ||
		existsSync(join(projectPath, "vite.config.js")) ||
		existsSync(join(projectPath, "vite.config.mjs")) ||
		existsSync(join(projectPath, "vite.config.mts"))
	);
}

/**
 * Runs Vite build for the project
 * @param projectPath - Absolute path to project directory
 * @throws JackError if build fails
 */
export async function runViteBuild(projectPath: string): Promise<void> {
	// Try `bun run build` first (respects package.json scripts)
	const packageJsonPath = join(projectPath, "package.json");
	let buildCommand = "bunx vite build";

	if (existsSync(packageJsonPath)) {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
		if (packageJson.scripts?.build) {
			buildCommand = "bun run build";
		}
	}

	const buildResult = await $`${buildCommand.split(" ")}`.cwd(projectPath).nothrow().quiet();

	if (buildResult.exitCode !== 0) {
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Vite build failed",
			"Check your vite.config and source files for errors",
			{
				exitCode: buildResult.exitCode,
				stderr: buildResult.stderr.toString(),
			},
		);
	}
}

/**
 * Builds a Cloudflare Worker project using wrangler dry-run
 * @param options - Build options with project path and optional reporter
 * @returns BuildOutput containing build artifacts and metadata
 * @throws JackError if build fails
 */
export async function buildProject(options: BuildOptions): Promise<BuildOutput> {
	const { projectPath, reporter } = options;

	// Parse wrangler config first
	const config = await parseWranglerConfig(projectPath);

	// Check if Vite build is needed and run it
	const hasVite = await needsViteBuild(projectPath);
	if (hasVite) {
		reporter?.start("Building with Vite...");
		await runViteBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built with Vite");
	}

	// Create unique temp directory for build output
	const buildId = `jack-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const outDir = join(tmpdir(), buildId);
	await mkdir(outDir, { recursive: true });

	// Run wrangler dry-run to build without deploying
	reporter?.start("Building worker...");

	const dryRunResult = await $`wrangler deploy --dry-run --outdir=${outDir}`
		.cwd(projectPath)
		.nothrow()
		.quiet();

	if (dryRunResult.exitCode !== 0) {
		reporter?.stop();
		reporter?.error("Worker build failed");
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Worker build failed",
			"Check your wrangler.jsonc and worker code for errors",
			{
				exitCode: dryRunResult.exitCode,
				stderr: dryRunResult.stderr.toString(),
			},
		);
	}

	reporter?.stop();
	reporter?.success("Built worker");

	const entrypoint = await resolveEntrypoint(outDir, config.main);

	// Determine assets directory if configured
	let assetsDir: string | null = null;
	if (config.assets?.directory) {
		const assetsDirPath = join(projectPath, config.assets.directory);
		if (existsSync(assetsDirPath)) {
			assetsDir = assetsDirPath;
		}
	}

	return {
		outDir,
		entrypoint,
		assetsDir,
		compatibilityDate: config.compatibility_date || "2024-01-01",
		compatibilityFlags: config.compatibility_flags || [],
		moduleFormat: "esm",
	};
}

async function resolveEntrypoint(outDir: string, main?: string): Promise<string> {
	const candidates: string[] = [];

	if (main) {
		const base = basename(main).replace(/\.[^.]+$/, "");
		if (base) {
			candidates.push(`${base}.js`, `${base}.mjs`);
		}
	}

	candidates.push("index.js", "worker.js");

	for (const candidate of candidates) {
		if (existsSync(join(outDir, candidate))) {
			return candidate;
		}
	}

	const files = await readdir(outDir);
	const jsFiles = files.filter((file) => file.endsWith(".js"));
	if (jsFiles.length === 1) {
		return jsFiles[0] as string;
	}

	throw new JackError(
		JackErrorCode.BUILD_FAILED,
		"Could not determine build entrypoint",
		"Ensure wrangler outputs a single entry file (index.js or worker.js)",
	);
}

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";
import { JackError, JackErrorCode } from "./errors.ts";
import { parseJsonc } from "./jsonc.ts";
import type { OperationReporter } from "./project-operations.ts";

/**
 * Get the wrangler config file path for a project
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
	r2_buckets?: Array<{
		binding: string;
		bucket_name: string;
	}>;
	kv_namespaces?: Array<{
		binding: string;
		id?: string; // Optional - wrangler auto-provisions if missing
	}>;
	// Unsupported bindings (for validation)
	durable_objects?: unknown;
	queues?: unknown;
	services?: unknown;
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
 * Checks if project requires OpenNext build by detecting open-next config files
 * @param projectPath - Absolute path to project directory
 * @returns true if open-next.config.ts or open-next.config.js exists
 */
export async function needsOpenNextBuild(projectPath: string): Promise<boolean> {
	return (
		existsSync(join(projectPath, "open-next.config.ts")) ||
		existsSync(join(projectPath, "open-next.config.js"))
	);
}

/**
 * Runs Vite build for the project
 * @param projectPath - Absolute path to project directory
 * @throws JackError if build fails
 */
export async function runViteBuild(projectPath: string): Promise<void> {
	// Use local vite if installed to avoid module resolution issues
	// bunx vite installs to temp dir, but vite.config.js may require('vite') from node_modules
	// Don't use project's build script - it might do more than just vite build (e.g., Tauri)
	let buildCommand: string[];

	if (existsSync(join(projectPath, "node_modules", ".bin", "vite"))) {
		// Local vite installed - use it directly
		buildCommand = ["bun", "run", "vite", "build"];
	} else {
		// Fallback to bunx
		buildCommand = ["bunx", "vite", "build"];
	}

	const buildResult = await $`${buildCommand}`.cwd(projectPath).nothrow().quiet();

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
 * Runs OpenNext build for Next.js projects targeting Cloudflare
 * @param projectPath - Absolute path to project directory
 * @throws JackError if build fails
 */
export async function runOpenNextBuild(projectPath: string): Promise<void> {
	// OpenNext builds Next.js for Cloudflare Workers
	// Outputs to .open-next/worker.js and .open-next/assets/
	const buildResult = await $`bunx opennextjs-cloudflare build`.cwd(projectPath).nothrow().quiet();

	if (buildResult.exitCode !== 0) {
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"OpenNext build failed",
			"Check your next.config and source files for errors",
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

	// Check if OpenNext build is needed (Next.js + Cloudflare)
	const hasOpenNext = await needsOpenNextBuild(projectPath);
	if (hasOpenNext) {
		reporter?.start("Building assets...");
		await runOpenNextBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built assets");
	}

	// Check if Vite build is needed and run it (skip if OpenNext already built)
	const hasVite = await needsViteBuild(projectPath);
	if (hasVite && !hasOpenNext) {
		reporter?.start("Building assets...");
		await runViteBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built assets");
	}

	// Create unique temp directory for build output
	const buildId = `jack-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const outDir = join(tmpdir(), buildId);
	await mkdir(outDir, { recursive: true });

	// Run wrangler dry-run to build without deploying
	reporter?.start("Bundling runtime...");

	const configFile = getWranglerConfigPath(projectPath);
	const configArg = configFile ? ["--config", configFile] : [];
	const dryRunResult = await $`wrangler deploy ${configArg} --dry-run --outdir=${outDir}`
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
	reporter?.success("Bundled runtime");

	const entrypoint = await resolveEntrypoint(outDir, config.main);

	// Determine assets directory if configured
	let assetsDir: string | null = null;
	if (config.assets) {
		// Default to "dist" if assets binding exists but directory not specified (Vite convention)
		const directory = config.assets.directory || "dist";
		const assetsDirPath = join(projectPath, directory);
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

/**
 * Gets the installed wrangler version.
 * @returns Version string (e.g., "4.55.0")
 */
export async function getWranglerVersion(): Promise<string> {
	const result = await $`wrangler --version`.nothrow().quiet();
	if (result.exitCode !== 0) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"wrangler not found",
			"Install wrangler: npm install -g wrangler",
		);
	}
	// Parse "wrangler 4.55.0" -> "4.55.0"
	const match = result.stdout.toString().match(/(\d+\.\d+\.\d+)/);
	return match?.[1] ?? "0.0.0";
}

const MIN_WRANGLER_VERSION = "4.45.0";

/**
 * Checks if wrangler version meets minimum requirement for auto-provisioning.
 * @throws JackError if version is too old
 */
export function checkWranglerVersion(version: string): void {
	const parts = version.split(".").map(Number);
	const minParts = MIN_WRANGLER_VERSION.split(".").map(Number);

	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	const patch = parts[2] ?? 0;
	const minMajor = minParts[0] ?? 0;
	const minMinor = minParts[1] ?? 0;
	const minPatch = minParts[2] ?? 0;

	const isValid =
		major > minMajor ||
		(major === minMajor && minor > minMinor) ||
		(major === minMajor && minor === minMinor && patch >= minPatch);

	if (!isValid) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			`wrangler ${MIN_WRANGLER_VERSION}+ required (found ${version})`,
			"Run: npm install -g wrangler@latest",
		);
	}
}

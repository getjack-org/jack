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
	r2_buckets?: Array<{
		binding: string;
		bucket_name: string;
	}>;
	// Unsupported bindings (for validation)
	kv_namespaces?: unknown;
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
	// Jack controls the build for managed projects (omakase)
	// Users wanting tsc can run `bun run build` manually before shipping
	const buildResult = await $`bunx vite build`.cwd(projectPath).nothrow().quiet();

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
		reporter?.start("Building...");
		await runOpenNextBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built");
	}

	// Check if Vite build is needed and run it (skip if OpenNext already built)
	const hasVite = await needsViteBuild(projectPath);
	if (hasVite && !hasOpenNext) {
		reporter?.start("Building...");
		await runViteBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built");
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
 * Ensures R2 buckets exist for BYO deploy.
 * Creates buckets via wrangler if they don't exist.
 * @param projectPath - Absolute path to project directory
 * @returns Array of bucket names that were created or already existed
 */
export async function ensureR2Buckets(projectPath: string): Promise<string[]> {
	const config = await parseWranglerConfig(projectPath);

	if (!config.r2_buckets || config.r2_buckets.length === 0) {
		return [];
	}

	const results: string[] = [];

	for (const bucket of config.r2_buckets) {
		const bucketName = bucket.bucket_name;

		// Try to create the bucket (wrangler handles "already exists" gracefully)
		const result = await $`wrangler r2 bucket create ${bucketName}`
			.cwd(projectPath)
			.nothrow()
			.quiet();

		// Exit code 0 = created, non-zero with "already exists" = fine
		const stderr = result.stderr.toString();
		if (result.exitCode === 0 || stderr.includes("already exists")) {
			results.push(bucketName);
		} else {
			throw new JackError(
				JackErrorCode.RESOURCE_ERROR,
				`Failed to create R2 bucket: ${bucketName}`,
				"Check your Cloudflare account has R2 enabled",
				{ stderr },
			);
		}
	}

	return results;
}

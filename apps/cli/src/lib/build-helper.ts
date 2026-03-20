import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { $ } from "bun";
import type { ManagedAssetsConfigInput } from "@getjack/managed-deploy";
import { JackError, JackErrorCode } from "./errors.ts";
import { parseJsonc } from "./jsonc.ts";
import type { OperationReporter } from "./project-operations.ts";
import { findWranglerConfig } from "./wrangler-config.ts";

const BUILD_TIMEOUT_MS = 120_000;

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
	assets?: ManagedAssetsConfigInput;
	vars?: Record<string, string>;
	r2_buckets?: Array<{
		binding: string;
		bucket_name: string;
	}>;
	kv_namespaces?: Array<{
		binding: string;
		id?: string; // Optional - wrangler auto-provisions if missing
	}>;
	vectorize?: Array<{
		binding: string;
		index_name?: string;
		preset?: "cloudflare" | "cloudflare-small" | "cloudflare-large";
		dimensions?: number;
		metric?: "cosine" | "euclidean" | "dot-product";
	}>;
	durable_objects?: {
		bindings: Array<{
			name: string;
			class_name: string;
		}>;
	};
	migrations?: Array<{
		tag: string;
		new_sqlite_classes?: string[];
		deleted_classes?: string[];
		renamed_classes?: Array<{ from: string; to: string }>;
	}>;
	// Unsupported bindings (for validation)
	queues?: unknown;
	services?: unknown;
	hyperdrive?: unknown;
	browser?: unknown;
	mtls_certificates?: unknown;
}

/**
 * Parses wrangler.jsonc configuration from project directory
 * @param projectPath - Absolute path to project directory
 * @returns Parsed wrangler configuration
 */
export async function parseWranglerConfig(projectPath: string): Promise<WranglerConfig> {
	const wranglerPath = findWranglerConfig(projectPath);

	if (!wranglerPath) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			"wrangler config not found",
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
	let buildCommand: string[];

	if (existsSync(join(projectPath, "node_modules", ".bin", "vite"))) {
		buildCommand = ["bun", "run", "vite", "build"];
	} else {
		buildCommand = ["bunx", "vite", "build"];
	}

	const buildResult = await $`${buildCommand}`
		.cwd(projectPath)
		.nothrow()
		.quiet()
		.timeout(BUILD_TIMEOUT_MS);

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
	const buildResult = await $`bunx opennextjs-cloudflare build`
		.cwd(projectPath)
		.nothrow()
		.quiet()
		.timeout(BUILD_TIMEOUT_MS);

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

	let buildRan = false;

	// Check if OpenNext build is needed (Next.js + Cloudflare)
	const hasOpenNext = await needsOpenNextBuild(projectPath);
	if (hasOpenNext) {
		reporter?.start("Building assets...");
		await runOpenNextBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built assets");
		buildRan = true;
	}

	// Check if Vite build is needed and run it (skip if OpenNext already built)
	const hasVite = await needsViteBuild(projectPath);
	if (hasVite && !hasOpenNext) {
		reporter?.start("Building assets...");
		await runViteBuild(projectPath);
		reporter?.stop();
		reporter?.success("Built assets");
		buildRan = true;
	}

	// Fallback: if assets are configured but no framework build ran,
	// try running the project's package.json build script
	if (config.assets && !buildRan) {
		const ran = await runPackageJsonBuild(projectPath, config.assets, reporter);
		if (ran) buildRan = true;
	}

	// Create unique temp directory for build output
	const buildId = `jack-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const outDir = join(tmpdir(), buildId);
	await mkdir(outDir, { recursive: true });

	// Run wrangler dry-run to build without deploying
	reporter?.start("Bundling runtime...");

	const configFile = findWranglerConfig(projectPath);
	const configArg = configFile ? ["--config", configFile] : [];
	const dryRunResult = await $`wrangler deploy ${configArg} --dry-run --outdir=${outDir}`
		.cwd(projectPath)
		.nothrow()
		.quiet();

	if (dryRunResult.exitCode !== 0) {
		reporter?.stop();
		reporter?.error("Build failed");
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Build failed",
			"Check your code for syntax errors",
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

async function readPackageJsonScripts(dir: string): Promise<Record<string, string> | null> {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		const content = await readFile(pkgPath, "utf-8");
		const pkg = JSON.parse(content);
		return pkg.scripts ?? null;
	} catch {
		return null;
	}
}

async function runBuildScript(dir: string): Promise<void> {
	const result = await $`bun run build`.cwd(dir).nothrow().quiet().timeout(BUILD_TIMEOUT_MS);

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		const stdout = result.stdout.toString();
		// Include last 20 lines of stdout if stderr is empty (many build tools write errors to stdout)
		const output = stderr || stdout.split("\n").slice(-20).join("\n");
		throw new JackError(
			JackErrorCode.BUILD_FAILED,
			"Frontend build failed",
			"Check your build script and source files for errors",
			{ exitCode: result.exitCode, stderr: output },
		);
	}
}

function assetsAreFresh(projectPath: string, assets: ManagedAssetsConfigInput): boolean {
	const assetsDir = assets.directory || "dist";
	const assetsDirPath = resolve(projectPath, assetsDir);
	const sourceDir = resolve(projectPath, dirname(assetsDir));

	if (!existsSync(assetsDirPath)) return false;
	if (sourceDir === resolve(projectPath)) return false;

	try {
		const assetsMtime = statSync(assetsDirPath).mtimeMs;
		const srcDir = join(sourceDir, "src");
		const sourceMtime = existsSync(srcDir) ? statSync(srcDir).mtimeMs : statSync(sourceDir).mtimeMs;
		const pkgMtime = existsSync(join(sourceDir, "package.json"))
			? statSync(join(sourceDir, "package.json")).mtimeMs
			: 0;

		return assetsMtime > sourceMtime && assetsMtime > pkgMtime;
	} catch {
		return false;
	}
}

async function runPackageJsonBuild(
	projectPath: string,
	assets: ManagedAssetsConfigInput,
	reporter?: OperationReporter,
): Promise<boolean> {
	if (assetsAreFresh(projectPath, assets)) {
		return false;
	}

	// Check root package.json for a build script
	const rootScripts = await readPackageJsonScripts(projectPath);
	if (rootScripts?.build) {
		reporter?.start("Building frontend...");
		await runBuildScript(projectPath);
		reporter?.stop();
		reporter?.success("Built frontend");
		return true;
	}

	// Check assets directory's parent for its own package.json with a build script
	const assetsDir = assets.directory || "dist";
	const assetsParent = resolve(projectPath, dirname(assetsDir));
	if (assetsParent !== resolve(projectPath)) {
		const parentScripts = await readPackageJsonScripts(assetsParent);
		if (parentScripts?.build) {
			reporter?.start("Building frontend...");
			await runBuildScript(assetsParent);
			reporter?.stop();
			reporter?.success("Built frontend");
			return true;
		}
	}

	return false;
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

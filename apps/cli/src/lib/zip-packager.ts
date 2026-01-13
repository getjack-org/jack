import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import archiver from "archiver";
import { type AssetManifest, computeAssetHash } from "./asset-hash.ts";
import type { BuildOutput, WranglerConfig } from "./build-helper.ts";
import { scanProjectFiles } from "./storage/file-filter.ts";

export interface ZipPackageResult {
	bundleZipPath: string;
	sourceZipPath: string;
	manifestPath: string;
	schemaPath: string | null;
	secretsPath: string | null;
	assetsZipPath: string | null;
	assetManifest: AssetManifest | null;
	cleanup: () => Promise<void>;
}

export interface ManifestData {
	version: 1;
	entrypoint: string;
	compatibility_date: string;
	compatibility_flags?: string[];
	module_format: "esm";
	assets_dir?: string;
	built_at: string;
	bindings?: {
		d1?: { binding: string };
		ai?: { binding: string };
		assets?: {
			binding: string;
			directory: string;
			not_found_handling?: "single-page-application" | "404-page" | "none";
			html_handling?:
				| "auto-trailing-slash"
				| "force-trailing-slash"
				| "drop-trailing-slash"
				| "none";
		};
		vars?: Record<string, string>;
		r2?: Array<{ binding: string; bucket_name: string }>;
	};
}

/**
 * Creates a ZIP archive from source directory
 * @param outputPath - Absolute path for output ZIP file
 * @param sourceDir - Absolute path to directory to archive
 * @param files - Optional list of specific files to include (relative to sourceDir)
 * @returns Promise that resolves when ZIP is created
 */
async function createZipArchive(
	outputPath: string,
	sourceDir: string,
	files?: string[],
): Promise<void> {
	return new Promise((resolve, reject) => {
		const output = createWriteStream(outputPath);
		const archive = archiver("zip", { zlib: { level: 9 } });

		output.on("close", () => resolve());
		archive.on("error", (err) => reject(err));

		archive.pipe(output);

		if (files) {
			// Add specific files
			for (const file of files) {
				const filePath = join(sourceDir, file);
				archive.file(filePath, { name: file });
			}
		} else {
			// Add entire directory
			archive.directory(sourceDir, false);
		}

		archive.finalize();
	});
}

/**
 * Recursively collects all file paths in a directory
 */
async function collectAllFiles(dir: string, baseDir: string = dir): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectAllFiles(fullPath, baseDir)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}

	return files;
}

/**
 * Creates an asset manifest for all files in a directory.
 * Maps paths starting with "/" (e.g., "/index.html", "/assets/app.js")
 * to their content-addressable hashes.
 *
 * @param assetsDir - Absolute path to the assets directory
 * @returns Asset manifest mapping paths to hash entries
 */
export async function createAssetManifest(assetsDir: string): Promise<AssetManifest> {
	const allFiles = await collectAllFiles(assetsDir);

	const entries = await Promise.all(
		allFiles.map(async (filePath) => {
			const content = await readFile(filePath);
			const hash = await computeAssetHash(new Uint8Array(content), filePath);
			const fileStats = await stat(filePath);
			const relativePath = "/" + relative(assetsDir, filePath);
			return [relativePath, { hash, size: fileStats.size }] as const;
		}),
	);

	return Object.fromEntries(entries);
}

/**
 * Extracts binding intent from wrangler config for the manifest.
 * Returns undefined if no bindings are configured.
 */
function extractBindingsFromConfig(config?: WranglerConfig): ManifestData["bindings"] | undefined {
	if (!config) return undefined;

	const bindings: NonNullable<ManifestData["bindings"]> = {};

	// Extract D1 database binding (use first one if multiple)
	if (config.d1_databases && config.d1_databases.length > 0) {
		const firstDb = config.d1_databases[0];
		if (firstDb) {
			bindings.d1 = { binding: firstDb.binding };
		}
	}

	// Extract AI binding (default binding name: "AI")
	if (config.ai) {
		bindings.ai = { binding: config.ai.binding || "AI" };
	}

	// Extract assets binding (defaults: binding="ASSETS", directory="./dist")
	if (config.assets) {
		bindings.assets = {
			binding: config.assets.binding || "ASSETS",
			directory: config.assets.directory || "./dist",
			not_found_handling: config.assets.not_found_handling,
			html_handling: config.assets.html_handling,
		};
	}

	// Extract vars
	if (config.vars && Object.keys(config.vars).length > 0) {
		bindings.vars = config.vars;
	}

	// Extract R2 bucket bindings (support multiple)
	if (config.r2_buckets && config.r2_buckets.length > 0) {
		bindings.r2 = config.r2_buckets.map((bucket) => ({
			binding: bucket.binding,
			bucket_name: bucket.bucket_name,
		}));
	}

	// Return undefined if no bindings were extracted
	return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/**
 * Packages a built project for deployment to jack cloud
 * @param projectPath - Absolute path to project directory
 * @param buildOutput - Build output from buildProject()
 * @param config - Optional wrangler config to extract binding intent
 * @returns Package result with ZIP paths and cleanup function
 */
export async function packageForDeploy(
	projectPath: string,
	buildOutput: BuildOutput,
	config?: WranglerConfig,
): Promise<ZipPackageResult> {
	// Create temp directory for package artifacts
	const packageId = `jack-package-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const packageDir = join(tmpdir(), packageId);
	await mkdir(packageDir, { recursive: true });

	// Define artifact paths
	const bundleZipPath = join(packageDir, "bundle.zip");
	const sourceZipPath = join(packageDir, "source.zip");
	const manifestPath = join(packageDir, "manifest.json");

	// 1. Create bundle.zip from build output directory
	await createZipArchive(bundleZipPath, buildOutput.outDir);

	// 2. Create source.zip from project files (filtered)
	const projectFiles = await scanProjectFiles(projectPath);
	const sourceFiles = projectFiles.map((f) => f.path);
	await createZipArchive(sourceZipPath, projectPath, sourceFiles);

	// 3. Create manifest.json
	const manifest: ManifestData = {
		version: 1,
		entrypoint: buildOutput.entrypoint,
		compatibility_date: buildOutput.compatibilityDate,
		compatibility_flags:
			buildOutput.compatibilityFlags.length > 0 ? buildOutput.compatibilityFlags : undefined,
		module_format: "esm",
		assets_dir: buildOutput.assetsDir ? "assets" : undefined,
		built_at: new Date().toISOString(),
		bindings: extractBindingsFromConfig(config),
	};

	await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

	// 4. Check for optional files (schema.sql and .secrets.json)
	let schemaPath: string | null = null;
	const schemaSrcPath = join(projectPath, "schema.sql");
	if (existsSync(schemaSrcPath)) {
		schemaPath = join(packageDir, "schema.sql");
		await Bun.write(schemaPath, await readFile(schemaSrcPath));
	}

	let secretsPath: string | null = null;
	const secretsSrcPath = join(projectPath, ".secrets.json");
	if (existsSync(secretsSrcPath)) {
		secretsPath = join(packageDir, ".secrets.json");
		await Bun.write(secretsPath, await readFile(secretsSrcPath));
	}

	// 5. If assets directory exists, create assets.zip and asset manifest
	let assetsZipPath: string | null = null;
	let assetManifest: AssetManifest | null = null;
	if (buildOutput.assetsDir) {
		// Create zip and manifest in parallel for speed
		const [, manifest] = await Promise.all([
			createZipArchive(join(packageDir, "assets.zip"), buildOutput.assetsDir),
			createAssetManifest(buildOutput.assetsDir),
		]);
		assetsZipPath = join(packageDir, "assets.zip");
		assetManifest = manifest;
	}

	// Return package result with cleanup function
	return {
		bundleZipPath,
		sourceZipPath,
		manifestPath,
		schemaPath,
		secretsPath,
		assetsZipPath,
		assetManifest,
		cleanup: async () => {
			await rm(packageDir, { recursive: true, force: true });
			// Also cleanup build output directory
			await rm(buildOutput.outDir, { recursive: true, force: true });
		},
	};
}

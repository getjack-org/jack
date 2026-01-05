#!/usr/bin/env bun
/**
 * Pre-build templates and upload to R2 for fast project creation.
 *
 * Usage: bun run scripts/prebuild-templates.ts
 *
 * Uploads to: jack-code-internal/bundles/jack/{template}-v{version}/
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import {
	type BuildOutput,
	type WranglerConfig,
	buildProject,
	parseWranglerConfig,
} from "../apps/cli/src/lib/build-helper.ts";
import { packageForDeploy } from "../apps/cli/src/lib/zip-packager.ts";

const TEMPLATES = ["miniapp", "api", "hello"] as const;
const R2_BUCKET = "jack-code-internal";

interface TemplateMeta {
	template: string;
	version: string;
	built_at: string;
	maintained_by: string;
}

async function getCliVersion(): Promise<string> {
	const packageJsonPath = resolve(import.meta.dirname, "../apps/cli/package.json");
	const content = await readFile(packageJsonPath, "utf-8");
	const pkg = JSON.parse(content) as { version: string };
	return pkg.version;
}

async function uploadToR2(localPath: string, r2Key: string): Promise<void> {
	const result = await $`wrangler r2 object put ${R2_BUCKET}/${r2Key} --file ${localPath} --remote`
		.nothrow()
		.quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to upload ${r2Key}: ${result.stderr.toString()}`);
	}

	console.log(`  Uploaded: ${r2Key}`);
}

async function buildTemplate(template: string, version: string): Promise<void> {
	const templatePath = resolve(import.meta.dirname, `../apps/cli/templates/${template}`);

	if (!existsSync(templatePath)) {
		throw new Error(`Template not found: ${templatePath}`);
	}

	console.log(`\nBuilding template: ${template}`);

	// Install dependencies
	console.log("  Running bun install...");
	const installResult = await $`bun install`.cwd(templatePath).nothrow().quiet();
	if (installResult.exitCode !== 0) {
		throw new Error(`bun install failed for ${template}: ${installResult.stderr.toString()}`);
	}

	// Build the project
	console.log("  Building project...");
	const buildOutput: BuildOutput = await buildProject({
		projectPath: templatePath,
	});

	// Parse wrangler config for bindings
	const config: WranglerConfig = await parseWranglerConfig(templatePath);

	// Package for deploy
	console.log("  Packaging...");
	const packageResult = await packageForDeploy(templatePath, buildOutput, config);

	try {
		const r2Prefix = `bundles/jack/${template}-v${version}`;

		// Create meta.json
		const meta: TemplateMeta = {
			template,
			version,
			built_at: new Date().toISOString(),
			maintained_by: "jack-team",
		};

		const metaPath = join(tmpdir(), `${template}-meta.json`);
		await writeFile(metaPath, JSON.stringify(meta, null, 2));

		// Upload files to R2
		console.log("  Uploading to R2...");

		// Upload bundle.zip
		await uploadToR2(packageResult.bundleZipPath, `${r2Prefix}/bundle.zip`);

		// Upload assets.zip and asset-manifest.json if exists
		if (packageResult.assetsZipPath) {
			await uploadToR2(packageResult.assetsZipPath, `${r2Prefix}/assets.zip`);

			// Create and upload asset-manifest.json (precomputed hashes)
			if (packageResult.assetManifest) {
				const assetManifestPath = join(tmpdir(), `${template}-asset-manifest.json`);
				await writeFile(assetManifestPath, JSON.stringify(packageResult.assetManifest, null, 2));
				await uploadToR2(assetManifestPath, `${r2Prefix}/asset-manifest.json`);
				await rm(assetManifestPath, { force: true });
			}
		}

		// Upload manifest.json
		await uploadToR2(packageResult.manifestPath, `${r2Prefix}/manifest.json`);

		// Upload meta.json
		await uploadToR2(metaPath, `${r2Prefix}/meta.json`);

		// Cleanup temp meta file
		await rm(metaPath, { force: true });

		console.log(`  Completed: ${template} v${version}`);
	} finally {
		// Cleanup package artifacts
		await packageResult.cleanup();
	}
}

async function main(): Promise<void> {
	console.log("Pre-building jack templates");
	console.log("============================");

	const version = await getCliVersion();
	console.log(`CLI version: ${version}`);
	console.log(`R2 bucket: ${R2_BUCKET}`);
	console.log(`Templates: ${TEMPLATES.join(", ")}`);

	for (const template of TEMPLATES) {
		try {
			await buildTemplate(template, version);
		} catch (error) {
			console.error(`\nFailed to build template: ${template}`);
			if (error instanceof Error) {
				console.error(`  Error: ${error.message}`);
			}
			process.exit(1);
		}
	}

	console.log("\n============================");
	console.log("All templates built and uploaded successfully!");
	console.log("\nR2 paths:");
	for (const template of TEMPLATES) {
		console.log(`  ${R2_BUCKET}/bundles/jack/${template}-v${version}/`);
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});

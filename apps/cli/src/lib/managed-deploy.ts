/**
 * Managed deploy handler for jack cloud
 *
 * Isolates managed deployment logic from BYO (wrangler) path.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { validateBindings } from "./binding-validator.ts";
import { buildProject, parseWranglerConfig } from "./build-helper.ts";
import { createManagedProject, syncProjectTags } from "./control-plane.ts";
import { debug } from "./debug.ts";
import { uploadDeployment } from "./deploy-upload.ts";
import { ensureMigrations, ensureNodejsCompat } from "./do-config.ts";
import { validateDoExports } from "./do-export-validator.ts";
import { JackError, JackErrorCode } from "./errors.ts";
import { formatSize } from "./format.ts";
import { createFileCountProgress, createUploadProgress } from "./progress.ts";
import type { OperationReporter } from "./project-operations.ts";
import { getProjectTags } from "./tags.ts";
import { findTranscriptPath, uploadDeltaSessionTranscript } from "./session-transcript.ts";
import { Events, track, trackActivationIfFirst } from "./telemetry.ts";
import { findWranglerConfig } from "./wrangler-config.ts";
import { packageForDeploy } from "./zip-packager.ts";

export interface ManagedCreateResult {
	projectId: string;
	projectSlug: string;
	orgId: string;
	runjackUrl: string;
	status?: "live" | "created";
	prebuiltFailed?: boolean;
	prebuiltError?: string;
}

export interface ManagedCreateOptions {
	template?: string;
	usePrebuilt?: boolean;
	forkedFrom?: string;
}

/**
 * Create a project via the jack cloud control plane.
 *
 * This creates the remote project resource. Local files are created separately
 * by the main createProject() function.
 */
export async function createManagedProjectRemote(
	projectName: string,
	reporter?: OperationReporter,
	options?: ManagedCreateOptions,
): Promise<ManagedCreateResult> {
	reporter?.start("Creating managed project...");

	try {
		const result = await createManagedProject(projectName, {
			template: options?.template,
			usePrebuilt: options?.usePrebuilt ?? true,
			forkedFrom: options?.forkedFrom,
		});

		const runjackUrl = result.url || `https://${result.project.slug}.runjack.xyz`;

		reporter?.stop();
		reporter?.success("Created managed project");

		// Track managed project creation
		track(Events.MANAGED_PROJECT_CREATED, {});

		return {
			projectId: result.project.id,
			projectSlug: result.project.slug,
			orgId: result.project.org_id,
			runjackUrl,
			status: result.status,
			prebuiltFailed: result.prebuilt_failed,
			prebuiltError: result.prebuilt_error,
		};
	} catch (error) {
		reporter?.stop();
		throw error;
	}
}

export interface ManagedCodeDeployOptions {
	projectId: string;
	projectPath: string;
	reporter?: OperationReporter;
	message?: string;
}

/**
 * Deploy local code to a managed project via the control plane.
 *
 * This builds the project, packages artifacts, and uploads to jack cloud.
 */
export async function deployCodeToManagedProject(
	options: ManagedCodeDeployOptions,
): Promise<{ deploymentId: string; status: string; errorMessage: string | null }> {
	const { projectId, projectPath, reporter } = options;

	// Track deploy start
	track(Events.MANAGED_DEPLOY_STARTED, {});
	const startTime = Date.now();

	let pkg: Awaited<ReturnType<typeof packageForDeploy>> | null = null;

	try {
		let config = await parseWranglerConfig(projectPath);

		// Step 1: Build the project (must happen before validation, as build creates dist/)
		reporter?.start("Building project...");
		const buildOutput = await buildProject({ projectPath, reporter });

		// Step 1.5: Auto-fix DO prerequisites (after build so we have output to validate)
		if (config.durable_objects?.bindings?.length) {
			const configPath = findWranglerConfig(projectPath) ?? join(projectPath, "wrangler.jsonc");
			const fixes: string[] = [];

			const addedCompat = await ensureNodejsCompat(configPath, config);
			if (addedCompat) fixes.push("nodejs_compat");

			const migratedClasses = await ensureMigrations(configPath, config);
			if (migratedClasses.length > 0) fixes.push(`migrations for ${migratedClasses.join(", ")}`);

			if (fixes.length > 0) {
				config = await parseWranglerConfig(projectPath);
				reporter?.success(`Auto-configured: ${fixes.join(", ")}`);
			}

			// Validate DO class exports
			const missing = await validateDoExports(
				buildOutput.outDir,
				buildOutput.entrypoint,
				config.durable_objects.bindings.map((b) => b.class_name),
			);
			if (missing.length > 0) {
				throw new JackError(
					JackErrorCode.VALIDATION_ERROR,
					`Durable Object class${missing.length > 1 ? "es" : ""} not exported: ${missing.join(", ")}`,
					missing.map((c) => `Add "export" before "class ${c}" in your source code`).join("\n"),
				);
			}
		}

		// Step 2: Validate bindings are supported (after build, so assets dir exists)
		const validation = validateBindings(config, projectPath);
		if (!validation.valid) {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				validation.errors[0] || "Invalid bindings configuration",
				validation.errors.length > 1
					? `Additional errors:\n${validation.errors.slice(1).join("\n")}`
					: undefined,
			);
		}

		// Step 3: Package artifacts with file-count progress
		reporter?.stop(); // Stop reporter spinner, we'll use our own progress
		const packagingProgress = createFileCountProgress({ label: "Packaging" });
		packagingProgress.start();
		pkg = await packageForDeploy({
			projectPath,
			buildOutput,
			config,
			onProgress: (current, total) => packagingProgress.update(current, total),
		});
		packagingProgress.complete();
		reporter?.success("Packaged artifacts");

		// Step 4: Upload to control plane
		// Calculate total upload size for progress display
		const fileSizes = await Promise.all([
			stat(pkg.bundleZipPath).then((s) => s.size),
			stat(pkg.sourceZipPath).then((s) => s.size),
			stat(pkg.manifestPath).then((s) => s.size),
			pkg.schemaPath ? stat(pkg.schemaPath).then((s) => s.size) : Promise.resolve(0),
			pkg.secretsPath ? stat(pkg.secretsPath).then((s) => s.size) : Promise.resolve(0),
			pkg.assetsZipPath ? stat(pkg.assetsZipPath).then((s) => s.size) : Promise.resolve(0),
		]);
		const totalUploadSize = fileSizes.reduce((sum, size) => sum + size, 0);
		debug(`Upload size: ${formatSize(totalUploadSize)}`);

		// Stop the reporter spinner - we'll use our own progress display
		reporter?.stop();

		// Use custom progress with pulsing bar (since fetch doesn't support upload progress)
		const uploadProgress = createUploadProgress({
			totalSize: totalUploadSize,
			label: "Deploying to jack cloud",
		});
		uploadProgress.start();

		const result = await uploadDeployment({
			projectId,
			bundleZipPath: pkg.bundleZipPath,
			sourceZipPath: pkg.sourceZipPath,
			manifestPath: pkg.manifestPath,
			schemaPath: pkg.schemaPath ?? undefined,
			secretsPath: pkg.secretsPath ?? undefined,
			assetsZipPath: pkg.assetsZipPath ?? undefined,
			assetManifest: pkg.assetManifest ?? undefined,
			message: options.message,
		});

		uploadProgress.complete();
		reporter?.success("Deployed to jack cloud");

		// Track success
		track(Events.MANAGED_DEPLOY_COMPLETED, {
			duration_ms: Date.now() - startTime,
			project_id: projectId,
		});

		await trackActivationIfFirst("managed");

		// Fire-and-forget tag sync (non-blocking)
		getProjectTags(projectPath)
			.then((tags) => {
				if (tags.length > 0) {
					void syncProjectTags(projectId, tags);
				}
			})
			.catch(() => {});

		// Source snapshot for forking is now derived from deployment artifacts on the control plane.
		// No separate upload needed — clone/fork reads from the latest live deployment's source.zip.

		// Best-effort: upload Claude Code session transcript if running under Claude Code.
		// Uses findTranscriptPath() which checks env var first, then filesystem discovery.
		// Awaited so the upload completes before the process exits, but errors are silenced.
		const transcriptPath = findTranscriptPath(projectPath);
		if (transcriptPath) {
			await uploadDeltaSessionTranscript({
				projectId,
				deploymentId: result.id,
				transcriptPath,
				projectDir: projectPath,
			}).catch(() => {});
		}

		// Ensure Claude Code hooks are installed (retroactively for projects that missed initial install)
		await import("./claude-hooks-installer.ts")
			.then(({ installClaudeCodeHooks }) => installClaudeCodeHooks(projectPath))
			.catch(() => {});

		return {
			deploymentId: result.id,
			status: result.status,
			errorMessage: result.error_message,
		};
	} catch (error) {
		reporter?.stop();

		// Track failure
		track(Events.MANAGED_DEPLOY_FAILED, {
			duration_ms: Date.now() - startTime,
		});

		throw error;
	} finally {
		// Always cleanup temp files
		if (pkg) {
			await pkg.cleanup().catch(() => {});
		}
	}
}

/**
 * Deploy to a managed project via the control plane.
 */
export async function deployToManagedProject(
	projectId: string,
	projectPath: string,
	reporter?: OperationReporter,
	message?: string,
): Promise<{ deploymentId: string; status: string; errorMessage: string | null }> {
	return deployCodeToManagedProject({
		projectId,
		projectPath,
		reporter,
		message,
	});
}

/**
 * Managed deploy handler for jack cloud
 *
 * Isolates managed deployment logic from BYO (wrangler) path.
 */

import { validateBindings } from "./binding-validator.ts";
import { buildProject, parseWranglerConfig } from "./build-helper.ts";
import { createManagedProject, syncProjectTags } from "./control-plane.ts";
import { uploadDeployment } from "./deploy-upload.ts";
import { JackError, JackErrorCode } from "./errors.ts";
import type { OperationReporter } from "./project-operations.ts";
import { getProjectTags } from "./tags.ts";
import { Events, track } from "./telemetry.ts";
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
		});

		const runjackUrl = `https://${result.project.slug}.runjack.xyz`;

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
}

/**
 * Deploy local code to a managed project via the control plane.
 *
 * This builds the project, packages artifacts, and uploads to jack cloud.
 */
export async function deployCodeToManagedProject(
	options: ManagedCodeDeployOptions,
): Promise<{ deploymentId: string; status: string }> {
	const { projectId, projectPath, reporter } = options;

	// Track deploy start
	track(Events.MANAGED_DEPLOY_STARTED, {});
	const startTime = Date.now();

	let pkg: Awaited<ReturnType<typeof packageForDeploy>> | null = null;

	try {
		const config = await parseWranglerConfig(projectPath);

		// Step 1: Build the project (must happen before validation, as build creates dist/)
		reporter?.start("Building project...");
		const buildOutput = await buildProject({ projectPath, reporter });

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

		// Step 3: Package artifacts
		reporter?.start("Packaging artifacts...");
		pkg = await packageForDeploy(projectPath, buildOutput, config);
		reporter?.stop();
		reporter?.success("Packaged artifacts");

		// Step 4: Upload to control plane
		reporter?.start("Uploading to jack cloud...");
		const result = await uploadDeployment({
			projectId,
			bundleZipPath: pkg.bundleZipPath,
			sourceZipPath: pkg.sourceZipPath,
			manifestPath: pkg.manifestPath,
			schemaPath: pkg.schemaPath ?? undefined,
			secretsPath: pkg.secretsPath ?? undefined,
			assetsZipPath: pkg.assetsZipPath ?? undefined,
			assetManifest: pkg.assetManifest ?? undefined,
		});

		reporter?.stop();
		reporter?.success("Deployed to jack cloud");

		// Track success
		track(Events.MANAGED_DEPLOY_COMPLETED, {
			duration_ms: Date.now() - startTime,
		});

		// Fire-and-forget tag sync (non-blocking)
		getProjectTags(projectPath)
			.then((tags) => {
				if (tags.length > 0) {
					void syncProjectTags(projectId, tags);
				}
			})
			.catch(() => {});

		return {
			deploymentId: result.id,
			status: result.status,
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
): Promise<{ deploymentId: string; status: string }> {
	return deployCodeToManagedProject({
		projectId,
		projectPath,
		reporter,
	});
}

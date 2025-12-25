/**
 * Managed deploy handler for jack cloud
 *
 * Isolates managed deployment logic from BYO (wrangler) path.
 */

import { validateBindings } from "./binding-validator.ts";
import { buildProject, parseWranglerConfig } from "./build-helper.ts";
import { createManagedProject } from "./control-plane.ts";
import { uploadDeployment } from "./deploy-upload.ts";
import { JackError, JackErrorCode } from "./errors.ts";
import type { OperationReporter } from "./project-operations.ts";
import { Events, track } from "./telemetry.ts";
import { packageForDeploy } from "./zip-packager.ts";

export interface ManagedCreateResult {
	projectId: string;
	projectSlug: string;
	orgId: string;
	runjackUrl: string;
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
): Promise<ManagedCreateResult> {
	reporter?.start("Creating managed project...");

	try {
		const result = await createManagedProject(projectName);

		const runjackUrl = `https://${result.project.slug}.runjack.xyz`;

		reporter?.stop();
		reporter?.success(`Created: ${runjackUrl}`);

		// Track managed project creation
		track(Events.MANAGED_PROJECT_CREATED, {});

		return {
			projectId: result.project.id,
			projectSlug: result.project.slug,
			orgId: result.project.org_id,
			runjackUrl,
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

		// Validate bindings are supported
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

		// Step 1: Build the project
		reporter?.start("Building project...");
		const buildOutput = await buildProject({ projectPath, reporter });

		// Step 2: Package artifacts
		reporter?.start("Packaging artifacts...");
		pkg = await packageForDeploy(projectPath, buildOutput, config);

		// Step 3: Upload to control plane
		reporter?.start("Uploading to jack cloud...");
		const result = await uploadDeployment({
			projectId,
			bundleZipPath: pkg.bundleZipPath,
			sourceZipPath: pkg.sourceZipPath,
			manifestPath: pkg.manifestPath,
			schemaPath: pkg.schemaPath ?? undefined,
			secretsPath: pkg.secretsPath ?? undefined,
			assetsZipPath: pkg.assetsZipPath ?? undefined,
		});

		reporter?.stop();
		reporter?.success("Deployed to jack cloud");

		// Track success
		track(Events.MANAGED_DEPLOY_COMPLETED, {
			duration_ms: Date.now() - startTime,
		});

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

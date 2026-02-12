/**
 * Upload deployment artifacts to control plane via multipart form-data
 */

import { readFile } from "node:fs/promises";
import type { AssetManifest } from "./asset-hash.ts";
import { authFetch } from "./auth/index.ts";
import { getControlApiUrl } from "./control-plane.ts";
import { debug } from "./debug.ts";
import { formatSize } from "./format.ts";

export interface DeployUploadOptions {
	projectId: string;
	bundleZipPath: string;
	sourceZipPath: string;
	manifestPath: string;
	schemaPath?: string;
	secretsPath?: string;
	assetsZipPath?: string;
	assetManifest?: AssetManifest;
	message?: string;
}

export interface DeployUploadResult {
	id: string;
	project_id: string;
	status: "queued" | "building" | "live" | "failed";
	source: string;
	error_message: string | null;
	created_at: string;
}

/**
 * Upload deployment artifacts via multipart/form-data
 */
export async function uploadDeployment(options: DeployUploadOptions): Promise<DeployUploadResult> {
	const formData = new FormData();
	let totalSize = 0;

	const prepareStart = Date.now();

	// Read files and add to form data
	const manifestContent = await readFile(options.manifestPath);
	formData.append(
		"manifest",
		new Blob([manifestContent], { type: "application/json" }),
		"manifest.json",
	);
	totalSize += manifestContent.length;

	const bundleContent = await readFile(options.bundleZipPath);
	formData.append("bundle", new Blob([bundleContent], { type: "application/zip" }), "bundle.zip");
	totalSize += bundleContent.length;
	debug(`  bundle.zip: ${formatSize(bundleContent.length)}`);

	const sourceContent = await readFile(options.sourceZipPath);
	formData.append("source", new Blob([sourceContent], { type: "application/zip" }), "source.zip");
	totalSize += sourceContent.length;
	debug(`  source.zip: ${formatSize(sourceContent.length)}`);

	// Optional files
	if (options.schemaPath) {
		const schemaContent = await readFile(options.schemaPath);
		formData.append("schema", new Blob([schemaContent], { type: "text/sql" }), "schema.sql");
		totalSize += schemaContent.length;
		debug(`  schema.sql: ${formatSize(schemaContent.length)}`);
	}

	if (options.secretsPath) {
		const secretsContent = await readFile(options.secretsPath);
		formData.append(
			"secrets",
			new Blob([secretsContent], { type: "application/json" }),
			"secrets.json",
		);
		totalSize += secretsContent.length;
	}

	if (options.assetsZipPath) {
		const assetsContent = await readFile(options.assetsZipPath);
		formData.append("assets", new Blob([assetsContent], { type: "application/zip" }), "assets.zip");
		totalSize += assetsContent.length;
		debug(`  assets.zip: ${formatSize(assetsContent.length)}`);
	}

	if (options.assetManifest) {
		const manifestJson = JSON.stringify(options.assetManifest);
		formData.append(
			"asset-manifest",
			new Blob([manifestJson], { type: "application/json" }),
			"asset-manifest.json",
		);
		totalSize += manifestJson.length;
	}

	if (options.message) {
		formData.append("message", options.message);
	}

	const prepareMs = Date.now() - prepareStart;
	debug(`Payload ready: ${formatSize(totalSize)} (${prepareMs}ms)`);

	// POST to control plane
	const url = `${getControlApiUrl()}/v1/projects/${options.projectId}/deployments/upload`;
	debug(`POST ${url}`);

	const uploadStart = Date.now();
	const response = await authFetch(url, {
		method: "POST",
		body: formData,
	});
	const uploadMs = Date.now() - uploadStart;
	debug(`Response: ${response.status} (${(uploadMs / 1000).toFixed(1)}s)`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
			error?: string;
		};

		// Provide actionable error for orphaned local links
		if (response.status === 404 && err.error === "not_found") {
			throw new Error(
				"Project not found in jack cloud. The local link may be orphaned.\nFix: jack unlink && jack ship",
			);
		}

		throw new Error(err.message || `Upload failed: ${response.status}`);
	}

	return response.json() as Promise<DeployUploadResult>;
}

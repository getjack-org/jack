/**
 * Upload deployment artifacts to control plane via multipart form-data
 */

import { readFile } from "node:fs/promises";
import type { AssetManifest } from "./asset-hash.ts";
import { authFetch } from "./auth/index.ts";
import { getControlApiUrl } from "./control-plane.ts";

export interface DeployUploadOptions {
	projectId: string;
	bundleZipPath: string;
	sourceZipPath: string;
	manifestPath: string;
	schemaPath?: string;
	secretsPath?: string;
	assetsZipPath?: string;
	assetManifest?: AssetManifest;
}

export interface DeployUploadResult {
	id: string;
	project_id: string;
	status: "queued" | "building" | "live" | "failed";
	source: string;
	created_at: string;
}

/**
 * Upload deployment artifacts via multipart/form-data
 */
export async function uploadDeployment(options: DeployUploadOptions): Promise<DeployUploadResult> {
	const formData = new FormData();

	// Read files and add to form data
	const manifestContent = await readFile(options.manifestPath);
	formData.append(
		"manifest",
		new Blob([manifestContent], { type: "application/json" }),
		"manifest.json",
	);

	const bundleContent = await readFile(options.bundleZipPath);
	formData.append("bundle", new Blob([bundleContent], { type: "application/zip" }), "bundle.zip");

	const sourceContent = await readFile(options.sourceZipPath);
	formData.append("source", new Blob([sourceContent], { type: "application/zip" }), "source.zip");

	// Optional files
	if (options.schemaPath) {
		const schemaContent = await readFile(options.schemaPath);
		formData.append("schema", new Blob([schemaContent], { type: "text/sql" }), "schema.sql");
	}

	if (options.secretsPath) {
		const secretsContent = await readFile(options.secretsPath);
		formData.append(
			"secrets",
			new Blob([secretsContent], { type: "application/json" }),
			"secrets.json",
		);
	}

	if (options.assetsZipPath) {
		const assetsContent = await readFile(options.assetsZipPath);
		formData.append("assets", new Blob([assetsContent], { type: "application/zip" }), "assets.zip");
	}

	if (options.assetManifest) {
		formData.append(
			"asset-manifest",
			new Blob([JSON.stringify(options.assetManifest)], { type: "application/json" }),
			"asset-manifest.json",
		);
	}

	// POST to control plane
	const url = `${getControlApiUrl()}/v1/projects/${options.projectId}/deployments/upload`;
	const response = await authFetch(url, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new Error(err.message || `Upload failed: ${response.status}`);
	}

	return response.json() as Promise<DeployUploadResult>;
}

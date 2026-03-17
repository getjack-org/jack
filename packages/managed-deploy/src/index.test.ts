import { describe, expect, it } from "bun:test";
import {
	CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION,
	type ManagedAssetsConfigInput,
	getManagedAssetsUploadConfig,
	normalizeManagedAssetsBinding,
	shouldRunWorkerFirstForPath,
	validateManagedAssetsConfigInput,
	validateManagedDeploymentManifest,
} from "./index.ts";

describe("managed deploy manifest contract", () => {
	it("normalizes supported assets config into the manifest binding shape", () => {
		const assets: ManagedAssetsConfigInput = {
			binding: "ASSETS",
			directory: "./dist/client",
			html_handling: "none",
			not_found_handling: "single-page-application",
			run_worker_first: ["/*", "!/assets/*"],
		};

		expect(normalizeManagedAssetsBinding(assets)).toEqual({
			binding: "ASSETS",
			directory: "./dist/client",
			html_handling: "none",
			not_found_handling: "single-page-application",
			run_worker_first: ["/*", "!/assets/*"],
		});
	});

	it("rejects unsupported wrangler assets fields", () => {
		const validation = validateManagedAssetsConfigInput({
			directory: "./dist/client",
			binding: "ASSETS",
			_headers: "./_headers",
		});

		expect(validation.valid).toBe(false);
		expect(validation.errors[0]).toContain("is not supported");
	});

	it("accepts boolean and array run_worker_first values", () => {
		expect(
			validateManagedAssetsConfigInput({
				directory: "./dist/client",
				run_worker_first: true,
			}).valid,
		).toBe(true);

		expect(
			validateManagedAssetsConfigInput({
				directory: "./dist/client",
				run_worker_first: ["/*", "!/assets/*"],
			}).valid,
		).toBe(true);
	});

	it("returns exact upload config for current manifests", () => {
		const manifest = {
			version: CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION,
			entrypoint: "worker.js",
			compatibility_date: "2026-03-14",
			module_format: "esm" as const,
			built_at: "2026-03-14T00:00:00.000Z",
			bindings: {
				assets: {
					binding: "ASSETS",
					directory: "./dist/client",
					run_worker_first: ["/*", "!/assets/*"],
				},
			},
		};

		expect(getManagedAssetsUploadConfig(manifest)).toEqual({
			run_worker_first: ["/*", "!/assets/*"],
			html_handling: undefined,
			not_found_handling: undefined,
		});
	});

	it("replays legacy default routing only for legacy manifests", () => {
		const manifest = {
			version: 1 as const,
			entrypoint: "worker.js",
			compatibility_date: "2026-03-14",
			module_format: "esm" as const,
			built_at: "2026-03-14T00:00:00.000Z",
			bindings: {
				assets: {
					binding: "ASSETS",
					directory: "./dist/client",
					run_worker_first: true,
				},
			},
		};

		expect(getManagedAssetsUploadConfig(manifest)).toEqual({
			html_handling: "auto-trailing-slash",
			not_found_handling: "single-page-application",
			run_worker_first: true,
		});
	});

	it("validates current manifests with supported asset routing config", () => {
		const validation = validateManagedDeploymentManifest({
			version: CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION,
			entrypoint: "worker.js",
			compatibility_date: "2026-03-14",
			module_format: "esm",
			built_at: "2026-03-14T00:00:00.000Z",
			bindings: {
				assets: {
					binding: "ASSETS",
					directory: "./dist/client",
					not_found_handling: "single-page-application",
					run_worker_first: ["/*", "!/assets/*"],
				},
			},
		});

		expect(validation.valid).toBe(true);
		expect(validation.errors).toEqual([]);
	});

	it("matches run_worker_first path rules", () => {
		expect(shouldRunWorkerFirstForPath(true, "/")).toBe(true);
		expect(shouldRunWorkerFirstForPath(["/*", "!/assets/*"], "/")).toBe(true);
		expect(shouldRunWorkerFirstForPath(["/*", "!/assets/*"], "/index.html")).toBe(true);
		expect(shouldRunWorkerFirstForPath(["/*", "!/assets/*"], "/assets/app.js")).toBe(false);
		expect(shouldRunWorkerFirstForPath(undefined, "/")).toBe(false);
	});
});

export const LEGACY_MANAGED_DEPLOYMENT_MANIFEST_VERSION = 1 as const;
export const CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION = 2 as const;

export type ManagedDeploymentManifestVersion =
	| typeof LEGACY_MANAGED_DEPLOYMENT_MANIFEST_VERSION
	| typeof CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION;

export type ManagedAssetsNotFoundHandling = "single-page-application" | "404-page" | "none";
export type ManagedAssetsHtmlHandling =
	| "auto-trailing-slash"
	| "force-trailing-slash"
	| "drop-trailing-slash"
	| "none";

export interface ManagedAssetsConfigInput {
	directory?: string;
	binding?: string;
	not_found_handling?: ManagedAssetsNotFoundHandling;
	html_handling?: ManagedAssetsHtmlHandling;
	run_worker_first?: boolean | string[];
}

export interface ManagedAssetsBinding {
	binding: string;
	directory: string;
	not_found_handling?: ManagedAssetsNotFoundHandling;
	html_handling?: ManagedAssetsHtmlHandling;
	run_worker_first?: boolean | string[];
}

export interface ManagedDeploymentManifest {
	version: ManagedDeploymentManifestVersion;
	entrypoint: string;
	compatibility_date: string;
	compatibility_flags?: string[];
	module_format: "esm";
	assets_dir?: string;
	built_at: string;
	bindings?: ManagedManifestBindings;
	migrations?: Array<{
		tag: string;
		new_sqlite_classes?: string[];
		deleted_classes?: string[];
		renamed_classes?: Array<{ from: string; to: string }>;
	}>;
}

export interface ManagedManifestBindings {
	d1?: { binding: string };
	ai?: { binding: string };
	assets?: ManagedAssetsBinding;
	vars?: Record<string, string>;
	r2?: Array<{ binding: string; bucket_name: string }>;
	kv?: Array<{ binding: string }>;
	vectorize?: Array<{
		binding: string;
		preset?: string;
		dimensions?: number;
		metric?: string;
	}>;
	durable_objects?: Array<{
		binding: string;
		class_name: string;
	}>;
}

export interface ManagedAssetsUploadConfig {
	html_handling?: ManagedAssetsHtmlHandling;
	not_found_handling?: ManagedAssetsNotFoundHandling;
	run_worker_first?: boolean | string[];
}

export interface ManifestValidationResult {
	valid: boolean;
	errors: string[];
}

export const SUPPORTED_MANAGED_ASSET_KEYS = [
	"binding",
	"directory",
	"html_handling",
	"not_found_handling",
	"run_worker_first",
] as const;

export const SUPPORTED_MANAGED_BINDING_KEYS = [
	"d1",
	"ai",
	"r2",
	"kv",
	"vectorize",
	"assets",
	"vars",
	"durable_objects",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateRunWorkerFirst(
	value: unknown,
	field: string,
	errors: string[],
): value is boolean | string[] | undefined {
	if (value === undefined) return true;
	if (typeof value === "boolean") return true;
	if (isStringArray(value)) return true;
	errors.push(`${field} must be a boolean or string[]`);
	return false;
}

export function validateManagedAssetsConfigInput(
	assets: unknown,
	fieldPrefix = "assets",
): ManifestValidationResult {
	const errors: string[] = [];

	if (assets === undefined) {
		return { valid: true, errors };
	}

	if (!isRecord(assets)) {
		return { valid: false, errors: [`${fieldPrefix} must be an object`] };
	}

	for (const key of Object.keys(assets)) {
		if (!SUPPORTED_MANAGED_ASSET_KEYS.includes(key as (typeof SUPPORTED_MANAGED_ASSET_KEYS)[number])) {
			errors.push(
				`${fieldPrefix}.${key} is not supported in Jack managed deploy. Supported fields: ${SUPPORTED_MANAGED_ASSET_KEYS.map((name) => `${fieldPrefix}.${name}`).join(", ")}`,
			);
		}
	}

	if (assets.binding !== undefined && typeof assets.binding !== "string") {
		errors.push(`${fieldPrefix}.binding must be a string`);
	}

	if (assets.directory !== undefined && typeof assets.directory !== "string") {
		errors.push(`${fieldPrefix}.directory must be a string`);
	}

	if (
		assets.not_found_handling !== undefined &&
		assets.not_found_handling !== "single-page-application" &&
		assets.not_found_handling !== "404-page" &&
		assets.not_found_handling !== "none"
	) {
		errors.push(
			`${fieldPrefix}.not_found_handling must be one of: single-page-application, 404-page, none`,
		);
	}

	if (
		assets.html_handling !== undefined &&
		assets.html_handling !== "auto-trailing-slash" &&
		assets.html_handling !== "force-trailing-slash" &&
		assets.html_handling !== "drop-trailing-slash" &&
		assets.html_handling !== "none"
	) {
		errors.push(
			`${fieldPrefix}.html_handling must be one of: auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none`,
		);
	}

	validateRunWorkerFirst(assets.run_worker_first, `${fieldPrefix}.run_worker_first`, errors);

	return { valid: errors.length === 0, errors };
}

export function normalizeManagedAssetsBinding(
	assets: ManagedAssetsConfigInput,
): ManagedAssetsBinding {
	return {
		binding: assets.binding || "ASSETS",
		directory: assets.directory || "./dist",
		...(assets.not_found_handling !== undefined && {
			not_found_handling: assets.not_found_handling,
		}),
		...(assets.html_handling !== undefined && {
			html_handling: assets.html_handling,
		}),
		...(assets.run_worker_first !== undefined && {
			run_worker_first: assets.run_worker_first,
		}),
	};
}

function validateManagedAssetsBinding(
	assets: unknown,
	fieldPrefix: string,
	errors: string[],
): assets is ManagedAssetsBinding {
	const validation = validateManagedAssetsConfigInput(assets, fieldPrefix);
	errors.push(...validation.errors);

	if (!isRecord(assets)) {
		return false;
	}

	if (typeof assets.binding !== "string") {
		errors.push(`${fieldPrefix}.binding must be a string`);
	}

	if (typeof assets.directory !== "string") {
		errors.push(`${fieldPrefix}.directory must be a string`);
	}

	return errors.length === 0;
}

export function validateManagedDeploymentManifest(manifest: unknown): ManifestValidationResult {
	const errors: string[] = [];

	if (!isRecord(manifest)) {
		return { valid: false, errors: ["Manifest must be a valid object"] };
	}

	if (
		manifest.version !== LEGACY_MANAGED_DEPLOYMENT_MANIFEST_VERSION &&
		manifest.version !== CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION
	) {
		errors.push(
			`manifest.version must be ${LEGACY_MANAGED_DEPLOYMENT_MANIFEST_VERSION} or ${CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION}`,
		);
	}

	if (typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0) {
		errors.push("manifest.entrypoint is required");
	}

	if (
		typeof manifest.compatibility_date !== "string" ||
		manifest.compatibility_date.length === 0
	) {
		errors.push("manifest.compatibility_date is required");
	}

	if (manifest.bindings !== undefined) {
		if (!isRecord(manifest.bindings)) {
			errors.push("manifest.bindings must be an object if present");
		} else {
			for (const key of Object.keys(manifest.bindings)) {
				if (
					!SUPPORTED_MANAGED_BINDING_KEYS.includes(
						key as (typeof SUPPORTED_MANAGED_BINDING_KEYS)[number],
					)
				) {
					errors.push(
						`Unsupported binding type in manifest: ${key}. Managed deploy supports: ${SUPPORTED_MANAGED_BINDING_KEYS.join(", ")}`,
					);
				}
			}

			if (manifest.bindings.d1 !== undefined) {
				const d1 = manifest.bindings.d1;
				if (!isRecord(d1) || typeof d1.binding !== "string") {
					errors.push("manifest.bindings.d1.binding must be a string");
				}
			}

			if (manifest.bindings.ai !== undefined) {
				const ai = manifest.bindings.ai;
				if (!isRecord(ai) || typeof ai.binding !== "string") {
					errors.push("manifest.bindings.ai.binding must be a string");
				}
			}

			if (manifest.bindings.r2 !== undefined) {
				if (!Array.isArray(manifest.bindings.r2)) {
					errors.push("manifest.bindings.r2 must be an array");
				} else {
					for (const [index, r2] of manifest.bindings.r2.entries()) {
						if (!isRecord(r2)) {
							errors.push(`manifest.bindings.r2[${index}] must be an object`);
							continue;
						}
						if (typeof r2.binding !== "string") {
							errors.push(`manifest.bindings.r2[${index}].binding must be a string`);
						}
						if (typeof r2.bucket_name !== "string") {
							errors.push(
								`manifest.bindings.r2[${index}].bucket_name must be a string`,
							);
						}
					}
				}
			}

			if (manifest.bindings.kv !== undefined) {
				if (!Array.isArray(manifest.bindings.kv)) {
					errors.push("manifest.bindings.kv must be an array");
				} else {
					for (const [index, kv] of manifest.bindings.kv.entries()) {
						if (!isRecord(kv)) {
							errors.push(`manifest.bindings.kv[${index}] must be an object`);
							continue;
						}
						if (typeof kv.binding !== "string") {
							errors.push(`manifest.bindings.kv[${index}].binding must be a string`);
						}
					}
				}
			}

			if (manifest.bindings.vectorize !== undefined) {
				if (!Array.isArray(manifest.bindings.vectorize)) {
					errors.push("manifest.bindings.vectorize must be an array");
				} else {
					for (const [index, vec] of manifest.bindings.vectorize.entries()) {
						if (!isRecord(vec)) {
							errors.push(`manifest.bindings.vectorize[${index}] must be an object`);
							continue;
						}
						if (typeof vec.binding !== "string") {
							errors.push(
								`manifest.bindings.vectorize[${index}].binding must be a string`,
							);
						}
						if (vec.preset !== undefined && typeof vec.preset !== "string") {
							errors.push(
								`manifest.bindings.vectorize[${index}].preset must be a string`,
							);
						}
						if (vec.dimensions !== undefined && typeof vec.dimensions !== "number") {
							errors.push(
								`manifest.bindings.vectorize[${index}].dimensions must be a number`,
							);
						}
						if (vec.metric !== undefined && typeof vec.metric !== "string") {
							errors.push(
								`manifest.bindings.vectorize[${index}].metric must be a string`,
							);
						}
					}
				}
			}

			if (manifest.bindings.durable_objects !== undefined) {
				if (!Array.isArray(manifest.bindings.durable_objects)) {
					errors.push("manifest.bindings.durable_objects must be an array");
				} else {
					for (const [index, dob] of manifest.bindings.durable_objects.entries()) {
						if (!isRecord(dob)) {
							errors.push(
								`manifest.bindings.durable_objects[${index}] must be an object`,
							);
							continue;
						}
						if (typeof dob.binding !== "string") {
							errors.push(
								`manifest.bindings.durable_objects[${index}].binding must be a string`,
							);
						}
						if (typeof dob.class_name !== "string") {
							errors.push(
								`manifest.bindings.durable_objects[${index}].class_name must be a string`,
							);
						}
						if (typeof dob.binding === "string" && dob.binding.startsWith("__JACK_")) {
							errors.push(
								`manifest.bindings.durable_objects[${index}].binding uses reserved __JACK_ prefix`,
							);
						}
						if (
							typeof dob.class_name === "string" &&
							dob.class_name.startsWith("__JACK_")
						) {
							errors.push(
								`manifest.bindings.durable_objects[${index}].class_name uses reserved __JACK_ prefix`,
							);
						}
					}
				}
			}

			if (manifest.bindings.assets !== undefined) {
				validateManagedAssetsBinding(
					manifest.bindings.assets,
					"manifest.bindings.assets",
					errors,
				);
			}

			if (manifest.bindings.vars !== undefined) {
				if (!isRecord(manifest.bindings.vars)) {
					errors.push("manifest.bindings.vars must be an object");
				} else {
					for (const [key, value] of Object.entries(manifest.bindings.vars)) {
						if (typeof value !== "string") {
							errors.push(`manifest.bindings.vars.${key} must be a string`);
						}
					}
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

export function usesExactManagedAssetsSemantics(manifest: ManagedDeploymentManifest): boolean {
	return manifest.version >= CURRENT_MANAGED_DEPLOYMENT_MANIFEST_VERSION;
}

export function getManagedAssetsUploadConfig(
	manifest: ManagedDeploymentManifest,
): ManagedAssetsUploadConfig | undefined {
	const assets = manifest.bindings?.assets;
	if (!assets) return undefined;

	if (usesExactManagedAssetsSemantics(manifest)) {
		return {
			html_handling: assets.html_handling,
			not_found_handling: assets.not_found_handling,
			run_worker_first: assets.run_worker_first,
		};
	}

	return {
		html_handling: assets.html_handling ?? "auto-trailing-slash",
		not_found_handling: assets.not_found_handling ?? "single-page-application",
		run_worker_first: assets.run_worker_first,
	};
}

function escapeRouteRule(rule: string): string {
	return rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
}

function matchesRouteRule(rule: string, path: string): boolean {
	return new RegExp(`^${escapeRouteRule(rule)}$`).test(path);
}

export function shouldRunWorkerFirstForPath(
	runWorkerFirst: ManagedAssetsBinding["run_worker_first"],
	path: string,
): boolean {
	if (typeof runWorkerFirst === "boolean") {
		return runWorkerFirst;
	}

	if (!runWorkerFirst || runWorkerFirst.length === 0) {
		return false;
	}

	let matched = false;
	let shouldRunWorkerFirst = false;

	for (const rawRule of runWorkerFirst) {
		const negative = rawRule.startsWith("!");
		const rule = negative ? rawRule.slice(1) : rawRule;
		if (!matchesRouteRule(rule, path)) continue;
		matched = true;
		shouldRunWorkerFirst = !negative;
	}

	return matched ? shouldRunWorkerFirst : false;
}

import type { ManagedAssetsBinding } from "@getjack/managed-deploy";
import { shouldRunWorkerFirstForPath } from "@getjack/managed-deploy";

export const ROUTING_VERIFICATION_REQUEST_HEADER = "X-Jack-Verify-Route";
export const ROUTING_VERIFICATION_RESPONSE_HEADER = "X-Jack-Worker-Reached";

const API_CANDIDATE_PATHS = ["/api/ping", "/api/health", "/health", "/_health", "/api"] as const;

export interface RoutingVerificationTarget {
	kind: "document" | "asset" | "api";
	path: string;
	headers?: Record<string, string>;
	expectedWorkerReached: boolean | null;
}

export interface RoutingVerificationProbe {
	kind: RoutingVerificationTarget["kind"];
	path: string;
	expected_worker_reached: boolean | null;
	worker_reached: boolean;
	status?: number;
	error?: string;
}

export interface RoutingVerificationRecord {
	checked_at: string;
	base_url: string;
	warnings: string[];
	probes: RoutingVerificationProbe[];
}

export function listAssetPathsFromManifest(assetManifest?: Record<string, unknown>): string[] {
	if (!assetManifest) return [];
	return Object.keys(assetManifest).sort();
}

export function listAssetPathsFromZipEntries(entries: Iterable<string>): string[] {
	return [...entries]
		.map((path) => (path.startsWith("/") ? path : `/${path}`))
		.sort();
}

export function pickDocumentPath(assetPaths: string[]): string | null {
	if (assetPaths.includes("/index.html")) {
		return "/index.html";
	}

	return assetPaths.find((path) => path.endsWith(".html")) ?? null;
}

export function pickStaticAssetPath(assetPaths: string[]): string | null {
	return (
		assetPaths.find((path) => !path.endsWith(".html") && !path.endsWith("/")) ?? null
	);
}

function expectedWorkerReached(
	runWorkerFirst: ManagedAssetsBinding["run_worker_first"],
	path: string,
): boolean | null {
	if (runWorkerFirst === undefined) return null;
	return shouldRunWorkerFirstForPath(runWorkerFirst, path);
}

export function buildRoutingVerificationTargets(
	assets: ManagedAssetsBinding,
	assetPaths: string[],
): RoutingVerificationTarget[] {
	const targets: RoutingVerificationTarget[] = [
		{
			kind: "document",
			path: "/",
			headers: { Accept: "text/html" },
			expectedWorkerReached: expectedWorkerReached(assets.run_worker_first, "/"),
		},
	];

	const documentPath = pickDocumentPath(assetPaths);
	if (documentPath && documentPath !== "/") {
		targets.push({
			kind: "document",
			path: documentPath,
			headers: { Accept: "text/html" },
			expectedWorkerReached: expectedWorkerReached(assets.run_worker_first, documentPath),
		});
	}

	const staticAssetPath = pickStaticAssetPath(assetPaths);
	if (staticAssetPath) {
		targets.push({
			kind: "asset",
			path: staticAssetPath,
			expectedWorkerReached: expectedWorkerReached(assets.run_worker_first, staticAssetPath),
		});
	}

	for (const path of API_CANDIDATE_PATHS) {
		targets.push({
			kind: "api",
			path,
			expectedWorkerReached: null,
		});
	}

	return targets;
}

export function summarizeRoutingVerification(record: RoutingVerificationRecord): string | null {
	if (record.warnings.length === 0) return null;
	return `Routing verification warnings: ${record.warnings.join(" | ")}`;
}

export function describeProbeMismatch(probe: RoutingVerificationProbe): string | null {
	if (probe.expected_worker_reached === null) return null;
	if (probe.error) {
		return `${probe.path} could not be verified (${probe.error})`;
	}
	if (probe.worker_reached !== probe.expected_worker_reached) {
		const expected = probe.expected_worker_reached ? "worker" : "assets";
		const actual = probe.worker_reached ? "worker" : "assets";
		return `${probe.path} expected ${expected} but reached ${actual}`;
	}
	return null;
}

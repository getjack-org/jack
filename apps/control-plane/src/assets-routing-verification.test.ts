import { describe, expect, it } from "bun:test";
import {
	buildRoutingVerificationTargets,
	describeProbeMismatch,
	pickDocumentPath,
	pickStaticAssetPath,
	summarizeRoutingVerification,
} from "./assets-routing-verification.ts";

describe("assets routing verification helpers", () => {
	it("selects document and static asset paths from the asset set", () => {
		const assetPaths = ["/index.html", "/assets/app.js", "/favicon.ico"];

		expect(pickDocumentPath(assetPaths)).toBe("/index.html");
		expect(pickStaticAssetPath(assetPaths)).toBe("/assets/app.js");
	});

	it("builds targets with worker-first expectations from run_worker_first rules", () => {
		const targets = buildRoutingVerificationTargets(
			{
				binding: "ASSETS",
				directory: "./dist/client",
				run_worker_first: ["/*", "!/assets/*"],
			},
			["/index.html", "/assets/app.js"],
		);

		expect(targets[0]).toMatchObject({
			path: "/",
			expectedWorkerReached: true,
		});
		expect(targets[1]).toMatchObject({
			path: "/index.html",
			expectedWorkerReached: true,
		});
		expect(targets[2]).toMatchObject({
			path: "/assets/app.js",
			expectedWorkerReached: false,
		});
	});

	it("describes mismatches and summarizes warnings", () => {
		const warning = describeProbeMismatch({
			kind: "document",
			path: "/",
			expected_worker_reached: true,
			worker_reached: false,
			status: 200,
		});

		expect(warning).toBe("/ expected worker but reached assets");
		expect(
			summarizeRoutingVerification({
				checked_at: "2026-03-14T00:00:00.000Z",
				base_url: "https://example.runjack.xyz",
				warnings: [warning!],
				probes: [],
			}),
		).toContain("Routing verification warnings");
	});
});

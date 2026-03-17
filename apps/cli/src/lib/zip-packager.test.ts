import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildOutput, WranglerConfig } from "./build-helper.ts";
import { packageForDeploy } from "./zip-packager.ts";

let testDir: string;

function writeProjectFixture(config: WranglerConfig): { projectPath: string; buildOutput: BuildOutput } {
	const projectPath = join(testDir, "project");
	const outDir = join(testDir, "out");
	const assetsDir = join(projectPath, "public");

	mkdirSync(projectPath, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	mkdirSync(join(assetsDir, "assets"), { recursive: true });

	writeFileSync(join(outDir, "worker.js"), "export default { fetch() { return new Response('ok'); } };");
	writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>probe</title>");
	writeFileSync(join(assetsDir, "assets", "probe.txt"), "asset-probe");

	return {
		projectPath,
		buildOutput: {
			outDir,
			entrypoint: "worker.js",
			assetsDir,
			compatibilityDate: "2026-03-14",
			compatibilityFlags: [],
			moduleFormat: "esm",
		},
	};
}

describe("zip-packager", () => {
	beforeEach(() => {
		testDir = join(tmpdir(), `zip-packager-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("preserves boolean assets.run_worker_first in the deployment manifest", async () => {
		const config: WranglerConfig = {
			main: "src/worker.ts",
			compatibility_date: "2026-03-14",
			assets: {
				binding: "ASSETS",
				directory: "./public",
				run_worker_first: true,
			},
		};
		const { projectPath, buildOutput } = writeProjectFixture(config);
		const pkg = await packageForDeploy({ projectPath, buildOutput, config });

		try {
			const manifest = JSON.parse(await Bun.file(pkg.manifestPath).text()) as {
				bindings?: { assets?: { run_worker_first?: boolean | string[] } };
			};
			expect(manifest.bindings?.assets?.run_worker_first).toBe(true);
		} finally {
			await pkg.cleanup();
		}
	});

	it("preserves array assets.run_worker_first in the deployment manifest", async () => {
		const rules = ["/*", "!/assets/*"];
		const config: WranglerConfig = {
			main: "src/worker.ts",
			compatibility_date: "2026-03-14",
			assets: {
				binding: "ASSETS",
				directory: "./public",
				run_worker_first: rules,
			},
		};
		const { projectPath, buildOutput } = writeProjectFixture(config);
		const pkg = await packageForDeploy({ projectPath, buildOutput, config });

		try {
			const manifest = JSON.parse(await Bun.file(pkg.manifestPath).text()) as {
				bindings?: { assets?: { run_worker_first?: boolean | string[] } };
			};
			expect(manifest.bindings?.assets?.run_worker_first).toEqual(rules);
		} finally {
			await pkg.cleanup();
		}
	});
});

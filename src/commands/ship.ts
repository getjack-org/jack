import { existsSync } from "node:fs";
import { basename } from "node:path";
import { $ } from "bun";
import { getSyncConfig } from "../lib/config.ts";
import { detectSecrets } from "../lib/env-parser.ts";
import { error, info, spinner, success, warn } from "../lib/output.ts";
import { filterNewSecrets, promptSaveSecrets } from "../lib/prompts.ts";
import { applySchema, getD1DatabaseName, hasD1Config } from "../lib/schema.ts";
import { getProjectNameFromDir, syncToCloud } from "../lib/storage/index.ts";

function hasWranglerConfig(): boolean {
	return (
		existsSync("./wrangler.toml") || existsSync("./wrangler.jsonc") || existsSync("./wrangler.json")
	);
}

function isViteProject(): boolean {
	return (
		existsSync("./vite.config.ts") ||
		existsSync("./vite.config.js") ||
		existsSync("./vite.config.mjs")
	);
}

async function getProjectName(): Promise<string> {
	const configPaths = ["./wrangler.jsonc", "./wrangler.json", "./wrangler.toml"];

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = await Bun.file(configPath).text();
				// For JSON/JSONC - strip comments and parse
				if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
					const cleaned = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
					const config = JSON.parse(cleaned);
					if (config.name) return config.name;
				}
				// For TOML
				if (configPath.endsWith(".toml")) {
					const match = content.match(/name\s*=\s*"([^"]+)"/);
					if (match?.[1]) return match[1];
				}
			} catch {}
		}
	}

	// Fallback to directory name
	return basename(process.cwd());
}

export default async function ship(): Promise<void> {
	if (!hasWranglerConfig()) {
		error("No wrangler config found in current directory");
		error("Run: jack new <project-name>");
		process.exit(1);
	}

	// For Vite projects, build first
	if (isViteProject()) {
		const buildSpin = spinner("Building...");
		const buildResult = await $`npx vite build`.nothrow().quiet();

		if (buildResult.exitCode !== 0) {
			buildSpin.error("Build failed");
			console.error(buildResult.stderr.toString());
			process.exit(buildResult.exitCode);
		}
		buildSpin.success("Built");
	}

	const spin = spinner("Deploying...");

	const result = await $`wrangler deploy`.nothrow().quiet();

	if (result.exitCode !== 0) {
		spin.error("Deploy failed");
		console.error(result.stderr.toString());
		process.exit(result.exitCode);
	}

	// Parse URL from output
	const output = result.stdout.toString();
	const urlMatch = output.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);

	if (urlMatch) {
		spin.success(`Live: ${urlMatch[0]}`);
	} else {
		spin.success("Deployed");
		console.error(output);
	}

	// Update registry after successful deploy
	try {
		const { registerProject } = await import("../lib/registry.ts");
		const projectName = await getProjectNameFromDir(process.cwd());

		await registerProject(projectName, {
			localPath: process.cwd(),
			workerUrl: urlMatch ? urlMatch[0] : null,
			lastDeployed: new Date().toISOString(),
		});
	} catch {
		// Don't fail the deploy if registry update fails
	}

	// Apply schema.sql after deploy (database auto-provisioned by wrangler)
	const projectDir = process.cwd();
	if (await hasD1Config(projectDir)) {
		const dbName = await getD1DatabaseName(projectDir);
		if (dbName) {
			try {
				await applySchema(dbName, projectDir);
			} catch (err) {
				warn(`Schema application failed: ${err}`);
				info("Run manually: bun run db:migrate");
			}
		}
	}

	// Detect and offer to save secrets
	const detected = await detectSecrets();
	const newSecrets = await filterNewSecrets(detected);

	if (newSecrets.length > 0) {
		await promptSaveSecrets(newSecrets);
	}

	// Auto-sync to cloud storage
	const syncConfig = await getSyncConfig();
	if (syncConfig.enabled && syncConfig.autoSync) {
		const syncSpin = spinner("Syncing source to cloud...");
		try {
			const projectName = await getProjectNameFromDir(process.cwd());
			const result = await syncToCloud(process.cwd());
			if (result.success) {
				if (result.filesUploaded > 0 || result.filesDeleted > 0) {
					syncSpin.success(
						`Backed up ${result.filesUploaded} files to jack-storage/${projectName}/`,
					);
				} else {
					syncSpin.success("Source already synced");
				}
			}
		} catch (err) {
			syncSpin.stop();
			warn("Cloud sync failed (deploy succeeded)");
			info("Run: jack sync");
		}
	}
}

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateAgentFiles } from "../lib/agent-files.ts";
import {
	getActiveAgents,
	getPreferredLaunchAgent,
	launchAgent,
	validateAgentPaths,
} from "../lib/agents.ts";
import { debug, printTimingSummary, time } from "../lib/debug.ts";
import { generateEnvFile, generateSecretsJson } from "../lib/env-parser.ts";
import { promptSelect, runHook } from "../lib/hooks.ts";
import { generateProjectName } from "../lib/names.ts";
import { output } from "../lib/output.ts";
import { applySchema, getD1DatabaseName, hasD1Config } from "../lib/schema.ts";
import { getSavedSecrets } from "../lib/secrets.ts";
import { renderTemplate, resolveTemplate } from "../templates/index.ts";
import type { Template } from "../templates/types.ts";
import { isInitialized } from "./init.ts";

export default async function newProject(
	name?: string,
	options: { template?: string } = {},
): Promise<void> {
	const timings: Array<{ label: string; duration: number }> = [];

	// Immediate feedback
	output.start("Starting...");
	debug("newProject called", { name, options });

	// Check if jack init was run
	const initDuration = await time("Check init", async () => {
		const initialized = await isInitialized();
		if (!initialized) {
			output.stop();
			output.error("jack is not set up yet");
			output.info("Run: jack init");
			process.exit(1);
		}
	});
	timings.push({ label: "Check init", duration: initDuration });

	const projectName = name ?? generateProjectName();
	const targetDir = resolve(projectName);
	debug("Project details", { projectName, targetDir });

	// Check directory doesn't exist
	if (existsSync(targetDir)) {
		output.stop();
		output.error(`Directory ${projectName} already exists`);
		process.exit(1);
	}

	output.start("Creating project...");

	// Load template
	let template: Template;
	const templateDuration = await time("Load template", async () => {
		try {
			template = await resolveTemplate(options.template);
			debug("Template loaded", {
				files: Object.keys(template.files).length,
				secrets: template.secrets,
				hooks: Object.keys(template.hooks || {}),
			});
		} catch (err) {
			output.stop();
			output.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});
	timings.push({ label: "Load template", duration: templateDuration });

	const rendered = renderTemplate(template!, { name: projectName });

	// Handle template-specific secrets (omakase: auto-use saved, fail if missing)
	const secretsToUse: Record<string, string> = {};
	if (template!.secrets?.length) {
		const secretsDuration = await time("Check secrets", async () => {
			const saved = await getSavedSecrets();
			debug("Saved secrets", Object.keys(saved));

			for (const key of template!.secrets!) {
				if (saved[key]) {
					secretsToUse[key] = saved[key];
				}
			}

			const missing = template!.secrets!.filter((key) => !saved[key]);
			if (missing.length > 0) {
				output.stop();
				output.error(`Missing required secrets: ${missing.join(", ")}`);
				for (const key of missing) {
					output.info(`  Run: jack secrets add ${key}`);
				}
				process.exit(1);
			}

			// Show what we're using (no prompt - omakase)
			output.stop();
			for (const key of Object.keys(secretsToUse)) {
				output.success(`Using saved secret: ${key}`);
			}
			output.start("Creating project...");
		});
		timings.push({ label: "Check secrets", duration: secretsDuration });
	}

	// Write all template files
	const writeDuration = await time("Write files", async () => {
		for (const [filePath, content] of Object.entries(rendered.files)) {
			debug(`Writing: ${filePath}`);
			await Bun.write(join(targetDir, filePath), content);
		}
	});
	timings.push({ label: "Write files", duration: writeDuration });

	// Write secrets files (.env for Vite, .dev.vars for wrangler local, .secrets.json for wrangler bulk)
	if (Object.keys(secretsToUse).length > 0) {
		const envContent = generateEnvFile(secretsToUse);
		const jsonContent = generateSecretsJson(secretsToUse);
		await Bun.write(join(targetDir, ".env"), envContent);
		await Bun.write(join(targetDir, ".dev.vars"), envContent);
		await Bun.write(join(targetDir, ".secrets.json"), jsonContent);
		debug("Wrote .env, .dev.vars, and .secrets.json");

		const gitignorePath = join(targetDir, ".gitignore");
		const gitignoreExists = existsSync(gitignorePath);

		if (!gitignoreExists) {
			await Bun.write(gitignorePath, ".env\n.env.*\n.dev.vars\n.secrets.json\nnode_modules/\n");
		} else {
			const existingContent = await Bun.file(gitignorePath).text();
			if (!existingContent.includes(".env")) {
				await Bun.write(
					gitignorePath,
					`${existingContent}\n.env\n.env.*\n.dev.vars\n.secrets.json\n`,
				);
			}
		}
	}

	// Generate agent context files
	const agentsDuration = await time("Generate agent files", async () => {
		let activeAgents = await getActiveAgents();
		if (activeAgents.length > 0) {
			// Validate paths still exist
			const validation = await validateAgentPaths();

			if (validation.invalid.length > 0) {
				output.stop();
				output.warn("Some agent paths no longer exist:");
				for (const { id, path } of validation.invalid) {
					output.info(`  ${id}: ${path}`);
				}
				output.info("Run: jack agents scan");
				output.start("Creating project...");

				// Filter out invalid agents
				activeAgents = activeAgents.filter(
					({ id }) => !validation.invalid.some((inv) => inv.id === id),
				);
			}

			if (activeAgents.length > 0) {
				await generateAgentFiles(targetDir, projectName, template!, activeAgents);
				const agentNames = activeAgents.map(({ definition }) => definition.name).join(", ");
				output.stop();
				output.success(`Generated context for: ${agentNames}`);
				output.start("Creating project...");
			}
		}
	});
	if (agentsDuration > 0) {
		timings.push({ label: "Generate agent files", duration: agentsDuration });
	}

	output.stop();
	output.success(`Created ${projectName}/`);

	// Auto-install dependencies
	output.start("Installing dependencies...");
	const installDuration = await time("bun install", async () => {
		debug("Running: bun install");
		const install = Bun.spawn(["bun", "install"], {
			cwd: targetDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await install.exited;

		if (install.exitCode === 0) {
			output.stop();
			output.success("Dependencies installed");
		} else {
			output.stop();
			output.warn("Failed to install dependencies, run: bun install");
			printTimingSummary(timings);
			return;
		}
	});
	timings.push({ label: "bun install", duration: installDuration });

	// Auto-deploy
	const { $ } = await import("bun");

	// Run pre-deploy hooks (e.g., check required secrets)
	if (template!.hooks?.preDeploy?.length) {
		const hookDuration = await time("Pre-deploy hooks", async () => {
			debug("Running pre-deploy hooks", template!.hooks?.preDeploy);
			const hookContext = { projectName, projectDir: targetDir };
			const passed = await runHook(template!.hooks!.preDeploy!, hookContext);
			if (!passed) {
				output.error("Pre-deploy checks failed");
				printTimingSummary(timings);
				return;
			}
		});
		timings.push({ label: "Pre-deploy hooks", duration: hookDuration });
	}

	// For Vite projects, build first
	const hasVite = existsSync(join(targetDir, "vite.config.ts"));
	if (hasVite) {
		output.start("Building...");
		const buildDuration = await time("vite build", async () => {
			debug("Running: npx vite build");
			const buildResult = await $`npx vite build`.cwd(targetDir).nothrow().quiet();
			if (buildResult.exitCode !== 0) {
				output.stop();
				output.error("Build failed");
				console.error(buildResult.stderr.toString());
				debug("Build stderr", buildResult.stderr.toString());
				printTimingSummary(timings);
				return;
			}
			output.stop();
			output.success("Built");
		});
		timings.push({ label: "vite build", duration: buildDuration });
	}

	output.start("Deploying...");
	const deployDuration = await time("wrangler deploy", async () => {
		debug("Running: wrangler deploy");
		const deployResult = await $`wrangler deploy`.cwd(targetDir).nothrow().quiet();

		if (deployResult.exitCode !== 0) {
			output.stop();
			output.error("Deploy failed");
			console.error(deployResult.stderr.toString());
			debug("Deploy stderr", deployResult.stderr.toString());
			printTimingSummary(timings);
			return;
		}
	});
	timings.push({ label: "wrangler deploy", duration: deployDuration });

	// Apply schema.sql after deploy (database auto-provisioned by wrangler)
	if (await hasD1Config(targetDir)) {
		const schemaDuration = await time("Apply schema", async () => {
			const dbName = await getD1DatabaseName(targetDir);
			if (dbName) {
				try {
					await applySchema(dbName, targetDir);
				} catch (err) {
					output.warn(`Schema application failed: ${err}`);
					output.info("Run manually: bun run db:migrate");
				}
			}
		});
		timings.push({ label: "Apply schema", duration: schemaDuration });
	}

	// Push secrets to Cloudflare (if any)
	const secretsJsonPath = join(targetDir, ".secrets.json");
	if (existsSync(secretsJsonPath)) {
		output.start("Configuring secrets...");
		const secretsPushDuration = await time("wrangler secret bulk", async () => {
			debug("Running: wrangler secret bulk .secrets.json");
			const secretsResult = await $`wrangler secret bulk .secrets.json`
				.cwd(targetDir)
				.nothrow()
				.quiet();
			if (secretsResult.exitCode !== 0) {
				output.stop();
				output.warn("Failed to push secrets to Cloudflare");
				output.info("Run manually: wrangler secret bulk .secrets.json");
				debug("Secrets stderr", secretsResult.stderr.toString());
			} else {
				output.stop();
				output.success("Secrets configured");
			}
		});
		timings.push({ label: "wrangler secret bulk", duration: secretsPushDuration });
	}

	// Parse URL from output (re-run deploy to get output if needed)
	const deployResult = await $`wrangler deploy`.cwd(targetDir).nothrow().quiet();
	const deployOutput = deployResult.stdout.toString();
	const urlMatch = deployOutput.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);

	output.stop();
	if (urlMatch) {
		output.success(`Live: ${urlMatch[0]}`);
	} else {
		output.success("Deployed");
	}

	// Register project in registry after successful deploy
	try {
		const { registerProject } = await import("../lib/registry.ts");
		const { getAccountId } = await import("../lib/cloudflare-api.ts");

		const accountId = await getAccountId();
		const dbName = await getD1DatabaseName(targetDir);

		await registerProject(projectName, {
			localPath: targetDir,
			workerUrl: urlMatch ? urlMatch[0] : null,
			createdAt: new Date().toISOString(),
			lastDeployed: urlMatch ? new Date().toISOString() : null,
			cloudflare: {
				accountId,
				workerId: projectName,
			},
			resources: {
				services: {
					db: dbName,
				},
			},
		});
	} catch {
		// Don't fail the deploy if registry update fails
	}

	console.error("");
	output.info(`Project: ${targetDir}`);

	// Run post-deploy hooks
	if (template!.hooks?.postDeploy?.length && urlMatch) {
		const postHookDuration = await time("Post-deploy hooks", async () => {
			const deployedUrl = urlMatch[0];
			const domain = deployedUrl.replace(/^https?:\/\//, "");
			debug("Running post-deploy hooks", { domain, url: deployedUrl });
			await runHook(template!.hooks!.postDeploy!, {
				domain,
				url: deployedUrl,
				projectName,
				projectDir: targetDir,
			});
		});
		timings.push({ label: "Post-deploy hooks", duration: postHookDuration });
	}

	// Print timing summary if debug mode
	printTimingSummary(timings);

	// Prompt to open preferred agent (only in interactive TTY)
	if (process.stdout.isTTY) {
		const preferred = await getPreferredLaunchAgent();
		if (preferred) {
			console.error("");
			console.error(`  Open project in ${preferred.definition.name}?`);
			console.error("");
			const choice = await promptSelect(["Yes", "No"]);

			if (choice === 0) {
				// Ensure terminal is in normal state before handoff
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}

				const launchResult = await launchAgent(preferred.launch, targetDir);
				if (!launchResult.success) {
					output.warn(`Failed to launch ${preferred.definition.name}`);
					if (launchResult.command?.length) {
						output.info(`Run manually: ${launchResult.command.join(" ")}`);
					}
				}
			}
		} else {
			console.error("");
			output.info("No launchable AI agent detected");
			output.info("Run: jack agents scan");
		}
	}
}

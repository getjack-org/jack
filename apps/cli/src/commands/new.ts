import {
	getAgentDefinition,
	getPreferredLaunchAgent,
	launchAgent,
	scanAgents,
	updateAgent,
} from "../lib/agents.ts";
import { debug } from "../lib/debug.ts";
import { getErrorDetails } from "../lib/errors.ts";
import { promptSelect } from "../lib/hooks.ts";
import { isIntentPhrase } from "../lib/intent.ts";
import { output, spinner } from "../lib/output.ts";
import { createProject } from "../lib/project-operations.ts";

export default async function newProject(
	nameOrPhrase?: string,
	options: {
		template?: string;
		intent?: string;
		managed?: boolean;
		byo?: boolean;
		ci?: boolean;
	} = {},
): Promise<void> {
	// Immediate feedback
	output.start("Starting...");
	debug("newProject called", { nameOrPhrase, options });
	// CI mode: explicit --ci flag, JACK_CI env, or standard CI env
	const isCi =
		options.ci ||
		process.env.JACK_CI === "1" ||
		process.env.JACK_CI === "true" ||
		process.env.CI === "true" ||
		process.env.CI === "1";

	// Determine if first arg is intent phrase or project name
	let projectName: string | undefined;
	let intentPhrase: string | undefined = options.intent;

	if (nameOrPhrase) {
		if (options.intent) {
			// Explicit -m flag means first arg is definitely a name
			projectName = nameOrPhrase;
		} else if (isIntentPhrase(nameOrPhrase)) {
			// Detected as intent phrase - name will be auto-generated
			intentPhrase = nameOrPhrase;
			projectName = undefined;
		} else {
			// Treat as project name
			projectName = nameOrPhrase;
		}
	}

	let result: Awaited<ReturnType<typeof createProject>>;
	try {
		result = await createProject(projectName, {
			template: options.template,
			intent: intentPhrase,
			reporter: {
				start: output.start,
				stop: output.stop,
				spinner,
				info: output.info,
				warn: output.warn,
				error: output.error,
				success: output.success,
				box: output.box,
				celebrate: output.celebrate,
			},
			interactive: !isCi,
			managed: options.managed,
			byo: options.byo,
		});
	} catch (error) {
		const details = getErrorDetails(error);
		output.stop();
		if (!details.meta?.reported) {
			output.error(details.message);
		}

		const missingSecrets = details.meta?.missingSecrets;
		if (missingSecrets?.length) {
			for (const key of missingSecrets) {
				output.info(`  Run: jack secrets add ${key}`);
			}
		}

		if (details.meta?.stderr) {
			console.error(details.meta.stderr);
		}

		if (details.suggestion && !details.meta?.reported && !missingSecrets?.length) {
			output.info(details.suggestion);
		}

		if (details.meta?.exitCode === 0) {
			return;
		}

		process.exit(details.meta?.exitCode ?? 1);
		return;
	}

	console.error("");
	output.info(`Project: ${result.targetDir}`);

	// Prompt to open preferred agent (only in interactive TTY, skip in CI mode)
	if (process.stdout.isTTY && !isCi) {
		const preferred = await getPreferredLaunchAgent();
		if (preferred) {
			console.error("");
			console.error(`  Open project in ${preferred.definition.name}?`);
			console.error("");
			const choice = await promptSelect(["Yes", "No"]);

			if (choice === 0) {
				const launchResult = await launchAgent(preferred.launch, result.targetDir, {
					projectName: result.projectName,
					url: result.workerUrl,
				});
				if (!launchResult.success) {
					output.warn(`Failed to launch ${preferred.definition.name}`);
					if (launchResult.command?.length) {
						output.info(`Run manually: ${launchResult.command.join(" ")}`);
					}
				}
			}
		} else {
			// No agents configured - auto-scan and offer to open in detected agents
			const detectionResult = await scanAgents();

			if (detectionResult.detected.length > 0) {
				// Auto-enable newly detected agents
				for (const { id, path, launch } of detectionResult.detected) {
					await updateAgent(id, {
						active: true,
						path,
						detectedAt: new Date().toISOString(),
						launch,
					});
				}

				// Build menu options: detected agents + Skip
				const menuOptions = detectionResult.detected.map(({ id }) => {
					const definition = getAgentDefinition(id);
					return definition?.name ?? id;
				});
				menuOptions.push("Skip");

				console.error("");
				console.error("  Open project in:");
				console.error("");
				const choice = await promptSelect(menuOptions);

				// Launch selected agent (unless Skip or cancelled)
				if (choice >= 0 && choice < detectionResult.detected.length) {
					const selected = detectionResult.detected[choice];
					const launchConfig = selected.launch;
					if (launchConfig) {
						const launchResult = await launchAgent(launchConfig, result.targetDir, {
							projectName: result.projectName,
							url: result.workerUrl,
						});
						if (!launchResult.success) {
							const definition = getAgentDefinition(selected.id);
							output.warn(`Failed to launch ${definition?.name ?? selected.id}`);
							if (launchResult.command?.length) {
								output.info(`Run manually: ${launchResult.command.join(" ")}`);
							}
						}
					}
				}
			} else {
				console.error("");
				output.info("No AI agents detected");
				output.info("Install Claude Code or Codex, then run: jack agents scan");
			}
		}
	}
}

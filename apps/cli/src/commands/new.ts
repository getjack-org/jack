import { getPreferredLaunchAgent, launchAgent, scanAgents, updateAgent } from "../lib/agents.ts";
import { debug } from "../lib/debug.ts";
import { getErrorDetails } from "../lib/errors.ts";
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
		open?: boolean;
		noOpen?: boolean;
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

	// Skip agent section entirely if --no-open or env var
	if (options.noOpen || process.env.JACK_NO_OPEN === "1") {
		return;
	}

	// Skip in CI mode
	if (!process.stdout.isTTY || isCi) {
		return;
	}

	// Get preferred agent
	let preferred = await getPreferredLaunchAgent();

	// If no preferred agent, scan and auto-enable detected agents
	if (!preferred) {
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
			// Use the first detected agent as preferred
			preferred = await getPreferredLaunchAgent();
		}
	}

	// Auto-open if --open flag
	if (options.open && preferred) {
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
		return;
	}

	// Default: show next steps (no prompt)
	if (preferred) {
		console.error("");
		output.info(`Next: cd ${result.targetDir} && ${preferred.launch.command}`);
	} else {
		console.error("");
		output.info("No AI agents detected");
		output.info("Install Claude Code or Codex, then run: jack agents scan");
	}
}

import { getPreferredLaunchAgent, launchAgent, scanAgents, updateAgent } from "../lib/agents.ts";
import { debug } from "../lib/debug.ts";
import { getErrorDetails } from "../lib/errors.ts";
import { isIntentPhrase } from "../lib/intent.ts";
import { createReporter, output } from "../lib/output.ts";
import { createProject } from "../lib/project-operations.ts";
import {
	detectShell,
	getRcFilePath,
	isInstalled as isShellIntegrationInstalled,
} from "../lib/shell-integration.ts";

export default async function newProject(
	nameOrPhrase?: string,
	pathArg?: string,
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
			reporter: createReporter(),
			interactive: !isCi,
			managed: options.managed,
			byo: options.byo,
			targetDir: pathArg || undefined,
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

	// Skip next steps if --no-open or env var
	if (options.noOpen || process.env.JACK_NO_OPEN === "1") {
		return;
	}

	// Check if shell integration is installed
	const shell = detectShell();
	const rcFile = getRcFilePath(shell);
	const hasShellIntegration = rcFile ? isShellIntegrationInstalled(rcFile) : false;

	if (!process.stdout.isTTY || isCi) {
		console.error("");
		console.error(`cd ${result.targetDir}`);
		// Print path to stdout for shell integration to capture
		console.log(result.targetDir);
		return;
	}

	// Auto-open if --open flag (requires agent detection)
	if (options.open) {
		let preferred = await getPreferredLaunchAgent();

		if (!preferred) {
			const detectionResult = await scanAgents();
			if (detectionResult.detected.length > 0) {
				for (const { id, path, launch } of detectionResult.detected) {
					await updateAgent(id, {
						active: true,
						path,
						detectedAt: new Date().toISOString(),
						launch,
					});
				}
				preferred = await getPreferredLaunchAgent();
			}
		}

		if (preferred) {
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
	}

	console.error("");
	if (hasShellIntegration) {
		output.success(`Ready in ${result.projectName}`);
		// Print path to stdout for shell integration to capture
		console.log(result.targetDir);
	} else {
		console.error(`cd ${result.targetDir}`);
	}
}

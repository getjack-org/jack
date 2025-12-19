import { getPreferredLaunchAgent, launchAgent } from "../lib/agents.ts";
import { debug } from "../lib/debug.ts";
import { getErrorDetails } from "../lib/errors.ts";
import { promptSelect } from "../lib/hooks.ts";
import { output, spinner } from "../lib/output.ts";
import { createProject } from "../lib/project-operations.ts";

export default async function newProject(
	name?: string,
	options: { template?: string } = {},
): Promise<void> {
	// Immediate feedback
	output.start("Starting...");
	debug("newProject called", { name, options });
	const isCi = process.env.CI === "true" || process.env.CI === "1";

	let result: Awaited<ReturnType<typeof createProject>>;
	try {
		result = await createProject(name, {
			template: options.template,
			reporter: {
				start: output.start,
				stop: output.stop,
				spinner,
				info: output.info,
				warn: output.warn,
				error: output.error,
				success: output.success,
				box: output.box,
			},
			interactive: !isCi,
		});
	} catch (error) {
		const details = getErrorDetails(error);
		output.stop();
		if (!details.meta?.reported) {
			output.error(details.message);
		}

		const hasMissingSecrets = !!details.meta?.missingSecrets?.length;
		if (hasMissingSecrets) {
			for (const key of details.meta.missingSecrets) {
				output.info(`  Run: jack secrets add ${key}`);
			}
		}

		if (details.meta?.stderr) {
			console.error(details.meta.stderr);
		}

		if (details.suggestion && !details.meta?.reported && !hasMissingSecrets) {
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

				const launchResult = await launchAgent(preferred.launch, result.targetDir);
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

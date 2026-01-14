import { getErrorDetails } from "../lib/errors.ts";
import { output, spinner } from "../lib/output.ts";
import { deployProject } from "../lib/project-operations.ts";

export default async function ship(
	options: { managed?: boolean; byo?: boolean; dryRun?: boolean } = {},
): Promise<void> {
	const isCi = process.env.CI === "true" || process.env.CI === "1";
	try {
		const result = await deployProject({
			projectPath: process.cwd(),
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
			includeSecrets: !options.dryRun,
			includeSync: !options.dryRun,
			managed: options.managed,
			byo: options.byo,
			dryRun: options.dryRun,
		});

		if (!result.workerUrl && result.deployOutput) {
			console.error(result.deployOutput);
		}
	} catch (error) {
		const details = getErrorDetails(error);
		if (!details.meta?.reported) {
			output.error(details.message);
		}

		if (details.meta?.stderr) {
			console.error(details.meta.stderr);
		}

		if (details.suggestion && !details.meta?.reported) {
			output.info(details.suggestion);
		}

		process.exit(details.meta?.exitCode ?? 1);
	}
}

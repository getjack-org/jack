import { getErrorDetails } from "../lib/errors.ts";
import { createReporter, output } from "../lib/output.ts";
import { deployProject } from "../lib/project-operations.ts";

export default async function ship(
	options: { managed?: boolean; byo?: boolean; dryRun?: boolean; json?: boolean; message?: string } = {},
): Promise<void> {
	const isCi = process.env.CI === "true" || process.env.CI === "1";
	const jsonOutput = options.json ?? false;
	try {
		const result = await deployProject({
			projectPath: process.cwd(),
			reporter: jsonOutput ? undefined : createReporter(),
			interactive: !isCi && !jsonOutput,
			includeSecrets: !options.dryRun,
			includeSync: !options.dryRun,
			managed: options.managed,
			byo: options.byo,
			dryRun: options.dryRun,
			message: options.message,
		});

		if (jsonOutput) {
			console.log(
				JSON.stringify({
					success: true,
					projectName: result.projectName,
					url: result.workerUrl,
					deployMode: result.deployMode,
					...(options.message && { message: options.message }),
				}),
			);
			return;
		}

		if (!result.workerUrl && result.deployOutput) {
			console.error(result.deployOutput);
		}
	} catch (error) {
		const details = getErrorDetails(error);

		if (jsonOutput) {
			console.log(
				JSON.stringify({
					success: false,
					error: details.message,
					suggestion: details.suggestion,
				}),
			);
			process.exit(details.meta?.exitCode ?? 1);
		}

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

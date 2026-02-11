import { rollbackDeployment } from "../lib/control-plane.ts";
import { error, info, spinner } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

/** Shorten a deployment ID for display: "dep_a1b2c3d4-..." → "a1b2c3d4" */
function shortDeployId(id: string): string {
	return id.startsWith("dep_") ? id.slice(4, 12) : id.slice(0, 8);
}

interface RollbackOptions {
	to?: string;
}

/**
 * Rollback to a previous deployment
 */
export default async function rollback(options: RollbackOptions = {}): Promise<void> {
	const link = await readProjectLink(process.cwd());

	if (!link) {
		error("Not a jack project");
		info("Run this command from a linked project directory");
		process.exit(1);
	}

	if (link.deploy_mode !== "managed") {
		error("Rollback is available for managed projects only");
		info("BYO projects can be rolled back using wrangler directly");
		process.exit(1);
	}

	let projectName: string;
	try {
		projectName = await getProjectNameFromDir(process.cwd());
	} catch {
		projectName = link.project_id;
	}

	const targetLabel = options.to ? shortDeployId(options.to) : "previous version";
	const spin = spinner(`Rolling back ${projectName} to ${targetLabel}`);

	try {
		const result = await rollbackDeployment(link.project_id, options.to);
		spin.success(`Rolled back to ${shortDeployId(result.deployment.id)}`);
		info(`New deployment: ${result.deployment.id}`);
		info("Code rolled back. Database state is unchanged.");
	} catch (err) {
		const message = err instanceof Error ? err.message : "Rollback failed";
		spin.error(message);
		process.exit(1);
	}
}

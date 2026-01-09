/**
 * jack unlink - Remove .jack/ directory from current project
 *
 * Removes the local project link but does NOT delete the project from cloud.
 * You can re-link anytime with: jack link
 */

import { error, info, success } from "../lib/output.ts";
import { unregisterPath } from "../lib/paths-index.ts";
import { readProjectLink, unlinkProject } from "../lib/project-link.ts";

export default async function unlink(): Promise<void> {
	// Check if linked
	const link = await readProjectLink(process.cwd());

	if (!link) {
		error("This directory is not linked");
		info("Nothing to unlink");
		process.exit(1);
	}

	// Remove from paths index
	await unregisterPath(link.project_id, process.cwd());

	// Remove .jack/ directory
	await unlinkProject(process.cwd());

	success("Project unlinked");
	info("You can re-link with: jack link");
}

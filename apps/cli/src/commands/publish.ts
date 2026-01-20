import { getCurrentUserProfile, publishProject } from "../lib/control-plane.ts";
import { output, spinner } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";

export default async function publish(): Promise<void> {
	// Check we're in a project directory
	const link = await readProjectLink(process.cwd());
	if (!link) {
		output.error("Not in a jack project directory");
		console.error("");
		output.info("This command requires a jack project.");
		output.info("  → cd into an existing project, or");
		output.info("  → Run: jack new my-project");
		process.exit(1);
	}

	if (link.deploy_mode !== "managed") {
		output.error("Only jack cloud projects can be published");
		output.info("Projects on your own Cloudflare account cannot be published");
		process.exit(1);
	}

	if (!link.project_id) {
		output.error("Project not linked to jack cloud");
		output.info("Run: jack ship (to deploy and link the project)");
		process.exit(1);
	}

	// Check user has username
	const profile = await getCurrentUserProfile();
	if (!profile?.username) {
		output.error("You need a username to publish projects");
		console.error("");
		output.info("Usernames identify your published templates.");
		output.info("  → Run: jack login");
		process.exit(1);
	}

	const spin = spinner("Publishing project...");

	try {
		const result = await publishProject(link.project_id);
		spin.stop();
		output.success(`Published as ${result.published_as}`);

		console.error("");
		output.info("Share this project:");
		output.info(`  ${result.fork_command}`);
	} catch (err) {
		spin.stop();
		const message = err instanceof Error ? err.message : "Unknown error";
		output.error(`Publish failed: ${message}`);
		process.exit(1);
	}
}

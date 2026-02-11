import { fetchDeployments } from "../lib/control-plane.ts";
import { error, info, item } from "../lib/output.ts";
import { readProjectLink } from "../lib/project-link.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

const DEFAULT_LIMIT = 5;
const ALL_LIMIT = 50;

function humanizeSource(source: string): string {
	if (source.startsWith("code:")) return "cli";
	if (source.startsWith("prebuilt:")) return "template";
	if (source.startsWith("template:")) return "template";
	if (source.startsWith("rollback:")) return "rollback";
	return source;
}

function humanizeStatus(status: string): string {
	if (status === "queued") return "interrupted";
	return status;
}

interface DeploysOptions {
	all?: boolean;
}

/**
 * List recent deployments for a project
 */
export default async function deploys(options: DeploysOptions = {}): Promise<void> {
	const link = await readProjectLink(process.cwd());

	if (!link) {
		error("Not a jack project");
		info("Run this command from a linked project directory");
		process.exit(1);
	}

	if (link.deploy_mode !== "managed") {
		info("Deploy history is available for managed projects only");
		process.exit(0);
	}

	let result;
	try {
		result = await fetchDeployments(link.project_id);
	} catch {
		error("Could not fetch deployments");
		info("Check your network connection and try again");
		process.exit(1);
	}

	if (result.deployments.length === 0) {
		info("No deployments yet");
		return;
	}

	let projectName: string;
	try {
		projectName = await getProjectNameFromDir(process.cwd());
	} catch {
		projectName = link.project_id;
	}

	const limit = options.all ? ALL_LIMIT : DEFAULT_LIMIT;
	const shown = result.deployments.slice(0, limit);

	console.error("");
	info(`Deployments for ${projectName} (${result.total} total)`);
	console.error("");

	//          icon + id       status        source       time
	console.error("    ID        Status       Source     Deployed");
	console.error("    ──        ──────       ──────     ────────");

	for (const deploy of shown) {
		const time = new Date(deploy.created_at).toLocaleString();
		const shortId = deploy.id.length > 12 ? deploy.id.slice(4, 12) : deploy.id;
		const status = humanizeStatus(deploy.status);
		const source = humanizeSource(deploy.source);
		const icon = status === "live" ? "✓" : status === "failed" ? "✗" : "○";
		item(`${icon} ${shortId}  ${status.padEnd(12)} ${source.padEnd(10)} ${time}`);
		if (deploy.error_message) {
			console.error(`    ${deploy.error_message}`);
		}
	}

	if (!options.all && result.total > DEFAULT_LIMIT) {
		console.error("");
		info(`Showing ${shown.length} of ${result.total}. Use --all to see more.`);
	}
	console.error("");
}

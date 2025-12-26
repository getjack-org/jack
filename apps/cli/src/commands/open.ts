import { $ } from "bun";
import { error, info } from "../lib/output.ts";
import { resolveProject } from "../lib/project-resolver.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

export interface OpenFlags {
	dash?: boolean;
	logs?: boolean;
}

export default async function open(projectName?: string, flags: OpenFlags = {}): Promise<void> {
	let name = projectName;

	// If no projectName provided, try to get from wrangler.toml in cwd
	if (!name) {
		try {
			name = await getProjectNameFromDir(process.cwd());
		} catch {
			error("No project name provided and could not determine from current directory");
			info("Usage: jack open [project-name] [--dash|--logs]");
			process.exit(1);
		}
	}

	// Resolve project from registry and control plane
	const project = await resolveProject(name);

	// Determine URL based on flags and deploy mode
	let url: string;

	if (flags.dash) {
		// Dashboard URLs - use Cloudflare dash for now
		url = `https://dash.cloudflare.com/workers/services/view/${name}`;
	} else if (flags.logs) {
		url = `https://dash.cloudflare.com/workers/services/view/${name}/logs`;
	} else {
		// Default: use mode-appropriate URL
		if (project?.sources.controlPlane && project.url) {
			// Managed project: use runjack URL
			url = project.url;
		} else {
			// BYO project: use workers.dev URL or stored URL
			url = project?.url || `https://${name}.workers.dev`;
		}
	}

	// Open browser using platform-specific command
	const cmd =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

	info(`Opening ${url}`);

	try {
		await $`${cmd} ${url}`;
	} catch (err) {
		error(`Failed to open browser: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/**
 * jack domains - List all custom domains across all projects
 *
 * Shows a high-level overview of all domains connected across all projects,
 * with slot usage information.
 */

import { authFetch, isLoggedIn } from "../lib/auth/index.ts";
import { getControlApiUrl } from "../lib/control-plane.ts";
import { JackError, JackErrorCode } from "../lib/errors.ts";
import { colors, error, info, output } from "../lib/output.ts";

interface DomainWithProject {
	id: string;
	hostname: string;
	status: string;
	ssl_status: string | null;
	project_slug: string;
	project_url: string;
	created_at: string;
	verification?: {
		type: "cname";
		target: string;
	};
	ownership_verification?: {
		type: "txt";
		name: string;
		value: string;
	};
}

interface ListAllDomainsResponse {
	domains: DomainWithProject[];
	slots: {
		used: number;
		max: number;
	};
}

/**
 * Get status icon for domain status
 */
function getStatusIcon(status: string): string {
	switch (status) {
		case "active":
			return `${colors.green}✓${colors.reset}`;
		case "pending":
		case "pending_owner":
		case "pending_ssl":
			return `${colors.yellow}⏳${colors.reset}`;
		case "failed":
		case "blocked":
			return `${colors.red}✗${colors.reset}`;
		case "moved":
		case "deleting":
			return `${colors.cyan}○${colors.reset}`;
		default:
			return "○";
	}
}

/**
 * Get human-readable status label
 */
function getStatusLabel(status: string): string {
	switch (status) {
		case "active":
			return "active";
		case "pending":
			return "pending DNS";
		case "pending_owner":
			return "pending ownership";
		case "pending_ssl":
			return "pending SSL";
		case "failed":
			return "failed";
		case "blocked":
			return "blocked";
		case "moved":
			return "moved";
		case "deleting":
			return "deleting";
		default:
			return status;
	}
}

interface DomainsOptions {
	json?: boolean;
	help?: boolean;
}

export default async function domains(options: DomainsOptions = {}): Promise<void> {
	// Handle help flags
	if (options.help) {
		return showHelp();
	}

	const jsonOutput = options.json ?? false;

	// Check if authenticated
	if (!isLoggedIn()) {
		error("Not logged in");
		info("Run: jack login");
		process.exit(1);
	}

	output.start("Loading domains...");

	const response = await authFetch(`${getControlApiUrl()}/v1/domains`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		output.stop();
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to list domains: ${response.status}`,
		);
	}

	const data = (await response.json()) as ListAllDomainsResponse;
	output.stop();

	// JSON output
	if (jsonOutput) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	// Render table
	console.error("");

	// Show slot usage
	const { used, max } = data.slots;
	const slotColor = used >= max ? colors.yellow : colors.green;
	console.error(`  ${colors.bold}Custom Domains${colors.reset}  ${slotColor}${used}/${max} slots used${colors.reset}`);
	console.error("");

	if (data.domains.length === 0) {
		info("No custom domains configured");
		console.error("");
		info("Add a domain: jack domain add <hostname>");
		console.error("");
		return;
	}

	// Group by status
	const active = data.domains.filter((d) => d.status === "active");
	const pending = data.domains.filter((d) =>
		["pending", "pending_owner", "pending_ssl"].includes(d.status),
	);
	const other = data.domains.filter(
		(d) => !["active", "pending", "pending_owner", "pending_ssl"].includes(d.status),
	);

	// Show active domains
	if (active.length > 0) {
		console.error(`  ${colors.dim}Active${colors.reset}`);
		for (const d of active) {
			console.error(
				`  ${getStatusIcon(d.status)} ${colors.green}https://${d.hostname}${colors.reset}  ${colors.dim}→ ${d.project_slug}${colors.reset}`,
			);
		}
		console.error("");
	}

	// Show pending domains
	if (pending.length > 0) {
		console.error(`  ${colors.dim}Pending${colors.reset}`);
		for (const d of pending) {
			const label = getStatusLabel(d.status);
			console.error(
				`  ${getStatusIcon(d.status)} ${colors.cyan}${d.hostname}${colors.reset} ${colors.yellow}(${label})${colors.reset}  ${colors.dim}→ ${d.project_slug}${colors.reset}`,
			);
		}
		console.error("");
	}

	// Show other (failed, blocked, moved)
	if (other.length > 0) {
		console.error(`  ${colors.dim}Other${colors.reset}`);
		for (const d of other) {
			const label = getStatusLabel(d.status);
			console.error(
				`  ${getStatusIcon(d.status)} ${d.hostname} ${colors.red}(${label})${colors.reset}  ${colors.dim}→ ${d.project_slug}${colors.reset}`,
			);
		}
		console.error("");
	}

	// Footer hints
	info("jack domain add <hostname> -p <project>  to add a domain");
	info("jack domain -p <project>                 to see project domain status");
	console.error("");
}

function showHelp(): void {
	console.error("");
	info("jack domains - List all custom domains across all projects");
	console.error("");
	console.error("Usage:");
	console.error("  jack domains           List all domains with slot usage");
	console.error("  jack domains --json    Output as JSON");
	console.error("");
	console.error("Related:");
	console.error("  jack domain            Manage domains for a specific project");
	console.error("  jack upgrade           Upgrade your plan for more slots");
	console.error("");
}

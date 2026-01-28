/**
 * jack domains - List all custom domains across all projects
 *
 * Shows a high-level overview of all domains connected across all projects,
 * with slot usage information.
 */

import { isLoggedIn } from "../lib/auth/index.ts";
import { colors, error, info, output } from "../lib/output.ts";
import {
	type DomainInfo,
	type DomainStatus,
	listDomains,
} from "../lib/services/domain-operations.ts";

/**
 * Get status icon for domain status
 */
function getStatusIcon(status: DomainStatus): string {
	switch (status) {
		case "active":
			return `${colors.green}✓${colors.reset}`;
		case "claimed":
			return `${colors.dim}○${colors.reset}`;
		case "unassigned":
			return `${colors.cyan}○${colors.reset}`;
		case "pending":
		case "pending_dns":
		case "pending_owner":
		case "pending_ssl":
			return `${colors.yellow}⏳${colors.reset}`;
		case "failed":
		case "blocked":
		case "expired":
			return `${colors.red}✗${colors.reset}`;
		case "moved":
		case "deleting":
		case "deleted":
			return `${colors.cyan}○${colors.reset}`;
		default:
			return "○";
	}
}

/**
 * Get human-readable status label
 */
function getStatusLabel(status: DomainStatus): string {
	switch (status) {
		case "active":
			return "active";
		case "claimed":
			return "reserved";
		case "unassigned":
			return "ready";
		case "pending":
			return "pending DNS";
		case "pending_dns":
			return "configure DNS";
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
		case "expired":
			return "expired";
		case "deleted":
			return "deleted";
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

	try {
		const data = await listDomains();
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
		const available = max - used;

		if (data.domains.length === 0) {
			// Empty state - focus on what's available
			if (max === 0) {
				console.error(
					`  ${colors.bold}Custom Domains${colors.reset}  ${colors.yellow}Free plan${colors.reset}`,
				);
				console.error("");
				info("Custom domains require a Pro plan");
				info("Upgrade: jack upgrade");
			} else {
				console.error(
					`  ${colors.bold}Custom Domains${colors.reset}  ${colors.green}${available} slots available${colors.reset}`,
				);
				console.error("");
				info("Reserve a slot, then assign to a project:");
				console.error(`  jack domain connect ${colors.cyan}api.yourcompany.com${colors.reset}`);
				console.error(
					`  jack domain assign ${colors.cyan}api.yourcompany.com${colors.reset} ${colors.cyan}<project>${colors.reset}`,
				);
			}
			console.error("");
			return;
		}

		// Has domains - show usage
		const slotColor = used >= max ? colors.yellow : colors.green;
		console.error(
			`  ${colors.bold}Custom Domains${colors.reset}  ${slotColor}${used}/${max} slots${colors.reset}`,
		);
		console.error("");

		// Group by status
		const active = data.domains.filter((d) => d.status === "active");
		const pending = data.domains.filter((d) =>
			["pending", "pending_dns", "pending_owner", "pending_ssl"].includes(d.status),
		);
		const unassigned = data.domains.filter((d) => d.status === "claimed");
		const other = data.domains.filter(
			(d) =>
				![
					"active",
					"pending",
					"pending_dns",
					"pending_owner",
					"pending_ssl",
					"claimed",
					"deleted",
				].includes(d.status),
		);

		// Show active domains
		if (active.length > 0) {
			console.error(`  ${colors.dim}Active${colors.reset}`);
			for (const d of active) {
				console.error(
					`  ${getStatusIcon(d.status)} ${colors.green}https://${d.hostname}${colors.reset}  ${colors.dim}-> ${d.project_slug}${colors.reset}`,
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
					`  ${getStatusIcon(d.status)} ${colors.cyan}${d.hostname}${colors.reset} ${colors.yellow}(${label})${colors.reset}  ${colors.dim}-> ${d.project_slug}${colors.reset}`,
				);
			}
			console.error("");
		}

		// Show unassigned domains (claimed but not connected to a project)
		if (unassigned.length > 0) {
			console.error(`  ${colors.dim}Unassigned${colors.reset}`);
			for (const d of unassigned) {
				console.error(`  ○ ${d.hostname}`);
			}
			console.error("");
		}

		// Show other (failed, blocked, moved)
		if (other.length > 0) {
			console.error(`  ${colors.dim}Other${colors.reset}`);
			for (const d of other) {
				const label = getStatusLabel(d.status);
				console.error(
					`  ${getStatusIcon(d.status)} ${d.hostname} ${colors.red}(${label})${colors.reset}  ${colors.dim}-> ${d.project_slug}${colors.reset}`,
				);
			}
			console.error("");
		}

		// Footer hints - show available slots if any
		if (available > 0) {
			info(
				`${available} slot${available > 1 ? "s" : ""} available. Add: jack domain connect <hostname>`,
			);
		} else {
			info("All slots used. Remove a domain to free a slot: jack domain rm <hostname>");
		}
		console.error("");
	} catch (err) {
		output.stop();
		throw err;
	}
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

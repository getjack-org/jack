/**
 * jack domain - Manage custom domains (slot-based workflow)
 *
 * Slots allow you to reserve domains before assigning them to projects.
 * Only available for paid plans.
 *
 * Workflow:
 *   1. connect <hostname>  - Reserve a slot
 *   2. assign <hostname> <project> - Provision to Cloudflare
 *   3. unassign <hostname> - Remove from CF, keep slot
 *   4. disconnect <hostname> - Full removal, free slot
 */

import { JackError } from "../lib/errors.ts";
import { isCancel, promptSelect } from "../lib/hooks.ts";
import { colors, error, info, output, success, warn } from "../lib/output.ts";
import {
	type DomainInfo,
	type DomainOwnershipVerification,
	type DomainStatus,
	type DomainVerification,
	assignDomain as assignDomainService,
	connectDomain as connectDomainService,
	disconnectDomain as disconnectDomainService,
	getDomainByHostname,
	listDomains as listDomainsService,
	unassignDomain as unassignDomainService,
} from "../lib/services/domain-operations.ts";

export default async function domain(subcommand?: string, args: string[] = []): Promise<void> {
	// Handle help flags
	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		return showHelp();
	}

	// No subcommand = show status (not help)
	if (!subcommand) {
		return await listDomainsCommand();
	}

	switch (subcommand) {
		case "connect":
			return await connectDomainCommand(args);
		case "assign":
			return await assignDomainCommand(args);
		case "unassign":
			return await unassignDomainCommand(args);
		case "disconnect":
			return await disconnectDomainCommand(args);
		case "list":
		case "ls":
			return await listDomainsCommand();
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: connect, assign, unassign, disconnect, list, help");
			process.exit(1);
	}
}

function showHelp(): void {
	console.error("");
	info("jack domain - Manage custom domains");
	console.error("");
	console.error("Usage:");
	console.error("  jack domain                          Show all domains and slot usage");
	console.error("  jack domain connect <hostname>       Reserve a domain slot");
	console.error("  jack domain assign <hostname> <project>  Provision domain to project");
	console.error("  jack domain unassign <hostname>      Remove from project, keep slot");
	console.error("  jack domain disconnect <hostname>    Remove completely, free slot");
	console.error("");
	console.error("Workflow:");
	console.error("  1. connect    - Reserve hostname (uses a slot)");
	console.error("  2. assign     - Point domain to a project (configures DNS)");
	console.error("  3. unassign   - Remove from project but keep slot reserved");
	console.error("  4. disconnect - Full removal, slot freed");
	console.error("");
	console.error("Examples:");
	console.error("  jack domain connect api.mycompany.com");
	console.error("  jack domain assign api.mycompany.com my-api");
	console.error("  jack domain unassign api.mycompany.com");
	console.error("  jack domain disconnect api.mycompany.com");
	console.error("");
}

/**
 * Get status icon for domain status
 */
function getStatusIcon(status: DomainStatus): string {
	switch (status) {
		case "active":
			return `${colors.green}✓${colors.reset}`;
		case "claimed":
			return `${colors.dim}○${colors.reset}`;
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
function getStatusLabel(status: DomainStatus): string {
	switch (status) {
		case "active":
			return "active";
		case "claimed":
			return "unassigned";
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

/**
 * Show DNS configuration instructions for pending domains
 */
function showDnsInstructions(
	hostname: string,
	verification?: DomainVerification,
	ownershipVerification?: DomainOwnershipVerification,
): void {
	// Extract the base domain (e.g., "hellno.wtf" from "app.hellno.wtf")
	const parts = hostname.split(".");
	const baseDomain = parts.slice(-2).join(".");
	const subdomain = parts.slice(0, -2).join(".");

	console.error(
		`  ${colors.cyan}Add these records to your DNS provider for ${colors.bold}${baseDomain}${colors.reset}${colors.cyan}:${colors.reset}`,
	);
	console.error("");

	let step = 1;

	if (verification) {
		console.error(
			`  ${colors.bold}${step}. CNAME${colors.reset} ${colors.cyan}(routes traffic)${colors.reset}`,
		);
		console.error(
			`     ${colors.cyan}Name:${colors.reset}  ${colors.green}${subdomain || "@"}${colors.reset}`,
		);
		console.error(
			`     ${colors.cyan}Value:${colors.reset} ${colors.green}${verification.target}${colors.reset}`,
		);
		step++;
	}

	if (ownershipVerification) {
		if (step > 1) console.error("");
		// Extract just the subdomain part for the TXT name
		const txtSubdomain = ownershipVerification.name.replace(`.${baseDomain}`, "");
		console.error(
			`  ${colors.bold}${step}. TXT${colors.reset} ${colors.cyan}(proves ownership)${colors.reset}`,
		);
		console.error(
			`     ${colors.cyan}Name:${colors.reset}  ${colors.green}${txtSubdomain}${colors.reset}`,
		);
		console.error(
			`     ${colors.cyan}Value:${colors.reset} ${colors.green}${ownershipVerification.value}${colors.reset}`,
		);
	}
}

/**
 * Get seconds until next cron check (runs on the minute, ~5s to process)
 */
function getSecondsUntilNextCheck(): number {
	const now = new Date();
	const secondsIntoMinute = now.getSeconds();
	// Cron runs at :00, takes ~5s to process pending domains
	const secondsUntilNextMinute = 60 - secondsIntoMinute;
	return secondsUntilNextMinute + 5;
}

/**
 * List domains and show status
 */
async function listDomainsCommand(): Promise<void> {
	output.start("Loading domains...");

	try {
		const data = await listDomainsService();
		output.stop();

		console.error("");

		// Show slot usage
		const { slots } = data;
		console.error(`  Slots: ${slots.used}/${slots.max} used`);
		console.error("");

		if (data.domains.length === 0) {
			info("No custom domains configured.");
			console.error("");
			info("Reserve a domain: jack domain connect <hostname>");
			return;
		}

		info("Custom domains:");
		console.error("");

		// Group domains by status
		const pendingDomains: DomainInfo[] = [];

		for (const d of data.domains) {
			const icon = getStatusIcon(d.status);
			const label = getStatusLabel(d.status);

			if (d.status === "active") {
				// Show clickable URL for active domains
				const projectInfo = d.project_slug ? ` -> ${d.project_slug}` : "";
				console.error(
					`  ${icon} ${colors.green}https://${d.hostname}${colors.reset}${colors.cyan}${projectInfo}${colors.reset}`,
				);
			} else if (d.status === "claimed") {
				// Reserved but not assigned
				console.error(
					`  ${icon} ${colors.dim}${d.hostname}${colors.reset} ${colors.cyan}(${label})${colors.reset}`,
				);
			} else {
				// Pending states
				const projectInfo = d.project_slug ? ` -> ${d.project_slug}` : "";
				console.error(
					`  ${icon} ${colors.cyan}${d.hostname}${colors.reset}${projectInfo} ${colors.yellow}(${label})${colors.reset}`,
				);
				if (d.verification || d.ownership_verification) {
					pendingDomains.push(d);
				}
			}
		}

		// Show DNS instructions for pending domains
		if (pendingDomains.length > 0) {
			for (const d of pendingDomains) {
				console.error("");
				showDnsInstructions(d.hostname, d.verification, d.ownership_verification);
			}
			const nextCheck = getSecondsUntilNextCheck();
			console.error("");
			console.error(`  ${colors.cyan}Next auto-check in ~${nextCheck}s${colors.reset}`);
		}

		console.error("");
	} catch (err) {
		output.stop();
		throw err;
	}
}

/**
 * Connect (reserve) a domain slot
 */
async function connectDomainCommand(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain connect <hostname>");
		process.exit(1);
	}

	console.error("");
	info(`Reserving slot for ${hostname}...`);

	try {
		const data = await connectDomainService(hostname);

		console.error("");
		success(`Slot reserved: ${data.hostname}`);
		console.error("");
		info("Next step: assign to a project with 'jack domain assign <hostname> <project>'");
		console.error("");
	} catch (err) {
		if (err instanceof JackError) {
			error(err.message);
			if (err.suggestion) {
				info(err.suggestion);
			}
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Assign a reserved domain to a project
 */
async function assignDomainCommand(args: string[]): Promise<void> {
	const hostname = args[0];
	const projectSlug = args[1];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain assign <hostname> <project>");
		process.exit(1);
	}

	if (!projectSlug) {
		error("Missing project name");
		info("Usage: jack domain assign <hostname> <project>");
		process.exit(1);
	}

	output.start("Looking up domain and project...");

	try {
		const data = await assignDomainService(hostname, projectSlug);
		output.stop();

		console.error("");

		if (data.status === "active") {
			success(`Domain active: https://${hostname}`);
		} else if (data.verification || data.ownership_verification) {
			info(`Domain assigned. Configure DNS to activate:`);
			console.error("");
			showDnsInstructions(hostname, data.verification, data.ownership_verification);
			console.error("");
			const nextCheck = getSecondsUntilNextCheck();
			console.error(
				`  ${colors.cyan}First auto-check in ~${nextCheck}s after DNS is configured.${colors.reset}`,
			);
		} else {
			success(`Domain assigned: ${hostname}`);
			console.error(`  Status: ${data.status}`);
		}
		console.error("");
	} catch (err) {
		output.stop();
		if (err instanceof JackError) {
			error(err.message);
			if (err.suggestion) {
				info(err.suggestion);
			}
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Unassign a domain from its project (keep the slot)
 */
async function unassignDomainCommand(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain unassign <hostname>");
		process.exit(1);
	}

	output.start("Finding domain...");

	// First, get the domain info for the confirmation prompt
	let domain: DomainInfo | null;
	try {
		domain = await getDomainByHostname(hostname);
	} catch (err) {
		output.stop();
		throw err;
	}

	if (!domain) {
		output.stop();
		error(`Domain not found: ${hostname}`);
		info("Run 'jack domain' to see all domains");
		process.exit(1);
	}

	if (!domain.project_id) {
		output.stop();
		error(`Domain ${hostname} is not assigned to any project`);
		process.exit(1);
	}

	output.stop();

	// Confirm
	console.error("");
	const projectInfo = domain.project_slug ? ` from ${domain.project_slug}` : "";
	const choice = await promptSelect(
		["Yes, unassign", "Cancel"],
		`Unassign ${hostname}${projectInfo}? (slot will be kept)`,
	);

	if (isCancel(choice) || choice !== 0) {
		info("Cancelled");
		return;
	}

	output.start("Unassigning domain...");

	try {
		await unassignDomainService(hostname);
		output.stop();
		console.error("");
		success(`Domain unassigned: ${hostname}`);
		info("Slot kept. Reassign with: jack domain assign <hostname> <project>");
		console.error("");
	} catch (err) {
		output.stop();
		if (err instanceof JackError) {
			error(err.message);
			if (err.suggestion) {
				info(err.suggestion);
			}
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Disconnect (fully remove) a domain
 */
async function disconnectDomainCommand(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain disconnect <hostname>");
		process.exit(1);
	}

	output.start("Finding domain...");

	// First, get the domain info for the confirmation prompt
	let domain: DomainInfo | null;
	try {
		domain = await getDomainByHostname(hostname);
	} catch (err) {
		output.stop();
		throw err;
	}

	if (!domain) {
		output.stop();
		error(`Domain not found: ${hostname}`);
		info("Run 'jack domain' to see all domains");
		process.exit(1);
	}

	output.stop();

	// Strong warning for disconnect
	console.error("");
	warn("This will permanently remove the domain and free the slot.");
	if (domain.project_slug) {
		warn(`Traffic to ${hostname} will stop routing to ${domain.project_slug}.`);
	}
	console.error("");

	const choice = await promptSelect(
		["Yes, disconnect permanently", "Cancel"],
		`Disconnect ${hostname}?`,
	);

	if (isCancel(choice) || choice !== 0) {
		info("Cancelled");
		return;
	}

	output.start("Disconnecting domain...");

	try {
		await disconnectDomainService(hostname);
		output.stop();
		console.error("");
		success(`Domain disconnected: ${hostname}`);
		info("Slot freed.");
		console.error("");
	} catch (err) {
		output.stop();
		if (err instanceof JackError) {
			error(err.message);
			if (err.suggestion) {
				info(err.suggestion);
			}
			process.exit(1);
		}
		throw err;
	}
}

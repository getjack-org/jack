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

import { authFetch } from "../lib/auth/index.ts";
import { findProjectBySlug, getControlApiUrl } from "../lib/control-plane.ts";
import { JackError, JackErrorCode } from "../lib/errors.ts";
import { isCancel, promptSelect } from "../lib/hooks.ts";
import { colors, error, info, output, success, warn } from "../lib/output.ts";

interface DomainResponse {
	id: string;
	hostname: string;
	status:
		| "claimed"
		| "pending"
		| "pending_owner"
		| "pending_ssl"
		| "active"
		| "blocked"
		| "moved"
		| "failed"
		| "deleting";
	ssl_status: string | null;
	project_id: string | null;
	project_slug: string | null;
	verification?: {
		type: "cname";
		target: string;
		instructions: string;
	};
	ownership_verification?: {
		type: "txt";
		name: string;
		value: string;
	};
	created_at: string;
}

interface ListDomainsResponse {
	domains: DomainResponse[];
	slots: {
		used: number;
		max: number;
	};
}

interface ConnectDomainResponse {
	id: string;
	hostname: string;
	status: string;
}

interface AssignDomainResponse {
	id: string;
	hostname: string;
	status: string;
	ssl_status: string | null;
	verification?: {
		type: "cname";
		target: string;
		instructions: string;
	};
	ownership_verification?: {
		type: "txt";
		name: string;
		value: string;
	};
}

export default async function domain(subcommand?: string, args: string[] = []): Promise<void> {
	// Handle help flags
	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		return showHelp();
	}

	// No subcommand = show status (not help)
	if (!subcommand) {
		return await listDomains();
	}

	switch (subcommand) {
		case "connect":
			return await connectDomain(args);
		case "assign":
			return await assignDomain(args);
		case "unassign":
			return await unassignDomain(args);
		case "disconnect":
			return await disconnectDomain(args);
		case "list":
		case "ls":
			return await listDomains();
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
function getStatusIcon(status: DomainResponse["status"]): string {
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
function getStatusLabel(status: DomainResponse["status"]): string {
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
	verification?: { type: "cname"; target: string },
	ownershipVerification?: { type: "txt"; name: string; value: string },
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
 * Find a domain by hostname from the global list
 */
async function findDomainByHostname(hostname: string): Promise<DomainResponse | null> {
	const response = await authFetch(`${getControlApiUrl()}/v1/domains`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to list domains: ${response.status}`,
		);
	}

	const data = (await response.json()) as ListDomainsResponse;
	return data.domains.find((d) => d.hostname === hostname) ?? null;
}

/**
 * List domains and show status
 */
async function listDomains(): Promise<void> {
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

	const data = (await response.json()) as ListDomainsResponse;
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
	const pendingDomains: DomainResponse[] = [];

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
}

/**
 * Connect (reserve) a domain slot
 */
async function connectDomain(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain connect <hostname>");
		process.exit(1);
	}

	console.error("");
	info(`Reserving slot for ${hostname}...`);

	const response = await authFetch(`${getControlApiUrl()}/v1/domains`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
			error?: string;
		};

		// Handle plan limit errors
		if (response.status === 403 || err.error === "plan_limit_reached") {
			error("No domain slots available");
			info("Upgrade your plan for more slots: jack upgrade");
			process.exit(1);
		}

		// Handle "already exists"
		if (response.status === 409 || err.error === "domain_exists") {
			error(`Domain ${hostname} is already reserved`);
			info("Run 'jack domain' to see all domains");
			process.exit(1);
		}

		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to reserve domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as ConnectDomainResponse;

	console.error("");
	success(`Slot reserved: ${data.hostname}`);
	console.error("");
	info("Next step: assign to a project with 'jack domain assign <hostname> <project>'");
	console.error("");
}

/**
 * Assign a reserved domain to a project
 */
async function assignDomain(args: string[]): Promise<void> {
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

	// Find the domain
	const domain = await findDomainByHostname(hostname);
	if (!domain) {
		output.stop();
		error(`Domain not found: ${hostname}`);
		info("Reserve it first: jack domain connect <hostname>");
		process.exit(1);
	}

	// Find the project
	const project = await findProjectBySlug(projectSlug);
	if (!project) {
		output.stop();
		error(`Project not found: ${projectSlug}`);
		info("Check your projects: jack ls");
		process.exit(1);
	}

	output.stop();
	console.error("");
	info(`Assigning ${hostname} to ${projectSlug}...`);

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}/assign`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project_id: project.id }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
			error?: string;
		};

		// Handle already assigned
		if (err.error === "already_assigned") {
			error(`Domain is already assigned to a project`);
			info("Unassign it first: jack domain unassign <hostname>");
			process.exit(1);
		}

		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to assign domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as AssignDomainResponse;

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
}

/**
 * Unassign a domain from its project (keep the slot)
 */
async function unassignDomain(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain unassign <hostname>");
		process.exit(1);
	}

	output.start("Finding domain...");

	const domain = await findDomainByHostname(hostname);
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

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}/unassign`, {
		method: "POST",
	});

	if (!response.ok) {
		output.stop();
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to unassign domain: ${response.status}`,
		);
	}

	output.stop();
	console.error("");
	success(`Domain unassigned: ${hostname}`);
	info("Slot kept. Reassign with: jack domain assign <hostname> <project>");
	console.error("");
}

/**
 * Disconnect (fully remove) a domain
 */
async function disconnectDomain(args: string[]): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain disconnect <hostname>");
		process.exit(1);
	}

	output.start("Finding domain...");

	const domain = await findDomainByHostname(hostname);
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

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}`, {
		method: "DELETE",
	});

	if (!response.ok) {
		output.stop();
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to disconnect domain: ${response.status}`,
		);
	}

	output.stop();
	console.error("");
	success(`Domain disconnected: ${hostname}`);
	info("Slot freed.");
	console.error("");
}

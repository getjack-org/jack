/**
 * jack domain - Manage custom domains for projects
 *
 * Custom domains allow routing traffic through your own hostname.
 * Only available for managed (jack cloud) projects.
 */

import { authFetch } from "../lib/auth/index.ts";
import { findProjectBySlug, getControlApiUrl } from "../lib/control-plane.ts";
import { JackError, JackErrorCode } from "../lib/errors.ts";
import { isCancel, promptSelect } from "../lib/hooks.ts";
import { colors, error, info, output, success } from "../lib/output.ts";
import { type LocalProjectLink, readProjectLink } from "../lib/project-link.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

interface DomainResponse {
	id: string;
	hostname: string;
	status:
		| "pending"
		| "pending_owner"
		| "pending_ssl"
		| "active"
		| "blocked"
		| "moved"
		| "failed"
		| "deleting";
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
	created_at: string;
}

interface ListDomainsResponse {
	domains: DomainResponse[];
}

interface AddDomainResponse {
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

interface DomainOptions {
	project?: string;
}

export default async function domain(
	subcommand?: string,
	args: string[] = [],
	options: DomainOptions = {},
): Promise<void> {
	// Handle help flags
	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		return showHelp();
	}

	// No subcommand = show status (not help)
	if (!subcommand) {
		return await listDomains(options);
	}

	switch (subcommand) {
		case "add":
			return await addDomain(args, options);
		case "rm":
		case "remove":
			return await removeDomain(args, options);
		case "list":
		case "ls":
			return await listDomains(options);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: add, rm, list, help");
			process.exit(1);
	}
}

function showHelp(): void {
	console.error("");
	info("jack domain - Manage custom domains");
	console.error("");
	console.error("Usage:");
	console.error("  jack domain              Show domain status (same as list)");
	console.error("  jack domain list         List domains and show status");
	console.error("  jack domain add <host>   Add a custom domain");
	console.error("  jack domain rm <host>    Remove a custom domain");
	console.error("");
	console.error("Options:");
	console.error("  --project, -p            Project name (auto-detected from cwd)");
	console.error("");
	console.error("Examples:");
	console.error("  jack domain add api.mycompany.com");
	console.error("  jack domain rm api.mycompany.com");
	console.error("");
}

/**
 * Resolve project context, requiring managed mode
 */
async function resolveProjectContext(options: DomainOptions): Promise<{
	projectName: string;
	link: LocalProjectLink;
	projectId: string;
}> {
	// If --project flag provided, look up from cloud first
	if (options.project) {
		// Try to find the project by slug in the cloud
		const managedProject = await findProjectBySlug(options.project);

		if (managedProject) {
			// Found in cloud - create a synthetic link for the rest of the code
			const syntheticLink: LocalProjectLink = {
				version: 1,
				project_id: managedProject.id,
				deploy_mode: "managed",
				linked_at: managedProject.created_at,
				owner_username: managedProject.owner_username ?? undefined,
			};
			return {
				projectName: managedProject.slug,
				link: syntheticLink,
				projectId: managedProject.id,
			};
		}

		// Not found in cloud - maybe it's a local BYO project?
		error(`Project '${options.project}' not found in jack cloud`);
		info("Custom domains are only available for jack cloud projects");
		process.exit(1);
	}

	// No --project flag: try to get from current directory
	let projectName: string;
	try {
		projectName = await getProjectNameFromDir(process.cwd());
	} catch {
		error("Could not determine project");
		info("Run from a project directory, or use --project <name>");
		process.exit(1);
	}

	// Read deploy mode from .jack/project.json
	const link = await readProjectLink(process.cwd());

	if (!link) {
		error("Project not linked");
		info("Run 'jack ship' first to deploy your project");
		process.exit(1);
	}

	if (link.deploy_mode !== "managed") {
		error("Custom domains require jack cloud");
		info("Deploy with jack cloud: jack ship");
		process.exit(1);
	}

	const projectId = link.project_id;

	return { projectName, link, projectId };
}

/**
 * Get status icon for domain status
 */
function getStatusIcon(status: DomainResponse["status"]): string {
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
function getStatusLabel(status: DomainResponse["status"]): string {
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

	console.error(`  ${colors.cyan}Add these records to your DNS provider for ${colors.bold}${baseDomain}${colors.reset}${colors.cyan}:${colors.reset}`);
	console.error("");

	let step = 1;

	if (verification) {
		console.error(`  ${colors.bold}${step}. CNAME${colors.reset} ${colors.cyan}(routes traffic)${colors.reset}`);
		console.error(`     ${colors.cyan}Name:${colors.reset}  ${colors.green}${subdomain || "@"}${colors.reset}`);
		console.error(`     ${colors.cyan}Value:${colors.reset} ${colors.green}${verification.target}${colors.reset}`);
		step++;
	}

	if (ownershipVerification) {
		if (step > 1) console.error("");
		// Extract just the subdomain part for the TXT name
		const txtSubdomain = ownershipVerification.name.replace(`.${baseDomain}`, "");
		console.error(`  ${colors.bold}${step}. TXT${colors.reset} ${colors.cyan}(proves ownership)${colors.reset}`);
		console.error(`     ${colors.cyan}Name:${colors.reset}  ${colors.green}${txtSubdomain}${colors.reset}`);
		console.error(`     ${colors.cyan}Value:${colors.reset} ${colors.green}${ownershipVerification.value}${colors.reset}`);
	}
}

// Keep old name as alias for compatibility
const showDnsTable = showDnsInstructions;

/**
 * List domains and show status
 */
async function listDomains(options: DomainOptions): Promise<void> {
	const { projectName, link, projectId } = await resolveProjectContext(options);

	output.start("Loading domains...");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/domains`);

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

	// Build default URL from owner_username and project slug
	const username = link.owner_username ?? "user";
	const defaultUrl = `${username}-${projectName}.runjack.xyz`;

	if (data.domains.length === 0) {
		console.error("");
		info(`No custom domains for ${projectName}.`);
		console.error("");
		console.error(`  Default URL: ${defaultUrl}`);
		console.error("");
		info("Add a domain: jack domain add <hostname>");
		return;
	}

	console.error("");
	info(`Domains for ${projectName}:`);
	console.error("");

	// Show domains with DNS instructions for pending ones
	const pendingDomains: DomainResponse[] = [];
	const activeDomains: DomainResponse[] = [];

	for (const d of data.domains) {
		const icon = getStatusIcon(d.status);
		const label = getStatusLabel(d.status);

		if (d.status === "active") {
			// Show clickable URL for active domains
			console.error(`  ${icon} ${colors.green}https://${d.hostname}${colors.reset}`);
			activeDomains.push(d);
		} else {
			// Show hostname with status for pending domains
			console.error(`  ${icon} ${colors.cyan}${d.hostname}${colors.reset} ${colors.yellow}(${label})${colors.reset}`);
			if (d.verification || d.ownership_verification) {
				pendingDomains.push(d);
			}
		}
	}

	// Show DNS instructions for pending domains
	if (pendingDomains.length > 0) {
		for (const d of pendingDomains) {
			console.error("");
			showDnsTable(d.hostname, d.verification, d.ownership_verification);
		}
		const nextCheck = getSecondsUntilNextCheck();
		console.error("");
		console.error(`  ${colors.cyan}Next auto-check in ~${nextCheck}s${colors.reset}`);
	}

	console.error("");
	console.error(`  Default: ${colors.cyan}https://${defaultUrl}${colors.reset}`);
	console.error("");
}

/**
 * Add a custom domain
 */
async function addDomain(args: string[], options: DomainOptions): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain add <hostname>");
		process.exit(1);
	}

	const { projectName, projectId } = await resolveProjectContext(options);

	console.error("");
	info(`Adding ${hostname} to ${projectName}...`);

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/domains`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
			error?: string;
		};

		// Handle plan limit errors with upgrade suggestion
		if (response.status === 403 || err.error === "plan_limit_reached") {
			error("Custom domains require a Pro plan");
			info("Upgrade your plan: jack upgrade");
			process.exit(1);
		}

		// Handle "already exists" - show current status instead of error
		if (response.status === 409 || err.error === "domain_exists") {
			return await showExistingDomainStatus(hostname, projectId);
		}

		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to add domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as AddDomainResponse;

	console.error("");
	if (data.verification || data.ownership_verification) {
		showDnsTable(hostname, data.verification, data.ownership_verification);
		console.error("");
		const nextCheck = getSecondsUntilNextCheck();
		console.error(`  First auto-check in ~${nextCheck}s after DNS is configured.`);
	} else {
		success(`Domain added: ${hostname}`);
		console.error(`  Status: ${data.status}`);
	}
	console.error("");
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
 * Show status for an existing domain (when user tries to add one that exists)
 */
async function showExistingDomainStatus(hostname: string, projectId: string): Promise<void> {
	// Fetch current domain status
	const listResponse = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/domains`);

	if (!listResponse.ok) {
		info(`Domain ${hostname} already configured.`);
		info("Run 'jack domain' to see status.");
		return;
	}

	const listData = (await listResponse.json()) as ListDomainsResponse;
	const domain = listData.domains.find((d) => d.hostname === hostname);

	if (!domain) {
		info(`Domain ${hostname} already configured.`);
		info("Run 'jack domain' to see status.");
		return;
	}

	// Show current status with DNS instructions
	console.error("");
	const icon = getStatusIcon(domain.status);
	const label = getStatusLabel(domain.status);
	info(`${hostname} is already configured:`);
	console.error("");
	console.error(`  Status: ${icon} ${label}`);

	if (domain.status === "active") {
		console.error("");
		success("Domain is active and routing traffic.");
	} else if (domain.verification || domain.ownership_verification) {
		console.error("");
		showDnsTable(hostname, domain.verification, domain.ownership_verification);
		console.error("");
		const nextCheck = getSecondsUntilNextCheck();
		console.error(`  Next auto-check in ~${nextCheck}s`);
	}
	console.error("");
}

/**
 * Remove a custom domain
 */
async function removeDomain(args: string[], options: DomainOptions): Promise<void> {
	const hostname = args[0];

	if (!hostname) {
		error("Missing hostname");
		info("Usage: jack domain rm <hostname>");
		process.exit(1);
	}

	const { projectId } = await resolveProjectContext(options);

	// First, list domains to find the ID
	output.start("Finding domain...");

	const listResponse = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/domains`);

	if (!listResponse.ok) {
		output.stop();
		const err = (await listResponse.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to list domains: ${listResponse.status}`,
		);
	}

	const listData = (await listResponse.json()) as ListDomainsResponse;
	const domain = listData.domains.find((d) => d.hostname === hostname);

	output.stop();

	if (!domain) {
		error(`Domain not found: ${hostname}`);
		info("Run 'jack domain' to see configured domains");
		process.exit(1);
	}

	// Confirm removal
	console.error("");
	const choice = await promptSelect(["Yes, remove", "Cancel"], `Remove ${hostname}?`);

	if (isCancel(choice) || choice !== 0) {
		info("Cancelled");
		return;
	}

	output.start("Removing domain...");

	const deleteResponse = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/domains/${domain.id}`,
		{ method: "DELETE" },
	);

	if (!deleteResponse.ok) {
		output.stop();
		const err = (await deleteResponse.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to remove domain: ${deleteResponse.status}`,
		);
	}

	output.stop();
	success(`Domain removed: ${hostname}`);
}

/**
 * Domain operations service layer for jack cloud
 *
 * Provides shared domain management functions for both CLI and MCP.
 * Returns pure data - no console.log or process.exit.
 */

import { authFetch } from "../auth/index.ts";
import { findProjectBySlug, getControlApiUrl } from "../control-plane.ts";
import { JackError, JackErrorCode } from "../errors.ts";

// ============================================================================
// Types
// ============================================================================

export type DomainStatus =
	| "claimed"
	| "unassigned"
	| "pending"
	| "pending_dns"
	| "pending_owner"
	| "pending_ssl"
	| "active"
	| "blocked"
	| "moved"
	| "failed"
	| "deleting"
	| "expired"
	| "deleted";

export interface DomainVerification {
	type: "cname";
	target: string;
	instructions: string;
}

export interface DomainOwnershipVerification {
	type: "txt";
	name: string;
	value: string;
}

export interface DomainDns {
	verified: boolean;
	checked_at: string | null;
	current_target: string | null;
	expected_target: string | null;
	error: string | null;
}

export interface DomainNextStep {
	action: string;
	record_type?: string;
	record_name?: string;
	record_value?: string;
	message?: string;
}

export interface DomainInfo {
	id: string;
	hostname: string;
	status: DomainStatus;
	ssl_status: string | null;
	project_id: string | null;
	project_slug: string | null;
	verification?: DomainVerification;
	ownership_verification?: DomainOwnershipVerification;
	dns?: DomainDns;
	next_step?: DomainNextStep;
	created_at: string;
}

export interface DomainSlots {
	used: number;
	max: number;
}

export interface ListDomainsResult {
	domains: DomainInfo[];
	slots: DomainSlots;
}

export interface ConnectDomainResult {
	id: string;
	hostname: string;
	status: DomainStatus;
}

export interface AssignDomainResult {
	id: string;
	hostname: string;
	status: DomainStatus;
	ssl_status: string | null;
	project_id: string;
	project_slug: string;
	verification?: DomainVerification;
	ownership_verification?: DomainOwnershipVerification;
}

export interface UnassignDomainResult {
	id: string;
	hostname: string;
	status: DomainStatus;
}

export interface DisconnectDomainResult {
	success: boolean;
	hostname: string;
}

// ============================================================================
// API Response Types (internal)
// ============================================================================

interface ListDomainsApiResponse {
	domains: DomainInfo[];
	slots: DomainSlots;
}

interface ConnectDomainApiResponse {
	domain: {
		id: string;
		hostname: string;
		status: string;
	};
}

interface AssignDomainApiResponse {
	domain: {
		id: string;
		hostname: string;
		status: string;
		ssl_status: string | null;
	};
	verification?: DomainVerification;
	ownership_verification?: DomainOwnershipVerification;
}

interface ApiErrorResponse {
	message?: string;
	error?: string;
}

// ============================================================================
// Error Codes for Domain Operations
// ============================================================================

/**
 * Extended error codes for domain operations.
 * Maps to JackErrorCode where possible, uses specific codes where needed.
 */
export const DomainErrorCode = {
	PLAN_LIMIT_REACHED: "PLAN_LIMIT_REACHED",
	RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
	ALREADY_EXISTS: "ALREADY_EXISTS",
	ALREADY_ASSIGNED: "ALREADY_ASSIGNED",
	NOT_ASSIGNED: "NOT_ASSIGNED",
} as const;

export type DomainErrorCodeType = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

// ============================================================================
// Service Functions
// ============================================================================

/**
 * List all domains for the current user.
 */
export async function listDomains(): Promise<ListDomainsResult> {
	const response = await authFetch(`${getControlApiUrl()}/v1/domains`);

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to list domains: ${response.status}`,
		);
	}

	const data = (await response.json()) as ListDomainsApiResponse;
	return {
		domains: data.domains,
		slots: data.slots,
	};
}

/**
 * Find a domain by hostname.
 * Returns null if not found.
 */
export async function getDomainByHostname(hostname: string): Promise<DomainInfo | null> {
	const result = await listDomains();
	return result.domains.find((d) => d.hostname === hostname) ?? null;
}

/**
 * Reserve a domain slot (connect a domain).
 *
 * @throws JackError with PLAN_LIMIT_REACHED if no slots available
 * @throws JackError with ALREADY_EXISTS if domain already reserved
 */
export async function connectDomain(hostname: string): Promise<ConnectDomainResult> {
	const response = await authFetch(`${getControlApiUrl()}/v1/domains`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;

		// Handle plan limit errors
		if (response.status === 403 || err.error === "plan_limit_reached") {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				"No domain slots available",
				"Upgrade your plan for more slots: jack upgrade",
				{ exitCode: 1 },
			);
		}

		// Handle "already exists"
		if (response.status === 409 || err.error === "domain_exists") {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				`Domain ${hostname} is already reserved`,
				"Run 'jack domain' to see all domains",
				{ exitCode: 1 },
			);
		}

		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to reserve domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as ConnectDomainApiResponse;
	return {
		id: data.domain.id,
		hostname: data.domain.hostname,
		status: data.domain.status as DomainStatus,
	};
}

/**
 * Assign a reserved domain to a project.
 *
 * @throws JackError with RESOURCE_NOT_FOUND if domain or project not found
 * @throws JackError with ALREADY_ASSIGNED if domain already assigned to a project
 */
export async function assignDomain(
	hostname: string,
	projectSlug: string,
): Promise<AssignDomainResult> {
	// Find the domain
	const domain = await getDomainByHostname(hostname);
	if (!domain) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			`Domain not found: ${hostname}`,
			"Reserve it first: jack domain connect <hostname>",
			{ exitCode: 1 },
		);
	}

	// Find the project
	const project = await findProjectBySlug(projectSlug);
	if (!project) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			`Project not found: ${projectSlug}`,
			"Check your projects: jack ls",
			{ exitCode: 1 },
		);
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}/assign`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project_id: project.id }),
	});

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;

		// Handle already assigned
		if (err.error === "already_assigned") {
			throw new JackError(
				JackErrorCode.VALIDATION_ERROR,
				"Domain is already assigned to a project",
				"Unassign it first: jack domain unassign <hostname>",
				{ exitCode: 1 },
			);
		}

		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to assign domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as AssignDomainApiResponse;
	return {
		id: data.domain.id,
		hostname: data.domain.hostname,
		status: data.domain.status as DomainStatus,
		ssl_status: data.domain.ssl_status,
		project_id: project.id,
		project_slug: projectSlug,
		verification: data.verification,
		ownership_verification: data.ownership_verification,
	};
}

/**
 * Unassign a domain from its project (keep the slot).
 *
 * @throws JackError with RESOURCE_NOT_FOUND if domain not found
 * @throws JackError with NOT_ASSIGNED if domain is not assigned to any project
 */
export async function unassignDomain(hostname: string): Promise<UnassignDomainResult> {
	// Find the domain
	const domain = await getDomainByHostname(hostname);
	if (!domain) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			`Domain not found: ${hostname}`,
			"Run 'jack domain' to see all domains",
			{ exitCode: 1 },
		);
	}

	if (!domain.project_id) {
		throw new JackError(
			JackErrorCode.VALIDATION_ERROR,
			`Domain ${hostname} is not assigned to any project`,
			undefined,
			{ exitCode: 1 },
		);
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}/unassign`, {
		method: "POST",
	});

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to unassign domain: ${response.status}`,
		);
	}

	const data = (await response.json()) as {
		domain: { id: string; hostname: string; status: string };
	};
	return {
		id: data.domain.id,
		hostname: data.domain.hostname,
		status: data.domain.status as DomainStatus,
	};
}

/**
 * Disconnect (fully remove) a domain.
 *
 * @throws JackError with RESOURCE_NOT_FOUND if domain not found
 */
export async function disconnectDomain(hostname: string): Promise<DisconnectDomainResult> {
	// Find the domain
	const domain = await getDomainByHostname(hostname);
	if (!domain) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			`Domain not found: ${hostname}`,
			"Run 'jack domain' to see all domains",
			{ exitCode: 1 },
		);
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}`, {
		method: "DELETE",
	});

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to disconnect domain: ${response.status}`,
		);
	}

	return {
		success: true,
		hostname: domain.hostname,
	};
}

/**
 * Verify DNS configuration for a domain.
 *
 * @throws JackError with RESOURCE_NOT_FOUND if domain not found
 */
export interface VerifyDomainResult {
	domain: DomainInfo;
	dns_check?: {
		verified: boolean;
		target: string | null;
		error: string | null;
	};
}

export async function verifyDomain(hostname: string): Promise<VerifyDomainResult> {
	const domain = await getDomainByHostname(hostname);
	if (!domain) {
		throw new JackError(
			JackErrorCode.PROJECT_NOT_FOUND,
			`Domain not found: ${hostname}`,
			"Run 'jack domain' to see all domains",
			{ exitCode: 1 },
		);
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/domains/${domain.id}/verify`, {
		method: "POST",
	});

	if (!response.ok) {
		const err = (await response
			.json()
			.catch(() => ({ message: "Unknown error" }))) as ApiErrorResponse;
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to verify domain: ${response.status}`,
		);
	}

	return (await response.json()) as VerifyDomainResult;
}

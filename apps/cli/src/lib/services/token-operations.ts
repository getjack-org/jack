/**
 * Token operations service layer for jack cloud
 *
 * Provides shared API token management functions for both CLI and MCP.
 * Returns pure data - no console.log or process.exit.
 */

import { authFetch } from "../auth/index.ts";
import { getControlApiUrl } from "../control-plane.ts";

// ============================================================================
// Types
// ============================================================================

export interface CreateTokenResult {
	token: string;
	id: string;
	name: string;
	created_at: string;
	expires_at: string | null;
}

export interface TokenInfo {
	id: string;
	name: string;
	id_prefix: string;
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Create a new API token for headless authentication.
 */
export async function createApiToken(
	name: string,
	expiresInDays?: number,
): Promise<CreateTokenResult> {
	const response = await authFetch(`${getControlApiUrl()}/v1/tokens`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, expires_in_days: expiresInDays }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({}))) as { message?: string };
		throw new Error(err.message || `Failed to create token: ${response.status}`);
	}

	return response.json() as Promise<CreateTokenResult>;
}

/**
 * List all active API tokens for the current user.
 */
export async function listApiTokens(): Promise<TokenInfo[]> {
	const response = await authFetch(`${getControlApiUrl()}/v1/tokens`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({}))) as { message?: string };
		throw new Error(err.message || `Failed to list tokens: ${response.status}`);
	}

	const data = (await response.json()) as { tokens: TokenInfo[] };
	return data.tokens;
}

/**
 * Revoke an API token by ID.
 */
export async function revokeApiToken(tokenId: string): Promise<void> {
	const response = await authFetch(`${getControlApiUrl()}/v1/tokens/${tokenId}`, {
		method: "DELETE",
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({}))) as { message?: string };
		throw new Error(err.message || `Failed to revoke token: ${response.status}`);
	}
}

import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export interface AuthUser {
	id: string;
	email: string;
	first_name: string | null;
	last_name: string | null;
}

export interface AuthCredentials {
	access_token: string;
	refresh_token: string;
	expires_at: number; // Unix timestamp (seconds)
	user: AuthUser;
}

const AUTH_PATH = join(CONFIG_DIR, "auth.json");

export async function getCredentials(): Promise<AuthCredentials | null> {
	if (!existsSync(AUTH_PATH)) {
		return null;
	}
	try {
		return await Bun.file(AUTH_PATH).json();
	} catch {
		return null;
	}
}

export async function saveCredentials(creds: AuthCredentials): Promise<void> {
	await Bun.write(AUTH_PATH, JSON.stringify(creds, null, 2));
	await chmod(AUTH_PATH, 0o600);
}

export async function deleteCredentials(): Promise<void> {
	if (existsSync(AUTH_PATH)) {
		const { unlink } = await import("node:fs/promises");
		await unlink(AUTH_PATH);
	}
}

export type AuthState = "logged-in" | "not-logged-in" | "session-expired";

/**
 * Get detailed auth state
 * - "logged-in": valid token (or successfully refreshed)
 * - "not-logged-in": no credentials stored
 * - "session-expired": had credentials but refresh failed
 */
export async function getAuthState(): Promise<AuthState> {
	const creds = await getCredentials();
	if (!creds) return "not-logged-in";

	// If token is not expired, we're logged in
	if (!isTokenExpired(creds)) return "logged-in";

	// If expired, try to refresh (dynamic import to avoid circular dep)
	try {
		const { getValidAccessToken } = await import("./client.ts");
		const token = await getValidAccessToken();
		return token !== null ? "logged-in" : "session-expired";
	} catch {
		return "session-expired";
	}
}

export async function isLoggedIn(): Promise<boolean> {
	return (await getAuthState()) === "logged-in";
}

export function isTokenExpired(creds: AuthCredentials): boolean {
	const now = Math.floor(Date.now() / 1000);
	const buffer = 5 * 60; // 5 minutes
	return creds.expires_at < now + buffer;
}

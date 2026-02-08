import { JackError, JackErrorCode } from "../errors.ts";
import { info } from "../output.ts";
import { getValidAccessToken } from "./client.ts";
import { getCredentials } from "./store.ts";

/**
 * Require auth - throws error if not logged in (for non-interactive contexts)
 */
export async function requireAuth(): Promise<string> {
	const token = await getValidAccessToken();

	if (!token) {
		throw new JackError(
			JackErrorCode.AUTH_FAILED,
			"Not logged in",
			"Run 'jack login' to sign in, or set JACK_API_TOKEN for headless use",
		);
	}

	return token;
}

/**
 * Require auth with auto-login - starts login flow if needed (omakase style)
 * Use this for interactive CLI commands that need auth.
 */
export async function requireAuthOrLogin(): Promise<string> {
	const token = await getValidAccessToken();

	if (token) {
		return token;
	}

	// Auto-start login flow
	info("Signing in to jack cloud...");

	const { default: login } = await import("../../commands/login.ts");
	await login({ silent: true });

	// After login, get the token
	const newToken = await getValidAccessToken();
	if (!newToken) {
		throw new JackError(
			JackErrorCode.AUTH_FAILED,
			"Login failed",
			"Please try again with 'jack login'",
		);
	}

	console.error(""); // Space before continuing with original command
	return newToken;
}

export async function getCurrentUser() {
	const creds = await getCredentials();
	return creds?.user ?? null;
}

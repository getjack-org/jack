import { JackError, JackErrorCode } from "../errors.ts";
import { getValidAccessToken } from "./client.ts";
import { getCredentials } from "./store.ts";

export async function requireAuth(): Promise<string> {
	const token = await getValidAccessToken();

	if (!token) {
		throw new JackError(
			JackErrorCode.AUTH_FAILED,
			"Not logged in",
			"Run 'jack login' to sign in to jack cloud",
		);
	}

	return token;
}

export async function getCurrentUser() {
	const creds = await getCredentials();
	return creds?.user ?? null;
}

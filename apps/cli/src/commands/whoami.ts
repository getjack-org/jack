import { authFetch } from "../lib/auth/index.ts";
import { getCredentials } from "../lib/auth/store.ts";
import { getControlApiUrl } from "../lib/control-plane.ts";
import { error, info, item, success } from "../lib/output.ts";

export default async function whoami(): Promise<void> {
	const apiToken = process.env.JACK_API_TOKEN;
	const creds = await getCredentials();

	if (!apiToken && !creds) {
		info("Not logged in");
		info("Run 'jack login' to sign in");
		return;
	}

	console.error("");

	if (apiToken && !creds) {
		// Token-only: fetch user info from control plane
		try {
			const res = await authFetch(`${getControlApiUrl()}/v1/me`);
			if (!res.ok) {
				error("API token is invalid or expired");
				return;
			}
			const data = (await res.json()) as {
				user?: { email?: string; id?: string; first_name?: string; last_name?: string };
			};
			if (data.user) {
				success("Logged in");
				if (data.user.email) item(`Email: ${data.user.email}`);
				if (data.user.id) item(`ID: ${data.user.id}`);
				if (data.user.first_name) {
					item(`Name: ${data.user.first_name}${data.user.last_name ? ` ${data.user.last_name}` : ""}`);
				}
			} else {
				success("Authenticated");
			}
			item(`Auth: API token (${apiToken.slice(4, 12)}...)`);
		} catch {
			error("Failed to reach control plane");
			item(`Auth: API token (${apiToken.slice(4, 12)}...)`);
		}
		console.error("");
		return;
	}

	// Has stored creds (with or without API token)
	success("Logged in");
	item(`Email: ${creds!.user.email}`);
	item(`ID: ${creds!.user.id}`);

	if (creds!.user.first_name) {
		item(`Name: ${creds!.user.first_name}${creds!.user.last_name ? ` ${creds!.user.last_name}` : ""}`);
	}

	if (apiToken) {
		item("Auth: API token");
	} else {
		const expiresIn = creds!.expires_at - Math.floor(Date.now() / 1000);
		if (expiresIn > 0) {
			const hours = Math.floor(expiresIn / 3600);
			const minutes = Math.floor((expiresIn % 3600) / 60);
			item(`Token expires: ${hours}h ${minutes}m`);
		} else {
			item("Token: expired (will refresh on next request)");
		}
	}
	console.error("");
}

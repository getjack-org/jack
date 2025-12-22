import { getCredentials } from "../lib/auth/store.ts";
import { info, item, success } from "../lib/output.ts";

export default async function whoami(): Promise<void> {
	const creds = await getCredentials();

	if (!creds) {
		info("Not logged in");
		info("Run 'jack login' to sign in");
		return;
	}

	console.error("");
	success("Logged in");
	item(`Email: ${creds.user.email}`);
	item(`ID: ${creds.user.id}`);

	if (creds.user.first_name) {
		item(
			`Name: ${creds.user.first_name}${creds.user.last_name ? ` ${creds.user.last_name}` : ""}`,
		);
	}

	const expiresIn = creds.expires_at - Math.floor(Date.now() / 1000);
	if (expiresIn > 0) {
		const hours = Math.floor(expiresIn / 3600);
		const minutes = Math.floor((expiresIn % 3600) / 60);
		item(`Token expires: ${hours}h ${minutes}m`);
	} else {
		item("Token: expired (will refresh on next request)");
	}
	console.error("");
}

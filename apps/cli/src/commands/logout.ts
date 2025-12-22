import { deleteCredentials, getCredentials } from "../lib/auth/store.ts";
import { info, success } from "../lib/output.ts";

export default async function logout(): Promise<void> {
	const creds = await getCredentials();

	if (!creds) {
		info("Not logged in");
		return;
	}

	await deleteCredentials();
	success("Logged out");
}

import { type DeviceAuthResponse, pollDeviceToken, startDeviceAuth } from "../lib/auth/client.ts";
import { type AuthCredentials, saveCredentials } from "../lib/auth/store.ts";
import { error, info, spinner, success } from "../lib/output.ts";

interface LoginOptions {
	/** Skip the initial "Logging in..." message (used when called from auto-login) */
	silent?: boolean;
}

export default async function login(options: LoginOptions = {}): Promise<void> {
	if (!options.silent) {
		info("Logging in to jack cloud...");
		console.error("");
	}

	const spin = spinner("Starting login...");
	let deviceAuth: DeviceAuthResponse;

	try {
		deviceAuth = await startDeviceAuth();
		spin.stop();
	} catch (err) {
		spin.stop();
		error(err instanceof Error ? err.message : "Failed to start login");
		process.exit(1);
	}

	console.error("");
	console.error("  ┌────────────────────────────────────┐");
	console.error("  │                                    │");
	console.error(`  │    Your code:  ${deviceAuth.user_code.padEnd(12)}      │`);
	console.error("  │                                    │");
	console.error("  └────────────────────────────────────┘");
	console.error("");
	info(`Opening ${deviceAuth.verification_uri} in your browser...`);
	console.error("");

	// Open browser - use Bun.spawn for cross-platform
	try {
		const platform = process.platform;
		const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
		Bun.spawn([cmd, deviceAuth.verification_uri_complete]);
	} catch {
		info(`If the browser didn't open, go to: ${deviceAuth.verification_uri_complete}`);
	}

	const pollSpin = spinner("Waiting for you to complete login in browser...");
	const interval = (deviceAuth.interval || 5) * 1000;
	const expiresAt = Date.now() + deviceAuth.expires_in * 1000;

	while (Date.now() < expiresAt) {
		await sleep(interval);

		try {
			const tokens = await pollDeviceToken(deviceAuth.device_code);

			if (tokens) {
				pollSpin.stop();

				// Default to 5 minutes if expires_in not provided
				const expiresIn = tokens.expires_in ?? 300;
				const creds: AuthCredentials = {
					access_token: tokens.access_token,
					refresh_token: tokens.refresh_token,
					expires_at: Math.floor(Date.now() / 1000) + expiresIn,
					user: tokens.user,
				};
				await saveCredentials(creds);

				console.error("");
				success(`Logged in as ${tokens.user.email}`);
				return;
			}
		} catch (err) {
			pollSpin.stop();
			error(err instanceof Error ? err.message : "Login failed");
			process.exit(1);
		}
	}

	pollSpin.stop();
	error("Login timed out. Please try again.");
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

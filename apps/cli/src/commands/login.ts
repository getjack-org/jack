import { input } from "@inquirer/prompts";
import { type DeviceAuthResponse, pollDeviceToken, startDeviceAuth } from "../lib/auth/client.ts";
import { type AuthCredentials, saveCredentials } from "../lib/auth/store.ts";
import {
	checkUsernameAvailable,
	getCurrentUserProfile,
	setUsername,
} from "../lib/control-plane.ts";
import { error, info, spinner, success, warn } from "../lib/output.ts";

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

				// Prompt for username if not set
				await promptForUsername(tokens.user.email);
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

async function promptForUsername(email: string): Promise<void> {
	// Skip in non-TTY environments
	if (!process.stdout.isTTY) {
		return;
	}

	const spin = spinner("Checking account...");

	try {
		const profile = await getCurrentUserProfile();
		spin.stop();

		// If user already has a username, skip
		if (profile?.username) {
			return;
		}

		console.error("");
		info("Choose a username for your jack cloud account.");
		info("URLs will look like: alice-vibes.runjack.xyz");
		console.error("");

		// Generate suggestions from $USER env var and email
		const suggestions = generateUsernameSuggestions(email);

		let username: string | null = null;

		while (!username) {
			// Show suggestions if available
			if (suggestions.length > 0) {
				info(`Suggestions: ${suggestions.join(", ")}`);
			}

			const inputUsername = await input({
				message: "Username:",
				default: suggestions[0],
				validate: (value) => {
					if (!value || value.length < 3) {
						return "Username must be at least 3 characters";
					}
					if (value.length > 39) {
						return "Username must be 39 characters or less";
					}
					if (value !== value.toLowerCase()) {
						return "Username must be lowercase";
					}
					if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/.test(value)) {
						return "Use only lowercase letters, numbers, and hyphens";
					}
					return true;
				},
			});

			// Check availability
			const checkSpin = spinner("Checking availability...");
			const availability = await checkUsernameAvailable(inputUsername);
			checkSpin.stop();

			if (!availability.available) {
				warn(availability.error || `Username "${inputUsername}" is already taken. Try another.`);
				continue;
			}

			// Try to set the username
			const setSpin = spinner("Setting username...");
			try {
				await setUsername(inputUsername);
				setSpin.stop();
				username = inputUsername;
				success(`Username set to "${username}"`);
			} catch (err) {
				setSpin.stop();
				warn(err instanceof Error ? err.message : "Failed to set username");
			}
		}
	} catch (err) {
		spin.stop();
		// Non-fatal - user can set username later
		warn("Could not set username. You can set it later.");
	}
}

function generateUsernameSuggestions(email: string): string[] {
	const suggestions: string[] = [];

	// Try $USER environment variable first
	const envUser = process.env.USER || process.env.USERNAME;
	if (envUser) {
		const normalized = normalizeToUsername(envUser);
		if (normalized && normalized.length >= 3) {
			suggestions.push(normalized);
		}
	}

	// Try email local part
	const emailLocal = email.split("@")[0];
	if (emailLocal) {
		const normalized = normalizeToUsername(emailLocal);
		if (normalized && normalized.length >= 3 && !suggestions.includes(normalized)) {
			suggestions.push(normalized);
		}
	}

	return suggestions.slice(0, 3); // Max 3 suggestions
}

function normalizeToUsername(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 39);
}

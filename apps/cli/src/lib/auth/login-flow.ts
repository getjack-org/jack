/**
 * Shared login flow for CLI and programmatic use
 */
import { input } from "@inquirer/prompts";
import {
	checkUsernameAvailable,
	getCurrentUserProfile,
	registerUser,
	setUsername,
} from "../control-plane.ts";
import { promptSelect } from "../hooks.ts";
import { celebrate, error, info, spinner, success, warn } from "../output.ts";
import { identifyUser } from "../telemetry.ts";
import { type DeviceAuthResponse, pollDeviceToken, startDeviceAuth } from "./client.ts";
import { type AuthCredentials, saveCredentials } from "./store.ts";

export interface LoginFlowOptions {
	/** Skip the initial "Logging in..." message (used when called from auto-login) */
	silent?: boolean;
	/** Skip the username prompt after login */
	skipUsernamePrompt?: boolean;
}

export interface LoginFlowResult {
	success: boolean;
	user?: {
		id: string;
		email: string;
		first_name: string | null;
		last_name: string | null;
	};
}

/**
 * Run the complete login flow including device auth, token polling, and user registration.
 * Returns a result object instead of calling process.exit().
 */
export async function runLoginFlow(options?: LoginFlowOptions): Promise<LoginFlowResult> {
	if (!options?.silent) {
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
		return { success: false };
	}

	celebrate("Your code:", [deviceAuth.user_code]);
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

				// Register user in control plane database (required for subsequent API calls)
				try {
					await registerUser({
						email: tokens.user.email,
						first_name: tokens.user.first_name,
						last_name: tokens.user.last_name,
					});
				} catch (_regError) {
					// Registration is required - without it, all API calls will fail
					error("Failed to complete login - could not reach jack cloud.");
					error("Please check your internet connection and try again.");
					return { success: false };
				}

				// Link user identity for cross-platform analytics
				await identifyUser(tokens.user.id, { email: tokens.user.email });

				// Prompt for username if not set (unless explicitly skipped)
				// Do this before welcome message so we know if user is new or returning
				let isNewUser = false;
				if (!options?.skipUsernamePrompt) {
					isNewUser = await promptForUsername(tokens.user.email, tokens.user.first_name);
				}

				console.error("");
				const displayName = tokens.user.first_name || "you";
				if (isNewUser) {
					success(`Welcome, ${displayName}!`);
				} else {
					success(`Welcome back, ${displayName}`);
				}

				return {
					success: true,
					user: tokens.user,
				};
			}
		} catch (err) {
			pollSpin.stop();
			error(err instanceof Error ? err.message : "Login failed");
			return { success: false };
		}
	}

	pollSpin.stop();
	error("Login timed out. Please try again.");
	return { success: false };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prompt user to set their username if not already set.
 * Returns true if this was a new user (username was set), false if returning user.
 */
async function promptForUsername(email: string, firstName: string | null): Promise<boolean> {
	// Skip in non-TTY environments
	if (!process.stdout.isTTY) {
		return false;
	}

	const spin = spinner("Checking account...");

	try {
		const profile = await getCurrentUserProfile();
		spin.stop();

		// If user already has a username, they're a returning user
		if (profile?.username) {
			return false;
		}

		console.error("");
		info("Choose a username for your jack cloud account.");
		info("URLs will look like: alice-vibes.runjack.xyz");
		console.error("");

		// Generate suggestions from first name, $USER env var, and email
		const suggestions = generateUsernameSuggestions(email, firstName);

		let username: string | null = null;

		while (!username) {
			// Build options for promptSelect
			const options = [...suggestions, "Type custom username"];
			info("Pick a username:");
			const choice = await promptSelect(options);

			let inputUsername: string;

			if (choice === -1) {
				// User pressed Esc - skip username setup
				warn("Skipped username setup. You can set it later.");
				return true; // Still a new user, just skipped
			}

			if (choice === options.length - 1) {
				// User chose to type custom username
				inputUsername = await input({
					message: "Username:",
					validate: validateUsername,
				});
			} else {
				// User picked a suggestion (choice is guaranteed to be valid index)
				inputUsername = suggestions[choice] as string;
			}

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

		return true; // New user - username was set
	} catch (_err) {
		spin.stop();
		// Non-fatal - user can set username later
		warn("Could not set username. You can set it later.");
		return true; // Assume new user if we couldn't check
	}
}

function validateUsername(value: string): string | true {
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
}

function generateUsernameSuggestions(email: string, firstName: string | null): string[] {
	const suggestions: string[] = [];

	// Try first name first (most personal)
	if (firstName) {
		const normalized = normalizeToUsername(firstName);
		if (normalized && normalized.length >= 3) {
			suggestions.push(normalized);
		}
	}

	// Try $USER environment variable
	const envUser = process.env.USER || process.env.USERNAME;
	if (envUser) {
		const normalized = normalizeToUsername(envUser);
		if (normalized && normalized.length >= 3 && !suggestions.includes(normalized)) {
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

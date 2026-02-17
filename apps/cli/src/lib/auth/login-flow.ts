/**
 * Shared login flow for CLI and programmatic use
 */
import { text } from "@clack/prompts";
import {
	applyReferralCode,
	checkUsernameAvailable,
	getCurrentUserProfile,
	registerUser,
	setUsername,
} from "../control-plane.ts";
import { isCancel } from "../hooks.ts";
import { promptSelect } from "../hooks.ts";
import { celebrate, error, info, spinner, success, warn } from "../output.ts";
import { identifyUser } from "../telemetry.ts";
import {
	type DeviceAuthResponse,
	type MagicAuthStartResponse,
	pollDeviceToken,
	startDeviceAuth,
	startMagicAuth,
	verifyMagicAuth,
} from "./client.ts";
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

				// Prompt for referral code for new users only (one-time, no retry)
				if (isNewUser && process.stdout.isTTY) {
					await promptForReferral();
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

// ============================================================================
// Magic Auth Flow (headless / agent login)
// ============================================================================

export interface MagicAuthFlowOptions {
	email: string;
	/** 6-digit code from email. If omitted: sends code, then prompts (TTY) or exits (non-TTY). */
	code?: string;
	silent?: boolean;
}

export interface MagicAuthFlowResult {
	success: boolean;
	/** Set when code was sent but not yet verified (step 1 only) */
	codeSent?: boolean;
	token?: string; // jkt_* token
	user?: { id: string; email: string; first_name: string | null; last_name: string | null };
}

/**
 * Magic auth login flow. Two modes:
 *
 * 1. No code provided → sends verification email.
 *    - TTY: prompts for code inline, then completes login.
 *    - Non-TTY: prints instructions and exits (agent runs again with --code).
 *
 * 2. Code provided → skips send, verifies directly → register → create jkt_* token.
 */
export async function runMagicAuthFlow(
	options: MagicAuthFlowOptions,
): Promise<MagicAuthFlowResult> {
	const { email } = options;
	let code = options.code;

	// If no code provided, send the magic auth email first
	if (!code) {
		if (!options.silent) {
			info(`Sending verification code to ${email}...`);
			console.error("");
		}

		const sendSpin = spinner("Sending code...");
		try {
			await startMagicAuth(email);
			sendSpin.stop();
		} catch (err) {
			sendSpin.stop();
			error(err instanceof Error ? err.message : "Failed to send verification code");
			return { success: false };
		}

		info("Check your email for a 6-digit code.");

		const isInteractive = process.stdout.isTTY && !process.env.CI;

		// Interactive: prompt inline so human-supervised agents can paste the code
		if (isInteractive) {
			console.error("");
			const codeInput = await text({
				message: "Enter code:",
				validate: (value) => {
					if (!value || value.trim().length === 0) return "Code is required";
					if (!/^\d{6}$/.test(value.trim())) return "Enter the 6-digit code from your email";
				},
			});

			if (isCancel(codeInput)) {
				warn("Login cancelled.");
				return { success: false };
			}
			code = codeInput.trim();
		} else {
			// Non-TTY: exit so agent can re-run with --code
			console.error("");
			info("Then run:");
			info(`  jack login --email ${email} --code <CODE>`);
			return { success: true, codeSent: true };
		}
	}

	// Verify code and complete login
	const verifySpin = spinner("Verifying code...");

	try {
		const tokens = await verifyMagicAuth(email, code);
		verifySpin.stop();

		// Save credentials (needed for authFetch in subsequent calls)
		const expiresIn = tokens.expires_in ?? 300;
		const creds: AuthCredentials = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: Math.floor(Date.now() / 1000) + expiresIn,
			user: tokens.user,
		};
		await saveCredentials(creds);

		// Register user in control plane
		try {
			await registerUser({
				email: tokens.user.email,
				first_name: tokens.user.first_name,
				last_name: tokens.user.last_name,
			});
		} catch (_regError) {
			error("Failed to complete login - could not reach jack cloud.");
			error("Please check your internet connection and try again.");
			return { success: false };
		}

		// Link user identity for analytics
		await identifyUser(tokens.user.id, { email: tokens.user.email });

		// Create API token for headless use
		let apiToken: string | undefined;
		try {
			const { createApiToken } = await import("../services/token-operations.ts");
			const tokenResult = await createApiToken("Magic Auth Token");
			apiToken = tokenResult.token;
		} catch (_err) {
			warn("Could not create API token. You can create one later with 'jack tokens create'.");
		}

		// Prompt for username only when interactive
		if (process.stdout.isTTY && !process.env.CI) {
			await promptForUsername(tokens.user.email, tokens.user.first_name);
		}

		const isInteractive = process.stdout.isTTY && !process.env.CI;

		console.error("");
		success(`Logged in as ${tokens.user.email}`);

		if (apiToken) {
			if (isInteractive) {
				success(`API token created: ${apiToken.slice(0, 12)}...`);
				console.error("");
				info("Your token has been saved. You can also set it as:");
				info(`  export JACK_API_TOKEN=${apiToken}`);
			} else {
				info("jack CLI is now authenticated. Future commands will use this session.");
				info(`API token for other tools: ${apiToken}`);
			}
		}

		return {
			success: true,
			token: apiToken,
			user: tokens.user,
		};
	} catch (err) {
		verifySpin.stop();
		error(err instanceof Error ? err.message : "Verification failed");
		return { success: false };
	}
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
				const customInput = await text({
					message: "Username:",
					validate: (value) => {
						const result = validateUsername(value);
						if (result !== true) return result;
					},
				});
				if (isCancel(customInput)) {
					warn("Skipped username setup. You can set it later.");
					return true;
				}
				inputUsername = customInput;
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

/**
 * Prompt new users for a referral code (one-time, no retry on failure).
 */
async function promptForReferral(): Promise<void> {
	console.error("");
	const referralInput = await text({
		message: "Were you referred by someone? Enter their username (or press Enter to skip):",
	});

	if (isCancel(referralInput)) {
		return;
	}

	const code = referralInput.trim();
	if (!code) {
		return;
	}

	try {
		const result = await applyReferralCode(code);
		if (result.applied) {
			success("Referral applied! You'll both get a bonus when you upgrade.");
		}
	} catch {
		// Silently continue - referral is not critical
	}
}
